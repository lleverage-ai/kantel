package disksync

// The fetch (docs/design/disk-store.md, "2c. Peer sync"): a host gets a version from the peers that hold it by moving
// only the blocks that differ from what it holds already.
//
//  1. Where it is: disk.locate answers the holders, their mesh addresses, the version's map digest and a grant (or
//     disk.fetch brings them).
//  2. Its block map, from any holder, checked against the digest.
//  3. <version>.partial, a clone of the host's nearest version of the object (else an empty file), cut to the size.
//     A block whose hash the nearest version's map has too is there already; a block of zeros is cleared.
//  4. Every other block from the holders, a run of neighbouring blocks to a request, at most RunsInFlight at once, each
//     block checked against its hash before it is written in place.
//  5. fsync; then the version's small files (Store.Files: a root filesystem's record), whole, from any holder; then the
//     partial becomes the version, with its map and those files beside it.
//
// A bitmap beside the partial, <version>.partial.done, records the blocks that are in place and synced, so a fetch
// cut short (a restart, a peer gone) goes on where it stopped when it is asked again.
//
// A version of a kind with parts (Parted: a template snapshot's disk and memory) has several block-mapped files. Its
// map is then its manifest (parts.go), which names each part's map digest; each part is fetched as above into its own
// partial (Parted.PartPartial), from an empty file, and the parts are published together.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/bits"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const (
	// RunsInFlight is how many runs of blocks a fetch asks its holders for at once.
	RunsInFlight = 8
	// DefaultFetches is how many fetches run at once by default; others wait their turn.
	DefaultFetches = 2
	// checkpointEvery is how often a fetch syncs what it wrote and records it in its bitmap.
	checkpointEvery = 5 * time.Second
	// mapTimeout bounds a request for a map, or for one of a version's small files.
	mapTimeout = 2 * time.Minute
	// maxFileBytes is the most one of a version's small files may have.
	maxFileBytes = 1 << 20
	// grantMargin is how long before its grant expires a fetch asks for a new one.
	grantMargin = time.Minute
	// failedKeep is how long a failed fetch with no partial left is still reported (Progress): one with a partial is
	// reported for as long as the partial is there.
	failedKeep = 10 * time.Minute
)

// runBlocks is the most blocks one request asks for: 64 MiB.
var runBlocks = 16

// retryWait is how long a run waits before it tries the next holder, times its tries so far (at most 5).
var retryWait = time.Second

// Ref names a version of an object.
type Ref struct {
	Kind     string
	ObjectID string
	Version  string
}

func (r Ref) String() string { return r.Kind + "/" + r.ObjectID + "/" + r.Version }

// Store is where the host keeps the versions it holds and fetches new ones into.
type Store interface {
	// Held says whether the host holds the version.
	Held(r Ref) bool
	// Partial is the path a fetch of the version writes to, beside the object's versions (its directory made).
	Partial(r Ref) (string, error)
	// CloneNearest makes dst a clone of the host's nearest version of the object with a map, and answers that map:
	// nil, without making dst, when it holds none.
	CloneNearest(r Ref, dst string) (*blockmap.Map, error)
	// Files are the small files a version of r's kind has beside its block-mapped one, which a fetch takes whole: none
	// for most kinds.
	Files(r Ref) []string
	// Publish makes the fetched partial file, written through partial, the version, with its map's file and its small
	// files (those of Files its holder had) beside it. The partial is synced. A partial whose name no longer names
	// partial's file (removed meanwhile) isn't published.
	Publish(r Ref, partial *os.File, mapFile []byte, files map[string][]byte) error
	// Partials are the fetches left unfinished, by a previous run of the host or one that failed.
	Partials() []Ref
	// Discard removes a fetch's partial file and its bitmap.
	Discard(r Ref)
	// Reserve holds room for bytes a fetch is to write, beside the host's other copies under way, until release; an
	// error (proto.ErrCapacity) when that would leave the host too little.
	Reserve(r Ref, bytes int64) (release func(), err error)
}

// Request is a fetch of a version, with what disk.locate said of it; with no holders, grant or digest it is asked.
type Request struct {
	Ref
	MapDigest string
	Holders   []proto.DiskHolder
	Grant     string
}

// Stats are what a fetch did: of the version's blocks, how many it had already (Reused: the nearest version had them,
// or zeros, or a fetch cut short had written them) and how many it fetched, with the bytes.
type Stats struct {
	Blocks       int
	Reused       int
	Fetched      int
	FetchedBytes int64
	Resumed      bool
}

