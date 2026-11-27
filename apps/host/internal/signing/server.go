package signing

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// maxRequestBytes bounds a POST /sign: a payload of MaxPayloadBytes, base64, in JSON.
const maxRequestBytes = 512 * 1024

// Each sandbox signs at most signBurst objects at once, then signRate a second: plenty for a rebase, and a bound on a
// sandbox that asks in a loop.
const (
	signBurst = 30
	signRate  = 1.0
)

// Manager serves each running microVM's signing socket (guest.SignPort) from the Store's keys, and reports each
// decision to OnRecord.
type Manager struct {
	store *Store
	// OnRecord receives every signing decision, allowed or refused. It mustn't block.
	OnRecord func(proto.SigningRecord)
	now      func() time.Time

	mu        sync.Mutex
	listeners map[string]*sandboxListener
	limiters  map[string]*limiter
}

type sandboxListener struct {
	path   string
	server *http.Server
}

// NewManager makes a Manager over store's keys.
func NewManager(store *Store) *Manager {
	return &Manager{store: store, now: time.Now, listeners: map[string]*sandboxListener{}, limiters: map[string]*limiter{}}
}

// Store is the Manager's keys.
func (m *Manager) Store() *Store { return m.store }

// SocketPath is where Firecracker hands a VM's connections to guest.SignPort: <vmDir>/<udsName>_1028.
func SocketPath(vmDir, udsName string) string {
	return filepath.Join(vmDir, fmt.Sprintf("%s_%d", udsName, guest.SignPort))
}

