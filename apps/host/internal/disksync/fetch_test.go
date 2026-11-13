package disksync

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// dirStore is a host's versions of sticky disk sdk_1 in a directory: <version>.img and <version>.map.
type dirStore struct {
	dir string
	// base, when set, is the version CloneNearest clones.
	base string
	// cloned, when set, is called once CloneNearest has made its clone.
	cloned func(dst string)
	// cloneErr, when set, is what CloneNearest fails with.
	cloneErr error
	// room is the most a fetch may reserve (0: no limit); reserved what is reserved now, and most the most at once.
	mu             sync.Mutex
	room           int64
	reserved, most int64
}

func (s *dirStore) Reserve(r Ref, bytes int64) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.room > 0 && s.reserved+bytes > s.room {
		return nil, &proto.Error{Code: proto.ErrCapacity, Message: "no room"}
	}
	s.reserved += bytes
	s.most = max(s.most, s.reserved)
	return func() {
		s.mu.Lock()
		s.reserved -= bytes
		s.mu.Unlock()
	}, nil
}

func (s *dirStore) img(v string) string { return filepath.Join(s.dir, v+".img") }
func (s *dirStore) mapPath(v string) string {
	return filepath.Join(s.dir, v+".map")
}

func (s *dirStore) Open(kind, objectID, version string, _ bool) (*os.File, []byte, error) {
	if kind != "sticky" || objectID != "sdk_1" {
		return nil, nil, fs.ErrNotExist
	}
	raw, err := os.ReadFile(s.mapPath(version))
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(s.img(version))
	return f, raw, err
}

func (s *dirStore) Held(r Ref) bool { _, err := os.Stat(s.img(r.Version)); return err == nil }

func (s *dirStore) Partial(r Ref) (string, error) {
	return filepath.Join(s.dir, r.Version+".partial"), nil
}

func (s *dirStore) CloneNearest(r Ref, dst string) (*blockmap.Map, error) {
	if s.cloneErr != nil {
		return nil, s.cloneErr
	}
	if s.base == "" {
		return nil, nil
	}
	m, _, err := blockmap.ReadFile(s.mapPath(s.base))
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(s.img(s.base))
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		return nil, err
	}
	if s.cloned != nil {
		s.cloned(dst)
	}
	return m, nil
}

func (s *dirStore) Publish(r Ref, partial *os.File, mapFile []byte) error {
	path, _ := s.Partial(r)
	mine, _ := partial.Stat()
	if now, err := os.Stat(path); err != nil || !os.SameFile(mine, now) {
		return errors.New("the partial was removed")
	}
	if err := os.WriteFile(s.mapPath(r.Version), mapFile, 0o600); err != nil {
		return err
	}
	return os.Rename(path, s.img(r.Version))
}

func (s *dirStore) Partials() []Ref {
	matches, _ := filepath.Glob(filepath.Join(s.dir, "*.partial"))
	var out []Ref
	for _, m := range matches {
		out = append(out, Ref{Kind: "sticky", ObjectID: "sdk_1", Version: strings.TrimSuffix(filepath.Base(m), ".partial")})
	}
	return out
}

func (s *dirStore) Discard(r Ref) {
	p, _ := s.Partial(r)
	_ = os.Remove(p)
	_ = os.Remove(p + ".done")
}

