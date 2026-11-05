// Package mounts is the host's half of a sandbox's read-only bucket mounts. For each mount the host lists the
// bucket prefix once (the manifest), which the guest's FUSE file system answers lookups, listings and stat from, and
// serves the bytes of an object as the guest reads them, from the host-wide read cache (Cache), fetching a chunk
// from the store only when no sandbox on the host has read it yet.
//
// The guest reaches its own sandbox's mounts only: over vsock port guest.MountPort, which Firecracker hands to a Unix
// socket in that sandbox's VM directory. The bucket source's location and credentials come from the control plane
// (bucket.fetch) and stay in the host's memory.
package mounts

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// DefaultTTL is how old a manifest may be, while the sandbox uses the mount, before the host lists the prefix again.
const DefaultTTL = 60 * time.Second

// MinTTL keeps a short TTL from turning into a list call on every look at the mount.
const MinTTL = 5 * time.Second

// DefaultMaxObjects bounds a mount's manifest.
const DefaultMaxObjects = 200_000

// MaxMounts bounds a sandbox's mounts.
const MaxMounts = 16

// DefaultMaxOpenChunks bounds the chunks the host's mounts fetch or send at once, all sandboxes together (512 MiB
// of chunks), and SandboxOpenChunks one sandbox's share. A chunk being sent is open, so its disk space stays used
// even once the cache has evicted it, and a fetch writes a chunk beside the cache: these bound both beyond the cache's
// own limit.
const (
	DefaultMaxOpenChunks = 64
	SandboxOpenChunks    = 16
)

// ChunkWriteTimeout is how long the host waits for a guest to take one chunk's bytes before it gives up on the read
// (and closes the chunk): a guest that stops reading can't hold chunks open.
const ChunkWriteTimeout = time.Minute

// ListTimeout bounds one listing of a prefix, all its pages (each a request within the store client's own timeout).
const ListTimeout = 10 * time.Minute

// sourceTTL is how long the host keeps a bucket source it resolved before asking again.
const sourceTTL = 10 * time.Minute

// Config is the host's setup for bucket mounts.
type Config struct {
	Cache *Cache
	// HTTP reaches the stores: the host's rules for where it may connect are in its dialer.
	HTTP *http.Client
	// Resolve asks the control plane for a bucket source a sandbox mounts (bucket.fetch).
	Resolve func(ctx context.Context, sandboxID, sourceID string) (proto.BucketSource, error)
	// MaxObjects bounds a manifest (default DefaultMaxObjects).
	MaxObjects int
	Log        *slog.Logger
	// Changed says a sandbox's mount status changed outside a call (a refresh that failed, say).
	Changed func(sandboxID string)
	// ProofKey signs the object versions a guest is shown (mount.proof), so a file opened before a refresh still
	// reads its version. Kept across a restart of the host, so an adopted guest's open files do too; empty: a random
	// key for this run.
	ProofKey []byte
	// MaxOpenChunks bounds the chunks fetched or sent at once (default DefaultMaxOpenChunks).
	MaxOpenChunks int
}

// Manager holds every sandbox's mounts on the host.
type Manager struct {
	cfg Config
	log *slog.Logger

	mu        sync.Mutex
	sandboxes map[string]*Sandbox
	sources   map[string]*source
	// now is the clock for listings' timing (tests give another).
	now      func() time.Time
	proofKey []byte
	// slots are the host's open chunks (Config.MaxOpenChunks).
	slots chan struct{}
	// writeTimeout is ChunkWriteTimeout (tests give another).
	writeTimeout time.Duration
}

type source struct {
	client  *bucket.Client
	src     proto.BucketSource
	fetched time.Time
}

func New(cfg Config) *Manager {
	if cfg.MaxObjects <= 0 {
		cfg.MaxObjects = DefaultMaxObjects
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 5 * time.Minute}
	}
	key := cfg.ProofKey
	if len(key) == 0 {
		key = make([]byte, 32)
		_, _ = rand.Read(key)
	}
	if cfg.MaxOpenChunks <= 0 {
		cfg.MaxOpenChunks = DefaultMaxOpenChunks
	}
	return &Manager{cfg: cfg, log: cfg.Log.With("part", "mounts"), sandboxes: map[string]*Sandbox{}, sources: map[string]*source{}, now: time.Now, proofKey: key, slots: make(chan struct{}, cfg.MaxOpenChunks), writeTimeout: ChunkWriteTimeout}
}

// Cache is the host's read cache.
func (m *Manager) Cache() *Cache { return m.cfg.Cache }

