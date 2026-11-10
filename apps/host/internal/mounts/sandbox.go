package mounts

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Sandbox is one sandbox's mounts.
type Sandbox struct {
	id    string
	m     *Manager
	specs []proto.Mount

	mounts []*mount
	// slots are the sandbox's share of the host's open chunks (SandboxOpenChunks).
	slots chan struct{}

	lmu      sync.Mutex
	listener net.Listener
	server   *http.Server
}

type mount struct {
	s     *Sandbox
	index int
	spec  proto.Mount
	// prefix is the bucket prefix as listed ("" or ending in "/").
	prefix string
	ttl    time.Duration

	mu    sync.Mutex
	state string
	err   string
	// current is the newest manifest. A version it no longer has is still read by a file the guest opened before,
	// however many refreshes later, through the proof that version's entry carried (proof, proven).
	current     *manifest
	refreshedAt time.Time
	// listedAt is when the listing current came from began: everything in the bucket before then is in it (Sync).
	listedAt time.Time
	// attemptedAt is when the mount was last listed, successfully or not: one listing per MinTTL, whoever asks
	// (Sync apart). listErr is that listing's error, nil when it listed.
	attemptedAt time.Time
	listErr     error
	listing     chan struct{}
	lists       atomic.Int64
}

// proof is the host's signature of one object version in this mount (its key, version tag, ETag and size, under
// what the mount shows): the guest gets it in the manifest and sends it back with a read. "<mac>" when the tag is
// the ETag's, else "<etag>.<mac>", both base64url.
func (mt *mount) proof(o object) string {
	mac := mt.mac(o)
	if o.tag == "e"+o.etag {
		return mac
	}
	return base64.RawURLEncoding.EncodeToString([]byte(o.etag)) + "." + mac
}

func (mt *mount) mac(o object) string {
	h := hmac.New(sha256.New, mt.s.m.proofKey)
	for _, part := range []string{specKey(mt.spec), o.key, o.tag, o.etag, strconv.FormatInt(o.size, 10)} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:16])
}

// proven is the object version a read names by its proof (one the guest was shown, and only that), when it isn't in
// the current manifest: a file opened before a refresh. Its bytes come from the cache, or from the store while it
// still has that version (If-Match), else the read fails as stale.
func (mt *mount) proven(path, tag, size, proof string) (object, bool) {
	if proof == "" || !validRel(path) || tag == "" {
		return object{}, false
	}
	n, err := strconv.ParseInt(size, 10, 64)
	if err != nil || n < 0 {
		return object{}, false
	}
	o := object{key: mt.prefix + path, tag: tag, size: n}
	mac := proof
	if enc, m, ok := strings.Cut(proof, "."); ok {
		etag, err := base64.RawURLEncoding.DecodeString(enc)
		if err != nil {
			return object{}, false
		}
		o.etag, mac = string(etag), m
	} else if e, ok := strings.CutPrefix(tag, "e"); ok {
		o.etag = e
	} else {
		return object{}, false
	}
	if !hmac.Equal([]byte(mac), []byte(mt.mac(o))) {
		return object{}, false
	}
	return o, true
}

func newMount(s *Sandbox, index int, spec proto.Mount) *mount {
	mt := &mount{s: s, index: index, spec: spec, state: proto.MountPending, ttl: DefaultTTL}
	mt.prefix = normalPrefix(spec.Prefix)
	if ttl := spec.RefreshTTLSeconds; ttl != nil {
		// 0: never look again by itself (a refresh still does).
		mt.ttl = 0
		if *ttl > 0 {
			mt.ttl = max(MinTTL, time.Duration(*ttl)*time.Second)
		}
	}
	return mt
}