// Fetcher fetches versions from the host's peers, at most Fetches at once.
type Fetcher struct {
	Store Store
	// Locate is disk.locate: where a version is, and a grant to fetch it.
	Locate func(ctx context.Context, r Ref) (proto.DiskLocateResult, error)
	// Client makes requests to peers (default: HTTP/2 without TLS).
	Client *http.Client
	// Limit holds what the fetches read to the host's --sync-rate.
	Limit *Limiter
	// Fetches is how many run at once (default DefaultFetches).
	Fetches int
	// Port is the peers' sync port (default Port).
	Port int
	Log  *slog.Logger
	// Context is what fetches run under; they stop when it ends.
	Context context.Context

	once  sync.Once
	slots chan struct{}
	mu    sync.Mutex
	jobs  map[Ref]*Job
	// failed are the fetches that ended with an error, as they stood then, until one is started again or held.
	failed map[Ref]failure
}

// failure is how a failed fetch stood when it ended: its blocks, how many were in place, its error and when.
type failure struct {
	blocks, inPlace int64
	err             string
	at              time.Time
}

// Job is a fetch under way, or queued.
type Job struct {
	done  chan struct{}
	err   error
	stats Stats
	// again is a resume asked for while it ran (ResumeAll): one that fails is started again once it has ended.
	again bool

	// running is set once it has its turn. blocks are its version's (every part's), once its map is read, and inPlace
	// how many of them are in place. lastErr is the last error it met: a holder that failed it, or the failure of the
	// fetch it goes on from.
	running         atomic.Bool
	blocks, inPlace atomic.Int64
	lastErr         atomic.Pointer[string]
}

// noteError records err as the last error the fetch met.
func (j *Job) noteError(err error) {
	if j == nil || err == nil {
		return
	}
	msg := err.Error()
	j.lastErr.Store(&msg)
}

// Done is closed when the fetch has ended.
func (j *Job) Done() <-chan struct{} { return j.done }

// Result is how the fetch ended, once Done is closed.
func (j *Job) Result() (Stats, error) { return j.stats, j.err }

func (f *Fetcher) init() {
	f.once.Do(func() {
		n := f.Fetches
		if n <= 0 {
			n = DefaultFetches
		}
		f.slots = make(chan struct{}, n)
		f.jobs = map[Ref]*Job{}
		f.failed = map[Ref]failure{}
		if f.Client == nil {
			var protocols http.Protocols
			protocols.SetUnencryptedHTTP2(true)
			f.Client = &http.Client{
				Transport: &http.Transport{Protocols: &protocols, ResponseHeaderTimeout: time.Minute},
				// A holder's redirect is its answer, a failed one: a fetch goes only to the addresses disk.locate gave.
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			}
		}
		if f.Context == nil {
			f.Context = context.Background()
		}
	})
}

// Start fetches the version in the background, after the fetches ahead of it, and answers its job: the one under way
// already when the version is being fetched.
func (f *Fetcher) Start(req Request) *Job {
	f.init()
	f.mu.Lock()
	defer f.mu.Unlock()
	if j := f.jobs[req.Ref]; j != nil {
		return j
	}
	j := &Job{done: make(chan struct{})}
	if failed, ok := f.failed[req.Ref]; ok {
		// It goes on from where the failed fetch stopped, which it reports until it has its own.
		j.blocks.Store(failed.blocks)
		j.inPlace.Store(failed.inPlace)
		j.lastErr.Store(&failed.err)
		delete(f.failed, req.Ref)
	}
	f.jobs[req.Ref] = j
	go func() {
		defer close(j.done)
		defer func() {
			f.mu.Lock()
			delete(f.jobs, req.Ref)
			// A failure is reported until the fetch is asked for again: not one the host's stop or the control plane's
			// not_found (its partial discarded) ended.
			if j.err != nil && f.Context.Err() == nil && !IsNotFound(j.err) {
				f.failed[req.Ref] = failure{blocks: j.blocks.Load(), inPlace: j.inPlace.Load(), err: j.err.Error(), at: time.Now()}
			}
			again := j.again && j.err != nil && f.Context.Err() == nil
			f.mu.Unlock()
			if again {
				// A resume came while it was failing (the control plane back, say): what it left goes on.
				f.Start(Request{Ref: req.Ref})
			}
		}()
		select {
		case f.slots <- struct{}{}:
		case <-f.Context.Done():
			j.err = f.Context.Err()
			return
		}
		defer func() { <-f.slots }()
		j.running.Store(true)
		start := time.Now()
		j.stats, j.err = f.fetch(f.Context, req, j)
		if IsNotFound(j.err) {
			// The control plane has no such version (deleted): what was fetched of it is no use.
			f.Store.Discard(req.Ref)
		}
		if j.err != nil {
			f.Log.Warn("a disk version's fetch failed", "version", req.Ref.String(), "error", j.err, "fetchedBytes", j.stats.FetchedBytes)
			return
		}
		f.Log.Info("disk version fetched", "version", req.Ref.String(), "blocks", j.stats.Blocks, "reused", j.stats.Reused,
			"fetched", j.stats.Fetched, "fetchedBytes", j.stats.FetchedBytes, "resumed", j.stats.Resumed,
			"took", time.Since(start).Round(time.Millisecond))
	}()
	return j
}

