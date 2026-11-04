//go:build vmtest

package agent

import (
	"crypto/rand"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// TestBundleTimings measures a sandbox's create (restored from the template, no warm pool) without a mount, with a
// bundle no sandbox on the host has mounted yet (cold: fetch, check and build its image) and with one already in
// the cache (warm), for a few bundle sizes, and logs each median. KANTEL_VMTEST_RUNS sets the runs (default 5).
func TestBundleTimings(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	runs := 5
	if n, err := fmt.Sscan(os.Getenv("KANTEL_VMTEST_RUNS"), &runs); n != 1 || err != nil {
		runs = 5
	}
	type file = struct {
		body string
		mode int64
	}
	// A bundle of size bytes: a script, and the rest in 1 MiB files of random bytes. nonce makes each one new.
	bundle := func(size int, nonce int) ([]byte, string) {
		files := map[string]file{
			"run.sh":   {"#!/bin/sh\necho ran\n", 0o755},
			"nonce":    {fmt.Sprint(nonce, time.Now().UnixNano()), 0o644},
			"data.txt": {"data\n", 0o644},
		}
		for i := 0; size > 0; i++ {
			n := min(size, 1<<20)
			b := make([]byte, n)
			_, _ = rand.Read(b)
			files[fmt.Sprintf("blobs/%04d.bin", i)] = file{string(b), 0o644}
			size -= n
		}
		return bundleTar(t, files)
	}
	var mu sync.Mutex
	tars := map[string][]byte{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		raw := tars[strings.TrimPrefix(r.URL.Path, "/v1/hosts/bundles/")]
		mu.Unlock()
		if raw == nil {
			http.NotFound(w, r)
			return
		}
		w.Write(raw)
	}))
	defer cp.Close()
	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open", ControlPlane: cp.URL, Credential: "khc_vmtest",
		SpoolMaxMiB: -1,
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)

	n := 0
	create := func(mounts []proto.Mount) (time.Duration, proto.SandboxInfo) {
		t.Helper()
		n++
		id := fmt.Sprintf("timing-%d", n)
		start := time.Now()
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Mounts: mounts})
		took := time.Since(start)
		if took > 2*time.Second {
			t.Logf("%s took %s: source %s, timings %v", id, took, info.Source, info.Timings)
		}
		for _, m := range info.Mounts {
			if m.State != proto.MountReady {
				t.Fatalf("%s: %+v", id, m)
			}
		}
		if len(mounts) > 0 {
			if r := vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, Command: "/mnt/b/run.sh", TimeoutMs: 30_000}); r.Stdout != "ran\n" {
				t.Fatalf("%s: %+v", id, r)
			}
		}
		vmCall[map[string]any](t, h, proto.MethodDelete, proto.SandboxRef{SandboxID: id})
		return took, info
	}
	median := func(d []time.Duration) time.Duration {
		s := slices.Clone(d)
		slices.Sort(s)
		return s[len(s)/2]
	}
	ms := func(d time.Duration) string { return fmt.Sprintf("%.0f ms", float64(d)/1e6) }

	// The first create makes the template; it's not counted.
	create(nil)
	var none []time.Duration
	for range runs {
		d, _ := create(nil)
		none = append(none, d)
	}
	t.Logf("no mount: median %s of %v", ms(median(none)), none)
	for _, size := range []int{1 << 20, 64 << 20, 256 << 20} {
		var cold, warm, build, warmStep []time.Duration
		var digest string
		for i := range runs {
			raw, d := bundle(size, i)
			mu.Lock()
			tars[d] = raw
			mu.Unlock()
			digest = d
			took, info := create([]proto.Mount{{Path: "/mnt/b", Kind: proto.MountBundle, Digest: d}})
			cold = append(cold, took)
			build = append(build, time.Duration(info.Timings["bundles"]*1e6))
		}
		for range runs {
			took, info := create([]proto.Mount{{Path: "/mnt/b", Kind: proto.MountBundle, Digest: digest}})
			warm = append(warm, took)
			warmStep = append(warmStep, time.Duration(info.Timings["bundles"]*1e6))
		}
		none = none[:0]
		for range runs {
			d, _ := create(nil)
			none = append(none, d)
		}
		t.Logf("no mount, again: median %s of %v", ms(median(none)), none)
		t.Logf("bundle %d MiB (tar %d bytes): cold median %s (bundles step %s) of %v; warm median %s (bundles step %s) of %v",
			size>>20, len(tars[digest]), ms(median(cold)), ms(median(build)), cold, ms(median(warm)), ms(median(warmStep)), warm)
	}
}