// slot takes one of the sandbox's open chunks and one of the host's, waiting for them (wait) or not; release gives
// them back.
func (s *Sandbox) slot(ctx context.Context, wait bool) (release func(), err error) {
	take := func(c chan struct{}) error {
		if !wait {
			select {
			case c <- struct{}{}:
				return nil
			default:
				return errors.New("no chunk free")
			}
		}
		select {
		case c <- struct{}{}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := take(s.slots); err != nil {
		return nil, err
	}
	if err := take(s.m.slots); err != nil {
		<-s.slots
		return nil, err
	}
	return func() { <-s.m.slots; <-s.slots }, nil
}

// Len is how many mounts the sandbox has.
func (s *Sandbox) Len() int { return len(s.mounts) }

// Listen serves the sandbox's mounts to its guest: on the Unix socket Firecracker hands the guest's vsock connections
// to host port guest.MountPort (<vm>/<uds>_1027). A listener already open is closed first.
func (s *Sandbox) Listen(vmDir, udsName string) error {
	s.closeListener()
	path := filepath.Join(vmDir, fmt.Sprintf("%s_%d", udsName, guest.MountPort))
	_ = os.Remove(path)
	l, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("mounts socket: %w", err)
	}
	srv := &http.Server{Handler: s.handler(), ReadHeaderTimeout: 30 * time.Second}
	s.lmu.Lock()
	s.listener, s.server = l, srv
	s.lmu.Unlock()
	go func() { _ = srv.Serve(l) }()
	return nil
}

// Close stops serving the guest (its VM stopped); the mounts' state stays for a resume.
func (s *Sandbox) Close() { s.closeListener() }

func (s *Sandbox) closeListener() {
	s.lmu.Lock()
	srv := s.server
	s.listener, s.server = nil, nil
	s.lmu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

// Load lists every mount that has no manifest yet (all of them at a create), at most a few at a time.
func (s *Sandbox) Load(ctx context.Context) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, mt := range s.mounts {
		mt.mu.Lock()
		have := mt.current != nil
		mt.mu.Unlock()
		if have {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			_, _ = mt.refresh(ctx)
		}()
	}
	wg.Wait()
}

// Refresh lists the mount at path again now (every mount when path is empty), retrying a failed one.
func (s *Sandbox) Refresh(ctx context.Context, path string) error {
	found := path == ""
	var errs []error
	for _, mt := range s.mounts {
		if path != "" && mt.spec.Path != path {
			continue
		}
		found = true
		if _, err := mt.refresh(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if !found {
		return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("the sandbox has no mount at %s", path)}
	}
	return errors.Join(errs...)
}

// Sync lists the mount at path again (every mount when path is empty) unless its manifest is already from a listing
// that began at or after since, so each has everything its prefix held at since; mounts are listed a few at a time.
// Unlike Refresh, a listing that fails is an error even for a mount that carries on with an older manifest, and
// MinTTL doesn't hold a listing off. The guest is shown the manifests afterwards (GuestSpecs, then Shown).
func (s *Sandbox) Sync(ctx context.Context, path string, since time.Time) error {
	var picked []*mount
	for _, mt := range s.mounts {
		if path == "" || mt.spec.Path == path {
			picked = append(picked, mt)
		}
	}
	if path != "" && len(picked) == 0 {
		return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("the sandbox has no bucket mount at %s", path)}
	}
	errs := make([]error, len(picked))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, mt := range picked {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if err := mt.sync(ctx, since); err != nil {
				errs[i] = fmt.Errorf("%s: %w", mt.spec.Path, err)
			}
		}()
	}
	wg.Wait()
	return errors.Join(errs...)
}

// Versions are the manifest versions of the mount at path (every one when empty), by path, as they are now: what a
// Sync just made them, for Shown.
func (s *Sandbox) Versions(path string) map[string]int64 {
	out := map[string]int64{}
	for _, mt := range s.mounts {
		if path != "" && mt.spec.Path != path {
			continue
		}
		mt.mu.Lock()
		if mt.current != nil {
			out[mt.spec.Path] = mt.current.wire.Version
		}
		mt.mu.Unlock()
	}
	return out
}

// Shown checks the guest's answer to GuestSpecs after a Sync: each mount in synced (Versions, taken after the Sync)
// must show that manifest, or the host's current one should a later listing have replaced it since, with no error.
// It is an error naming each one that doesn't.
func (s *Sandbox) Shown(synced map[string]int64, results []guest.MountResult, err error) error {
	if err != nil {
		return fmt.Errorf("the sandbox couldn't take the new listings: %w", err)
	}
	byPath := map[string]guest.MountResult{}
	for _, r := range results {
		byPath[r.Path] = r
	}
	var errs []error
	for _, mt := range s.mounts {
		want, picked := synced[mt.spec.Path]
		if !picked {
			continue
		}
		mt.mu.Lock()
		now := want
		if mt.current != nil {
			now = mt.current.wire.Version
		}
		mt.mu.Unlock()
		r, ok := byPath[mt.spec.Path]
		switch {
		case !ok:
			errs = append(errs, fmt.Errorf("%s: the sandbox didn't mount it", mt.spec.Path))
		case r.Error != "":
			errs = append(errs, fmt.Errorf("%s: the sandbox couldn't mount it: %s", mt.spec.Path, r.Error))
		case r.Version != want && r.Version != now:
			errs = append(errs, fmt.Errorf("%s: the sandbox still shows an older listing", mt.spec.Path))
		}
	}
	return errors.Join(errs...)
}