// Progress is every fetch under way or waiting its turn, and every failed one, by kind, object and version: a failed
// one while its partial is left for it to go on (and for failedKeep after it failed), and not once the version is held.
// Never nil, so a report says there are none.
func (f *Fetcher) Progress() []proto.FetchProgress {
	f.init()
	f.mu.Lock()
	out := make([]proto.FetchProgress, 0, len(f.jobs)+len(f.failed))
	for r, j := range f.jobs {
		state := proto.FetchQueued
		if j.running.Load() {
			state = proto.FetchRunning
		}
		p := proto.FetchProgress{Kind: r.Kind, ObjectID: r.ObjectID, Version: r.Version, State: state,
			Blocks: j.blocks.Load(), InPlace: j.inPlace.Load()}
		if msg := j.lastErr.Load(); msg != nil {
			p.Error = *msg
		}
		out = append(out, p)
	}
	failed := make(map[Ref]failure, len(f.failed))
	for r, fl := range f.failed {
		failed[r] = fl
	}
	f.mu.Unlock()
	// A version is reported fetching or held, never both: one queued may be of a version the host holds (asked for as
	// the catalogue caught up), which it ends at once when its turn comes. The store is read without the lock.
	out = slices.DeleteFunc(out, func(p proto.FetchProgress) bool {
		return p.State == proto.FetchQueued && f.Store.Held(Ref{Kind: p.Kind, ObjectID: p.ObjectID, Version: p.Version})
	})
	if len(failed) > 0 {
		// Without the lock: the store may be slow, and a fetch that starts meanwhile is reported next time.
		partials := map[Ref]bool{}
		for _, r := range f.Store.Partials() {
			partials[r] = true
		}
		var gone []Ref
		for r, fl := range failed {
			if f.Store.Held(r) || (!partials[r] && time.Since(fl.at) > failedKeep) {
				gone = append(gone, r)
				continue
			}
			out = append(out, proto.FetchProgress{Kind: r.Kind, ObjectID: r.ObjectID, Version: r.Version,
				State: proto.FetchFailed, Blocks: fl.blocks, InPlace: fl.inPlace, Error: fl.err})
		}
		f.mu.Lock()
		for _, r := range gone {
			if fl, ok := f.failed[r]; ok && fl.at.Equal(failed[r].at) {
				delete(f.failed, r)
			}
		}
		f.mu.Unlock()
	}
	slices.SortFunc(out, func(a, b proto.FetchProgress) int {
		return strings.Compare(a.Kind+"/"+a.ObjectID+"/"+a.Version, b.Kind+"/"+b.ObjectID+"/"+b.Version)
	})
	return out
}

// Running says whether the version is being fetched, or waits its turn.
func (f *Fetcher) Running(r Ref) bool {
	f.init()
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.jobs[r] != nil
}

var (
	// errGrant is a holder refusing the grant: a new one is asked for.
	errGrant = errors.New("the holder refused the grant")
	// errNoHolder is a version no host the fetch may reach holds.
	errNoHolder = errors.New("no host holds the version")
)

func (f *Fetcher) fetch(ctx context.Context, req Request, j *Job) (Stats, error) {
	if f.Store.Held(req.Ref) {
		// A partial left of it (published, then the host stopped before removing it) is no fetch to go on with.
		f.Store.Discard(req.Ref)
		return Stats{}, nil
	}
	src := &holders{f: f, job: j, ref: req.Ref, digest: req.MapDigest}
	if len(req.Holders) == 0 || req.Grant == "" || req.MapDigest == "" {
		if err := src.refresh(ctx, 0); err != nil {
			return Stats{}, err
		}
	} else {
		src.set(req.Holders, req.Grant)
	}
	if parted, ok := f.Store.(Parted); ok && len(parted.Parts(req.Kind)) > 0 {
		return f.fetchParts(ctx, req.Ref, parted, src)
	}
	raw, err := src.fetchMap(ctx, "map", "")
	if err != nil {
		return Stats{}, err
	}
	m := &blockmap.Map{}
	if err := m.UnmarshalBinary(raw); err != nil {
		return Stats{}, err
	}
	// Its blocks are known from here, however the rest goes.
	j.blocks.Store(int64(m.Blocks()))
	path, err := f.Store.Partial(req.Ref)
	if err != nil {
		return Stats{}, err
	}
	p, err := f.prepare(req.Ref, path, m, src.digest, "data", func(dst string) (*blockmap.Map, error) {
		return f.Store.CloneNearest(req.Ref, dst)
	})
	if err != nil {
		return Stats{}, err
	}
	defer p.file.Close()
	j.inPlace.Store(int64(p.inPlace()))
	// Room for everything the fetch writes from here, before it writes any of it: the blocks it fetches, and the blocks
	// of zeros it clears, which take none when a hole is punched but may where one can't be.
	release, err := f.Store.Reserve(req.Ref, p.left())
	if err != nil {
		return Stats{}, err
	}
	defer release()
	if err := p.clearZeros(); err != nil {
		return Stats{}, err
	}
	j.inPlace.Store(int64(p.inPlace()))
	st := Stats{Blocks: m.Blocks(), Resumed: p.resumed}
	runs := p.runs()
	for _, r := range runs {
		st.Fetched += r.last - r.first + 1
	}
	st.Reused = st.Blocks - st.Fetched
	fetched, err := f.fetchRuns(ctx, src, p, runs)
	st.FetchedBytes = fetched
	if err != nil {
		return st, err
	}
	if err := p.file.Sync(); err != nil {
		return st, err
	}
	files, err := src.fetchFiles(ctx, f.Store.Files(req.Ref))
	if err != nil {
		return st, err
	}
	if err := f.Store.Publish(req.Ref, p.file, raw, files); err != nil {
		return st, err
	}
	_ = os.Remove(p.bitmapPath)
	return st, nil
}