// put makes version v of data in the store, with its map, and answers its digest.
func (s *dirStore) put(t *testing.T, v string, data []byte) string {
	t.Helper()
	if err := os.WriteFile(s.img(v), data, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(s.img(v))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m, _, err := blockmap.Make(context.Background(), f, nil)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := blockmap.WriteFile(s.mapPath(v), m)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

// fixture is a fetching host (b) and its holders (a1, a2, ...), each serving its own store on a loopback address,
// all on one port, with grants the test key signs.
type fixture struct {
	t       *testing.T
	key     testKey
	port    int
	local   *dirStore
	holders []*holderFixture
	locates atomic.Int32
	// locate is what Locate answers (default: every holder, with a good grant).
	locate func(r Ref) (proto.DiskLocateResult, error)
	digest string
}

type holderFixture struct {
	id    string
	addr  netip.Addr
	store *dirStore
	srv   *Server
	// fail, when set, answers a data request instead of the server: false lets it through.
	fail func(w http.ResponseWriter, r *http.Request) bool
	// data counts the data requests the holder served.
	data atomic.Int32
}

func newFixture(t *testing.T, holders int) *fixture {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	f := &fixture{t: t, key: newTestKey(t), port: port, local: &dirStore{dir: t.TempDir()}}
	log := slog.New(slog.DiscardHandler)
	for i := range holders {
		h := &holderFixture{id: "host_a" + string(rune('1'+i)), addr: netip.AddrFrom4([4]byte{127, 0, 0, byte(i + 1)}), store: &dirStore{dir: t.TempDir()}}
		h.srv = &Server{
			Source: h.store, Self: func() string { return h.id }, Key: func() string { return f.key.public },
			PeerAt: func(a netip.Addr) (string, bool) { return "host_b", a.IsLoopback() }, Log: log, Port: port,
		}
		inner := h.srv.Handler()
		mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/data") {
				if h.fail != nil && h.fail(w, r) {
					return
				}
				h.data.Add(1)
			}
			inner.ServeHTTP(w, r)
		})
		ln, err := net.Listen("tcp", netip.AddrPortFrom(h.addr, uint16(port)).String())
		if err != nil {
			t.Skipf("can't listen on %s: %v", h.addr, err)
		}
		var protocols http.Protocols
		protocols.SetHTTP1(true)
		protocols.SetUnencryptedHTTP2(true)
		srv := &http.Server{Handler: mux, Protocols: &protocols}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close() })
		f.holders = append(f.holders, h)
	}
	return f
}

func (f *fixture) grant(exp time.Time) string {
	from := []string{}
	for _, h := range f.holders {
		from = append(from, h.id)
	}
	return f.key.sign(f.t, Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "v2", AccountID: "acc_1", From: from, To: "host_b", Exp: exp.UnixMilli()})
}

func (f *fixture) location() proto.DiskLocateResult {
	res := proto.DiskLocateResult{MapDigest: f.digest, Grant: f.grant(time.Now().Add(15 * time.Minute))}
	for _, h := range f.holders {
		res.Holders = append(res.Holders, proto.DiskHolder{HostID: h.id, Address: h.addr.String()})
	}
	return res
}

func (f *fixture) fetcher() *Fetcher {
	return &Fetcher{
		Store: f.local, Port: f.port, Log: slog.New(slog.DiscardHandler),
		Locate: func(ctx context.Context, r Ref) (proto.DiskLocateResult, error) {
			f.locates.Add(1)
			if f.locate != nil {
				return f.locate(r)
			}
			return f.location(), nil
		},
	}
}

// put makes version v on every holder.
func (f *fixture) put(v string, data []byte) {
	for _, h := range f.holders {
		f.digest = h.store.put(f.t, v, data)
	}
}

func wait(t *testing.T, j *Job) (Stats, error) {
	t.Helper()
	select {
	case <-j.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("the fetch didn't end")
	}
	return j.Result()
}

const block = blockmap.BlockSize

// disk is n blocks of random data, with block zero (if wanted) all zeros, and tail extra bytes.
func disk(t *testing.T, n int, tail int) []byte {
	t.Helper()
	data := make([]byte, n*block+tail)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	return data
}

func (f *fixture) checkHeld(v string, want []byte) {
	f.t.Helper()
	got, err := os.ReadFile(f.local.img(v))
	if err != nil {
		f.t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		f.t.Fatalf("the fetched %s differs from the holders' (%d bytes, want %d)", v, len(got), len(want))
	}
	if raw, err := os.ReadFile(f.local.mapPath(v)); err != nil || blockmap.Digest(raw) != f.digest {
		f.t.Fatalf("the fetched %s's map: %v", v, err)
	}
	if left, _ := filepath.Glob(filepath.Join(f.local.dir, "*.partial*")); len(left) != 0 {
		f.t.Fatalf("left behind: %v", left)
	}
}

// With nothing of the disk, a fetch asks where the version is and fetches every block with data from the holders.
func TestFetchFromNothing(t *testing.T) {
	f := newFixture(t, 2)
	data := disk(t, 5, 1000)
	clear(data[block : 2*block]) // a block of zeros, never fetched
	f.put("v2", data)
	st, err := wait(t, f.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}}))
	if err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	if st.Blocks != 6 || st.Fetched != 5 || st.FetchedBytes != int64(4*block+1000) || f.locates.Load() != 1 {
		t.Fatalf("stats %+v, locates %d", st, f.locates.Load())
	}
	// It held room for what it might write (the blocks it fetched and the block of zeros), and gave it back.
	if f.local.most != int64(5*block+1000) || f.local.reserved != 0 {
		t.Fatalf("reserved %d at most, %d now", f.local.most, f.local.reserved)
	}
	if f.holders[0].data.Load() == 0 || f.holders[1].data.Load() == 0 {
		t.Fatalf("runs not spread over the holders: %d, %d", f.holders[0].data.Load(), f.holders[1].data.Load())
	}
}

