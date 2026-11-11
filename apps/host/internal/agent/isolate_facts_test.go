package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// isolateWithRuntime is an isolate tier that knows what its runtime can do, from a template record on disk (as after
// a restart), without running one.
func isolateWithRuntime(t *testing.T, info proto.IsolateRuntime) *isolate.Manager {
	t.Helper()
	root := t.TempDir()
	images := t.TempDir()
	cfg := isolate.Config{Root: root, Firecracker: filepath.Join(images, "firecracker"), Kernel: filepath.Join(images, "vmlinux"), Rootfs: filepath.Join(images, "isolate.ext4"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, p := range []string{cfg.Firecracker, cfg.Kernel, cfg.Rootfs} {
		if err := os.WriteFile(p, []byte(p), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tpl := filepath.Join(root, "template")
	if err := os.MkdirAll(tpl, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(info)
	_ = os.WriteFile(filepath.Join(tpl, "images"), []byte(fc.Fingerprint(cfg.Firecracker, cfg.Kernel, cfg.Rootfs)), 0o600)
	_ = os.WriteFile(filepath.Join(tpl, "runtime.json"), raw, 0o600)
	m, err := isolate.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func TestIsolateRuntimeFacts(t *testing.T) {
	info := proto.IsolateRuntime{Runtime: "deno_core", Version: "1", JavaScript: true, Python: true, MemoryEnforced: true}
	iso := isolateWithRuntime(t, info)
	h := &Host{tiers: map[string]Tier{isolate.Tier: iso}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if f := h.Facts(); f.Isolate == nil || *f.Isolate != info {
		t.Fatalf("facts: %+v", f.Isolate)
	}
	// Known already: the first hello doesn't wait.
	began := time.Now()
	h.awaitIsolateRuntime(context.Background(), time.Minute)
	if time.Since(began) > time.Second {
		t.Fatal("waited for a runtime it knew")
	}

	// A hello that said nothing of it reconnects once the runtime has said; one that said the same doesn't.
	reconnected := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.reconnectOnIsolateRuntime(ctx, nil, 5*time.Millisecond, func() { close(reconnected) })
	select {
	case <-reconnected:
	case <-time.After(5 * time.Second):
		t.Fatal("no reconnect after facts without the runtime")
	}
	same := make(chan struct{}, 1)
	go h.reconnectOnIsolateRuntime(ctx, &info, 5*time.Millisecond, func() { same <- struct{}{} })
	select {
	case <-same:
		t.Fatal("reconnected with the facts unchanged")
	case <-time.After(100 * time.Millisecond):
	}
}