// holders are the hosts a fetch fetches from, and its grant, asked for again when a holder refuses it or it is about
// to expire.
type holders struct {
	f *Fetcher
	// job is the fetch's, for its progress.
	job    *Job
	ref    Ref
	digest string

	mu    sync.Mutex
	list  []netip.Addr
	grant string
	exp   time.Time
	// gen counts the lists: a refresh asked with an older one has been done already.
	gen int
}

func (h *holders) set(list []proto.DiskHolder, grant string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.setLocked(list, grant)
}

func (h *holders) setLocked(list []proto.DiskHolder, grant string) {
	h.list = nil
	for _, d := range list {
		if a, err := netip.ParseAddr(strings.TrimSuffix(d.Address, "/128")); err == nil {
			h.list = append(h.list, a)
		}
	}
	h.grant, h.exp = grant, grantExpiry(grant)
	h.gen++
}

// grantExpiry is when a grant expires, read from its payload without checking its signature (its holders do that):
// zero when it can't be read.
func grantExpiry(grant string) time.Time {
	payload, _, _ := strings.Cut(grant, ".")
	raw, err := decode(payload)
	if err != nil {
		return time.Time{}
	}
	var g Grant
	if json.Unmarshal(raw, &g) != nil || g.Exp == 0 {
		return time.Time{}
	}
	return time.UnixMilli(g.Exp)
}

// current is the holders and grant now, and their generation; a grant about to expire is replaced first.
func (h *holders) current(ctx context.Context) ([]netip.Addr, string, int, error) {
	h.mu.Lock()
	expiring := !h.exp.IsZero() && time.Until(h.exp) < grantMargin
	gen := h.gen
	h.mu.Unlock()
	if expiring {
		if err := h.refresh(ctx, gen); err != nil {
			return nil, "", 0, err
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.list) == 0 {
		return nil, "", 0, errNoHolder
	}
	return h.list, h.grant, h.gen, nil
}

// refresh asks disk.locate where the version is now, unless the list has moved past gen already. The map's digest
// must stay the one the fetch has. It holds the lock while it asks: the fetch's runs wait for the new grant, and ask
// once between them.
func (h *holders) refresh(ctx context.Context, gen int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if gen != h.gen {
		return nil
	}
	if h.f.Locate == nil {
		return errors.New("no control plane to ask where the version is")
	}
	at, err := h.f.Locate(ctx, h.ref)
	if err != nil {
		return fmt.Errorf("disk.locate: %w", err)
	}
	if at.MapDigest == "" {
		return errors.New("the control plane has no block map digest for the version yet")
	}
	if h.digest != "" && at.MapDigest != h.digest {
		return fmt.Errorf("the version's map digest is %s now, not %s", at.MapDigest, h.digest)
	}
	if len(at.Holders) == 0 || at.Grant == "" {
		return errNoHolder
	}
	h.digest = at.MapDigest
	h.setLocked(at.Holders, at.Grant)
	return nil
}

func (h *holders) url(addr netip.Addr, what string) string {
	port := h.f.Port
	if port == 0 {
		port = Port
	}
	return fmt.Sprintf("http://%s/v1/objects/%s/%s/%s/%s", netip.AddrPortFrom(addr, uint16(port)), h.ref.Kind, h.ref.ObjectID, h.ref.Version, what)
}

// get asks a holder for what (map or data), with the grant, and a Range when end > start. A refused grant is errGrant.
func (h *holders) get(ctx context.Context, addr netip.Addr, grant, what string, start, end int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.url(addr, what), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+grant)
	if end > start {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end-1))
	}
	res, err := h.f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	want := http.StatusOK
	if end > start {
		want = http.StatusPartialContent
	}
	if res.StatusCode == want {
		return res, nil
	}
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("%w: %s: %s", errGrant, addr, bytes.TrimSpace(msg))
	}
	if res.StatusCode == http.StatusNotFound && strings.HasPrefix(what, "files/") {
		return nil, fmt.Errorf("%w: %s", errNoFile, addr)
	}
	return nil, fmt.Errorf("%s answered %d: %s", addr, res.StatusCode, bytes.TrimSpace(msg))
}

