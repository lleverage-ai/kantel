package signing

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

var (
	// ErrUnavailable is a sandbox's key that can't be had now: Kantel unreachable, or its answer unusable.
	ErrUnavailable = errors.New("signing: the sandbox's signing key is unavailable")
	// ErrStale is a fetch that answered a key older than the version Kantel has advertised.
	ErrStale = errors.New("signing: the fetched signing key is older than the advertised version")
)

// fetchTimeout bounds a fetch that callers share: it runs on after the caller that started it gives up, so the others
// still get an answer.
const fetchTimeout = 15 * time.Second

// Store is the host's per-sandbox cache of signing keys, in memory only: a sandbox's is fetched on first use, and again
// after Invalidate or when Require advertises a newer version. A key is parsed and unlocked once, as it is fetched;
// what was fetched is dropped then, and the parsed key with Invalidate, Forget or the next fetch.
type Store struct {
	fetch func(ctx context.Context, sandboxID string) (proto.SigningKey, error)
	now   func() time.Time

	mu       sync.Mutex
	entries  map[string]*cachedKey
	inflight map[string]*fetchCall
	// minVersion is the newest version Kantel has advertised for each sandbox: a key older than it is never used.
	minVersion map[string]int64
}

// cachedKey is a sandbox's signing state as last fetched: enabled with its key, or not.
type cachedKey struct {
	version int64
	enabled bool
	// key is nil when not enabled.
	key *Key
}

// fetchCall is one fetch that every concurrent caller for a sandbox waits on.
type fetchCall struct {
	done   chan struct{}
	result *cachedKey
	err    error
}

// NewStore makes a Store that gets a sandbox's key from fetch.
func NewStore(fetch func(ctx context.Context, sandboxID string) (proto.SigningKey, error)) *Store {
	return &Store{fetch: fetch, now: time.Now, entries: map[string]*cachedKey{}, inflight: map[string]*fetchCall{}, minVersion: map[string]int64{}}
}

// Require records that Kantel has advertised version of a sandbox's key: a cached or in-flight key older than it is
// dropped, and a fetch that answers an older one is refused (ErrStale). Versions only move on.
func (s *Store) Require(sandboxID string, version int64) {
	if version <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if version <= s.minVersion[sandboxID] {
		return
	}
	s.minVersion[sandboxID] = version
	if e, ok := s.entries[sandboxID]; ok && e.version < version {
		delete(s.entries, sandboxID)
	}
	// A fetch under way may have been answered before the change: its result isn't cached.
	delete(s.inflight, sandboxID)
}

// MinVersion is the newest version Kantel has advertised for a sandbox's key, 0 for none.
func (s *Store) MinVersion(sandboxID string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.minVersion[sandboxID]
}

// Invalidate drops a sandbox's cached key, so the next Get fetches it again. A fetch already under way finishes for
// those waiting on it but isn't cached.
func (s *Store) Invalidate(sandboxID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, sandboxID)
	delete(s.inflight, sandboxID)
}

// InvalidateAll drops every cached key and marks every in-flight fetch uncacheable while preserving each sandbox's
// monotonic version floor. Called when the host reconnects to Kantel so a policy change missed while disconnected
// can't linger in memory.
func (s *Store) InvalidateAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.entries)
	clear(s.inflight)
}

// Forget drops everything held for a sandbox: stopped, deleted or moved away.
func (s *Store) Forget(sandboxID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.minVersion, sandboxID)
	delete(s.entries, sandboxID)
	delete(s.inflight, sandboxID)
}

// Get answers a sandbox's signing state, fetching it if it isn't cached; concurrent callers share one fetch.
func (s *Store) Get(ctx context.Context, sandboxID string) (*cachedKey, error) {
	s.mu.Lock()
	if e, ok := s.entries[sandboxID]; ok {
		s.mu.Unlock()
		return e, nil
	}
	c, ok := s.inflight[sandboxID]
	if !ok {
		c = &fetchCall{done: make(chan struct{})}
		s.inflight[sandboxID] = c
		go s.run(context.WithoutCancel(ctx), sandboxID, c)
	}
	s.mu.Unlock()
	select {
	case <-c.done:
		return c.result, c.err
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, ctx.Err())
	}
}

func (s *Store) run(ctx context.Context, sandboxID string, c *fetchCall) {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	var answer proto.SigningKey
	err := errors.New("no fetch function")
	if s.fetch != nil {
		answer, err = s.fetch(ctx, sandboxID)
	}
	var entry *cachedKey
	if err == nil {
		entry, err = load(answer, s.now())
	}
	// Only the parsed key is kept: the answer, with the private key's text and its passphrase, isn't.
	s.mu.Lock()
	if err == nil && entry.version < s.minVersion[sandboxID] {
		err = ErrStale
	}
	if err != nil {
		// Never cached: the next caller tries again.
		c.err = fmt.Errorf("%w: %w", ErrUnavailable, err)
	} else {
		c.result = entry
	}
	if s.inflight[sandboxID] == c {
		delete(s.inflight, sandboxID)
		if err == nil {
			s.entries[sandboxID] = entry
		}
	}
	s.mu.Unlock()
	close(c.done)
}

// load is a fetched answer as it is cached: its key parsed and unlocked when it is enabled.
func load(answer proto.SigningKey, now time.Time) (*cachedKey, error) {
	if !answer.Enabled {
		return &cachedKey{version: answer.Version}, nil
	}
	key, err := ParseKey(answer, now)
	if err != nil {
		return nil, err
	}
	return &cachedKey{version: answer.Version, enabled: true, key: key}, nil
}
