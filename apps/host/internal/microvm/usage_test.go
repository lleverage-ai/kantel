package microvm

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// The sampler never waits on a sandbox mid-operation (a cold boot holds its lock for minutes): Processes answers at
// once, naming it Held.
func TestProcessesDoesNotWaitOnAHeldSandbox(t *testing.T) {
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateRunning}}
	m := &Manager{sandboxes: map[string]*sandbox{"sbx_1": s}}
	s.mu.Lock()
	defer s.mu.Unlock()
	done := make(chan []usage.Process, 1)
	go func() { done <- m.Processes() }()
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("Processes waited on a held sandbox")
	case got := <-done:
		if len(got) != 1 || got[0].SandboxID != "sbx_1" || !got[0].Held || got[0].Pid != 0 {
			t.Fatalf("got %+v", got)
		}
	}
}

// guestMemory reads the guest's MemTotal and MemAvailable from its Firecracker's balloon statistics, and fails until
// the guest's driver has reported both.
func TestGuestMemoryFromBalloonStatistics(t *testing.T) {
	dir, err := os.MkdirTemp("", "vm")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	ln, err := net.Listen("unix", filepath.Join(dir, fc.APISocket))
	if err != nil {
		t.Fatal(err)
	}
	answer := `{"target_pages":0,"actual_pages":0,"target_mib":0,"actual_mib":0}`
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/balloon/statistics" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, answer)
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	if _, err := guestMemory(context.Background(), dir); err == nil {
		t.Fatal("no figures before the guest has reported them")
	}
	answer = strings.Replace(answer, "}", `,"total_memory":2000000000,"available_memory":1400000000,"free_memory":900000000}`, 1)
	got, err := guestMemory(context.Background(), dir)
	if err != nil || got.Total != 2_000_000_000 || got.Available != 1_400_000_000 || got.Used() != 600_000_000 {
		t.Fatalf("got %+v %v", got, err)
	}
}

// A size's template made before the reporting balloon has no balloon in its snapshot, so the sandboxes restored from it
// couldn't report their guest's memory: it is made again. Its shape is still the fingerprint's end, so with
// BackgroundTemplates it serves while its replacement builds.
func TestTemplateFromBeforeTheBalloonIsMadeAgain(t *testing.T) {
	m := &Manager{cfg: Config{Firecracker: "/nonexistent/firecracker", Kernel: "/nonexistent/vmlinux", Rootfs: "/nonexistent/sandbox.ext4"}}
	size := DefaultSizes[1]
	before := fc.Fingerprint(m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs) + templateShape(size)
	now := m.templateFingerprint(size)
	if now == before {
		t.Fatal("a template from before the balloon still counts as current")
	}
	if !strings.HasSuffix(now, templateShape(size)) || !strings.HasSuffix(before, templateShape(size)) {
		t.Fatalf("the shape must stay last: %q", now)
	}
	if cfg := m.bootConfig(size, "vmlinux", "tap0", "06:00:00:00:00:01", 3); cfg.BalloonStatsSeconds <= 0 {
		t.Fatal("a microVM boots without the reporting balloon")
	}
}