// fetchMap fetches a map (what: the version's, "map", or a part's) from the first holder that gives one whose digest is
// digest: with none, the version's map digest.
func (h *holders) fetchMap(ctx context.Context, what, digest string) ([]byte, error) {
	var errs []error
	for attempt := 0; attempt < 2; attempt++ {
		list, grant, gen, err := h.current(ctx)
		if err != nil {
			return nil, err
		}
		want := digest
		if want == "" {
			h.mu.Lock()
			want = h.digest
			h.mu.Unlock()
		}
		refused := false
		for _, addr := range list {
			raw, err := h.mapFrom(ctx, addr, grant, what, want)
			if err == nil {
				return raw, nil
			}
			refused = refused || errors.Is(err, errGrant)
			errs = append(errs, err)
			h.job.noteError(err)
		}
		if !refused {
			break
		}
		if err := h.refresh(ctx, gen); err != nil {
			return nil, errors.Join(append(errs, err)...)
		}
	}
	return nil, fmt.Errorf("no holder gave the version's %s: %w", what, errors.Join(errs...))
}

// fetchFiles fetches each of the version's small files whole, from the first holder that has it: one no holder has is
// left out (the version has none), and one a holder fails to give fails the fetch, to be tried again.
func (h *holders) fetchFiles(ctx context.Context, names []string) (map[string][]byte, error) {
	if len(names) == 0 {
		return nil, nil
	}
	out := map[string][]byte{}
	for _, name := range names {
		raw, err := h.fetchFile(ctx, name)
		if err != nil {
			return nil, err
		}
		if raw != nil {
			out[name] = raw
		}
	}
	return out, nil
}

// fetchFile fetches one small file: nil when every holder answers that it has none.
func (h *holders) fetchFile(ctx context.Context, name string) ([]byte, error) {
	var errs []error
	for attempt := 0; attempt < 2; attempt++ {
		list, grant, gen, err := h.current(ctx)
		if err != nil {
			return nil, err
		}
		refused, missing := false, 0
		for _, addr := range list {
			raw, err := h.fileFrom(ctx, addr, grant, name)
			if err == nil {
				return raw, nil
			}
			if errors.Is(err, errNoFile) {
				missing++
				continue
			}
			refused = refused || errors.Is(err, errGrant)
			errs = append(errs, err)
			h.job.noteError(err)
		}
		if missing == len(list) {
			return nil, nil
		}
		if !refused {
			break
		}
		if err := h.refresh(ctx, gen); err != nil {
			return nil, errors.Join(append(errs, err)...)
		}
	}
	return nil, fmt.Errorf("no holder gave the version's %s: %w", name, errors.Join(errs...))
}

// errNoFile is a holder answering that the version has no such file.
var errNoFile = errors.New("the version has no such file")

func (h *holders) fileFrom(ctx context.Context, addr netip.Addr, grant, name string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, mapTimeout)
	defer cancel()
	res, err := h.get(ctx, addr, grant, "files/"+url.PathEscape(name), 0, 0)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxFileBytes {
		return nil, fmt.Errorf("%s gave a %s of more than %d bytes", addr, name, maxFileBytes)
	}
	return raw, nil
}

func (h *holders) mapFrom(ctx context.Context, addr netip.Addr, grant, what, digest string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, mapTimeout)
	defer cancel()
	res, err := h.get(ctx, addr, grant, what, 0, 0)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	// A map is a header and 32 bytes a block of 4 MiB: a little over 16 MiB is a 2 TiB disk's, the largest.
	raw, err := io.ReadAll(io.LimitReader(res.Body, 17<<20))
	if err != nil {
		return nil, err
	}
	if got := blockmap.Digest(raw); got != digest {
		return nil, fmt.Errorf("%s gave a %s whose digest is %s, not %s", addr, what, got, digest)
	}
	return raw, nil
}

