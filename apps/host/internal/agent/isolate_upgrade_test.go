package agent

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A native host installed with workerd, and updated by its binary alone (a self-update fetches kantel-host only),
// keeps its isolate tier on workerd until kantel-isolate is installed: it never comes up with no tier.
func TestNativeHostUpdatedFromWorkerd(t *testing.T) {
	newHost := func(t *testing.T, root string) (*Host, error) {
		cfg := Config{Root: root, Tiers: []string{"isolate"}, IsolateRuntime: "native", Egress: "open"}
		cfg.Defaults()
		return New(cfg, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	}
	write := func(t *testing.T, p string, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 1\n"), mode); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("workerd only", func(t *testing.T) {
		root := t.TempDir()
		// What an install from before kantel-isolate left: workerd and its worker, at their default paths.
		write(t, filepath.Join(root, "bin", "workerd"), 0o755)
		write(t, filepath.Join(root, "isolate", "config.capnp"), 0o644)
		h, err := newHost(t, root)
		if err != nil {
			t.Fatalf("a host with workerd alone didn't start: %v", err)
		}
		defer h.Close()
		if !slices.Contains(h.Tiers(), "isolate") {
			t.Fatalf("tiers %v: no isolate tier", h.Tiers())
		}
	})

	t.Run("neither", func(t *testing.T) {
		if _, err := newHost(t, t.TempDir()); err == nil {
			t.Fatal("a host with no isolate runtime at all started with no tier")
		}
	})
}
