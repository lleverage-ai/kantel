package mounts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestManifest(t *testing.T) {
	at := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	objs := []bucket.Object{
		{Key: "org/42/a.txt", Size: 3, ETag: "e1", LastModified: at},
		{Key: "org/42/dir/b.txt", Size: 5, ETag: "e2"},
		{Key: "org/42/folder/", Size: 0},                   // a "folder" object: an empty directory
		{Key: "org/42/x", Size: 1, ETag: "e3"},             // a file where a directory is: the directory wins
		{Key: "org/42/x/y", Size: 2, ETag: "e4"},           //
		{Key: "org/42/bad//name", Size: 1},                 // an empty segment
		{Key: "org/42/../escape", Size: 1},                 // a dot segment
		{Key: "org/43/other", Size: 1, ETag: "e5"},         // outside the prefix
		{Key: "org/42/" + strings.Repeat("n", 256)},        // a name too long
		{Key: "org/42/" + strings.Repeat("a/", 600) + "f"}, // a key longer than a store allows
	}
	build := func(objs []bucket.Object, prefix string) *manifest {
		t.Helper()
		m, err := buildManifest(objs, prefix, nil, 100)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := build(objs, normalPrefix("/org/42"))
	var paths []string
	for _, e := range m.wire.Entries {
		if e.Dir {
			paths = append(paths, e.Path+"/")
		} else {
			paths = append(paths, e.Path)
		}
	}
	want := "a.txt dir/ dir/b.txt folder/ x/ x/y"
	if got := strings.Join(paths, " "); got != want {
		t.Fatalf("entries %q, want %q", got, want)
	}
	if m.skipped != 6 || m.bytes != 10 || m.objects["a.txt"].key != "org/42/a.txt" || m.objects["a.txt"].tag != "ee1" {
		t.Errorf("skipped %d, bytes %d, a.txt %+v", m.skipped, m.bytes, m.objects["a.txt"])
	}
	if m.wire.Entries[0].MTimeMs != at.UnixMilli() {
		t.Errorf("mtime %d", m.wire.Entries[0].MTimeMs)
	}
	// The same listing in another order is the same manifest; a changed object is another.
	rev := append([]bucket.Object{}, objs...)
	sort.Slice(rev, func(i, j int) bool { return rev[i].Key > rev[j].Key })
	if again := build(rev, "org/42/"); again.wire.Version != m.wire.Version || m.wire.Version <= 0 {
		t.Errorf("versions %d and %d", m.wire.Version, again.wire.Version)
	}
	objs[0].ETag = "changed"
	if changed := build(objs, "org/42/"); changed.wire.Version == m.wire.Version {
		t.Error("a changed object kept the version")
	}
	if e := build(nil, ""); len(e.wire.Entries) != 0 || !bytes.Contains(e.encoded, []byte(`"entries":[]`)) {
		t.Errorf("an empty prefix: %s", e.encoded)
	}
}

// A listing within its object limit that would expand into a huge tree (deep keys whose directories multiply) is
// refused before the tree is built further or encoded.
func TestManifestTreeIsBounded(t *testing.T) {
	// One key at the store's limit, all directories: 512 entries.
	deep := []bucket.Object{{Key: strings.Repeat("a/", 511) + "f", Size: 1, ETag: "e"}}
	if m, err := buildManifest(deep, "", nil, 1000); err != nil || len(m.wire.Entries) != 512 {
		t.Fatalf("one deep key: %v", err)
	}
	// A few hundred such keys, each in its own tree: within the objects allowed, far beyond the entries.
	var many []bucket.Object
	for i := range 300 {
		many = append(many, bucket.Object{Key: fmt.Sprintf("%03d/", i) + strings.Repeat("a/", 509) + "f", Size: 1, ETag: "e"})
	}
	if _, err := buildManifest(many, "", nil, 2*1000); !errors.Is(err, errTooBig) {
		t.Fatalf("300 deep keys: %v", err)
	}
	// Within the entries, beyond the names' bytes.
	if _, err := buildManifest(many, "", nil, 0); !errors.Is(err, errTooBig) {
		t.Fatalf("300 deep keys, no entry limit: %v", err)
	}
	// Folder objects count the same.
	var folders []bucket.Object
	for i := range 50 {
		folders = append(folders, bucket.Object{Key: fmt.Sprintf("d%d/", i)})
	}
	if _, err := buildManifest(folders, "", nil, 40); !errors.Is(err, errTooBig) {
		t.Fatalf("50 folders, 40 entries: %v", err)
	}
}

func TestValidate(t *testing.T) {
	zero, day, neg := 0, 86400, -1
	ok := []proto.Mount{
		{Path: "/mnt/a", Kind: "bucket", BucketSourceID: "bks_1"},
		{Path: "/mnt/ab", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p/", RefreshTTLSeconds: &zero},
		{Path: "/var/data", Kind: "bucket", BucketSourceID: "bks_1", RefreshTTLSeconds: &day},
		// Bundles and buckets in one list.
		{Path: "/workspace/skills", Kind: "bundle", Digest: "sha256:" + strings.Repeat("a", 64)},
	}
	if err := Validate(ok); err != nil {
		t.Fatal(err)
	}
	bundle := proto.Mount{Path: "/mnt/a/b", Kind: "bundle", Digest: "sha256:" + strings.Repeat("b", 64)}
	for name, mounts := range map[string][]proto.Mount{
		"overlap":       {{Path: "/mnt/a", Kind: "bucket", BucketSourceID: "b"}, {Path: "/mnt/a/b", Kind: "bucket", BucketSourceID: "b"}},
		"same":          {{Path: "/mnt/a", Kind: "bucket", BucketSourceID: "b"}, {Path: "/mnt/a", Kind: "bucket", BucketSourceID: "b"}},
		"system":        {{Path: "/usr/local/x", Kind: "bucket", BucketSourceID: "b"}},
		"var/run":       {{Path: "/var/run/x", Kind: "bucket", BucketSourceID: "b"}},
		"root":          {{Path: "/", Kind: "bucket", BucketSourceID: "b"}},
		"relative":      {{Path: "mnt/a", Kind: "bucket", BucketSourceID: "b"}},
		"unclean":       {{Path: "/mnt/../etc", Kind: "bucket", BucketSourceID: "b"}},
		"no source":     {{Path: "/mnt/a", Kind: "bucket"}},
		"negative ttl":  {{Path: "/mnt/a", Kind: "bucket", BucketSourceID: "b", RefreshTTLSeconds: &neg}},
		"unknown kind":  {{Path: "/mnt/a", Kind: "nfs"}},
		"no digest":     {{Path: "/mnt/a", Kind: "bundle"}},
		"bad digest":    {{Path: "/mnt/a", Kind: "bundle", Digest: "sha256:abc"}},
		"bundle path":   {{Path: "/etc/skills", Kind: "bundle", Digest: bundle.Digest}},
		"kinds overlap": {{Path: "/mnt/a", Kind: "bucket", BucketSourceID: "b"}, bundle},
		"too many": func() []proto.Mount {
			var ms []proto.Mount
			for i := range MaxMounts + 1 {
				ms = append(ms, proto.Mount{Path: fmt.Sprintf("/mnt/%d", i), Kind: "bucket", BucketSourceID: "b"})
			}
			return ms
		}(),
	} {
		if err := Validate(mounts); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestCacheFetchesOnceAndEvicts(t *testing.T) {
	dir := t.TempDir()
	c, err := OpenCache(dir, 3*ChunkSize)
	if err != nil {
		t.Fatal(err)
	}
	var gets atomic.Int64
	get := func(b byte) func(context.Context) (io.ReadCloser, error) {
		return func(context.Context) (io.ReadCloser, error) {
			gets.Add(1)
			time.Sleep(20 * time.Millisecond)
			return io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{b}, int(ChunkSize)))), nil
		}
	}
	ctx := context.Background()
	// Ten sandboxes ask for one chunk at once: one fetch.
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f, err := c.Chunk(ctx, "obj", 0, get('a'))
			if err != nil {
				t.Error(err)
				return
			}
			f.Close()
		}()
	}
	wg.Wait()
	if gets.Load() != 1 || c.Hits.Load() != 9 || c.Misses.Load() != 1 {
		t.Fatalf("%d fetches, %d hits, %d misses", gets.Load(), c.Hits.Load(), c.Misses.Load())
	}
	// Three more chunks: the least recently used (obj-0) goes, and the cache stays within its size.
	for i := 1; i <= 3; i++ {
		f, err := c.Chunk(ctx, "obj", int64(i), get(byte('a'+i)))
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	if c.Cached("obj", 0) || !c.Cached("obj", 3) || c.Used() > 3*ChunkSize {
		t.Errorf("after eviction: chunk 0 cached %v, used %d", c.Cached("obj", 0), c.Used())
	}
	// An open chunk survives its eviction: the reader keeps its bytes.
	f, _ := c.Chunk(ctx, "obj", 1, get('x'))
	for i := 4; i <= 6; i++ {
		g, _ := c.Chunk(ctx, "obj", int64(i), get('y'))
		g.Close()
	}
	buf := make([]byte, 4)
	if _, err := f.ReadAt(buf, 100); err != nil || string(buf) != "bbbb" {
		t.Errorf("an evicted open chunk: %q %v", buf, err)
	}
	f.Close()
	// A failed fetch keeps nothing, and the next ask tries again.
	boom := errors.New("store down")
	if _, err := c.Chunk(ctx, "bad", 0, func(context.Context) (io.ReadCloser, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Errorf("failed fetch: %v", err)
	}
	if c.Cached("bad", 0) {
		t.Error("a failed fetch was kept")
	}
	// A restart keeps what the cache held.
	again, err := OpenCache(dir, 3*ChunkSize)
	if err != nil {
		t.Fatal(err)
	}
	if again.Used() != c.Used() || !again.Cached("obj", 6) {
		t.Errorf("reopened: used %d (was %d)", again.Used(), c.Used())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) == 0 {
		t.Error("nothing on disk")
	}
}

func TestShortChunkIsNotKept(t *testing.T) {
	r := &exactReader{ReadCloser: io.NopCloser(strings.NewReader("abc")), left: 5}
	if _, err := io.ReadAll(r); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("short body: %v", err)
	}
	r = &exactReader{ReadCloser: io.NopCloser(strings.NewReader("abcdefgh")), left: 5}
	if got, err := io.ReadAll(r); err != nil || string(got) != "abcde" {
		t.Errorf("long body: %q %v", got, err)
	}
}

