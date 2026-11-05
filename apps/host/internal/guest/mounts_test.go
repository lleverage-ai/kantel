package guest

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testMount is a bucketMount (no FUSE server) whose host is srv.
func testMount(srv *httptest.Server) *bucketMount {
	ms := &Mounts{Dial: func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}}
	m := &bucketMount{ms: ms, spec: MountSpec{Index: 0, Path: "/mnt/x"}}
	m.tree.Store(newTree(Manifest{}))
	return m
}

// An answer that ends before its Content-Length is a failed transfer: tried again, and an error if it stays short,
// never a short read the kernel would keep.
func TestReadAtRefusesAShortAnswer(t *testing.T) {
	const content = "0123456789"
	var asks atomic.Int64
	var shortFor atomic.Int64
	var query atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query.Store(r.URL.Query())
		n := asks.Add(1)
		w.Header().Set("content-length", strconv.Itoa(len(content)))
		w.WriteHeader(http.StatusOK)
		if n <= shortFor.Load() {
			// Cut short: the server closes the connection after these bytes.
			_, _ = w.Write([]byte(content[:4]))
			return
		}
		_, _ = w.Write([]byte(content))
	}))
	defer srv.Close()
	m := testMount(srv)
	e := ManifestEntry{Path: "f", Size: int64(len(content)), Tag: "t1", Proof: "proof1"}
	ctx := context.Background()

	shortFor.Store(1)
	p := make([]byte, len(content))
	if n, err := m.readAt(ctx, e, p, 0); err != nil || n != len(content) || string(p) != content {
		t.Errorf("a short answer, then a whole one: %d %q %v", n, p[:n], err)
	}
	if asks.Load() != 2 {
		t.Errorf("%d asks (want the short one tried again)", asks.Load())
	}
	// The read names the version it opened, with the host's proof of it.
	if q := query.Load().(url.Values); q.Get("tag") != "t1" || q.Get("k") != "proof1" || q.Get("size") != "10" || q.Get("path") != "f" {
		t.Errorf("the read's query: %v", q)
	}

	asks.Store(0)
	shortFor.Store(100)
	p = make([]byte, len(content))
	if n, err := m.readAt(ctx, e, p, 0); err == nil {
		t.Errorf("short answers every time: %d bytes and no error", n)
	}
}

// A manifest asked for earlier never replaces one asked for later, whichever answer comes first; a 304 keeps the
// tree there is.
func TestManifestUpdatesAreOrdered(t *testing.T) {
	release := make(chan struct{})
	asked := make(chan struct{}, 4)
	var version atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			asked <- struct{}{}
			if r.URL.Query().Get("have") == "" {
				// The background check's request: slow, and answering the listing it was asked about (version 1).
				<-release
				_ = json.NewEncoder(w).Encode(Manifest{Version: 1, Entries: []ManifestEntry{{Path: "old"}}})
				return
			}
			if r.URL.Query().Get("have") == strconv.FormatInt(version.Load(), 10) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			_ = json.NewEncoder(w).Encode(Manifest{Version: version.Load(), Entries: []ManifestEntry{{Path: "new"}}})
		case http.MethodPost:
			// The refresh: a newer listing (version 2).
			version.Store(2)
			_ = json.NewEncoder(w).Encode(Manifest{Version: 2, Entries: []ManifestEntry{{Path: "new"}}})
		}
	}))
	defer srv.Close()
	m := testMount(srv)
	ctx := context.Background()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := m.check(ctx); err != nil {
			t.Error(err)
		}
	}()
	<-asked
	refreshed := make(chan struct{})
	go func() {
		defer wg.Done()
		defer close(refreshed)
		if err := m.update(ctx, http.MethodPost, "refresh"); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-refreshed:
		t.Error("the refresh finished while an earlier check was still fetching")
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	wg.Wait()
	if v := m.tree.Load().version; v != 2 {
		t.Fatalf("the tree is version %d after the refresh (want 2: the earlier check's answer overwrote it)", v)
	}
	if _, ok := m.tree.Load().entries["new"]; !ok {
		t.Error("the tree isn't the refresh's")
	}
	// A check now: 304, and the tree stays.
	if err := m.check(ctx); err != nil {
		t.Fatal(err)
	}
	if v := m.tree.Load().version; v != 2 {
		t.Errorf("after a 304 the tree is version %d", v)
	}
}