// From the nearest version, only the blocks that differ cross the network; a block zero in the new version but not in
// the old is cleared; the size may change.
func TestFetchOnlyTheBlocksThatDiffer(t *testing.T) {
	f := newFixture(t, 1)
	old := disk(t, 8, 0)
	f.local.put(t, "v1", old)
	f.local.base = "v1"
	data := append(append([]byte{}, old...), disk(t, 1, 512)...) // grown by a block and a bit
	copy(data[2*block:3*block], disk(t, 1, 0))                   // changed
	clear(data[5*block : 6*block])                               // zeroed
	f.put("v2", data)
	loc := f.location()
	st, err := wait(t, f.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}, MapDigest: loc.MapDigest, Holders: loc.Holders, Grant: loc.Grant}))
	if err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	// Block 2 changed, blocks 8 and 9 are new.
	if st.Fetched != 3 || st.FetchedBytes != int64(2*block+512) || st.Reused != 7 || f.locates.Load() != 0 {
		t.Fatalf("stats %+v, locates %d", st, f.locates.Load())
	}
}

// A fetch cut short goes on from its bitmap: blocks in place aren't fetched again.
func TestFetchResumes(t *testing.T) {
	runBlocks = 1
	retryWait = time.Millisecond
	t.Cleanup(func() { runBlocks, retryWait = 16, time.Second })
	f := newFixture(t, 1)
	data := disk(t, 12, 0)
	f.put("v2", data)
	h := f.holders[0]
	var served atomic.Int32
	h.fail = func(w http.ResponseWriter, r *http.Request) bool {
		if served.Add(1) > 5 {
			http.Error(w, "gone", http.StatusServiceUnavailable)
			return true
		}
		return false
	}
	fetcher := f.fetcher()
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	if _, err := wait(t, fetcher.Start(Request{Ref: ref})); err == nil {
		t.Fatal("a fetch from a holder that stopped serving succeeded")
	}
	if f.local.Held(ref) {
		t.Fatal("published unfinished")
	}
	if got := f.local.Partials(); len(got) != 1 || got[0] != ref {
		t.Fatalf("partials %v", got)
	}
	h.fail = nil
	before := h.data.Load()
	fetcher.ResumeAll()
	fetcher.mu.Lock()
	j := fetcher.jobs[ref]
	fetcher.mu.Unlock()
	if j == nil {
		t.Fatal("ResumeAll started nothing")
	}
	st, err := wait(t, j)
	if err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	if !st.Resumed || st.Fetched != 12-int(before) || h.data.Load()-before != int32(st.Fetched) {
		t.Fatalf("stats %+v, served before %d, after %d", st, before, h.data.Load())
	}
}

// A holder that gives a block whose hash is wrong is passed over; with no other, nothing is published.
func TestFetchChecksEachBlock(t *testing.T) {
	retryWait = time.Millisecond
	t.Cleanup(func() { retryWait = time.Second })
	f := newFixture(t, 2)
	data := disk(t, 3, 0)
	f.put("v2", data)
	bad := append([]byte{}, data...)
	bad[block+7] ^= 1
	// The first holder's file is corrupt (its map is the good one's).
	if err := os.WriteFile(f.holders[0].store.img("v2"), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)

	g := newFixture(t, 1)
	g.put("v2", data)
	if err := os.WriteFile(g.holders[0].store.img("v2"), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := wait(t, g.fetcher().Start(Request{Ref: ref})); err == nil || !strings.Contains(err.Error(), "wrong hash") {
		t.Fatalf("a corrupt holder alone: %v", err)
	}
	if g.local.Held(ref) {
		t.Fatal("a corrupt version was published")
	}
}

// A clone removed before the fetch opens it (its version deleted meanwhile) fails the fetch: an empty file in its
// place would be taken for the clone, its blocks the base's map vouches for never fetched.
func TestFetchOfAPartialRemovedUnderIt(t *testing.T) {
	f := newFixture(t, 1)
	old := disk(t, 2, 0)
	f.local.put(t, "v1", old)
	f.local.base = "v1"
	data := append(append([]byte{}, old...), disk(t, 1, 0)...)
	f.put("v2", data)
	f.local.cloned = func(dst string) { _ = os.Remove(dst) }
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); err == nil {
		t.Fatal("fetched onto a clone that was removed")
	}
	if f.local.Held(ref) {
		t.Fatal("published")
	}
}