// fakeS3 lists and serves objects path-style, counting list calls.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string]string
	lists   atomic.Int64
	gets    atomic.Int64
	// ignoreRange answers a read with the whole object (200), as a store or proxy that drops Range does.
	ignoreRange bool
	// refuseList answers listings 503 (a store outage, or a prefix grown past the limit).
	refuseList atomic.Bool
	// denyList answers listings 403, as a store does once the credentials are revoked.
	denyList atomic.Bool
	// beforeList, when set, runs before a listing is answered, without the store's lock (so a test can hold one).
	beforeList func()
}

func (s *fakeS3) put(k, v string) {
	s.mu.Lock()
	s.objects[k] = v
	s.mu.Unlock()
}

func etag(v string) string { return strconv.Itoa(len(v)) + "-" + strconv.Itoa(int(v[0])) }

func (s *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f := s.beforeList; f != nil && r.URL.Query().Get("list-type") == "2" {
		f()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.URL.Query().Get("list-type") == "2" {
		s.lists.Add(1)
		if s.refuseList.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if s.denyList.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		fmt.Fprint(w, "<ListBucketResult><IsTruncated>false</IsTruncated>")
		for k, v := range s.objects {
			if strings.HasPrefix(k, r.URL.Query().Get("prefix")) {
				fmt.Fprintf(w, "<Contents><Key>%s</Key><Size>%d</Size><ETag>&quot;%s&quot;</ETag></Contents>", k, len(v), etag(v))
			}
		}
		fmt.Fprint(w, "</ListBucketResult>")
		return
	}
	s.gets.Add(1)
	v, ok := s.objects[strings.TrimPrefix(r.URL.Path, "/b/")]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if m := r.Header.Get("If-Match"); m != "" && m != `"`+etag(v)+`"` {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if s.ignoreRange {
		io.WriteString(w, v)
		return
	}
	var from, to int
	fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &from, &to)
	to = min(to, len(v)-1)
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(v)))
	w.WriteHeader(http.StatusPartialContent)
	io.WriteString(w, v[from:to+1])
}