// partial is a fetch's file and what of it is in place.
type partial struct {
	file       *os.File
	m          *blockmap.Map
	digest     string
	bitmapPath string
	resumed    bool
	// data is what its blocks are asked for as: "data", or a part's (parts/<name>/data).
	data string

	mu sync.Mutex
	// done are the blocks in place and recorded in the bitmap; written those in place since its last checkpoint.
	done    []byte
	written []int
	// checkpointing is one checkpoint at a time.
	checkpointing sync.Mutex
}

func (p *partial) isDone(i int) bool { return p.done[i/8]&(1<<(i%8)) != 0 }
func (p *partial) setDone(i int)     { p.done[i/8] |= 1 << (i % 8) }

// inPlace is how many blocks its bitmap records in place. Not while its runs are fetched: checkpoints change it then.
func (p *partial) inPlace() int {
	n := 0
	for _, b := range p.done {
		n += bits.OnesCount8(b)
	}
	return n
}

// bitmapMagic starts a bitmap's file, followed by the map digest it is for, a newline and a bit per block.
const bitmapMagic = "KTFETCH1 "

func readBitmap(path, digest string, blocks int) []byte {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	head := bitmapMagic + digest + "\n"
	if !bytes.HasPrefix(raw, []byte(head)) || len(raw)-len(head) != (blocks+7)/8 {
		return nil
	}
	return raw[len(head):]
}

func writeBitmap(path, digest string, done []byte) error {
	return fsutil.WriteFileDurably(path, append([]byte(bitmapMagic+digest+"\n"), done...), 0o600)
}