// A slow --sync-rate makes a request long, which is fine while bytes come; a holder that sends nothing is given up
// for another once stallTimeout passes.
func TestFetchGivesUpStalledRequestsOnly(t *testing.T) {
	stall := stallTimeout
	stallTimeout = 300 * time.Millisecond
	retryWait = time.Millisecond
	t.Cleanup(func() { stallTimeout, retryWait = stall, time.Second })
	f := newFixture(t, 2)
	data := disk(t, 2, 0)
	f.put("v2", data)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	f.holders[0].fail = func(w http.ResponseWriter, r *http.Request) bool {
		<-release
		return true
	}
	fetcher := f.fetcher()
	// 4 MiB/s: 8 MiB takes about two seconds, much longer than the stall timeout.
	fetcher.Limit = NewLimiter(4 << 20)
	start := time.Now()
	if _, err := wait(t, fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	if took := time.Since(start); took < time.Second {
		t.Fatalf("8 MiB at 4 MiB/s took %s", took)
	}
	if f.holders[1].data.Load() == 0 {
		t.Fatal("not fetched from the holder that answers")
	}
}

// A resume asked for while a fetch is failing (the control plane back) starts it again once it has failed.
func TestResumeWhileAFetchFails(t *testing.T) {
	f := newFixture(t, 1)
	data := disk(t, 1, 0)
	f.put("v2", data)
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	partial, _ := f.local.Partial(ref)
	if err := os.WriteFile(partial, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	asked := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	f.locate = func(Ref) (proto.DiskLocateResult, error) {
		if calls.Add(1) == 1 {
			close(asked)
			<-release
			return proto.DiskLocateResult{}, &proto.Error{Code: proto.ErrUnavailable, Message: "disconnected"}
		}
		return f.location(), nil
	}
	fetcher := f.fetcher()
	first := fetcher.Start(Request{Ref: ref})
	<-asked
	fetcher.ResumeAll()
	close(release)
	if _, err := wait(t, first); err == nil {
		t.Fatal("the first try didn't fail")
	}
	deadline := time.Now().Add(10 * time.Second)
	for !f.local.Held(ref) {
		if time.Now().After(deadline) {
			t.Fatal("not fetched again after the resume")
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.checkHeld("v2", data)
}

// A fetch the host has no room for writes nothing: neither the blocks it lacks, nor (with no room for a full copy of
// its nearest version) the whole version from nothing.
func TestFetchNeedsRoom(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 2, 0))
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	f.local.room = block
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); !isCapacity(err) {
		t.Fatalf("with room for one block of two: %v", err)
	}
	// What it prepared is kept for when there is room; a fetch from afresh needs a clone of the nearest version.
	if got := f.local.Partials(); len(got) != 1 {
		t.Fatalf("partials %v", got)
	}
	f.local.Discard(ref)
	f.local.room = 0
	f.local.cloneErr = &proto.Error{Code: proto.ErrCapacity, Message: "no room for a full copy"}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); !isCapacity(err) {
		t.Fatalf("with no room to copy the nearest version: %v", err)
	}
	if f.holders[0].data.Load() != 0 || f.local.Held(ref) {
		t.Fatal("fetched without room")
	}
}

func isCapacity(err error) bool {
	var pe *proto.Error
	return errors.As(err, &pe) && pe.Code == proto.ErrCapacity
}

