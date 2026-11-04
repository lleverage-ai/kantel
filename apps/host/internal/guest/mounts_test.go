package guest

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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