// prepare opens the version's partial file to go on with, as its bitmap says, or makes it afresh from the host's
// nearest version (clone; whose full copy, where there are no reflinks, holds its own room), or with no clone from an
// empty file. Its blocks are asked for as data.
func (f *Fetcher) prepare(r Ref, path string, m *blockmap.Map, digest, data string, clone func(dst string) (*blockmap.Map, error)) (*partial, error) {
	p := &partial{m: m, digest: digest, bitmapPath: path + ".done", data: data}
	if done := readBitmap(p.bitmapPath, digest, m.Blocks()); done != nil {
		if file, err := os.OpenFile(path, os.O_RDWR, 0); err == nil {
			if info, err := file.Stat(); err == nil && info.Size() == m.Size {
				p.file, p.done, p.resumed = file, done, true
			} else {
				file.Close()
			}
		}
	}
	if p.file == nil {
		if err := f.fresh(r, path, p, clone); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// left is the bytes of the blocks not yet in place: the most the rest of the fetch can write.
func (p *partial) left() int64 {
	var n int64
	for i := range p.m.Blocks() {
		if !p.isDone(i) {
			start, end := p.m.Range(i)
			n += end - start
		}
	}
	return n
}

// clearZeros clears each block of zeros not yet in place, then syncs the file and records it, with what fresh found
// in place, in the bitmap.
func (p *partial) clearZeros() error {
	changed := false
	for i := range p.m.Blocks() {
		if p.isDone(i) || p.m.Hash(i) != ([blockmap.HashSize]byte{}) {
			continue
		}
		start, end := p.m.Range(i)
		if err := zero(p.file, start, end); err != nil {
			return err
		}
		p.setDone(i)
		changed = true
	}
	if !changed && p.resumed {
		return nil
	}
	if err := p.file.Sync(); err != nil {
		return err
	}
	return writeBitmap(p.bitmapPath, p.digest, p.done)
}

// fresh makes the partial file anew: a clone of the nearest version cut to the version's size, whose blocks that
// match the version's are in place; else (or with no clone) an empty file of that size.
func (f *Fetcher) fresh(r Ref, path string, p *partial, clone func(dst string) (*blockmap.Map, error)) error {
	_ = os.Remove(p.bitmapPath)
	_ = os.Remove(path)
	m := p.m
	p.done = make([]byte, (m.Blocks()+7)/8)
	var base *blockmap.Map
	var err error
	if clone != nil {
		base, err = clone(path)
	}
	if pe := (*proto.Error)(nil); errors.As(err, &pe) && pe.Code == proto.ErrCapacity {
		// No room for a full copy of the nearest version: none for the version from nothing either.
		_ = os.Remove(path)
		return err
	}
	if err != nil {
		f.Log.Warn("a fetch starts from an empty file: the nearest version couldn't be cloned", "version", r.String(), "error", err)
		_ = os.Remove(path)
		base = nil
	}
	// Over a clone, the clone itself: one removed meanwhile (its version deleted) fails the fetch, rather than taking
	// an empty file for the clone whose blocks the base's map vouches for.
	flags := os.O_RDWR
	if base == nil {
		flags |= os.O_CREATE | os.O_EXCL
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	if err := file.Truncate(m.Size); err != nil {
		file.Close()
		return err
	}
	p.file = file
	for i := range m.Blocks() {
		want := m.Hash(i)
		if base == nil {
			// An empty file is zeros, which prepare counts as such.
			continue
		}
		start, end := m.Range(i)
		if i < base.Blocks() && want != ([blockmap.HashSize]byte{}) && base.Hash(i) == want {
			if bs, be := base.Range(i); bs == start && be == end {
				p.setDone(i)
			}
		}
	}
	return nil
}

// punchHole frees [off, off+n) of f, which then reads as zeros (a variable: tests stand in for a file system without
// it).
var punchHole = func(f *os.File, off, n int64) error {
	return unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, off, n)
}

// zero makes [start, end) of f zeros without taking any room: a hole punched, or where holes can't be punched, zeros
// written over the data the range has already (SEEK_DATA and SEEK_HOLE find it), never into its holes, which read as
// zeros already. A file system that can't say where its data is has every chunk read, and only those with a byte that
// isn't zero written.
func zero(f *os.File, start, end int64) error {
	if punchHole(f, start, end-start) == nil {
		return nil
	}
	zeros := make([]byte, 1<<20)
	write := func(from, to int64) error {
		for off := from; off < to; off += int64(len(zeros)) {
			if _, err := f.WriteAt(zeros[:min(int64(len(zeros)), to-off)], off); err != nil {
				return err
			}
		}
		return nil
	}
	fd := int(f.Fd())
	for off := start; off < end; {
		data, err := unix.Seek(fd, off, unix.SEEK_DATA)
		if errors.Is(err, unix.ENXIO) {
			return nil // no data from off on
		}
		if err != nil {
			return zeroByReading(f, off, end, zeros)
		}
		if data >= end {
			return nil
		}
		hole, err := unix.Seek(fd, data, unix.SEEK_HOLE)
		if err != nil {
			return zeroByReading(f, data, end, zeros)
		}
		if err := write(data, min(hole, end)); err != nil {
			return err
		}
		off = hole
	}
	return nil
}

// zeroByReading writes zeros over each chunk of [start, end) of f that has a byte that isn't zero.
func zeroByReading(f *os.File, start, end int64, zeros []byte) error {
	buf := make([]byte, len(zeros))
	for off := start; off < end; off += int64(len(buf)) {
		b := buf[:min(int64(len(buf)), end-off)]
		n, err := f.ReadAt(b, off)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if !bytes.Equal(b[:n], zeros[:n]) {
			if _, err := f.WriteAt(zeros[:n], off); err != nil {
				return err
			}
		}
	}
	return nil
}

// run is a run of neighbouring blocks not yet in place: first to last.
type run struct{ first, last int }

func (p *partial) runs() []run {
	var out []run
	for i := 0; i < p.m.Blocks(); i++ {
		if p.isDone(i) {
			continue
		}
		r := run{first: i, last: i}
		for r.last+1 < p.m.Blocks() && !p.isDone(r.last+1) && r.last-r.first+1 < runBlocks {
			r.last++
		}
		out = append(out, r)
		i = r.last
	}
	return out
}

// wrote records block i written in place, to be synced and recorded at the next checkpoint.
func (p *partial) wrote(i int) {
	p.mu.Lock()
	p.written = append(p.written, i)
	p.mu.Unlock()
}

// checkpoint syncs what was written since the last one and records it in the bitmap: the bitmap never names a block
// that isn't on the disk.
func (p *partial) checkpoint() error {
	p.checkpointing.Lock()
	defer p.checkpointing.Unlock()
	p.mu.Lock()
	written := p.written
	p.written = nil
	p.mu.Unlock()
	if len(written) == 0 {
		return nil
	}
	if err := p.file.Sync(); err != nil {
		return err
	}
	for _, i := range written {
		p.setDone(i)
	}
	return writeBitmap(p.bitmapPath, p.digest, p.done)
}

// fetchRuns fetches the runs, RunsInFlight at once, and answers the bytes fetched. Once a run fails no more are
// started. The partial is checkpointed every checkpointEvery, and once at the end, however it ends.
func (f *Fetcher) fetchRuns(ctx context.Context, src *holders, p *partial, runs []run) (int64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		mu      sync.Mutex
		fetched int64
		failed  error
		wg      sync.WaitGroup
		// quit stops new runs once one has failed: those under way go on, so what they fetch is kept for the next try.
		quit     = make(chan struct{})
		quitOnce sync.Once
	)
	work := make(chan int)
	for range min(RunsInFlight, len(runs)) {
		wg.Go(func() {
			buf := make([]byte, blockmap.BlockSize)
			for k := range work {
				n, err := f.fetchRun(ctx, src, p, runs[k], k, buf)
				mu.Lock()
				fetched += n
				if err != nil && failed == nil {
					failed = err
					quitOnce.Do(func() { close(quit) })
				}
				mu.Unlock()
			}
		})
	}
	stop := make(chan struct{})
	checkpoints := make(chan error, 1)
	go func() {
		t := time.NewTicker(checkpointEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				checkpoints <- nil
				return
			case <-t.C:
				if err := p.checkpoint(); err != nil {
					checkpoints <- err
					cancel()
					return
				}
			}
		}
	}()
feed:
	for k := range runs {
		select {
		case work <- k:
		case <-quit:
			break feed
		case <-ctx.Done():
			break feed
		}
	}
	close(work)
	wg.Wait()
	close(stop)
	cerr := <-checkpoints
	// What was written is kept for the next try, whatever ended this one.
	if err := p.checkpoint(); err != nil && cerr == nil {
		cerr = err
	}
	if failed == nil {
		failed = cerr
	}
	if failed == nil && ctx.Err() != nil {
		failed = ctx.Err()
	}
	return fetched, failed
}