// A holder that redirects is a holder that failed: the fetch never goes where it points.
func TestFetchFollowsNoRedirect(t *testing.T) {
	f := newFixture(t, 3)
	data := disk(t, 2, 0)
	f.put("v2", data)
	// The third serves, but isn't a holder disk.locate names; the first redirects there.
	elsewhere := f.holders[2]
	f.holders = f.holders[:2]
	var visited atomic.Int32
	elsewhere.fail = func(w http.ResponseWriter, r *http.Request) bool { visited.Add(1); return false }
	f.holders[0].fail = func(w http.ResponseWriter, r *http.Request) bool {
		http.Redirect(w, r, "http://"+netip.AddrPortFrom(elsewhere.addr, uint16(f.port)).String()+r.URL.Path, http.StatusFound)
		return true
	}
	retryWait = time.Millisecond
	t.Cleanup(func() { retryWait = time.Second })
	if _, err := wait(t, f.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	if visited.Load() != 0 {
		t.Fatalf("followed a redirect %d times", visited.Load())
	}
}

// A partial of a version the host holds (published, then the host stopped before removing it) is removed, and nothing
// fetched.
func TestFetchOfAVersionHeldDropsItsPartial(t *testing.T) {
	f := newFixture(t, 1)
	data := disk(t, 1, 0)
	f.local.put(t, "v2", data)
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	partial, _ := f.local.Partial(ref)
	for _, path := range []string{partial, partial + ".done"} {
		if err := os.WriteFile(path, []byte("left"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fetcher := f.fetcher()
	fetcher.ResumeAll()
	deadline := time.Now().Add(5 * time.Second)
	for len(f.local.Partials()) != 0 || fetcher.Running(ref) {
		if time.Now().After(deadline) {
			t.Fatal("the partial of a version held was kept")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(partial + ".done"); !errors.Is(err, fs.ErrNotExist) || f.locates.Load() != 0 {
		t.Fatalf("bitmap kept, or asked where it is (%d)", f.locates.Load())
	}
	if got, _ := os.ReadFile(f.local.img("v2")); !bytes.Equal(got, data) {
		t.Fatal("the version held changed")
	}
}

// Where holes can't be punched, zero blocks are cleared by writing zeros over the data they have only, taking no room:
// a version's zero blocks fetched onto an empty file write nothing, and a block of the base's that is zeros now is
// written over.
func TestFetchClearsZerosWithoutHoles(t *testing.T) {
	punch := punchHole
	punchHole = func(*os.File, int64, int64) error { return unix.EOPNOTSUPP }
	t.Cleanup(func() { punchHole = punch })
	f := newFixture(t, 1)
	empty := make([]byte, 64*block)
	f.put("v2", empty)
	if _, err := wait(t, f.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", empty)
	var st syscall.Stat_t
	if err := syscall.Stat(f.local.img("v2"), &st); err != nil {
		t.Fatal(err)
	}
	if st.Blocks*512 > block {
		t.Fatalf("a 256 MiB version of zeros took %d bytes", st.Blocks*512)
	}
	// Room was held for the zeros all the same: where holes can't be punched, clearing may write.
	if f.local.most != int64(len(empty)) || f.local.reserved != 0 {
		t.Fatalf("reserved %d at most, %d now", f.local.most, f.local.reserved)
	}
	// Without that room, nothing is cleared or written.
	h := newFixture(t, 1)
	h.put("v2", empty)
	h.local.room = block
	if _, err := wait(t, h.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); !isCapacity(err) {
		t.Fatalf("zeros without room: %v", err)
	}

	g := newFixture(t, 1)
	old := disk(t, 3, 0)
	g.local.put(t, "v1", old)
	g.local.base = "v1"
	data := append([]byte{}, old...)
	clear(data[block : 2*block])
	g.put("v2", data)
	if _, err := wait(t, g.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); err != nil {
		t.Fatal(err)
	}
	g.checkHeld("v2", data)
}

// A map that isn't the catalogue's is refused.
func TestFetchChecksTheMap(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 2, 0))
	f.digest = "sha256:" + strings.Repeat("0", 64)
	_, err := wait(t, f.fetcher().Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}}))
	if err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("a map with another digest: %v", err)
	}
}

// A grant the holders refuse (expired here), or one about to expire, is replaced by asking disk.locate again.
func TestFetchAsksForANewGrant(t *testing.T) {
	f := newFixture(t, 1)
	data := disk(t, 2, 0)
	f.put("v2", data)
	loc := f.location()
	stale := f.grant(time.Now().Add(-time.Second))
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref, MapDigest: loc.MapDigest, Holders: loc.Holders, Grant: stale})); err != nil {
		t.Fatal(err)
	}
	f.checkHeld("v2", data)
	if f.locates.Load() != 1 {
		t.Fatalf("locates %d", f.locates.Load())
	}
}