// GuestSpecs are the mounts the guest should show: those with a manifest.
func (s *Sandbox) GuestSpecs() []guest.MountSpec {
	var out []guest.MountSpec
	for _, mt := range s.mounts {
		mt.mu.Lock()
		ok := mt.current != nil
		mt.mu.Unlock()
		if ok {
			out = append(out, mt.guestSpec())
		}
	}
	return out
}

// AllGuestSpecs are every mount, listed or not: for a guest that may hold mounts already (a sandbox the host
// adopted), which keeps one it holds whose listing failed rather than unmounting it.
func (s *Sandbox) AllGuestSpecs() []guest.MountSpec {
	out := make([]guest.MountSpec, 0, len(s.mounts))
	for _, mt := range s.mounts {
		out = append(out, mt.guestSpec())
	}
	return out
}

// Listed says whether every mount has a manifest.
func (s *Sandbox) Listed() bool {
	for _, mt := range s.mounts {
		mt.mu.Lock()
		ok := mt.current != nil
		mt.mu.Unlock()
		if !ok {
			return false
		}
	}
	return true
}

func (mt *mount) guestSpec() guest.MountSpec {
	return guest.MountSpec{Index: mt.index, Path: mt.spec.Path, Key: specKey(mt.spec), TTLSeconds: int(mt.ttl / time.Second)}
}

// Applied takes the guest's answer to its mounts: one it couldn't mount fails with the guest's reason.
func (s *Sandbox) Applied(results []guest.MountResult, err error) {
	byPath := map[string]guest.MountResult{}
	for _, r := range results {
		byPath[r.Path] = r
	}
	for _, mt := range s.mounts {
		mt.mu.Lock()
		if mt.current != nil {
			r, ok := byPath[mt.spec.Path]
			switch {
			case err != nil:
				mt.state, mt.err = proto.MountFailed, "the sandbox couldn't mount it: "+err.Error()
			case !ok:
				mt.state, mt.err = proto.MountFailed, "the sandbox didn't mount it"
			case r.Error != "":
				mt.state, mt.err = proto.MountFailed, "the sandbox couldn't mount it: "+r.Error
			default:
				mt.state, mt.err = proto.MountReady, ""
			}
		}
		mt.mu.Unlock()
	}
}

// Status is how each mount is doing.
func (s *Sandbox) Status() []proto.MountStatus {
	out := make([]proto.MountStatus, 0, len(s.mounts))
	for _, mt := range s.mounts {
		mt.mu.Lock()
		st := proto.MountStatus{Path: mt.spec.Path, Kind: mt.spec.Kind, State: mt.state, Error: mt.err, ListCalls: mt.lists.Load()}
		if mt.current != nil {
			st.Objects = len(mt.current.objects)
			st.Bytes = mt.current.bytes
		}
		if !mt.refreshedAt.IsZero() {
			st.RefreshedAt = mt.refreshedAt.UnixMilli()
		}
		if mt.current != nil && !mt.listedAt.IsZero() {
			st.ListedAt = mt.listedAt.UnixMilli()
		}
		mt.mu.Unlock()
		out = append(out, st)
	}
	return out
}

// refresh lists the mount's prefix and keeps the manifest: once, whoever else asks meanwhile, and at most once per
// MinTTL whoever asks (a create, a refresh from Kantel or the guest, a TTL check, a guest asking for a manifest the
// host hasn't got), failed listings included, since each costs list calls on the account's bucket. Within MinTTL of
// the last listing it answers that listing's outcome. listed says whether this call listed.
func (mt *mount) refresh(ctx context.Context) (listed bool, err error) {
	mt.mu.Lock()
	if ch := mt.listing; ch != nil {
		mt.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return false, ctx.Err()
		}
		mt.mu.Lock()
		defer mt.mu.Unlock()
		return false, mt.outcome()
	}
	now := mt.s.m.now()
	if !mt.attemptedAt.IsZero() && now.Sub(mt.attemptedAt) < MinTTL {
		defer mt.mu.Unlock()
		return false, mt.outcome()
	}
	return true, mt.listLocked(ctx, now)
}

