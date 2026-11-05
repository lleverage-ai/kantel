package protect

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStoreFetchesOnceForConcurrentResolves(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	s := NewStore(func(context.Context, string) (Table, error) {
		calls.Add(1)
		<-release
		return Table{Version: 1, Entries: testEntries()}, nil
	})
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.Resolve(context.Background(), phGitHub, "sbx-1", githubDest)
			if err == nil && (r.Value != githubValue || r.Name != "GITHUB_TOKEN") {
				err = errors.New("wrong resolution for " + r.Name)
			}
			errs <- err
		}()
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("fetched %d times, want 1", n)
	}
}

func TestStoreRotation(t *testing.T) {
	var mu sync.Mutex
	value, calls := "first-value", 0
	s := NewStore(func(context.Context, string) (Table, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return Table{Version: int64(calls), Entries: []Entry{{Placeholder: phGitHub, Name: "GITHUB_TOKEN", Value: value, Bindings: []Binding{{Host: "api.github.com"}}}}}, nil
	})
	resolve := func() string {
		t.Helper()
		r, err := s.Resolve(context.Background(), phGitHub, "sbx-1", githubDest)
		if err != nil {
			t.Fatal(err)
		}
		return r.Value
	}
	if v := resolve(); v != "first-value" {
		t.Fatalf("got %q, want the first value", v)
	}
	mu.Lock()
	value = "second-value"
	mu.Unlock()
	if v := resolve(); v != "first-value" {
		t.Fatalf("got %q before Invalidate, want the cached first value", v)
	}
	s.Invalidate("sbx-1")
	if v := resolve(); v != "second-value" {
		t.Fatalf("got %q after Invalidate, want the rotated value", v)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("fetched %d times, want 2", calls)
	}
}

func TestStoreDoesNotCacheAFailedFetch(t *testing.T) {
	var fail atomic.Bool
	var calls atomic.Int32
	fail.Store(true)
	s := NewStore(func(context.Context, string) (Table, error) {
		calls.Add(1)
		if fail.Load() {
			return Table{}, errors.New("vault unreachable")
		}
		return Table{Version: 1, Entries: testEntries()}, nil
	})
	_, err := s.Resolve(context.Background(), phGitHub, "sbx-1", githubDest)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v, want ErrUnavailable", err)
	}
	fail.Store(false)
	r, err := s.Resolve(context.Background(), phGitHub, "sbx-1", githubDest)
	if err != nil || r.Value != githubValue {
		t.Fatalf("after recovery: %v", err)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("fetched %d times, want 2", n)
	}
}

func TestStoreErrors(t *testing.T) {
	s := testStore()
	unboundAs := func(name string) func(error) bool {
		return func(err error) bool {
			var u *UnboundError
			return errors.As(err, &u) && u.Name == name
		}
	}
	tests := []struct {
		name  string
		ph    string
		dest  Destination
		check func(error) bool
	}{
		{"unknown placeholder", phUnknown, githubDest, func(err error) bool { return errors.Is(err, ErrForeign) && errors.Is(err, ErrUnknown) }},
		{"not a placeholder", "hello", githubDest, func(err error) bool { return errors.Is(err, ErrUnknown) && !errors.Is(err, ErrForeign) }},
		{"bound elsewhere", phNPM, githubDest, unboundAs("NPM_TOKEN")},
		{"another port", phGitHub, Destination{Host: "api.github.com", Port: 8443, Method: "GET", Path: "/"}, unboundAs("GITHUB_TOKEN")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := s.Resolve(context.Background(), tt.ph, "sbx-1", tt.dest)
			if !tt.check(err) {
				t.Fatalf("got %v", err)
			}
			if msg := err.Error(); strings.Contains(msg, githubValue) || strings.Contains(msg, npmValue) {
				t.Fatalf("the error %q holds a value", msg)
			}
		})
	}
}

// A fork has placeholders of its own for the same variables and values. Each sandbox's placeholders resolve for it
// alone: the parent's sent from the fork (or the fork's from the parent) is denied, whatever the destination.
func TestStoreResolvesOnlyTheCallingSandboxsPlaceholders(t *testing.T) {
	phFork := "kph_" + strings.Repeat("f0", 20)
	s := NewStore(func(_ context.Context, sandboxID string) (Table, error) {
		entries := testEntries()
		switch sandboxID {
		case "sbx-parent":
		case "sbx-fork":
			entries[0].Placeholder = phFork
		default:
			return Table{}, errors.New("no such sandbox")
		}
		return Table{Version: 1, Entries: entries}, nil
	})
	ctx := context.Background()
	for _, c := range []struct{ ph, sandbox string }{{phGitHub, "sbx-parent"}, {phFork, "sbx-fork"}} {
		if r, err := s.Resolve(ctx, c.ph, c.sandbox, githubDest); err != nil || r.Value != githubValue || r.Name != "GITHUB_TOKEN" {
			t.Fatalf("%s's own placeholder: %v", c.sandbox, err)
		}
	}
	for _, c := range []struct{ ph, sandbox string }{{phGitHub, "sbx-fork"}, {phFork, "sbx-parent"}} {
		r, err := s.Resolve(ctx, c.ph, c.sandbox, githubDest)
		if !errors.Is(err, ErrForeign) || r.Value != "" {
			t.Fatalf("the other sandbox's placeholder from %s: %q, %v; want ErrForeign and no value", c.sandbox, r.Value, err)
		}
	}
	// Fixed, a request's view of one sandbox's entries, denies the other's too.
	entries, err := s.Values(ctx, "sbx-fork")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewFixed(entries).Resolve(ctx, phGitHub, "sbx-fork", githubDest); !errors.Is(err, ErrForeign) {
		t.Fatalf("Fixed: %v, want ErrForeign", err)
	}
}

func TestStoreValuesInterceptsAndForget(t *testing.T) {
	var calls atomic.Int32
	s := NewStore(func(context.Context, string) (Table, error) {
		calls.Add(1)
		entries := testEntries()
		entries[1].Bindings = append(entries[1].Bindings, Binding{Host: "*.Example.com."}, Binding{Host: "registry.npmjs.org"})
		return Table{Version: 1, Entries: entries}, nil
	})
	entries, err := s.Values(context.Background(), "sbx-1")
	if err != nil || len(entries) != 2 {
		t.Fatalf("Values: %d entries, %v", len(entries), err)
	}
	hosts, err := s.Intercepts(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"*.example.com", "api.github.com", "registry.npmjs.org"}; !slices.Equal(hosts, want) {
		t.Fatalf("Intercepts = %v, want %v", hosts, want)
	}
	s.Forget("sbx-1")
	if _, err := s.Values(context.Background(), "sbx-1"); err != nil {
		t.Fatal(err)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("fetched %d times, want 2 (once, and again after Forget)", n)
	}
}
