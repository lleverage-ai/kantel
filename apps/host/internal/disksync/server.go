package disksync

// The peer server: plain HTTP/2 (WireGuard encrypts it) on the host's mesh address only, on port 7480, which the
// firewall opens to the pool's prefix alone.
//
//	GET /v1/objects/{kind}/{id}/{version}/map    the version's block map
//	GET /v1/objects/{kind}/{id}/{version}/data   the version's bytes, a run of blocks with Range
//
// Each request carries a grant (Authorization: Bearer <grant>) the control plane signed, naming this host in from and
// the asking peer as to. Which peer asks is the request's source address: WireGuard takes a packet from a peer only
// from that peer's one mesh address, so the address proves the peer.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"
)

// Port is the server's TCP port on the mesh address (mesh.SyncPort).
const Port = 7480

// Source is the versions the host holds.
type Source interface {
	// Open opens a version: its file, and its block map's file. fs.ErrNotExist when the host doesn't hold it, or has no
	// map of it yet. The file stays readable while open, whatever is deleted meanwhile.
	Open(kind, objectID, version string) (*os.File, []byte, error)
}

// Server serves the versions the host holds to its mesh peers.
type Server struct {
	Source Source
	// Self is this host's ID, which a grant must name in from.
	Self func() string
	// Key is the control plane's grant key (Welcome.GrantKey); "" while it has none, when nothing is served.
	Key func() string
	// PeerAt is the pool host at a mesh address, the host the peer reports: false for none.
	PeerAt func(addr netip.Addr) (hostID string, ok bool)
	Log    *slog.Logger
	// Now is the clock grants are checked against (default time.Now).
	Now func() time.Time
	// Port is the TCP port it listens on (default Port).
	Port int

	mu   sync.Mutex
	addr netip.Addr
	srv  *http.Server
}

// Serve makes the server listen on addr's Port, or with no addr stop: it is called whenever the mesh comes up, goes
// down or changes address. Listening on the address it listens on already does nothing.
func (s *Server) Serve(addr netip.Addr) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil && s.addr == addr {
		return nil
	}
	s.stopLocked()
	if !addr.IsValid() {
		return nil
	}
	port := s.Port
	if port == 0 {
		port = Port
	}
	ln, err := net.Listen("tcp", netip.AddrPortFrom(addr, uint16(port)).String())
	if err != nil {
		return fmt.Errorf("peer sync server: %w", err)
	}
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	srv := &http.Server{
		Handler:           s.Handler(),
		Protocols:         &protocols,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(s.Log.Handler(), slog.LevelDebug),
	}
	s.srv, s.addr = srv, addr
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.Log.Warn("the peer sync server stopped", "error", err)
		}
	}()
	s.Log.Info("peer sync server listening", "address", ln.Addr().String())
	return nil
}

// Close stops the server.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
}

func (s *Server) stopLocked() {
	if s.srv == nil {
		return
	}
	// Transfers under way end now: the mesh is gone, or moved.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.srv.Shutdown(ctx); err != nil {
		_ = s.srv.Close()
	}
	s.srv, s.addr = nil, netip.Addr{}
}

// Handler is the server's routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/objects/{kind}/{id}/{version}/map", func(w http.ResponseWriter, r *http.Request) {
		f, raw, ok := s.open(w, r)
		if !ok {
			return
		}
		f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(raw))
	})
	mux.HandleFunc("GET /v1/objects/{kind}/{id}/{version}/data", func(w http.ResponseWriter, r *http.Request) {
		f, _, ok := s.open(w, r)
		if !ok {
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		// A version's file never changes once it is published: no validators, so a Range is always served.
		http.ServeContent(w, r, "", time.Time{}, f)
	})
	return mux
}

// open checks the request's grant and opens the version it names, or answers why not: 401 without a valid grant, 403
// with one that isn't for this version, this host or the asking peer, 404 for a version the host doesn't hold.
func (s *Server) open(w http.ResponseWriter, r *http.Request) (*os.File, []byte, bool) {
	kind, id, version := r.PathValue("kind"), r.PathValue("id"), r.PathValue("version")
	key := s.Key()
	if key == "" {
		http.Error(w, "this host has no grant key from the control plane yet", http.StatusServiceUnavailable)
		return nil, nil, false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		http.Error(w, "a fetch needs a grant", http.StatusUnauthorized)
		return nil, nil, false
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	g, err := VerifyGrant(key, strings.TrimSpace(token), now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return nil, nil, false
	}
	asker := ""
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		asker, _ = s.PeerAt(ap.Addr().Unmap())
	}
	if err := g.Allows(kind, id, version, s.Self(), asker); err != nil {
		s.Log.Warn("a peer's fetch refused", "peer", r.RemoteAddr, "host", asker, "kind", kind, "object", id, "version", version, "error", err)
		http.Error(w, err.Error(), http.StatusForbidden)
		return nil, nil, false
	}
	f, raw, err := s.Source.Open(kind, id, version)
	if errors.Is(err, fs.ErrNotExist) {
		http.Error(w, "this host doesn't hold that version", http.StatusNotFound)
		return nil, nil, false
	}
	if err != nil {
		s.Log.Warn("a version couldn't be opened for a peer", "kind", kind, "object", id, "version", version, "error", err)
		http.Error(w, "the version couldn't be read", http.StatusInternalServerError)
		return nil, nil, false
	}
	return f, raw, true
}