// sync makes the mount's manifest one whose listing began at or after since, so it has everything the bucket had
// then (Sync): a listing already under way that began before since is waited for and then listed again, one that
// began since is shared, and MinTTL doesn't hold it off, since the caller is waiting for exactly this. A failed
// listing is an error even when the mount has an older manifest to carry on with.
func (mt *mount) sync(ctx context.Context, since time.Time) error {
	for {
		mt.mu.Lock()
		if mt.current != nil && !mt.listedAt.Before(since) {
			mt.mu.Unlock()
			return nil
		}
		ch := mt.listing
		if ch == nil {
			// Ours: it begins now, after since.
			if err := mt.listLocked(ctx, mt.s.m.now()); err != nil {
				return err
			}
			continue
		}
		began := mt.attemptedAt
		mt.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
		if !began.Before(since) {
			mt.mu.Lock()
			err := mt.listErr
			mt.mu.Unlock()
			if err != nil {
				return err
			}
		}
	}
}

// listLocked lists the prefix, beginning at began, and keeps the manifest. Called with mt.mu held, which it lets go
// of while it lists and has let go of when it returns.
func (mt *mount) listLocked(ctx context.Context, began time.Time) error {
	mt.attemptedAt = began
	ch := make(chan struct{})
	mt.listing = ch
	mt.mu.Unlock()
	man, err := mt.list(ctx)
	mt.mu.Lock()
	defer mt.mu.Unlock()
	mt.listing = nil
	mt.listErr = err
	close(ch)
	if err != nil {
		if mt.current == nil {
			mt.state, mt.err = proto.MountFailed, err.Error()
		}
		// With a manifest already, the mount carries on with it: a failed refresh is in the log.
		mt.s.m.log.Warn("bucket mount listing failed", "sandbox", mt.s.id, "path", mt.spec.Path, "error", err)
		return err
	}
	if mt.current == nil || mt.current.wire.Version != man.wire.Version {
		mt.current = man
	}
	mt.listedAt = began
	mt.refreshedAt = mt.s.m.now()
	if mt.state == proto.MountFailed {
		// Listed at last; the guest mounts it next (Applied says how that went).
		mt.state, mt.err = proto.MountPending, ""
	}
	return nil
}

// outcome is the last listing's: its error while the mount has no manifest. Called with mt.mu held.
func (mt *mount) outcome() error {
	if mt.current == nil && mt.err != "" {
		return errors.New(mt.err)
	}
	return nil
}

func (mt *mount) list(ctx context.Context) (*manifest, error) {
	if mt.spec.Kind != proto.MountBucket {
		return nil, errors.New("not a bucket mount")
	}
	ctx, cancel := context.WithTimeout(ctx, ListTimeout)
	defer cancel()
	src, err := mt.s.m.client(ctx, mt.s.id, mt.spec.BucketSourceID, false)
	if err != nil {
		return nil, err
	}
	objs, pages, err := src.client.List(ctx, mt.prefix, mt.s.m.cfg.MaxObjects)
	mt.lists.Add(int64(pages))
	if errors.Is(err, bucket.ErrDenied) {
		// Credentials rotated since: ask again, once.
		if src, err = mt.s.m.client(ctx, mt.s.id, mt.spec.BucketSourceID, true); err != nil {
			return nil, err
		}
		objs, pages, err = src.client.List(ctx, mt.prefix, mt.s.m.cfg.MaxObjects)
		mt.lists.Add(int64(pages))
	}
	if err != nil {
		return nil, err
	}
	// Each object a file, in a directory of its own at most: twice the objects.
	return buildManifest(objs, mt.prefix, mt.proof, 2*mt.s.m.cfg.MaxObjects)
}

