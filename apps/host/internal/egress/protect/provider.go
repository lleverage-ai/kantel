package protect

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Resolution is a placeholder's value for one destination. Name is for logs; Value never goes into one.
type Resolution struct {
	Value, Name string
}

// Provider decides a swap: resolve(placeholder, sandbox, destination) -> value | deny.
type Provider interface {
	// Resolve answers the value for placeholder on a request from sandboxID to dest, ErrUnknown if it isn't a
	// placeholder at all (or the sandbox has no protected variables), ErrForeign if it is a placeholder but not one of
	// the sandbox's, *UnboundError if dest isn't one of its bindings, or ErrUnavailable.
	Resolve(ctx context.Context, placeholder, sandboxID string, dest Destination) (Resolution, error)
}

var (
	// ErrUnknown is text that isn't a placeholder of this sandbox, nor refused for being someone else's: it is left
	// as it is.
	ErrUnknown = errors.New("protect: not a placeholder of this sandbox")
	// ErrForeign is a placeholder that isn't one of this sandbox's: another sandbox's, such as a fork's parent's. It is
	// never swapped, and the request carrying it is refused rather than sent on, so
	// the sandbox learns why instead of getting the destination's 401. It is also ErrUnknown.
	ErrForeign = fmt.Errorf("%w: a placeholder, but not one of this sandbox's", ErrUnknown)
	// ErrUnavailable is a placeholder whose value can't be fetched now: the request is refused rather than sent
	// with the placeholder, so the caller sees why.
	ErrUnavailable = errors.New("protect: protected values are unavailable")
)

// UnboundError is a known placeholder sent to a destination outside its bindings.
type UnboundError struct {
	Name string
	Dest Destination
}

func (e *UnboundError) Error() string {
	return "protect: " + e.Name + " isn't bound to " + e.Dest.Host
}

// Entry is one protected variable of a sandbox.
type Entry struct {
	Placeholder string
	// Name is the variable's name: the only part of it that may be logged or shown.
	Name     string
	Value    string
	Bindings []Binding
}

// Table is a sandbox's protected variables, as the control plane answers them.
type Table struct {
	Version int64
	Entries []Entry
}

// fetchTimeout bounds a fetch that callers share: it runs on after the caller that started it gives up, so the
// others still get an answer.
const fetchTimeout = 15 * time.Second

// Store is the host's per-sandbox cache of protected values. It holds them in memory only, fetches a sandbox's on
// first use, and refetches after Invalidate or when Require advertises a newer version.
type Store struct {
	fetch func(ctx context.Context, sandboxID string) (Table, error)

	mu       sync.Mutex
	tables   map[string]*indexed
	inflight map[string]*fetchCall
	// minVersion is the newest version the control plane has advertised for each sandbox: a table older than it is
	// never used.
	minVersion map[string]int64
}

// ErrStale is a fetch that answered a table older than the version the control plane has advertised.
var ErrStale = errors.New("protect: the fetched table is older than the advertised version")

type indexed struct {
	table Table
	// byPlaceholder indexes table.Entries.
	byPlaceholder map[string]int
}

// fetchCall is one fetch that every concurrent caller for a sandbox waits on.
type fetchCall struct {
	done   chan struct{}
	result *indexed
	err    error
}

// NewStore makes a Store that gets a sandbox's table from fetch.
func NewStore(fetch func(ctx context.Context, sandboxID string) (Table, error)) *Store {
	return &Store{fetch: fetch, tables: map[string]*indexed{}, inflight: map[string]*fetchCall{}}
}

// Resolve implements Provider.
func (s *Store) Resolve(ctx context.Context, placeholder, sandboxID string, dest Destination) (Resolution, error) {
	if !IsPlaceholder(placeholder) {
		return Resolution{}, ErrUnknown
	}
	t, err := s.load(ctx, sandboxID)
	if err != nil {
		return Resolution{}, err
	}
	return t.resolve(placeholder, dest)
}

// Fixed is a Provider over one set of entries, for a single request: its placeholders are resolved from, and its
// response scrubbed of, the same values, whatever rotates while it is under way.
type Fixed struct {
	ix *indexed
}

// NewFixed makes a Fixed provider over entries.
func NewFixed(entries []Entry) *Fixed {
	return &Fixed{ix: index(Table{Entries: entries})}
}

// Resolve implements Provider; sandboxID isn't consulted, as the entries are already the sandbox's.
func (f *Fixed) Resolve(_ context.Context, placeholder, _ string, dest Destination) (Resolution, error) {
	if !IsPlaceholder(placeholder) {
		return Resolution{}, ErrUnknown
	}
	return f.ix.resolve(placeholder, dest)
}

