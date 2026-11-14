package disksync

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// progressOf is the fetcher's report of version v: false when it doesn't list it.
func progressOf(f *Fetcher, v string) (proto.FetchProgress, bool) {
	for _, p := range f.Progress() {
		if p.Version == v {
			return p, true
		}
	}
	return proto.FetchProgress{}, false
}

// eventually waits for the fetcher's report of version v to pass ok.
func eventually(t *testing.T, f *Fetcher, v string, ok func(proto.FetchProgress, bool) bool) proto.FetchProgress {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		p, listed := progressOf(f, v)
		if ok(p, listed) {
			return p
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s is reported %+v (listed %v)", v, p, listed)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A fetch is reported while it waits its turn and while it runs, with its blocks and how many are in place; one that
// fails is reported failed, with its error, while its partial is left; one asked for again goes on from there, carrying
// the error until it has done; one done isn't reported.
func TestFetchProgress(t *testing.T) {
	runBlocks = 1
	retryWait = time.Millisecond
	t.Cleanup(func() { runBlocks, retryWait = 16, time.Second })
	f := newFixture(t, 1)
	data := disk(t, 6, 0)
	clear(data[:block]) // a block of zeros, in place from the start
	f.put("v2", data)
	loc2 := f.location()
	h := f.holders[0]
	f.put("v3", disk(t, 1, 0))
	loc3 := f.location()
	loc3.MapDigest = blockmap.Digest(must(os.ReadFile(h.store.mapPath("v3"))))
	loc3.Grant = f.key.sign(t, Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "v3", From: []string{h.id}, To: "host_b", Exp: time.Now().Add(15 * time.Minute).UnixMilli()})

	// v2's holder serves three blocks, then holds the rest until gate; then it fails them (phase 1), or holds them until
	// hold and serves them (phase 2).
	gate, hold := make(chan struct{}), make(chan struct{})
	var served, phase atomic.Int32
	unavailable := func(w http.ResponseWriter) bool {
		http.Error(w, "gone", http.StatusServiceUnavailable)
		return true
	}
	h.fail = func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.Contains(r.URL.Path, "/v2/") {
			return false
		}
		switch phase.Load() {
		case 0:
			if served.Add(1) <= 3 {
				return false
			}
			<-gate
			if phase.Load() == 1 {
				return unavailable(w)
			}
			return false
		case 1:
			return unavailable(w)
		default:
			<-hold
			return false
		}
	}
	fetcher := f.fetcher()
	fetcher.Fetches = 1
	if got := fetcher.Progress(); got == nil || len(got) != 0 {
		t.Fatalf("no fetches reported as %#v, not as none", got)
	}
	ref2 := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	a := fetcher.Start(Request{Ref: ref2, MapDigest: loc2.MapDigest, Holders: loc2.Holders, Grant: loc2.Grant})

	// Under way: its six blocks, the block of zeros and the three served in place.
	p := eventually(t, fetcher, "v2", func(p proto.FetchProgress, _ bool) bool { return p.InPlace == 4 })
	if p.Kind != "sticky" || p.ObjectID != "sdk_1" || p.State != proto.FetchRunning || p.Blocks != 6 || p.Error != "" {
		t.Fatalf("running %+v", p)
	}
	// Another waits its turn, with nothing of it known yet.
	b := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v3"}, MapDigest: loc3.MapDigest, Holders: loc3.Holders, Grant: loc3.Grant})
	if q, ok := progressOf(fetcher, "v3"); !ok || q.State != proto.FetchQueued || q.Blocks != 0 || q.InPlace != 0 {
		t.Fatalf("queued %+v (listed %v)", q, ok)
	}

	// The holder stops serving: it fails, and is reported failed with what it had in place, its partial left.
	phase.Store(1)
	close(gate)
	if _, err := wait(t, a); err == nil {
		t.Fatal("a fetch from a holder that stopped serving succeeded")
	}
	if _, err := wait(t, b); err != nil {
		t.Fatal(err)
	}
	p, ok := progressOf(fetcher, "v2")
	if !ok || p.State != proto.FetchFailed || p.Blocks != 6 || p.InPlace != 4 || !strings.Contains(p.Error, "503") {
		t.Fatalf("failed %+v (listed %v)", p, ok)
	}
	if _, ok := progressOf(fetcher, "v3"); ok {
		t.Fatal("a version fetched is still reported")
	}

	// Asked for again, it goes on from what it had, reporting the last error until it has done.
	phase.Store(2)
	c := fetcher.Start(Request{Ref: ref2, MapDigest: loc2.MapDigest, Holders: loc2.Holders, Grant: loc2.Grant})
	p = eventually(t, fetcher, "v2", func(p proto.FetchProgress, _ bool) bool { return p.State == proto.FetchRunning })
	if p.Blocks != 6 || p.InPlace != 4 || !strings.Contains(p.Error, "503") {
		t.Fatalf("resumed %+v", p)
	}
	close(hold)
	if _, err := wait(t, c); err != nil {
		t.Fatal(err)
	}
	f.digest = loc2.MapDigest
	f.checkHeld("v2", data)
	if got := fetcher.Progress(); len(got) != 0 {
		t.Fatalf("after every fetch has done: %+v", got)
	}
}