// fetchRun fetches a run's blocks, trying its holders in turn (starting from one of its own, so runs spread over them)
// until each block is in place, and answers the bytes fetched. A holder that refuses the grant has a new one asked
// for; one that fails otherwise is passed over for the next. It gives up after trying each holder twice.
func (f *Fetcher) fetchRun(ctx context.Context, src *holders, p *partial, r run, k int, buf []byte) (int64, error) {
	var fetched int64
	next := r.first
	var errs []error
	for attempt := 0; ; attempt++ {
		list, grant, gen, err := src.current(ctx)
		if err != nil {
			return fetched, err
		}
		if attempt >= 2*len(list) {
			return fetched, fmt.Errorf("blocks %d to %d: %w", next, r.last, errors.Join(errs...))
		}
		addr := list[(k+attempt)%len(list)]
		n, err := f.fetchFrom(ctx, src, p, addr, grant, &next, r.last, buf)
		fetched += n
		if err == nil {
			return fetched, nil
		}
		if ctx.Err() != nil {
			return fetched, ctx.Err()
		}
		errs = append(errs, err)
		src.job.noteError(err)
		if errors.Is(err, errGrant) {
			if err := src.refresh(ctx, gen); err != nil {
				return fetched, err
			}
			continue
		}
		select {
		case <-time.After(time.Duration(min(attempt+1, 5)) * retryWait):
		case <-ctx.Done():
			return fetched, ctx.Err()
		}
	}
}

// stallTimeout is how long a request for a run may go without a byte before it is given up: not the time it takes,
// which --sync-rate may make long.
var stallTimeout = 2 * time.Minute

// fetchFrom fetches blocks *next to last from one holder, checking and writing each in turn, and moving *next on.
func (f *Fetcher) fetchFrom(ctx context.Context, src *holders, p *partial, addr netip.Addr, grant string, next *int, last int, buf []byte) (int64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stalled := time.AfterFunc(stallTimeout, cancel)
	defer stalled.Stop()
	start, _ := p.m.Range(*next)
	_, end := p.m.Range(last)
	res, err := src.get(ctx, addr, grant, p.data, start, end)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	body := limitedReader{ctx: ctx, r: progress{res.Body, func() { stalled.Reset(stallTimeout) }}, l: f.Limit}
	var fetched int64
	for *next <= last {
		i := *next
		bs, be := p.m.Range(i)
		b := buf[:be-bs]
		n, err := io.ReadFull(body, b)
		fetched += int64(n)
		if err != nil {
			return fetched, fmt.Errorf("%s: block %d: %w", addr, i, err)
		}
		if blockmap.HashBlock(b) != p.m.Hash(i) {
			return fetched, fmt.Errorf("%s gave block %d with the wrong hash", addr, i)
		}
		if _, err := p.file.WriteAt(b, bs); err != nil {
			return fetched, err
		}
		p.wrote(i)
		src.job.inPlace.Add(1)
		*next = i + 1
	}
	return fetched, nil
}

// progress calls moved each time a read gets bytes.
type progress struct {
	r     io.Reader
	moved func()
}

func (p progress) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.moved()
	}
	return n, err
}

// ResumeAll starts the fetches Store has unfinished, each asked of the control plane afresh. One running now is started
// again should it fail. A version the control plane no longer knows has its partial removed.
func (f *Fetcher) ResumeAll() {
	f.init()
	for _, r := range f.Store.Partials() {
		f.mu.Lock()
		j := f.jobs[r]
		if j != nil {
			j.again = true
		}
		f.mu.Unlock()
		if j == nil {
			f.Log.Info("resuming a disk version's fetch", "version", r.String())
			f.Start(Request{Ref: r})
		}
	}
}

// IsNotFound says whether err is the control plane's not_found.
func IsNotFound(err error) bool {
	var pe *proto.Error
	return errors.As(err, &pe) && pe.Code == proto.ErrNotFound
}