// manifestFor is the manifest the guest asks for, listing first when there is none (a host restart) or when it is
// older than the TTL (the guest's TTL check, which runs beside its file system: it gets the new listing now, not a
// TTL later; a failed listing answers the manifest the mount has).
func (mt *mount) manifestFor(ctx context.Context) (*manifest, error) {
	mt.mu.Lock()
	cur, at := mt.current, mt.refreshedAt
	mt.mu.Unlock()
	if cur == nil {
		if _, err := mt.refresh(ctx); err != nil {
			return nil, err
		}
		mt.mu.Lock()
		cur = mt.current
		mt.mu.Unlock()
		if cur == nil {
			return nil, errors.New("the mount has no listing yet")
		}
		return cur, nil
	}
	if mt.ttl > 0 && mt.s.m.now().Sub(at) > mt.ttl {
		if listed, _ := mt.refresh(ctx); listed {
			// Not waited for, as serveRefresh's.
			go mt.s.m.changed(mt.s.id)
		}
		mt.mu.Lock()
		cur = mt.current
		mt.mu.Unlock()
	}
	return cur, nil
}

// object finds the object version the guest names: in the current manifest, or by its proof (an older version).
// A proven version needs no listing: with none yet (a host restart), it reads from the cache or the store all the
// same.
func (mt *mount) object(ctx context.Context, path, tag, size, proof string) (object, bool, error) {
	mt.mu.Lock()
	cur := mt.current
	mt.mu.Unlock()
	if cur == nil {
		if o, ok := mt.proven(path, tag, size, proof); ok {
			return o, true, nil
		}
		var err error
		if cur, err = mt.manifestFor(ctx); err != nil {
			return object{}, false, err
		}
	}
	if o, ok := cur.objects[path]; ok && o.tag == tag {
		return o, true, nil
	}
	o, ok := mt.proven(path, tag, size, proof)
	return o, ok, nil
}

func (s *Sandbox) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mounts/{index}/manifest", s.serveManifest)
	mux.HandleFunc("POST /mounts/{index}/refresh", s.serveRefresh)
	mux.HandleFunc("GET /mounts/{index}/object", s.serveObject)
	return mux
}

func (s *Sandbox) mountOf(w http.ResponseWriter, r *http.Request) *mount {
	i, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || i < 0 || i >= len(s.mounts) {
		http.Error(w, "no such mount", http.StatusNotFound)
		return nil
	}
	return s.mounts[i]
}

func writeManifest(w http.ResponseWriter, r *http.Request, man *manifest) {
	if have := r.URL.Query().Get("have"); have != "" && have == strconv.FormatInt(man.wire.Version, 10) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("content-length", strconv.Itoa(len(man.encoded)))
	_, _ = w.Write(man.encoded)
}