// A fetch that fails before it has a partial (no holder) is reported failed for a while; one the control plane has no
// such version for isn't (its partial is discarded); a failed one whose version the host comes to hold isn't either.
func TestFetchProgressOfFailures(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 2, 0))
	fetcher := f.fetcher()
	f.locate = func(r Ref) (proto.DiskLocateResult, error) {
		switch r.Version {
		case "v4":
			return proto.DiskLocateResult{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such version"}
		default:
			return proto.DiskLocateResult{MapDigest: f.digest}, nil
		}
	}
	for _, v := range []string{"v2", "v4"} {
		if _, err := wait(t, fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: v}})); err == nil {
			t.Fatalf("%s fetched from nowhere", v)
		}
	}
	got := fetcher.Progress()
	if len(got) != 1 || got[0].Version != "v2" || got[0].State != proto.FetchFailed || got[0].Blocks != 0 ||
		!strings.Contains(got[0].Error, errNoHolder.Error()) {
		t.Fatalf("failures %+v", got)
	}
	// Past failedKeep, with no partial, it is forgotten.
	fetcher.mu.Lock()
	fl := fetcher.failed[Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}]
	fl.at = time.Now().Add(-failedKeep - time.Second)
	fetcher.failed[Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}] = fl
	fetcher.mu.Unlock()
	if got := fetcher.Progress(); len(got) != 0 {
		t.Fatalf("an old failure with no partial: %+v", got)
	}

	// A failure the host then holds the version of (fetched by another way, say) isn't reported.
	if _, err := wait(t, fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); err == nil {
		t.Fatal("v2 fetched from nowhere")
	}
	if _, ok := progressOf(fetcher, "v2"); !ok {
		t.Fatal("a new failure isn't reported")
	}
	f.local.put(t, "v2", disk(t, 2, 0))
	if got := fetcher.Progress(); len(got) != 0 {
		t.Fatalf("a failure of a version held: %+v", got)
	}
}

// A fetch that fails once its map is read and its partial opened (no room for the rest, after a restart) reports the
// version's blocks and those its partial has in place.
func TestFetchProgressOfAFetchWithNoRoom(t *testing.T) {
	runBlocks = 1
	retryWait = time.Millisecond
	t.Cleanup(func() { runBlocks, retryWait = 16, time.Second })
	f := newFixture(t, 1)
	f.put("v2", disk(t, 12, 0))
	h := f.holders[0]
	var served atomic.Int32
	h.fail = func(w http.ResponseWriter, r *http.Request) bool {
		if served.Add(1) > 5 {
			http.Error(w, "gone", http.StatusServiceUnavailable)
			return true
		}
		return false
	}
	ref := Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}
	if _, err := wait(t, f.fetcher().Start(Request{Ref: ref})); err == nil {
		t.Fatal("a fetch from a holder that stopped serving succeeded")
	}
	// The host restarts with too little room for the rest.
	f.local.room = 1
	restarted := f.fetcher()
	if _, err := wait(t, restarted.Start(Request{Ref: ref})); !isCapacity(err) {
		t.Fatalf("with no room: %v", err)
	}
	p, ok := progressOf(restarted, "v2")
	if !ok || p.State != proto.FetchFailed || p.Blocks != 12 || p.InPlace != 5 || p.Error == "" {
		t.Fatalf("failed for room %+v (listed %v)", p, ok)
	}
}

// A version the host holds, asked for while it waits its turn, isn't reported as a fetch.
func TestFetchProgressLeavesOutAVersionHeld(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 1, 0))
	f.local.put(t, "v5", disk(t, 1, 0))
	release := make(chan struct{})
	fetcher := f.fetcher()
	fetcher.Fetches = 1
	fetcher.Locate = func(ctx context.Context, r Ref) (proto.DiskLocateResult, error) {
		<-release
		return f.location(), nil
	}
	a := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})
	b := fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v5"}})
	eventually(t, fetcher, "v2", func(p proto.FetchProgress, _ bool) bool { return p.State == proto.FetchRunning })
	if got := fetcher.Progress(); len(got) != 1 || got[0].Version != "v2" {
		t.Fatalf("progress %+v", got)
	}
	close(release)
	for _, j := range []*Job{a, b} {
		if _, err := wait(t, j); err != nil {
			t.Fatal(err)
		}
	}
}

// A fetch whose partial can't be made (no room for a full copy of the nearest version) still reports the blocks its map
// gave.
func TestFetchProgressOfAPartialNotMade(t *testing.T) {
	f := newFixture(t, 1)
	f.put("v2", disk(t, 3, 0))
	f.local.cloneErr = &proto.Error{Code: proto.ErrCapacity, Message: "no room for a full copy"}
	fetcher := f.fetcher()
	if _, err := wait(t, fetcher.Start(Request{Ref: Ref{Kind: "sticky", ObjectID: "sdk_1", Version: "v2"}})); !isCapacity(err) {
		t.Fatalf("with no room for the clone: %v", err)
	}
	if p, ok := progressOf(fetcher, "v2"); !ok || p.State != proto.FetchFailed || p.Blocks != 3 || p.InPlace != 0 {
		t.Fatalf("failed %+v (listed %v)", p, ok)
	}
}
