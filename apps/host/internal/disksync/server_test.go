package disksync

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeSource holds one version of sticky disk sdk_1, sdv_1.
type fakeSource struct {
	path string
	raw  []byte
}

func (f fakeSource) Open(kind, objectID, version string, withMap bool) (*os.File, []byte, error) {
	if kind != "sticky" || objectID != "sdk_1" || version != "sdv_1" {
		return nil, nil, fs.ErrNotExist
	}
	file, err := os.Open(f.path)
	if !withMap {
		return file, nil, err
	}
	return file, f.raw, err
}

// testServer is a server for host_a, whose peer host_b is at fd4b::2 and host_c at fd4b::3.
func testServer(t *testing.T, key testKey) (*Server, []byte) {
	t.Helper()
	data := bytes.Repeat([]byte("0123456789abcdef"), 1<<16) // 1 MiB
	path := filepath.Join(t.TempDir(), "sdv_1.img")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	peers := map[netip.Addr]string{netip.MustParseAddr("fd4b::2"): "host_b", netip.MustParseAddr("fd4b::3"): "host_c"}
	return &Server{
		Source: fakeSource{path: path, raw: []byte("the map")},
		Self:   func() string { return "host_a" },
		Key:    func() string { return key.public },
		PeerAt: func(a netip.Addr) (string, bool) { id, ok := peers[a]; return id, ok },
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, data
}

func grantFor(to string, from ...string) Grant {
	return Grant{Kind: "sticky", ObjectID: "sdk_1", Version: "sdv_1", AccountID: "acc_1", From: from, To: to, Exp: time.Now().Add(15 * time.Minute).UnixMilli()}
}

func get(h http.Handler, path, remote, grant, rng string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.RemoteAddr = remote
	if grant != "" {
		r.Header.Set("Authorization", "Bearer "+grant)
	}
	if rng != "" {
		r.Header.Set("Range", rng)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestServerServesTheMapAndRangesOfTheVersionToTheGrantedPeer(t *testing.T) {
	key := newTestKey(t)
	s, data := testServer(t, key)
	h := s.Handler()
	grant := key.sign(t, grantFor("host_b", "host_c", "host_a"))
	w := get(h, "/v1/objects/sticky/sdk_1/sdv_1/map", "[fd4b::2]:40000", grant, "")
	if w.Code != http.StatusOK || w.Body.String() != "the map" {
		t.Fatalf("map: %d %q", w.Code, w.Body.String())
	}
	w = get(h, "/v1/objects/sticky/sdk_1/sdv_1/data", "[fd4b::2]:40000", grant, "bytes=4096-8191")
	if w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), data[4096:8192]) {
		t.Fatalf("data: %d, %d bytes", w.Code, w.Body.Len())
	}
	if got := w.Header().Get("Content-Range"); got != "bytes 4096-8191/1048576" {
		t.Fatalf("content-range: %q", got)
	}
}

func TestServerRefusesFetchesWithoutAGrantForThisHostAndPeer(t *testing.T) {
	key, other := newTestKey(t), newTestKey(t)
	s, _ := testServer(t, key)
	h := s.Handler()
	const path = "/v1/objects/sticky/sdk_1/sdv_1/data"
	expired := grantFor("host_b", "host_a")
	expired.Exp = time.Now().Add(-time.Second).UnixMilli()
	otherVersion := grantFor("host_b", "host_a")
	otherVersion.Version = "sdv_2"
	for name, c := range map[string]struct {
		remote, grant string
		want          int
	}{
		"no grant":              {"[fd4b::2]:1", "", http.StatusUnauthorized},
		"signed by another key": {"[fd4b::2]:1", other.sign(t, grantFor("host_b", "host_a")), http.StatusUnauthorized},
		"expired":               {"[fd4b::2]:1", key.sign(t, expired), http.StatusUnauthorized},
		"naming other holders":  {"[fd4b::2]:1", key.sign(t, grantFor("host_b", "host_c")), http.StatusForbidden},
		"for another host":      {"[fd4b::2]:1", key.sign(t, grantFor("host_c", "host_a")), http.StatusForbidden},
		"from the wrong peer":   {"[fd4b::3]:1", key.sign(t, grantFor("host_b", "host_a")), http.StatusForbidden},
		"from no peer":          {"[fd4b::9]:1", key.sign(t, grantFor("host_b", "host_a")), http.StatusForbidden},
		"for another version":   {"[fd4b::2]:1", key.sign(t, otherVersion), http.StatusForbidden},
	} {
		if w := get(h, path, c.remote, c.grant, "bytes=0-1"); w.Code != c.want {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	g := grantFor("host_b", "host_a")
	g.Version = "sdv_2"
	if w := get(h, "/v1/objects/sticky/sdk_1/sdv_2/map", "[fd4b::2]:1", key.sign(t, g), ""); w.Code != http.StatusNotFound {
		t.Errorf("a version it doesn't hold: %d", w.Code)
	}
	s.Key = func() string { return "" }
	if w := get(h, path, "[fd4b::2]:1", key.sign(t, grantFor("host_b", "host_a")), ""); w.Code != http.StatusServiceUnavailable {
		t.Errorf("without a grant key: %d", w.Code)
	}
}

// The server listens on the address it is given, speaks HTTP/2 without TLS, and stops; stopped before its listener is
// served, and started again at once, it listens again.
func TestServerListensOverHTTP2OnItsAddress(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback")
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	key := newTestKey(t)
	s, data := testServer(t, key)
	s.Port = port
	s.PeerAt = func(a netip.Addr) (string, bool) {
		if a == netip.IPv6Loopback() {
			return "host_b", true
		}
		return "", false
	}
	if err := s.Serve(netip.IPv6Loopback()); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Serve(netip.IPv6Loopback()); err != nil {
		t.Fatalf("serving again on the same address: %v", err)
	}
	var protocols http.Protocols
	protocols.SetUnencryptedHTTP2(true)
	client := &http.Client{Transport: &http.Transport{Protocols: &protocols}, Timeout: 10 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://[::1]:%d/v1/objects/sticky/sdk_1/sdv_1/data", port), nil)
	req.Header.Set("Authorization", "Bearer "+key.sign(t, grantFor("host_b", "host_a")))
	req.Header.Set("Range", "bytes=0-65535")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.ProtoMajor != 2 || res.StatusCode != http.StatusPartialContent || !bytes.Equal(body, data[:65536]) {
		t.Fatalf("%s %d, %d bytes", res.Proto, res.StatusCode, len(body))
	}
	if err := s.Serve(netip.Addr{}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(req.Clone(req.Context())); err == nil {
		t.Fatal("still served once stopped")
	}
	for range 20 {
		if err := s.Serve(netip.IPv6Loopback()); err != nil {
			t.Fatalf("started again: %v", err)
		}
		s.Close()
	}
	if err := s.Serve(netip.IPv6Loopback()); err != nil {
		t.Fatalf("started again: %v", err)
	}
	res, err = client.Do(req.Clone(req.Context()))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("started again: %d", res.StatusCode)
	}
}