// A version the control plane doesn't know (deleted) has what was fetched of it removed; one no host holds fails.
func TestFetchOfAVersionGone(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 1, 0))
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	partial, _ := f.local.Partial(ref)
	if err := os.WriteFile(partial, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.locate = func(Ref) (proto.DiskLocateResult, error) {
		return proto.DiskLocateResult{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such version"}
	}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); !IsNotFound(err) {
		t.Fatalf("%v", err)
	}
	if _, err := os.Stat(partial); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("the partial of a deleted version was kept")
	}
	f.locate = func(Ref) (proto.DiskLocateResult, error) {
		return proto.DiskLocateResult{MapDigest: f.digest, Holders: []proto.DiskHolder{}}, nil
	}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); !errors.Is(err, errNoHolder) {
		t.Fatalf("%v", err)
	}
}

// A version being fetched is fetched once, however often it is asked for; at most Fetches run at once.
func TestFetchesOnceAndAtMostFetchesAtOnce(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 1, 0))
	f.put("v3", disk(t, 1, 0))
	release := make(chan struct{})
	var mu sync.Mutex
	asked := []string{}
	fetcher := f.fetcher()
	fetcher.Fetches = 1
	fetcher.Locate = func(ctx context.Context, r Ref) (proto.DiskLocateResult, error) {
		mu.Lock()
		asked = append(asked, r.Version)
		mu.Unlock()
		<-release
		loc := f.location()
		loc.Grant = f.key.sign(t, Grant{Kind: "sticky", ObjectID: "sdk_1", Version: r.Version, From: []string{"host_a1"}, To: "host_b", Exp: time.Now().Add(time.Minute * 15).UnixMilli()})
		loc.MapDigest = blockmap.Digest(must(os.ReadFile(f.holders[0].store.mapPath(r.Version))))
		return loc, nil
	}
	a := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})
	if again := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}}); again != a {
		t.Fatal("a second job for the same version")
	}
	b := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v3"}})
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if len(asked) != 1 {
		t.Fatalf("asked %v with one fetch at a time", asked)
	}
	mu.Unlock()
	close(release)
	for _, j := range []*Job{a, b} {
		if _, err := wait(t, j); err != nil {
			t.Fatal(err)
		}
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// The limiter holds bytes to its rate, past a short burst.
func TestLimiter(t *testing.T) {
	l := NewLimiter(4 << 20) // 4 MiB/s
	start := time.Now()
	for range 8 {
		if err := l.Wait(context.Background(), 256<<10); err != nil {
			t.Fatal(err)
		}
	}
	// 2 MiB at 4 MiB/s, less the burst's quarter second: about a quarter of a second.
	if took := time.Since(start); took < 200*time.Millisecond || took > 2*time.Second {
		t.Fatalf("2 MiB at 4 MiB/s took %s", took)
	}
	if NewLimiter(0) != nil || NewLimiter(-1).Wait(context.Background(), 1<<30) != nil {
		t.Fatal("a limit of none held something back")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 10 {
		if err := l.Wait(ctx, 64<<20); err == nil {
			t.Fatal("a cancelled wait waited")
		}
	}
	// Cancelled waits leave no debt: the next bytes go at once (within the burst).
	start = time.Now()
	if err := l.Wait(context.Background(), 1); err != nil || time.Since(start) > time.Second {
		t.Fatalf("a wait after cancelled ones took %s", time.Since(start))
	}
	r := limitedReader{ctx: context.Background(), r: bytes.NewReader(make([]byte, 1<<20)), l: nil}
	if n, _ := io.Copy(io.Discard, r); n != 1<<20 {
		t.Fatal(n)
	}
}

func TestLinkSpeed(t *testing.T) {
	dir := t.TempDir()
	routes := filepath.Join(dir, "route")
	sys := filepath.Join(dir, "net")
	if err := os.MkdirAll(filepath.Join(sys, "eth0"), 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(routes, []byte("Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"+
		"docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"+
		"eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"), 0o600)
	_ = os.WriteFile(filepath.Join(sys, "eth0", "speed"), []byte("1000\n"), 0o600)
	if got := linkSpeed(routes, sys); got != 1000 {
		t.Fatalf("speed %d", got)
	}
	_ = os.WriteFile(filepath.Join(sys, "eth0", "speed"), []byte("-1\n"), 0o600)
	if got := linkSpeed(routes, sys); got != 0 {
		t.Fatalf("unknown speed: %d", got)
	}
}