// The host's side end to end, without a VM: two sandboxes mount one prefix; the guest's requests are made directly.
func TestSandboxesShareTheCache(t *testing.T) {
	store := &fakeS3{objects: map[string]string{"p/a.txt": "hello", "p/d/b.txt": strings.Repeat("x", 100), "q/secret": "no"}}
	srv := httptest.NewServer(store)
	defer srv.Close()
	cache, _ := OpenCache(t.TempDir(), 1<<30)
	var resolves atomic.Int64
	m := New(Config{Cache: cache, HTTP: srv.Client(), Resolve: func(_ context.Context, sandboxID, sourceID string) (proto.BucketSource, error) {
		resolves.Add(1)
		if sourceID != "bks_1" {
			return proto.BucketSource{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such source"}
		}
		return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: srv.URL, Credentials: &proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s"}}, nil
	}})
	// The listings' clock: later moves it on.
	var skew atomic.Int64
	m.now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	later := func() { skew.Add(int64(MinTTL)) }
	spec := []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}}
	ctx := context.Background()
	open := func(id string) (*Sandbox, http.Handler) {
		s := m.Sandbox(id, spec)
		s.Load(ctx)
		s.Applied([]guest.MountResult{{Path: "/mnt/p"}}, nil)
		return s, s.handler()
	}
	do := func(h http.Handler, method, target, rng string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	a, ha := open("sbx_a")
	if st := a.Status(); st[0].State != proto.MountReady || st[0].Objects != 2 || st[0].ListCalls != 1 {
		t.Fatalf("status %+v", st)
	}
	var man guest.Manifest
	if err := json.Unmarshal(do(ha, "GET", "/mounts/0/manifest", "").Body.Bytes(), &man); err != nil || len(man.Entries) != 3 {
		t.Fatalf("manifest %+v %v", man, err)
	}
	shown := map[string]guest.ManifestEntry{}
	for _, e := range man.Entries {
		shown[e.Path] = e
		if !e.Dir && e.Proof == "" {
			t.Errorf("%s has no proof", e.Path)
		}
	}
	tag := shown["a.txt"].Tag
	read := func(h http.Handler, p, tag, rng string) *httptest.ResponseRecorder {
		return do(h, "GET", "/mounts/0/object?path="+p+"&tag="+tag, rng)
	}
	// As the guest reads a file it opened: its entry's tag, size and proof.
	readOpen := func(h http.Handler, e guest.ManifestEntry, rng string) *httptest.ResponseRecorder {
		return do(h, "GET", fmt.Sprintf("/mounts/0/object?path=%s&tag=%s&size=%d&k=%s", url.QueryEscape(e.Path), url.QueryEscape(e.Tag), e.Size, url.QueryEscape(e.Proof)), rng)
	}
	if rec := read(ha, "a.txt", tag, "bytes=1-3"); rec.Code != 200 || rec.Body.String() != "ell" {
		t.Fatalf("A's read: %d %q", rec.Code, rec.Body.String())
	}
	_, hb := open("sbx_b")
	if rec := read(hb, "a.txt", tag, "bytes=0-99"); rec.Body.String() != "hello" {
		t.Fatalf("B's read: %q", rec.Body.String())
	}
	if store.gets.Load() != 1 || cache.Hits.Load() != 1 {
		t.Errorf("store GETs %d, cache hits %d (want B served from the cache)", store.gets.Load(), cache.Hits.Load())
	}
	if rec := read(ha, "../q/secret", "x", "bytes=0-9"); rec.Code == 200 {
		t.Errorf("a path outside the manifest was served: %q", rec.Body.String())
	}
	if rec := do(ha, "GET", "/mounts/7/manifest", ""); rec.Code != http.StatusNotFound {
		t.Errorf("another mount index: %d", rec.Code)
	}
	// The bucket changes; a refresh within MinTTL of the last listing lists nothing, whoever asks (the guest or
	// Kantel); one after it does.
	store.put("p/a.txt", "hello again")
	store.put("p/new.txt", "new")
	lists := store.lists.Load()
	do(ha, "POST", "/mounts/0/refresh", "")
	if err := a.Refresh(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if store.lists.Load() != lists {
		t.Errorf("a refresh right after a listing listed again")
	}
	later()
	if err := a.Refresh(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if st := a.Status(); st[0].Objects != 3 || st[0].ListCalls != 2 {
		t.Errorf("after the refresh: %+v", st)
	}
	// The old version: still served from the cache to a file opened before the refresh, by its proof (the current
	// manifest hasn't got it); without one, not.
	if rec := readOpen(ha, shown["a.txt"], "bytes=0-4"); rec.Body.String() != "hello" {
		t.Errorf("the previous version: %d %q", rec.Code, rec.Body.String())
	}
	if rec := read(ha, "a.txt", tag, "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("an old version with no proof: %d", rec.Code)
	}
	// Changed and listed again and again, every object replaced (the host keeps no old listings): a file opened before
	// all of it still reads its version; a new open (the newest manifest) reads the newest.
	for i := range 5 {
		later()
		store.put("p/a.txt", fmt.Sprintf("hello, take %d", i+3))
		store.put("p/new.txt", fmt.Sprintf("new %d", i))
		if err := a.Refresh(ctx, ""); err != nil {
			t.Fatal(err)
		}
	}
	if st := a.Status(); st[0].ListCalls != 7 {
		t.Errorf("after the refreshes: %+v", st)
	}
	if rec := readOpen(ha, shown["a.txt"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "hello" {
		t.Errorf("the version from six refreshes ago: %d %q", rec.Code, rec.Body.String())
	}
	var newest guest.Manifest
	_ = json.Unmarshal(do(ha, "GET", "/mounts/0/manifest", "").Body.Bytes(), &newest)
	for _, e := range newest.Entries {
		if e.Path == "a.txt" {
			if rec := readOpen(ha, e, "bytes=0-99"); rec.Body.String() != "hello, take 7" {
				t.Errorf("a new open: %q", rec.Body.String())
			}
		}
	}
	// An old version never read, which the store no longer has: stale, never the new bytes.
	store.put("p/d/b.txt", strings.Repeat("y", 101))
	later()
	_ = a.Refresh(ctx, "")
	if rec := readOpen(ha, shown["d/b.txt"], "bytes=10-19"); rec.Code != http.StatusGone {
		t.Errorf("an old version the store no longer has: %d %q", rec.Code, rec.Body.String())
	}
	// A proof is of one version: not another path, size or tag, and not made up.
	forged := shown["a.txt"]
	forged.Path = "d/b.txt"
	if rec := readOpen(ha, forged, "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("a proof for another path: %d", rec.Code)
	}
	forged = shown["a.txt"]
	forged.Size = 1 << 20
	if rec := readOpen(ha, forged, "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("a proof with another size: %d", rec.Code)
	}
	forged = shown["a.txt"]
	forged.Proof = "AAAAAAAAAAAAAAAAAAAAAA"
	if rec := readOpen(ha, forged, "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("a made-up proof: %d", rec.Code)
	}
	// Another host (another key) doesn't take this one's proofs.
	other := New(Config{Cache: cache, HTTP: srv.Client(), Resolve: m.cfg.Resolve})
	sa := other.Sandbox("sbx_a", spec)
	sa.Load(ctx)
	if rec := readOpen(sa.handler(), shown["a.txt"], "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("another key's proof: %d", rec.Code)
	}
	// A version the mount never listed isn't served.
	if rec := read(ha, "new.txt", "not-a-tag", "bytes=0-2"); rec.Code != http.StatusGone {
		t.Errorf("a version the mount never had: %d", rec.Code)
	}
	if err := a.Refresh(ctx, "/nope"); err == nil {
		t.Error("refreshing a path with no mount: no error")
	}
	// A source Kantel won't give fails the mount and says why.
	c := m.Sandbox("sbx_c", []proto.Mount{{Path: "/mnt/x", Kind: "bucket", BucketSourceID: "bks_none"}})
	c.Load(ctx)
	c.Applied(nil, nil)
	if st := c.Status(); st[0].State != proto.MountFailed || !strings.Contains(st[0].Error, "no such source") {
		t.Errorf("a missing source: %+v", st)
	}
	// A failed listing counts towards the limit too: asked again at once, by Kantel or the guest, it isn't tried
	// again; after MinTTL it is.
	asked := resolves.Load()
	if err := c.Refresh(ctx, ""); err == nil || !strings.Contains(err.Error(), "no such source") {
		t.Errorf("a refresh of a failed mount within MinTTL: %v", err)
	}
	if rec := do(c.handler(), "GET", "/mounts/0/manifest", ""); rec.Code != http.StatusBadGateway {
		t.Errorf("the guest's manifest of a failed mount: %d", rec.Code)
	}
	if resolves.Load() != asked {
		t.Errorf("a failed mount was tried again within MinTTL (%d more)", resolves.Load()-asked)
	}
	later()
	_ = c.Refresh(ctx, "")
	if resolves.Load() != asked+1 {
		t.Errorf("a failed mount wasn't tried again after MinTTL")
	}
	if len(c.GuestSpecs()) != 0 {
		t.Error("a failed mount is sent to the guest")
	}
	// To a guest that may hold it already (an adopted sandbox), it is, so the guest keeps it; and it isn't listed.
	if len(c.AllGuestSpecs()) != 1 || c.Listed() || !a.Listed() {
		t.Errorf("all specs %d, listed %v (A %v)", len(c.AllGuestSpecs()), c.Listed(), a.Listed())
	}
	m.Forget("sbx_a")
	if m.Get("sbx_a") != nil {
		t.Error("forgotten sandbox still held")
	}
}

// A store (or a proxy) that ignores Range: a chunk after the first is refused, never cached as the whole object's
// first bytes.
func TestIgnoredRangeIsNotCached(t *testing.T) {
	big := strings.Repeat("a", int(ChunkSize)) + "0123456789"
	store := &fakeS3{objects: map[string]string{"p/big": big}, ignoreRange: true}
	srv := httptest.NewServer(store)
	defer srv.Close()
	cache, _ := OpenCache(t.TempDir(), 1<<30)
	m := New(Config{Cache: cache, HTTP: srv.Client(), Resolve: func(context.Context, string, string) (proto.BucketSource, error) {
		return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: srv.URL, Credentials: &proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s"}}, nil
	}})
	s := m.Sandbox("sbx_r", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	s.Load(context.Background())
	var tag string
	for _, o := range s.mounts[0].current.objects {
		tag = o.tag
	}
	read := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/mounts/0/object?path=big&tag="+tag, nil)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", ChunkSize, ChunkSize+9))
		rec := httptest.NewRecorder()
		s.handler().ServeHTTP(rec, req)
		return rec
	}
	if rec := read(); rec.Code == http.StatusOK {
		t.Fatalf("a chunk from a store that ignored the range was served: %q", rec.Body.String()[:10])
	}
	store.mu.Lock()
	store.ignoreRange = false
	store.mu.Unlock()
	if rec := read(); rec.Code != http.StatusOK || rec.Body.String() != "0123456789" {
		t.Errorf("the chunk once the store answers ranges: %d %q (a wrong chunk was cached?)", rec.Code, rec.Body.String())
	}
}

func TestPrincipalNeverTheSecret(t *testing.T) {
	src := proto.BucketSource{Credentials: &proto.BucketCredentials{AccessKeyID: "AKID", SecretAccessKey: "s3cr3t"}}
	p := principal(src)
	if !strings.HasPrefix(p, "key:AKID:") || strings.Contains(p, "s3cr3t") {
		t.Errorf("principal %q", p)
	}
	// The whole credential: the same one is the same principal (on any host, after a restart); another secret or
	// session token under the same key ID isn't.
	if principal(proto.BucketSource{Credentials: &proto.BucketCredentials{AccessKeyID: "AKID", SecretAccessKey: "s3cr3t"}}) != p {
		t.Error("the same credential, another principal")
	}
	for _, other := range []proto.BucketCredentials{{AccessKeyID: "AKID", SecretAccessKey: "guess"}, {AccessKeyID: "AKID", SecretAccessKey: "s3cr3t", SessionToken: "tok"}} {
		if principal(proto.BucketSource{Credentials: &other}) == p {
			t.Errorf("%+v shares the principal", other)
		}
	}
	sa := proto.BucketSource{Credentials: &proto.BucketCredentials{ServiceAccountKey: `{"private_key":"PEM"}`}}
	if p := principal(sa); strings.Contains(p, "PEM") || !strings.HasPrefix(p, "sa:") {
		t.Errorf("principal %q", p)
	}
	if principal(proto.BucketSource{}) != "" {
		t.Error("a public bucket has a principal")
	}
}

// The guest's refresh is answered without waiting for the status to go out: that goes through the tier, which takes
// the sandbox's lock, and a host call holding it (Kantel's refresh, adoption's reconcile) may be waiting on this
// guest's manifest update, which waits on this answer.
func TestGuestRefreshDoesntWaitForTheStatus(t *testing.T) {
	store := &fakeS3{objects: map[string]string{"p/a.txt": "hello"}}
	srv := httptest.NewServer(store)
	defer srv.Close()
	cache, _ := OpenCache(t.TempDir(), 1<<30)
	var sandboxLock sync.Mutex
	changed := make(chan string, 4)
	m := New(Config{Cache: cache, HTTP: srv.Client(),
		Resolve: func(context.Context, string, string) (proto.BucketSource, error) {
			return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: srv.URL, Credentials: &proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s"}}, nil
		},
		// As the tier's Get does: the sandbox's lock.
		Changed: func(id string) {
			sandboxLock.Lock()
			defer sandboxLock.Unlock()
			changed <- id
		},
	})
	var skew atomic.Int64
	m.now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	s := m.Sandbox("sbx_l", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	s.Load(context.Background())
	skew.Add(int64(MinTTL))
	store.put("p/b.txt", "new")
	// A host call holds the sandbox's lock throughout.
	sandboxLock.Lock()
	answered := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		s.handler().ServeHTTP(rec, httptest.NewRequest("POST", "/mounts/0/refresh", nil))
		answered <- rec.Code
	}()
	select {
	case code := <-answered:
		if code != http.StatusOK {
			t.Errorf("the refresh: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the guest's refresh waited for the sandbox's lock")
	}
	sandboxLock.Unlock()
	select {
	case id := <-changed:
		if id != "sbx_l" {
			t.Errorf("status of %s", id)
		}
	case <-time.After(5 * time.Second):
		t.Error("the listing's status never went out")
	}
}

// review3 is a test bed: a store, a cache directory, and managers on it (a host, restarted or another).
type review3 struct {
	t     *testing.T
	store *fakeS3
	srv   *httptest.Server
	dir   string
	creds map[string]proto.BucketCredentials
}

func newReview3(t *testing.T, objects map[string]string) *review3 {
	b := &review3{t: t, store: &fakeS3{objects: objects}, dir: t.TempDir(), creds: map[string]proto.BucketCredentials{"bks_1": {AccessKeyID: "k", SecretAccessKey: "s"}}}
	b.srv = httptest.NewServer(b.store)
	t.Cleanup(b.srv.Close)
	return b
}

func (b *review3) manager(key []byte) *Manager {
	cache, err := OpenCache(b.dir, 1<<30)
	if err != nil {
		b.t.Fatal(err)
	}
	return New(Config{Cache: cache, HTTP: b.srv.Client(), ProofKey: key, Resolve: func(_ context.Context, _, sourceID string) (proto.BucketSource, error) {
		c, ok := b.creds[sourceID]
		if !ok {
			return proto.BucketSource{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such source"}
		}
		return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: b.srv.URL, Credentials: &c}, nil
	}})
}

func get(h http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
	return rec
}

func readEntry(h http.Handler, e guest.ManifestEntry) *httptest.ResponseRecorder {
	return get(h, fmt.Sprintf("/mounts/0/object?path=%s&tag=%s&size=%d&k=%s", url.QueryEscape(e.Path), url.QueryEscape(e.Tag), e.Size, url.QueryEscape(e.Proof)))
}

func manifestOf(t *testing.T, h http.Handler) map[string]guest.ManifestEntry {
	t.Helper()
	var man guest.Manifest
	if err := json.Unmarshal(get(h, "/mounts/0/manifest").Body.Bytes(), &man); err != nil {
		t.Fatal(err)
	}
	out := map[string]guest.ManifestEntry{}
	for _, e := range man.Entries {
		out[e.Path] = e
	}
	return out
}

// After a host restart, an adopted guest reads a version it holds by its proof, from the cache, without the host
// first listing the prefix (which may fail: a store outage, a prefix grown past the limit); a bad proof still reads
// nothing.
func TestAdoptedProofReadsWithoutAListing(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	key := bytes.Repeat([]byte{7}, 32)
	spec := []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}}
	before := b.manager(key).Sandbox("sbx", spec)
	before.Load(context.Background())
	held := manifestOf(t, before.handler())["a.txt"]
	if rec := readEntry(before.handler(), held); rec.Body.String() != "hello" {
		t.Fatalf("before the restart: %d %q", rec.Code, rec.Body.String())
	}
	b.store.refuseList.Store(true)
	lists, gets := b.store.lists.Load(), b.store.gets.Load()
	after := b.manager(key).Sandbox("sbx", spec)
	if rec := readEntry(after.handler(), held); rec.Code != 200 || rec.Body.String() != "hello" {
		t.Fatalf("after the restart, listings refused: %d %q", rec.Code, rec.Body.String())
	}
	if b.store.lists.Load() != lists || b.store.gets.Load() != gets {
		t.Errorf("%d listings and %d reads from the store (want none: the cache has it)", b.store.lists.Load()-lists, b.store.gets.Load()-gets)
	}
	forged := held
	forged.Proof = "AAAAAAAAAAAAAAAAAAAAAA"
	if rec := readEntry(after.handler(), forged); rec.Code == 200 {
		t.Error("a forged proof read the cached bytes")
	}
	if rec := readEntry(b.manager(nil).Sandbox("sbx", spec).handler(), held); rec.Code == 200 {
		t.Error("another key's host read by this one's proof")
	}
}

// The cache is shared by the whole credential: the same one shares cached bytes; the same key ID with another
// secret or session token reads from the store (whose listing it may well pass), never another's cache.
func TestCacheIsTheWholeCredential(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	b.creds["bks_same"] = proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s"}
	b.creds["bks_guess"] = proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "guessed"}
	b.creds["bks_token"] = proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s", SessionToken: "t"}
	m := b.manager(nil)
	read := func(id, source string) {
		t.Helper()
		s := m.Sandbox(id, []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: source, Prefix: "p"}})
		s.Load(context.Background())
		if rec := readEntry(s.handler(), manifestOf(t, s.handler())["a.txt"]); rec.Body.String() != "hello" {
			t.Fatalf("%s: %d %q", source, rec.Code, rec.Body.String())
		}
	}
	read("sbx_1", "bks_1")
	read("sbx_2", "bks_same")
	if g := b.store.gets.Load(); g != 1 {
		t.Errorf("the same credential: %d reads from the store (want 1, then the cache)", g)
	}
	read("sbx_3", "bks_guess")
	read("sbx_4", "bks_token")
	if g := b.store.gets.Load(); g != 3 {
		t.Errorf("other secrets: %d reads from the store (want each its own)", g)
	}
}