// A refresh that changes only a file's modification time (the same bytes uploaded again, the same ETag) gives it a
// new inode, so a fresh lookup shows the new time rather than reusing the node holding the old one; the same entry
// keeps its inode (Lookup and Readdir agree).
func TestMetadataChangeIsANewInode(t *testing.T) {
	e := ManifestEntry{Path: "a.txt", Size: 5, MTimeMs: 1000, Tag: "e1", Proof: "p1"}
	same := e
	same.Proof = "p2"
	touched := e
	touched.MTimeMs = 2000
	ino := func(e ManifestEntry) uint64 { return inoFor("f", e.Path, fileVersion(e)) }
	if ino(e) != ino(same) {
		t.Error("the same version, another inode")
	}
	if ino(e) == ino(touched) {
		t.Error("a new modification time kept the inode")
	}
	resized := e
	resized.Size = 6
	if ino(e) == ino(resized) {
		t.Error("a new size kept the inode")
	}
}

// Release drops the bucket mounts at the paths it is given (a snapshot's, where the sandbox now has bundles), and
// only those, saving what is left; a guest without bucket mounts (nil) has nothing to release.
func TestReleaseDropsOnlyTheBucketMountsAtThosePaths(t *testing.T) {
	state := t.TempDir() + "/mounts.json"
	ms := &Mounts{StateFile: state, byPath: map[string]*bucketMount{}}
	for _, p := range []string{"/mnt/data", "/mnt/keep"} {
		ms.byPath[p] = &bucketMount{ms: ms, spec: MountSpec{Path: p, Key: "k" + p}}
	}
	ms.Release([]string{"/mnt/data", "/workspace/skills"})
	if _, ok := ms.byPath["/mnt/data"]; ok {
		t.Fatal("the bucket mount where a bundle goes is released")
	}
	if _, ok := ms.byPath["/mnt/keep"]; !ok {
		t.Fatal("another bucket mount stays")
	}
	raw, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	var saved []MountSpec
	if err := json.Unmarshal(raw, &saved); err != nil || len(saved) != 1 || saved[0].Path != "/mnt/keep" {
		t.Fatalf("what is left is saved: %s %v", raw, err)
	}
	var none *Mounts
	none.Release([]string{"/mnt/data"})
}

// A snapshot's bucket above or under a bundle's path goes too (Cerbie, fe96543c): one above would otherwise be
// unmounted later with the bundle inside it, and one under would be hidden by the bundle, its later unmount by path
// reaching into the bundle. One beside it, even sharing a prefix, stays.
func TestReleaseDropsTheBucketMountsAboveAndUnderThosePaths(t *testing.T) {
	ms := &Mounts{byPath: map[string]*bucketMount{}}
	for _, p := range []string{"/mnt/data", "/workspace/skills/old", "/mnt/database", "/srv/a", "/workspace"} {
		ms.byPath[p] = &bucketMount{ms: ms, spec: MountSpec{Path: p, Key: "k" + p}}
	}
	ms.Release([]string{"/mnt/data/skills", "/workspace/skills"})
	var left []string
	for p := range ms.byPath {
		left = append(left, p)
	}
	sort.Strings(left)
	if want := []string{"/mnt/database", "/srv/a"}; !reflect.DeepEqual(left, want) {
		t.Fatalf("left %v, want %v", left, want)
	}
}

func TestOverlaps(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"/mnt/data", "/mnt/data", true},
		{"/mnt/data", "/mnt/data/sub", true},
		{"/mnt/data/sub", "/mnt/data", true},
		{"/mnt/data", "/mnt/database", false},
		{"/mnt/database", "/mnt/data", false},
		{"/mnt/a", "/mnt/b", false},
	} {
		if got := overlaps(c.a, c.b); got != c.want {
			t.Errorf("overlaps(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