// Entries answers the entries, to scrub what comes back.
func (f *Fixed) Entries() []Entry {
	return slices.Clone(f.ix.table.Entries)
}

func (t *indexed) resolve(placeholder string, dest Destination) (Resolution, error) {
	i, ok := t.byPlaceholder[placeholder]
	if !ok {
		// Only a sandbox's own placeholders are in its table, so the lookup is by sandbox and placeholder together.
		return Resolution{}, ErrForeign
	}
	e := t.table.Entries[i]
	for _, b := range e.Bindings {
		if b.Matches(dest) {
			if e.Value == "" {
				// A variable with no value is one whose value couldn't be read: sending nothing in its place
				// would only fail further away from the reason.
				return Resolution{}, fmt.Errorf("%w: %s has no value", ErrUnavailable, e.Name)
			}
			return Resolution{Value: e.Value, Name: e.Name}, nil
		}
	}
	return Resolution{}, &UnboundError{Name: e.Name, Dest: dest}
}

// Values answers a sandbox's entries, for scrubbing what comes back.
func (s *Store) Values(ctx context.Context, sandboxID string) ([]Entry, error) {
	t, err := s.load(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	return slices.Clone(t.table.Entries), nil
}

// Intercepts answers the distinct host patterns a sandbox's variables are bound to, sorted: the destinations the
// proxy must open (terminate TLS for) to swap.
func (s *Store) Intercepts(ctx context.Context, sandboxID string) ([]string, error) {
	t, err := s.load(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	var hosts []string
	for _, e := range t.table.Entries {
		for _, b := range e.Bindings {
			if h := normaliseHost(b.Host); h != "" {
				hosts = append(hosts, h)
			}
		}
	}
	slices.Sort(hosts)
	return slices.Compact(hosts), nil
}

// Invalidate drops a sandbox's cached values, so the next Resolve fetches them again: how a rotation takes effect.
// The placeholders stay the same, so nothing in the sandbox changes. A fetch already under way finishes for those
// waiting on it but isn't cached.
func (s *Store) Invalidate(sandboxID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tables, sandboxID)
	delete(s.inflight, sandboxID)
}

// Require records that the control plane has advertised version of a sandbox's table: a cached or in-flight table
// older than it is dropped, and a fetch that answers an older one is refused rather than used. Versions only move
// on; an older one than already required changes nothing.
func (s *Store) Require(sandboxID string, version int64) {
	if version <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.minVersion == nil {
		s.minVersion = map[string]int64{}
	}
	if version <= s.minVersion[sandboxID] {
		return
	}
	s.minVersion[sandboxID] = version
	if t, ok := s.tables[sandboxID]; ok && t.table.Version < version {
		delete(s.tables, sandboxID)
	}
	// A fetch under way may have been answered before the change: its result isn't cached.
	delete(s.inflight, sandboxID)
}

// Forget drops everything held for a sandbox that has gone.
func (s *Store) Forget(sandboxID string) {
	s.mu.Lock()
	delete(s.minVersion, sandboxID)
	s.mu.Unlock()
	s.Invalidate(sandboxID)
}

func (s *Store) load(ctx context.Context, sandboxID string) (*indexed, error) {
	s.mu.Lock()
	if s.tables == nil {
		s.tables, s.inflight = map[string]*indexed{}, map[string]*fetchCall{}
	}
	if t, ok := s.tables[sandboxID]; ok {
		s.mu.Unlock()
		return t, nil
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
	var t Table
	err := errors.New("no fetch function")
	if s.fetch != nil {
		t, err = s.fetch(ctx, sandboxID)
	}
	s.mu.Lock()
	if err == nil && t.Version < s.minVersion[sandboxID] {
		err = ErrStale
	}
	if err != nil {
		// Never cached: the next caller tries again.
		c.err = fmt.Errorf("%w: %w", ErrUnavailable, err)
	} else {
		c.result = index(t)
	}
	if s.inflight[sandboxID] == c {
		delete(s.inflight, sandboxID)
		if err == nil {
			s.tables[sandboxID] = c.result
		}
	}
	s.mu.Unlock()
	close(c.done)
}

func index(t Table) *indexed {
	entries := slices.Clone(t.Entries)
	ix := &indexed{table: Table{Version: t.Version, Entries: entries}, byPlaceholder: make(map[string]int, len(entries))}
	for i, e := range entries {
		if _, dup := ix.byPlaceholder[e.Placeholder]; !dup {
			ix.byPlaceholder[e.Placeholder] = i
		}
	}
	return ix
}