// A manifest past its TTL is listed again before the guest's check gets its answer: the check takes the new listing
// now, rather than the old manifest (a 304) and another whole TTL before it sees the change.
func TestExpiredManifestAnswersTheNewListing(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	m := b.manager(nil)
	var skew atomic.Int64
	m.now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	s := m.Sandbox("sbx", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	s.Load(context.Background())
	if _, ok := manifestOf(t, s.handler())["new.txt"]; ok {
		t.Fatal("new.txt before it was put")
	}
	b.store.put("p/new.txt", "new")
	if _, ok := manifestOf(t, s.handler())["new.txt"]; ok {
		t.Error("new.txt within the TTL (the manifest held is still fresh)")
	}
	skew.Add(int64(DefaultTTL + time.Second))
	if _, ok := manifestOf(t, s.handler())["new.txt"]; !ok {
		t.Error("the first check past the TTL hasn't new.txt")
	}
	if n := b.store.lists.Load(); n != 2 {
		t.Errorf("%d listings", n)
	}
}

// The chunks the host's mounts fetch or send at once are bounded, per sandbox and host-wide, read-ahead included; and
// a guest that stops taking a read's bytes gives its chunk up within the write timeout.
func TestOpenChunksAreBounded(t *testing.T) {
	big := strings.Repeat("z", int(2*ChunkSize))
	b := newReview3(t, map[string]string{"p/big": big, "p/a.txt": "hello"})
	m := b.manager(nil)
	m.writeTimeout = 300 * time.Millisecond
	spec := []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}}
	s := m.Sandbox("sbx", spec)
	var held []func()
	for range SandboxOpenChunks {
		release, err := s.slot(context.Background(), false)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, release)
	}
	if _, err := s.slot(context.Background(), false); err == nil {
		t.Error("a sandbox took more than its share")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := s.slot(ctx, true); err == nil {
		t.Error("a read waiting for a chunk didn't give up with its context")
	}
	for _, release := range held {
		release()
	}
	// Host-wide: other sandboxes share the rest.
	held = nil
	for i := range DefaultMaxOpenChunks {
		o := m.Sandbox(fmt.Sprintf("sbx_%d", i/SandboxOpenChunks), spec)
		release, err := o.slot(context.Background(), false)
		if err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
		held = append(held, release)
	}
	if _, err := s.slot(context.Background(), false); err == nil {
		t.Error("the host gave out more than its chunks")
	}
	for _, release := range held {
		release()
	}
	// A guest that asks for 16 MiB and reads none of it: its chunk is given back once the write times out.
	s.Load(context.Background())
	e := manifestOf(t, s.handler())["big"]
	l, err := os.MkdirTemp("", "mnt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(l)
	if err := s.Listen(l, "v"); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	conn, err := (&net.Dialer{}).Dial("unix", filepath.Join(l, fmt.Sprintf("v_%d", guest.MountPort)))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /mounts/0/object?path=big&tag=%s&size=%d&k=%s HTTP/1.1\r\nHost: host\r\nRange: bytes=0-%d\r\n\r\n", url.QueryEscape(e.Tag), e.Size, url.QueryEscape(e.Proof), e.Size-1)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && b.store.gets.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	for time.Now().Before(deadline) && (len(s.slots) > 0 || len(m.slots) > 0) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(s.slots) > 0 || len(m.slots) > 0 {
		t.Errorf("a stalled read still holds %d chunks (host %d)", len(s.slots), len(m.slots))
	}
}

