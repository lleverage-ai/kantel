package mounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func manifestBytes(t *testing.T, entries ...ManifestFileEntry) (string, string) {
	t.Helper()
	raw, err := json.Marshal(ManifestFile{Version: ManifestFormat, Entries: entries})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return string(raw), "sha256:" + hex.EncodeToString(sum[:])
}

func TestParseManifest(t *testing.T) {
	good, digest := manifestBytes(t,
		ManifestFileEntry{Path: "docs/a.md", Key: "blobs/1", Size: 3, ETag: "e1", MTimeMs: 1000},
		ManifestFileEntry{Path: "b.bin", Key: "blobs/2", Size: 5, Generation: "17", ETag: "e2"},
		ManifestFileEntry{Path: "empty", Dir: true},
	)
	m, err := parseManifest([]byte(good), digest, 10)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, e := range m.wire.Entries {
		paths = append(paths, e.Path)
	}
	if got := strings.Join(paths, " "); got != "b.bin docs docs/a.md empty" {
		t.Fatalf("entries %q", got)
	}
	if o := m.objects["b.bin"]; o.key != "blobs/2" || o.generation != "17" || o.etag != "e2" || o.tag != "g17ee2" {
		t.Errorf("b.bin %+v", o)
	}
	if m.bytes != 8 || m.wire.Entries[2].MTimeMs != 1000 {
		t.Errorf("bytes %d, mtime %d", m.bytes, m.wire.Entries[2].MTimeMs)
	}
	if _, err := parseManifest([]byte(good), "sha256:"+strings.Repeat("0", 64), 10); !errors.Is(err, errManifest) {
		t.Errorf("another digest: %v", err)
	}
	if _, err := parseManifest([]byte(good), digest, 1); err == nil || !strings.Contains(err.Error(), "more than 1 files") {
		t.Errorf("over the limit: %v", err)
	}
	// Unlike a listing, a manifest that can't be shown exactly as written is refused, never trimmed.
	for name, entries := range map[string][]ManifestFileEntry{
		"dot":      {{Path: "a/../b", Key: "k", ETag: "e"}},
		"absolute": {{Path: "/a", Key: "k", ETag: "e"}},
		"twice":    {{Path: "a", Key: "k", ETag: "e"}, {Path: "a", Key: "k2", ETag: "e"}},
		"no key":   {{Path: "a", ETag: "e"}},
		"unpinned": {{Path: "a", Key: "k"}},
		"negative": {{Path: "a", Key: "k", ETag: "e", Size: -1}},
		"file dir": {{Path: "a", Key: "k", ETag: "e"}, {Path: "a/b", Key: "k", ETag: "e"}},
		"dir file": {{Path: "a", Dir: true, Key: "k"}},
		"bad etag": {{Path: "a", Key: "k", ETag: `"e"`}},
		// Not a number: with an ETag, "7" and "abc" would make the same tag as this.
		"generation": {{Path: "a", Key: "k", Generation: "7eabc"}},
		"long name":  {{Path: strings.Repeat("n", 256), Key: "k", ETag: "e"}},
	} {
		raw, d := manifestBytes(t, entries...)
		if _, err := parseManifest([]byte(raw), d, 10); !errors.Is(err, errManifest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// More entries than a mount of 10 files may hold (20, its directories with them): refused as they are counted,
	// before the rest are decoded.
	var dirs []string
	for i := range 21 {
		dirs = append(dirs, fmt.Sprintf(`{"path":"d%d","dir":true}`, i))
	}
	many := `{"version":1,"entries":[` + strings.Join(dirs, ",") + `]}`
	manySum := sha256.Sum256([]byte(many))
	if _, err := parseManifest([]byte(many), "sha256:"+hex.EncodeToString(manySum[:]), 10); err == nil || !strings.Contains(err.Error(), "more than 20 entries") {
		t.Errorf("21 entries, 20 allowed: %v", err)
	}
	for name, raw := range map[string]string{
		"not json":      "nope",
		"version":       `{"version":2,"entries":[]}`,
		"unknown field": `{"version":1,"entries":[{"path":"a","key":"k","etag":"e","size":1,"mode":420}]}`,
		"no size":       `{"version":1,"entries":[{"path":"a","key":"k","etag":"e"}]}`,
		"null size":     `{"version":1,"entries":[{"path":"a","key":"k","etag":"e","size":null}]}`,
		"trailing":      `{"version":1,"entries":[]} {}`,
		"twice":         `{"version":1,"entries":[],"entries":[]}`,
	} {
		sum := sha256.Sum256([]byte(raw))
		if _, err := parseManifest([]byte(raw), "sha256:"+hex.EncodeToString(sum[:]), 10); !errors.Is(err, errManifest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// manifestBed is a store, a clock and a host's mounts on them, with bucket sources whose credentials expire.
type manifestBed struct {
	t     *testing.T
	store *fakeS3
	srv   *httptest.Server
	m     *Manager

	mu      sync.Mutex
	now     time.Time
	expires map[string]time.Time
}

func newManifestBed(t *testing.T, objects map[string]string) *manifestBed {
	b := &manifestBed{t: t, store: &fakeS3{objects: objects}, now: time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC), expires: map[string]time.Time{}}
	b.srv = httptest.NewServer(b.store)
	t.Cleanup(b.srv.Close)
	cache, err := OpenCache(t.TempDir(), 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	b.m = New(Config{Cache: cache, HTTP: b.srv.Client(), Resolve: func(_ context.Context, _, sourceID string) (proto.BucketSource, error) {
		b.mu.Lock()
		exp, ok := b.expires[sourceID]
		b.mu.Unlock()
		if !ok {
			return proto.BucketSource{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such source"}
		}
		// Every source reads the one bucket with the same key; only the source (and so the account) differs. No ID in
		// the answer: the host names the source by the one it asked for.
		return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: b.srv.URL,
			Credentials: &proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s", SessionToken: exp.String(), ExpiresAt: exp.UnixMilli()}}, nil
	}})
	b.m.clock = b.clock
	b.m.resolveBackoff = 0
	return b
}

func (b *manifestBed) clock() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.now
}

func (b *manifestBed) advance(d time.Duration) {
	b.mu.Lock()
	b.now = b.now.Add(d)
	b.mu.Unlock()
}

// source gives the bucket source credentials good for d from now (a refresh of them).
func (b *manifestBed) source(id string, d time.Duration) {
	b.mu.Lock()
	b.expires[id] = b.now.Add(d)
	b.mu.Unlock()
}

func (b *manifestBed) mount(sandboxID, sourceID, key, digest string) *Sandbox {
	b.t.Helper()
	s := b.m.Sandbox(sandboxID, []proto.Mount{{Path: "/mnt/files", Kind: proto.MountManifest, BucketSourceID: sourceID, ManifestKey: key, Digest: digest}})
	s.Load(context.Background())
	s.Applied([]guest.MountResult{{Path: "/mnt/files"}}, nil)
	return s
}

func readRange(h http.Handler, e guest.ManifestEntry, rng string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", fmt.Sprintf("/mounts/0/object?path=%s&tag=%s", e.Path, e.Tag), nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// A manifest mount shows exactly its manifest's files, whatever else the bucket holds, and reads each from the
// object its entry names; the first read of part of a large file fetches only that part of that file.
func TestManifestMountShowsExactlyItsEntries(t *testing.T) {
	large := strings.Repeat("L", int(2*ChunkSize+100))
	objects := map[string]string{
		"blobs/1":        "visible",
		"blobs/2":        large,
		"blobs/hidden":   "another user's file",
		"files/other.md": "not in the manifest",
	}
	raw, digest := manifestBytes(t,
		ManifestFileEntry{Path: "notes/a.txt", Key: "blobs/1", Size: 7, ETag: etag("visible")},
		ManifestFileEntry{Path: "big.bin", Key: "blobs/2", Size: int64(len(large)), ETag: etag(large)},
	)
	objects["manifests/1.json"] = raw
	b := newManifestBed(t, objects)
	b.source("bks_a", time.Hour)
	s := b.mount("sbx_1", "bks_a", "manifests/1.json", digest)
	if st := s.Status(); st[0].State != proto.MountReady || st[0].Kind != proto.MountManifest || st[0].Objects != 2 {
		t.Fatalf("status %+v", st)
	}
	h := s.handler()
	shown := manifestOf(t, h)
	var paths []string
	for p := range shown {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if got := strings.Join(paths, " "); got != "big.bin notes notes/a.txt" {
		t.Fatalf("shown %q", got)
	}
	if rec := readRange(h, shown["notes/a.txt"], "bytes=0-6"); rec.Code != 200 || rec.Body.String() != "visible" {
		t.Fatalf("a.txt: %d %q", rec.Code, rec.Body.String())
	}
	// Something the manifest doesn't list, by its path or by the key of an object it doesn't name: nothing.
	for _, p := range []string{"other.md", "blobs/hidden", "../blobs/hidden"} {
		if rec := readRange(h, guest.ManifestEntry{Path: p, Tag: "e" + etag("another user's file")}, "bytes=0-5"); rec.Code == 200 {
			t.Errorf("%s was served: %q", p, rec.Body.String())
		}
	}
	gets := b.store.gets.Load()
	if rec := readRange(h, shown["big.bin"], "bytes=10-4095"); rec.Code != 200 || rec.Body.Len() != 4086 {
		t.Fatalf("big.bin: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if n := b.store.gets.Load() - gets; n != 1 || !b.m.Cache().Cached(cacheID(t, s, "big.bin"), 0) || b.m.Cache().Cached(cacheID(t, s, "big.bin"), 1) {
		t.Errorf("the first read of 4 KiB of a %d-byte file: %d store reads (want one chunk, of that file only)", len(large), n)
	}
	// It never changes: a refresh (from Kantel or the guest) reads nothing again, and Sync is already current.
	fetches := b.store.gets.Load()
	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Sync(context.Background(), "", b.clock().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/mounts/0/refresh", nil))
	if b.store.gets.Load() != fetches {
		t.Error("a refresh read the manifest again")
	}
}

// cacheID is the cache's name for a file of a mount's, as serveObject makes it.
func cacheID(t *testing.T, s *Sandbox, path string) string {
	t.Helper()
	mt := s.mounts[0]
	src, err := s.m.client(context.Background(), s.id, mt.spec.BucketSourceID, false)
	if err != nil {
		t.Fatal(err)
	}
	o := mt.current.objects[path]
	return ObjectID(src.src.Endpoint+"|"+src.src.Provider, src.src.Bucket, o.key, o.tag+"/"+strconv.FormatInt(o.size, 10), principal(src.src))
}

// A manifest whose object isn't the one the create named (changed since, or another) doesn't mount.
func TestManifestMountRefusesAnotherManifest(t *testing.T) {
	raw, _ := manifestBytes(t, ManifestFileEntry{Path: "a", Key: "blobs/1", Size: 1, ETag: "e"})
	_, other := manifestBytes(t)
	b := newManifestBed(t, map[string]string{"manifests/1.json": raw})
	b.source("bks_a", time.Hour)
	s := b.mount("sbx", "bks_a", "manifests/1.json", other)
	if st := s.Status(); st[0].State != proto.MountFailed || !strings.Contains(st[0].Error, "digest") {
		t.Errorf("status %+v", st)
	}
}

// An object that changed since its entry was written is never served under the entry: the read fails as stale
// (ESTALE in the sandbox), and bytes already cached are the entry's version's.
func TestManifestMountChangedObjectIsStale(t *testing.T) {
	raw, digest := manifestBytes(t,
		ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 5, ETag: etag("hello")},
		ManifestFileEntry{Path: "b.txt", Key: "blobs/b", Size: 5, ETag: etag("world")},
	)
	b := newManifestBed(t, map[string]string{"manifests/1.json": raw, "blobs/a": "hello", "blobs/b": "world"})
	b.source("bks_a", time.Hour)
	h := b.mount("sbx", "bks_a", "manifests/1.json", digest).handler()
	shown := manifestOf(t, h)
	if rec := readRange(h, shown["a.txt"], "bytes=0-4"); rec.Body.String() != "hello" {
		t.Fatalf("a.txt: %d %q", rec.Code, rec.Body.String())
	}
	b.store.put("blobs/a", "HELLO, changed")
	b.store.put("blobs/b", "WORLD, changed")
	if rec := readRange(h, shown["b.txt"], "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("b.txt, changed before its first read: %d %q", rec.Code, rec.Body.String())
	}
	if rec := readRange(h, shown["a.txt"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "hello" {
		t.Errorf("a.txt, cached before it changed: %d %q", rec.Code, rec.Body.String())
	}
	b.store.mu.Lock()
	delete(b.store.objects, "blobs/b")
	b.store.mu.Unlock()
	if rec := readRange(h, shown["b.txt"], "bytes=0-4"); rec.Code != http.StatusGone {
		t.Errorf("b.txt, gone: %d", rec.Code)
	}
}

// An entry that understates its object's size fails as stale, and caches nothing another mount would read short.
func TestManifestMountSizeIsPinned(t *testing.T) {
	short, shortDigest := manifestBytes(t, ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 1, ETag: etag("hello")})
	right, rightDigest := manifestBytes(t, ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 5, ETag: etag("hello")})
	b := newManifestBed(t, map[string]string{"manifests/short.json": short, "manifests/right.json": right, "blobs/a": "hello"})
	b.source("bks_a", time.Hour)
	h := b.mount("sbx_1", "bks_a", "manifests/short.json", shortDigest).handler()
	if rec := readRange(h, manifestOf(t, h)["a.txt"], "bytes=0-0"); rec.Code != http.StatusGone {
		t.Errorf("an understated size: %d %q", rec.Code, rec.Body.String())
	}
	h = b.mount("sbx_2", "bks_a", "manifests/right.json", rightDigest).handler()
	if rec := readRange(h, manifestOf(t, h)["a.txt"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "hello" {
		t.Errorf("the right size, after: %d %q", rec.Code, rec.Body.String())
	}
	// With the right size's chunk cached, the understated entry still doesn't read it.
	h = b.mount("sbx_3", "bks_a", "manifests/short.json", shortDigest).handler()
	if rec := readRange(h, manifestOf(t, h)["a.txt"], "bytes=0-0"); rec.Code != http.StatusGone {
		t.Errorf("an understated size, the object cached: %d %q", rec.Code, rec.Body.String())
	}
}

// While Kantel can't be asked, a mount whose credentials expired asks it at most once per backoff, not on each read.
func TestExpiredSourceBacksOffWhenKantelIsDown(t *testing.T) {
	raw, digest := manifestBytes(t,
		ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 5, ETag: etag("hello")},
		ManifestFileEntry{Path: "b.txt", Key: "blobs/b", Size: 5, ETag: etag("world")},
	)
	b := newManifestBed(t, map[string]string{"manifests/1.json": raw, "blobs/a": "hello", "blobs/b": "world"})
	b.source("bks_a", 10*time.Minute)
	b.m.resolveBackoff = resolveBackoff
	var calls atomic.Int64
	resolve := b.m.cfg.Resolve
	var down atomic.Bool
	b.m.cfg.Resolve = func(ctx context.Context, sandboxID, sourceID string) (proto.BucketSource, error) {
		calls.Add(1)
		if down.Load() {
			return proto.BucketSource{}, errors.New("kantel is unreachable")
		}
		return resolve(ctx, sandboxID, sourceID)
	}
	h := b.mount("sbx", "bks_a", "manifests/1.json", digest).handler()
	shown := manifestOf(t, h)
	down.Store(true)
	b.advance(11 * time.Minute)
	before := calls.Load()
	for range 3 {
		if rec := readRange(h, shown["a.txt"], "bytes=0-4"); rec.Code != http.StatusBadGateway {
			t.Fatalf("expired, Kantel down: %d %q", rec.Code, rec.Body.String())
		}
	}
	if n := calls.Load() - before; n != 1 {
		t.Errorf("%d calls to Kantel for three reads within the backoff (want 1)", n)
	}
	down.Store(false)
	b.source("bks_a", 10*time.Minute)
	b.advance(resolveBackoff)
	if rec := readRange(h, shown["b.txt"], "bytes=0-4"); rec.Body.String() != "world" {
		t.Errorf("Kantel back, refreshed: %d %q", rec.Code, rec.Body.String())
	}
}

// Credentials that expire are used no later than their expiry: a read after it fails at once, without a request to
// the store, and once the account refreshes them the next read works; the host asks for them again shortly before
// they expire, so an account that refreshes ahead of time never sees a read fail.
func TestManifestMountCredentialsExpire(t *testing.T) {
	raw, digest := manifestBytes(t,
		ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 5, ETag: etag("hello")},
		ManifestFileEntry{Path: "b.txt", Key: "blobs/b", Size: 5, ETag: etag("world")},
		ManifestFileEntry{Path: "c.txt", Key: "blobs/c", Size: 5, ETag: etag("again")},
	)
	b := newManifestBed(t, map[string]string{"manifests/1.json": raw, "blobs/a": "hello", "blobs/b": "world", "blobs/c": "again"})
	b.source("bks_a", 10*time.Minute)
	h := b.mount("sbx", "bks_a", "manifests/1.json", digest).handler()
	shown := manifestOf(t, h)
	if rec := readRange(h, shown["a.txt"], "bytes=0-4"); rec.Body.String() != "hello" {
		t.Fatalf("a.txt: %d %q", rec.Code, rec.Body.String())
	}
	// The account didn't refresh them: past their expiry, reads fail cleanly and the store is never asked.
	b.advance(11 * time.Minute)
	gets := b.store.gets.Load()
	if rec := readRange(h, shown["b.txt"], "bytes=0-4"); rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "expired") {
		t.Errorf("b.txt, credentials expired: %d %q", rec.Code, rec.Body.String())
	}
	if b.store.gets.Load() != gets {
		t.Error("a request was made with expired credentials")
	}
	// What is cached is the entry's version, and stays readable.
	if rec := readRange(h, shown["a.txt"], "bytes=0-4"); rec.Body.String() != "hello" {
		t.Errorf("a.txt, cached: %d %q", rec.Code, rec.Body.String())
	}
	// Refreshed: the next read asks for the source again and works.
	b.source("bks_a", 10*time.Minute)
	if rec := readRange(h, shown["b.txt"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "world" {
		t.Errorf("b.txt, refreshed: %d %q", rec.Code, rec.Body.String())
	}
	// Refreshed ahead of time: within a minute of expiry the host takes the new ones before the old lapse.
	b.advance(9*time.Minute + 30*time.Second)
	b.source("bks_a", 10*time.Minute)
	b.advance(time.Minute)
	if rec := readRange(h, shown["c.txt"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "again" {
		t.Errorf("c.txt, refreshed ahead: %d %q", rec.Code, rec.Body.String())
	}
}

// One account's mounts never read another's cached bytes, even of the same object at the same version with the same
// key: short-lived credentials are cached by their source. The same source's other sandboxes, and the source after
// its credentials are refreshed, share them.
func TestManifestMountCacheIsPerSource(t *testing.T) {
	raw, digest := manifestBytes(t, ManifestFileEntry{Path: "a.txt", Key: "blobs/a", Size: 5, ETag: etag("hello")})
	b := newManifestBed(t, map[string]string{"manifests/1.json": raw, "blobs/a": "hello"})
	b.source("bks_a", time.Hour)
	b.source("bks_b", time.Hour)
	read := func(sandboxID, sourceID string) {
		t.Helper()
		h := b.mount(sandboxID, sourceID, "manifests/1.json", digest).handler()
		if rec := readRange(h, manifestOf(t, h)["a.txt"], "bytes=0-4"); rec.Body.String() != "hello" {
			t.Fatalf("%s: %d %q", sandboxID, rec.Code, rec.Body.String())
		}
	}
	blob := func() int64 {
		// Reads of the object itself, not of the manifest.
		return b.store.gets.Load()
	}
	// Two accounts' sources, each with exactly the same credentials (key, secret, token and expiry).
	read("sbx_a1", "bks_a")
	before := blob()
	read("sbx_b1", "bks_b")
	if got := blob() - before; got != 2 {
		t.Errorf("another account's source: %d store reads (want the manifest and a.txt, none from the cache)", got)
	}
	// The same source, its credentials refreshed since: a.txt from the cache.
	b.source("bks_a", 2*time.Hour)
	b.advance(sourceTTL)
	before = blob()
	read("sbx_a2", "bks_a")
	if got := blob() - before; got != 1 {
		t.Errorf("the same source, refreshed: %d store reads (want only the manifest)", got)
	}
}
