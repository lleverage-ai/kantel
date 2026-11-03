package protect

import (
	"context"
	"errors"
	"sync"
	"testing"
)

const versionPlaceholder = "kph_0123456789abcdefghijABCDEFGHIJ0123456789"

// versionedFetch answers the table the control plane has now: version and value set by the test.
type versionedFetch struct {
	mu      sync.Mutex
	version int64
	value   string
	host    string
	calls   int
}

func (f *versionedFetch) fetch(context.Context, string) (Table, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return Table{Version: f.version, Entries: []Entry{{Placeholder: versionPlaceholder, Name: "TOKEN", Value: f.value, Bindings: []Binding{{Host: f.host}}}}}, nil
}

func (f *versionedFetch) set(version int64, value, host string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version, f.value, f.host = version, value, host
}

// An advertised newer version makes a cached older table unusable, and a fetch still answering an older one is
// refused rather than used.
func TestRequireDropsOlderTables(t *testing.T) {
	f := &versionedFetch{version: 3, value: "v3", host: "a.example.com"}
	s := NewStore(f.fetch)
	ctx := context.Background()
	a := Destination{Host: "a.example.com", Port: 443, Method: "GET", Path: "/"}
	b := Destination{Host: "b.example.com", Port: 443, Method: "GET", Path: "/"}
	if r, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); err != nil || r.Value != "v3" {
		t.Fatalf("v3: %v %v", r, err)
	}
	// The same version again changes nothing: still cached.
	s.Require("sbx", 3)
	if _, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); err != nil || f.calls != 1 {
		t.Fatalf("same version refetched (%d calls): %v", f.calls, err)
	}

	// Version 4 is advertised (a rotation notice missed), but the control plane still answers 3: refused.
	s.Require("sbx", 4)
	if _, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); !errors.Is(err, ErrUnavailable) || !errors.Is(err, ErrStale) {
		t.Fatalf("a stale table was used: %v", err)
	}

	// Once it answers 4, its values and bindings are used.
	f.set(4, "v4", "b.example.com")
	if r, err := s.Resolve(ctx, versionPlaceholder, "sbx", b); err != nil || r.Value != "v4" {
		t.Fatalf("v4: %v %v", r, err)
	}
	var unbound *UnboundError
	if _, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); !errors.As(err, &unbound) {
		t.Fatalf("v3's binding still applies: %v", err)
	}
	// An older version than required changes nothing.
	calls := f.calls
	s.Require("sbx", 2)
	if _, err := s.Resolve(ctx, versionPlaceholder, "sbx", b); err != nil || f.calls != calls {
		t.Fatalf("an older Require refetched: %v", err)
	}
	// Forget drops what was required with the rest.
	s.Forget("sbx")
	f.set(1, "v1", "a.example.com")
	if r, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); err != nil || r.Value != "v1" {
		t.Fatalf("after Forget: %v %v", r, err)
	}
}

// A Fixed provider answers from its entries alone, whatever the store does meanwhile.
func TestFixedIgnoresInvalidation(t *testing.T) {
	f := &versionedFetch{version: 1, value: "first", host: "a.example.com"}
	s := NewStore(f.fetch)
	ctx := context.Background()
	entries, err := s.Values(ctx, "sbx")
	if err != nil {
		t.Fatal(err)
	}
	fixed := NewFixed(entries)
	f.set(2, "second", "a.example.com")
	s.Invalidate("sbx")
	a := Destination{Host: "a.example.com", Port: 443, Method: "GET", Path: "/"}
	if r, err := fixed.Resolve(ctx, versionPlaceholder, "sbx", a); err != nil || r.Value != "first" {
		t.Fatalf("fixed: %v %v", r, err)
	}
	if got := fixed.Entries(); len(got) != 1 || got[0].Value != "first" {
		t.Fatalf("entries %+v", got)
	}
	if r, err := s.Resolve(ctx, versionPlaceholder, "sbx", a); err != nil || r.Value != "second" {
		t.Fatalf("store: %v %v", r, err)
	}
	if _, err := fixed.Resolve(ctx, "not-a-placeholder", "sbx", a); !errors.Is(err, ErrUnknown) {
		t.Fatalf("not a placeholder: %v", err)
	}
}