// A sync lists again within MinTTL of the last listing, which a refresh doesn't, and then has what was put; a second
// sync from the same moment has nothing to list.
func TestSyncListsWithinMinTTL(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	s := b.manager(nil).Sandbox("sbx", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	ctx := context.Background()
	s.Load(ctx)
	s.Applied([]guest.MountResult{{Path: "/mnt/p"}}, nil)
	b.store.put("p/new.txt", "new")
	if err := s.Refresh(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := manifestOf(t, s.handler())["new.txt"]; ok {
		t.Fatal("a refresh within MinTTL listed again")
	}
	since := time.Now()
	if err := s.Sync(ctx, "", since); err != nil {
		t.Fatal(err)
	}
	if _, ok := manifestOf(t, s.handler())["new.txt"]; !ok {
		t.Error("new.txt isn't there after a sync")
	}
	st := s.Status()[0]
	if st.ListedAt < since.UnixMilli() || st.State != proto.MountReady {
		t.Errorf("after the sync: %+v (since %d)", st, since.UnixMilli())
	}
	lists := b.store.lists.Load()
	if err := s.Sync(ctx, "", since); err != nil {
		t.Fatal(err)
	}
	if b.store.lists.Load() != lists {
		t.Error("a second sync from the same moment listed again")
	}
	if err := s.Sync(ctx, "/mnt/other", since); err == nil {
		t.Error("a sync of a path with no mount")
	}
}

// A sync whose listing fails is an error, though the mount carries on with the manifest it has (and says ready).
func TestSyncFailsWhenTheListingFails(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	s := b.manager(nil).Sandbox("sbx", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	ctx := context.Background()
	s.Load(ctx)
	s.Applied([]guest.MountResult{{Path: "/mnt/p"}}, nil)
	b.store.refuseList.Store(true)
	err := s.Sync(ctx, "", time.Now())
	if err == nil || !strings.Contains(err.Error(), "/mnt/p") {
		t.Fatalf("a failed listing: %v", err)
	}
	if st := s.Status()[0]; st.State != proto.MountReady || st.Objects != 1 {
		t.Errorf("the mount after a failed sync: %+v", st)
	}
	b.store.refuseList.Store(false)
	if err := s.Sync(ctx, "", time.Now()); err != nil {
		t.Errorf("the sync after the store came back: %v", err)
	}
	// Credentials revoked, and a source Kantel won't give again: a mount that couldn't be listed, not a path with no
	// mount. The error names the mount and isn't itself a proto.Error, which only Sync's own refusal is (so the tier
	// answers it unavailable, whatever proto.Error a listing's error holds).
	delete(b.creds, "bks_1")
	b.store.denyList.Store(true)
	err = s.Sync(ctx, "", time.Now())
	if _, direct := err.(*proto.Error); direct || err == nil || !strings.Contains(err.Error(), "/mnt/p") {
		t.Errorf("revoked credentials: %T %v", err, err)
	}
	if _, direct := s.Sync(ctx, "/mnt/none", time.Now()).(*proto.Error); !direct {
		t.Error("a path with no mount isn't Sync's own proto.Error")
	}
}

// A sync that finds a listing under way that began before it waits for it, then lists again: that listing may have
// read the bucket before the change the caller is waiting for.
func TestSyncListsAgainAfterAnOlderListing(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	m := b.manager(nil)
	var skew atomic.Int64
	m.now = func() time.Time { return time.Now().Add(time.Duration(skew.Load())) }
	s := m.Sandbox("sbx", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	ctx := context.Background()
	s.Load(ctx)
	entered, release := make(chan struct{}), make(chan struct{})
	var held atomic.Bool
	b.store.beforeList = func() {
		if held.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	}
	lists := b.store.lists.Load()
	skew.Add(int64(MinTTL))
	older := make(chan error, 1)
	go func() { older <- s.Refresh(ctx, "") }()
	<-entered
	skew.Add(int64(time.Millisecond))
	synced := make(chan error, 1)
	go func() { synced <- s.Sync(ctx, "", m.now()) }()
	select {
	case err := <-synced:
		t.Fatalf("the sync answered before the older listing ended: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-older; err != nil {
		t.Fatal(err)
	}
	if err := <-synced; err != nil {
		t.Fatal(err)
	}
	if n := b.store.lists.Load() - lists; n != 2 {
		t.Errorf("%d listings (want the older one and the sync's own)", n)
	}
}

// Shown takes the guest's answer after a sync: the synced version, or the host's newer one, with no error.
func TestShownChecksTheGuestsVersion(t *testing.T) {
	b := newReview3(t, map[string]string{"p/a.txt": "hello"})
	s := b.manager(nil).Sandbox("sbx", []proto.Mount{{Path: "/mnt/p", Kind: "bucket", BucketSourceID: "bks_1", Prefix: "p"}})
	ctx := context.Background()
	s.Load(ctx)
	if err := s.Sync(ctx, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	synced := s.Versions("")
	v := synced["/mnt/p"]
	if v == 0 {
		t.Fatalf("versions %v", synced)
	}
	if err := s.Shown(synced, []guest.MountResult{{Path: "/mnt/p", Version: v}}, nil); err != nil {
		t.Errorf("the synced version: %v", err)
	}
	for name, results := range map[string][]guest.MountResult{
		"an older version": {{Path: "/mnt/p", Version: v + 2}},
		"an error":         {{Path: "/mnt/p", Version: v, Error: "busy"}},
		"no answer":        nil,
	} {
		if err := s.Shown(synced, results, nil); err == nil {
			t.Errorf("%s was taken as current", name)
		}
	}
	if err := s.Shown(synced, nil, errors.New("the guest went away")); err == nil {
		t.Error("a guest that didn't answer was taken as current")
	}
}