// Listen serves sandboxID's guest its signing on SocketPath(vmDir, udsName). A listener already open on the same
// socket path is kept (so live key updates leave no gap on disk); any other listener for the sandbox is closed first.
func (m *Manager) Listen(sandboxID, vmDir, udsName string) error {
	if udsName == "" || strings.Contains(udsName, "..") || strings.Contains(udsName, "/") || strings.Contains(udsName, `\`) {
		return fmt.Errorf("signing socket: bad socket name")
	}
	cleanDir := filepath.Clean(vmDir)
	path := filepath.Clean(SocketPath(cleanDir, udsName))
	rel, err := filepath.Rel(cleanDir, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("signing socket: bad socket path")
	}
	prefix := cleanDir
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if !strings.HasPrefix(path, prefix) {
		return fmt.Errorf("signing socket: bad socket path")
	}
	m.mu.Lock()
	existing := m.listeners[sandboxID]
	m.mu.Unlock()
	if existing != nil && existing.path == path {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
	}
	m.closeListener(sandboxID)
	_ = os.Remove(path)
	l, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("signing socket: %w", err)
	}
	srv := &http.Server{Handler: m.Handler(sandboxID), ReadHeaderTimeout: 10 * time.Second}
	m.mu.Lock()
	prior := m.listeners[sandboxID]
	m.listeners[sandboxID] = &sandboxListener{path: path, server: srv}
	m.mu.Unlock()
	if prior != nil {
		_ = prior.server.Close()
	}
	go func() { _ = srv.Serve(l) }()
	return nil
}

// Close stops serving a sandbox whose VM has stopped, and drops its key from memory: its next run fetches it again.
func (m *Manager) Close(sandboxID string) {
	m.closeListener(sandboxID)
	m.store.Forget(sandboxID)
}

// Forget drops everything held for a sandbox that has gone: its listener, its rate limit and its key.
func (m *Manager) Forget(sandboxID string) {
	m.closeListener(sandboxID)
	m.mu.Lock()
	delete(m.limiters, sandboxID)
	m.mu.Unlock()
	m.store.Forget(sandboxID)
}

// CloseAll stops serving every sandbox (the host stopping). Their keys go with the process.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	all := m.listeners
	m.listeners = map[string]*sandboxListener{}
	m.mu.Unlock()
	for _, l := range all {
		_ = l.server.Close()
	}
}

func (m *Manager) closeListener(sandboxID string) {
	m.mu.Lock()
	l := m.listeners[sandboxID]
	delete(m.listeners, sandboxID)
	m.mu.Unlock()
	if l != nil {
		_ = l.server.Close()
	}
}

// Handler serves sandboxID's guest: GET /status and POST /sign.
func (m *Manager) Handler(sandboxID string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { m.status(w, r, sandboxID) })
	mux.HandleFunc("POST /sign", func(w http.ResponseWriter, r *http.Request) { m.sign(w, r, sandboxID) })
	return mux
}

func (m *Manager) status(w http.ResponseWriter, r *http.Request, sandboxID string) {
	entry, err := m.store.Get(r.Context(), sandboxID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	st := guest.SignStatus{Enabled: entry.enabled}
	if entry.enabled {
		k := entry.key
		st.Format, st.KeyID, st.Fingerprint = k.Format, k.KeyID, k.Fingerprint
		for e := range k.AllowedEmails {
			st.AllowedEmails = append(st.AllowedEmails, e)
		}
		slices.Sort(st.AllowedEmails)
	}
	writeJSON(w, http.StatusOK, st)
}

func (m *Manager) sign(w http.ResponseWriter, r *http.Request, sandboxID string) {
	var req guest.SignRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("the request isn't a sign request"))
		return
	}
	rec := proto.SigningRecord{SandboxID: sandboxID, Format: req.Format}
	refuse := func(status int, reason string) {
		rec.Allowed, rec.Reason = false, reason
		m.record(rec)
		writeError(w, status, errors.New(reason))
	}
	if !m.allow(sandboxID) {
		refuse(http.StatusTooManyRequests, "rate limit exceeded")
		return
	}
	entry, err := m.store.Get(r.Context(), sandboxID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	if !entry.enabled {
		refuse(http.StatusForbidden, "no git signing key configured")
		return
	}
	key := entry.key
	rec.Format, rec.KeyID, rec.Fingerprint = key.Format, key.KeyID, key.Fingerprint
	if req.Format != "" && req.Format != key.Format {
		refuse(http.StatusForbidden, fmt.Sprintf("the sandbox's signing key is %s, not %s", key.Format, req.Format))
		return
	}
	payload, err := base64.StdEncoding.DecodeString(req.Payload)
	if err != nil {
		rec.ObjectType = "unknown"
		refuse(http.StatusForbidden, "the payload isn't base64")
		return
	}
	obj, err := ParseGitObject(payload)
	if err != nil {
		rec.ObjectType = "unknown"
		refuse(http.StatusForbidden, err.Error())
		return
	}
	rec.ObjectType, rec.Committer, rec.Object = obj.Type, obj.CommitterEmail, obj.ObjectHash
	if !key.Allows(obj.CommitterEmail) {
		who := "committer"
		if obj.Type == ObjectTag {
			who = "tagger"
		}
		refuse(http.StatusForbidden, fmt.Sprintf("the %s's email %s isn't one the sandbox's signing key signs for", who, obj.CommitterEmail))
		return
	}
	sig, err := key.Sign(payload, m.now())
	if err != nil {
		rec.Allowed, rec.Reason = false, "signing failed"
		m.record(rec)
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	rec.Allowed = true
	m.record(rec)
	writeJSON(w, http.StatusOK, guest.SignAnswer{
		Signature: sig.Text, Format: key.Format, KeyID: key.KeyID, Fingerprint: sig.Fingerprint,
		PKAlgo: sig.PKAlgo, HashAlgo: sig.HashAlgo, Timestamp: sig.Timestamp,
	})
}

func (m *Manager) record(rec proto.SigningRecord) {
	rec.At = m.now().UnixMilli()
	if m.OnRecord != nil {
		m.OnRecord(rec)
	}
}

// allow takes one of a sandbox's signing tokens.
func (m *Manager) allow(sandboxID string) bool {
	m.mu.Lock()
	l, ok := m.limiters[sandboxID]
	if !ok {
		l = &limiter{tokens: signBurst, at: m.now()}
		m.limiters[sandboxID] = l
	}
	m.mu.Unlock()
	return l.take(m.now())
}

// limiter is a token bucket: signBurst tokens, refilled at signRate a second.
type limiter struct {
	mu     sync.Mutex
	tokens float64
	at     time.Time
}

func (l *limiter) take(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if elapsed := now.Sub(l.at).Seconds(); elapsed > 0 {
		l.tokens = min(signBurst, l.tokens+elapsed*signRate)
	}
	l.at = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