func (s *Sandbox) serveManifest(w http.ResponseWriter, r *http.Request) {
	mt := s.mountOf(w, r)
	if mt == nil {
		return
	}
	man, err := mt.manifestFor(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeManifest(w, r, man)
}

func (s *Sandbox) serveRefresh(w http.ResponseWriter, r *http.Request) {
	mt := s.mountOf(w, r)
	if mt == nil {
		return
	}
	// The guest asks for these as often as it likes, and each costs list calls on the account's bucket: one within
	// MinTTL of the last listing gets that listing (refresh).
	listed, err := mt.refresh(r.Context())
	if listed {
		// Not waited for: the status goes out through the tier, which takes the sandbox's lock, and a host call holding
		// that lock (a refresh from Kantel, adoption's reconcile) may be waiting on this guest's manifest update, which
		// waits on this answer.
		go s.m.changed(s.id)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	mt.mu.Lock()
	man := mt.current
	mt.mu.Unlock()
	if man == nil {
		http.Error(w, "the mount has no listing yet", http.StatusBadGateway)
		return
	}
	writeManifest(w, r, man)
}

// parseRange reads "bytes=a-b" (one range, both ends given), the only form the guest sends.
func parseRange(h string, size int64) (int64, int64, bool) {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok {
		return 0, 0, false
	}
	a, b, ok := strings.Cut(spec, "-")
	if !ok {
		return 0, 0, false
	}
	start, err1 := strconv.ParseInt(a, 10, 64)
	end, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil || start < 0 || end < start {
		return 0, 0, false
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true
}

func (s *Sandbox) serveObject(w http.ResponseWriter, r *http.Request) {
	mt := s.mountOf(w, r)
	if mt == nil {
		return
	}
	q := r.URL.Query()
	obj, ok, err := mt.object(r.Context(), q.Get("path"), q.Get("tag"), q.Get("size"), q.Get("k"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if !ok {
		// Not in the current manifest, and no proof of a version the guest was shown: something it was never shown.
		http.Error(w, "no such object in the mount's manifest", http.StatusGone)
		return
	}
	start, end := int64(0), obj.size-1
	if h := r.Header.Get("Range"); h != "" {
		var ok bool
		if start, end, ok = parseRange(h, obj.size); !ok {
			http.Error(w, "bad range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
	}
	if obj.size == 0 || start >= obj.size {
		w.Header().Set("content-length", "0")
		w.WriteHeader(http.StatusOK)
		return
	}
	src, err := s.m.client(r.Context(), s.id, mt.spec.BucketSourceID, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	cache := s.m.cfg.Cache
	id := ObjectID(src.src.Endpoint+"|"+src.src.Provider, src.src.Bucket, obj.key, obj.tag, principal(src.src))
	w.Header().Set("content-length", strconv.FormatInt(end-start+1, 10))
	w.Header().Set("content-type", "application/octet-stream")
	wrote := false
	rc := http.NewResponseController(w)
	for chunk := start / ChunkSize; chunk <= end/ChunkSize; chunk++ {
		// Held while the chunk is fetched and sent: the host's open chunks are bounded, and a guest that stops reading
		// gives its chunk up after ChunkWriteTimeout.
		release, err := s.slot(r.Context(), true)
		if err != nil {
			if !wrote {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
			}
			return
		}
		f, err := cache.Chunk(r.Context(), id, chunk, mt.getChunk(src, obj, chunk))
		if err != nil {
			release()
			if !wrote {
				code := http.StatusBadGateway
				if errors.Is(err, bucket.ErrStale) {
					code = http.StatusGone
				}
				http.Error(w, err.Error(), code)
			}
			return
		}
		lo := max(start, chunk*ChunkSize) - chunk*ChunkSize
		hi := min(end, (chunk+1)*ChunkSize-1) - chunk*ChunkSize
		_ = rc.SetWriteDeadline(time.Now().Add(s.m.writeTimeout))
		if !wrote {
			w.WriteHeader(http.StatusOK)
			wrote = true
		}
		_, err = io.Copy(w, io.NewSectionReader(f, lo, hi-lo+1))
		if err == nil {
			err = rc.Flush()
		}
		f.Close()
		release()
		if err != nil {
			return
		}
		// Read ahead: a read into the second half of a chunk fetches the next one, so a file read from start to end
		// waits for the store only once.
		// Only with a chunk free: read-ahead never waits for one, nor takes one beyond the bounds.
		if next := chunk + 1; hi >= ChunkSize/2 && next*ChunkSize < obj.size && chunk == end/ChunkSize && !cache.Cached(id, next) {
			if release, err := s.slot(r.Context(), false); err == nil {
				go func() {
					defer release()
					ctx, cancel := context.WithTimeout(context.Background(), FetchTimeout)
					defer cancel()
					if f, err := cache.Chunk(ctx, id, next, mt.getChunk(src, obj, next)); err == nil {
						f.Close()
					}
				}()
			}
		}
	}
}

// getChunk fetches one chunk of an object from the store.
func (mt *mount) getChunk(src *source, obj object, chunk int64) func(ctx context.Context) (io.ReadCloser, error) {
	return func(ctx context.Context) (io.ReadCloser, error) {
		off := chunk * ChunkSize
		n := min(ChunkSize, obj.size-off)
		body, err := src.client.Get(ctx, obj.key, obj.etag, off, n)
		if errors.Is(err, bucket.ErrDenied) {
			fresh, ferr := mt.s.m.client(ctx, mt.s.id, mt.spec.BucketSourceID, true)
			if ferr != nil {
				return nil, err
			}
			body, err = fresh.client.Get(ctx, obj.key, obj.etag, off, n)
		}
		if err != nil {
			return nil, err
		}
		return &exactReader{ReadCloser: body, left: n}, nil
	}
}

// exactReader fails a body that ends before its chunk does (a connection cut short), so the cache never keeps a
// short chunk as a whole one; and stops at the chunk's end.
type exactReader struct {
	io.ReadCloser
	left int64
}

func (r *exactReader) Read(p []byte) (int, error) {
	if r.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > r.left {
		p = p[:r.left]
	}
	n, err := r.ReadCloser.Read(p)
	r.left -= int64(n)
	if err == io.EOF && r.left > 0 {
		return n, io.ErrUnexpectedEOF
	}
	if r.left == 0 && err == nil {
		return n, io.EOF
	}
	return n, err
}