// Validate checks a create's mounts before anything is made.
func Validate(mounts []proto.Mount) error {
	if len(mounts) > MaxMounts {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("a sandbox has at most %d mounts", MaxMounts)}
	}
	seen := map[string]bool{}
	for _, mt := range mounts {
		if err := guest.CheckMountPath(mt.Path); err != nil {
			return &proto.Error{Code: proto.ErrInvalid, Message: err.Error()}
		}
		for other := range seen {
			if other == mt.Path || strings.HasPrefix(mt.Path, other+"/") || strings.HasPrefix(other, mt.Path+"/") {
				return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("mounts at %s and %s overlap", other, mt.Path)}
			}
		}
		seen[mt.Path] = true
		switch mt.Kind {
		case proto.MountBucket:
			if mt.BucketSourceID == "" {
				return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("the bucket mount at %s names no bucket source", mt.Path)}
			}
			if ttl := mt.RefreshTTLSeconds; ttl != nil && (*ttl < 0 || *ttl > 86400) {
				return &proto.Error{Code: proto.ErrInvalid, Message: "refreshTtlSeconds is 0 to 86400"}
			}
		default:
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("this host has no %q mounts", mt.Kind)}
		}
	}
	return nil
}

// Sandbox returns the sandbox's mounts, made from specs the first time (and replaced when specs differ).
func (m *Manager) Sandbox(sandboxID string, specs []proto.Mount) *Sandbox {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sandboxes[sandboxID]; ok && sameSpecs(s.specs, specs) {
		return s
	} else if ok {
		s.closeListener()
	}
	s := &Sandbox{id: sandboxID, m: m, specs: specs, slots: make(chan struct{}, SandboxOpenChunks)}
	for i, spec := range specs {
		s.mounts = append(s.mounts, newMount(s, i, spec))
	}
	m.sandboxes[sandboxID] = s
	return s
}

// Get is a sandbox's mounts, if it has any on this host.
func (m *Manager) Get(sandboxID string) *Sandbox {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sandboxes[sandboxID]
}

// Forget drops a deleted sandbox's mounts.
func (m *Manager) Forget(sandboxID string) {
	m.mu.Lock()
	s := m.sandboxes[sandboxID]
	delete(m.sandboxes, sandboxID)
	for k := range m.sources {
		if strings.HasPrefix(k, sandboxID+"\x00") {
			delete(m.sources, k)
		}
	}
	m.mu.Unlock()
	if s != nil {
		s.closeListener()
	}
}

func sameSpecs(a, b []proto.Mount) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if specKey(a[i]) != specKey(b[i]) || a[i].Path != b[i].Path {
			return false
		}
	}
	return true
}

// specKey is a digest of what a mount shows: its source and prefix.
func specKey(mt proto.Mount) string {
	parts := []string{mt.Kind}
	if mt.Kind == proto.MountBucket {
		parts = append(parts, mt.BucketSourceID, normalPrefix(mt.Prefix))
	}
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(h[:12])
}

// client is the bucket source's client for a sandbox, resolved through the control plane when the host has none or
// had it too long (or fresh is set: the store refused the one it had).
func (m *Manager) client(ctx context.Context, sandboxID, sourceID string, fresh bool) (*source, error) {
	key := sandboxID + "\x00" + sourceID
	m.mu.Lock()
	s, ok := m.sources[key]
	m.mu.Unlock()
	if ok && !fresh && time.Since(s.fetched) < sourceTTL {
		return s, nil
	}
	if m.cfg.Resolve == nil {
		return nil, errors.New("this host can't resolve bucket sources")
	}
	src, err := m.cfg.Resolve(ctx, sandboxID, sourceID)
	if err != nil {
		if ok {
			// The control plane can't be asked now: keep using what the host has.
			m.log.Warn("bucket source re-resolve failed; keeping the one held", "sandbox", sandboxID, "error", err)
			return s, nil
		}
		return nil, fmt.Errorf("bucket source %s: %w", sourceID, err)
	}
	bs := bucket.Source{Provider: src.Provider, Bucket: src.Bucket, Endpoint: src.Endpoint, Region: src.Region}
	if c := src.Credentials; c != nil {
		bs.Credentials = bucket.Credentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken}
		bs.ServiceAccountKey = c.ServiceAccountKey
	}
	client, err := bucket.NewClient(bs, m.cfg.HTTP)
	if err != nil {
		return nil, err
	}
	s = &source{client: client, src: src, fetched: time.Now()}
	m.mu.Lock()
	m.sources[key] = s
	m.mu.Unlock()
	return s, nil
}

// principal names who reads a bucket source, for the cache's keys: a digest of the whole credential (an access key's
// ID, secret and session token; or a service account's key), never the secret itself. Two sources share cached bytes
// only with the same credential, so naming another account's key ID with another secret reads none of its cache.
func principal(src proto.BucketSource) string {
	c := src.Credentials
	switch {
	case c == nil:
		return ""
	case c.AccessKeyID != "":
		h := sha256.New()
		for _, part := range []string{"kantel-bucket-principal", c.AccessKeyID, c.SecretAccessKey, c.SessionToken} {
			h.Write([]byte(part))
			h.Write([]byte{0})
		}
		return "key:" + c.AccessKeyID + ":" + hex.EncodeToString(h.Sum(nil)[:16])
	case c.ServiceAccountKey != "":
		h := sha256.Sum256([]byte(c.ServiceAccountKey))
		return "sa:" + hex.EncodeToString(h[:16])
	}
	return ""
}

func (m *Manager) changed(sandboxID string) {
	if m.cfg.Changed != nil {
		m.cfg.Changed(sandboxID)
	}
}
