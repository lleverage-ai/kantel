//go:build vmtest

// Real-VM bundle mount tests: a bundle's tar served as the control plane serves it, built into an erofs image once
// and mounted read-only in several microVMs, through create (from the template, and a custom shape's cold boot), stop and
// resume, fork, and a bundle that can't be fetched. Run as the isolation tests are (apps/host/test/isolation.sh, with
// KANTEL_VMTEST_RUN=Bundles), with images whose kernel has erofs and whose guest agent mounts bundles, and
// mkfs.erofs (erofs-utils) installed.
package agent

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func bundleTar(t *testing.T, files map[string]struct {
	body string
	mode int64
}) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: f.mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg, ModTime: time.Now()}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), "sha256:" + hex.EncodeToString(sum[:])
}

func TestBundles(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	type file = struct {
		body string
		mode int64
	}
	skills, skillsDigest := bundleTar(t, map[string]file{
		"skills/hello/run.sh":   {"#!/bin/sh\necho \"hello from $(basename \"$0\") in $(dirname \"$0\")\"\n", 0o755},
		"skills/hello/data.txt": {"bundle data\n", 0o644},
	})
	other, otherDigest := bundleTar(t, map[string]file{"notes.md": {"# notes\n", 0o600}})
	missing := "sha256:" + strings.Repeat("0", 64)

	// The control plane's GET /v1/hosts/bundles/{digest}, counting fetches.
	var mu sync.Mutex
	fetches := map[string]int{}
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer khc_vmtest" || r.URL.Query().Get("sandboxId") == "" {
			http.Error(w, "unauthorised", http.StatusUnauthorized)
			return
		}
		digest := strings.TrimPrefix(r.URL.Path, "/v1/hosts/bundles/")
		mu.Lock()
		fetches[digest]++
		mu.Unlock()
		switch digest {
		case skillsDigest:
			w.Write(skills)
		case otherDigest:
			w.Write(other)
		default:
			http.Error(w, `{"error":{"code":"not_found"}}`, http.StatusNotFound)
		}
	}))
	defer cp.Close()
	fetched := func(d string) int {
		mu.Lock()
		defer mu.Unlock()
		return fetches[d]
	}

	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open", ControlPlane: cp.URL, Credential: "khc_vmtest",
		// A container's /dev/shm is too small for a memory snapshot.
		SpoolMaxMiB: -1,
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	found := false
	for _, f := range h.Facts().Features {
		found = found || f == proto.FeatureBundleMounts
	}
	if !found {
		t.Fatalf("the host offers bundle mounts: %v", h.Facts().Features)
	}

	sh := func(sandbox, command string) proto.ExecResult {
		t.Helper()
		return vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: sandbox, Command: command, TimeoutMs: 30_000})
	}
	ready := func(info proto.SandboxInfo, want int) {
		t.Helper()
		if len(info.Mounts) != want {
			t.Fatalf("%s: %d mounts, want %d: %+v", info.ID, len(info.Mounts), want, info.Mounts)
		}
		for _, m := range info.Mounts {
			if m.State != proto.MountReady {
				t.Fatalf("%s: mount %s is %s: %s", info.ID, m.Path, m.State, m.Error)
			}
		}
	}
	check := func(sandbox string) {
		t.Helper()
		if r := sh(sandbox, "cat /workspace/skills/skills/hello/data.txt"); r.ExitCode != 0 || r.Stdout != "bundle data\n" {
			t.Fatalf("%s: cat: %+v", sandbox, r)
		}
		if r := sh(sandbox, "/workspace/skills/skills/hello/run.sh"); r.ExitCode != 0 || !strings.Contains(r.Stdout, "hello from run.sh in /workspace/skills/skills/hello") {
			t.Fatalf("%s: run: %+v", sandbox, r)
		}
		for _, cmd := range []string{"touch /workspace/skills/new", "echo x >> /workspace/skills/skills/hello/data.txt", "sudo touch /workspace/skills/new", "sudo rm /workspace/skills/skills/hello/data.txt"} {
			r := sh(sandbox, cmd)
			if r.ExitCode == 0 || !strings.Contains(r.Stderr, "Read-only file system") {
				t.Fatalf("%s: %q must fail with EROFS: %+v", sandbox, cmd, r)
			}
		}
		if r := sh(sandbox, "findmnt -no FSTYPE,OPTIONS /workspace/skills"); !strings.HasPrefix(r.Stdout, "erofs ro,") {
			t.Fatalf("%s: findmnt: %+v", sandbox, r)
		}
	}
	mounts := []proto.Mount{{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: skillsDigest}}

	a := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-a", Tier: "microvm", Mounts: mounts})
	t.Logf("a: source %s, timings %v", a.Source, a.Timings)
	ready(a, 1)
	check("bundle-a")

	// A custom shape has no template: it cold-boots with empty drives, and the bundle is attached once it is up.
	b := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-b", Tier: "microvm", VCPUs: 2, MemoryMiB: 1536, DiskGiB: 12, Mounts: mounts})
	t.Logf("b: source %s, timings %v", b.Source, b.Timings)
	ready(b, 1)
	check("bundle-b")
	if n := fetched(skillsDigest); n != 1 {
		t.Fatalf("one fetch for two sandboxes, got %d", n)
	}
	image := filepath.Join(root, "bundles", "images", strings.TrimPrefix(skillsDigest, "sha256:")+".erofs")
	var st syscall.Stat_t
	if err := syscall.Stat(image, &st); err != nil {
		t.Fatal(err)
	}
	if st.Nlink != 3 {
		t.Fatalf("one image on the host, linked by both sandboxes' drives: %d links", st.Nlink)
	}

	// Stop and resume: the restored guest still has its mount.
	vmCall[proto.SnapshotInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: "bundle-a", SnapshotID: "snap-a1"})
	resumed := vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.ResumeParams{SandboxID: "bundle-a"})
	ready(resumed, 1)
	check("bundle-a")

	// A live fork has the mount too.
	fork := vmCall[proto.SandboxInfo](t, h, proto.MethodFork, proto.ForkParams{SandboxID: "bundle-a", NewID: "bundle-fork", SnapshotID: "snap-a2"})
	ready(fork, 1)
	check("bundle-fork")

	// Stopped without its memory, it boots from its disk, with its drives as they were, and mounts them again.
	no := false
	vmCall[proto.SnapshotInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: "bundle-b", SnapshotID: "snap-b1", Memory: &no})
	booted := vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.ResumeParams{SandboxID: "bundle-b"})
	t.Logf("b booted: source %s", booted.Source)
	ready(booted, 1)
	check("bundle-b")

	// From a's snapshot (its memory has the skills bundle mounted at /workspace/skills), but with another bundle
	// there: the guest lets go of the old one before its drive changes.
	d := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-d", Tier: "microvm", From: "snap-a2", Mounts: []proto.Mount{
		{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: otherDigest},
	}})
	ready(d, 1)
	if r := sh("bundle-d", "ls /workspace/skills; cat /workspace/skills/notes.md"); r.ExitCode != 0 || r.Stdout != "notes.md\n# notes\n" {
		t.Fatalf("d: %+v", r)
	}
	if r := sh("bundle-d", "findmnt -rno TARGET | grep -c /workspace/skills"); strings.TrimSpace(r.Stdout) != "1" {
		t.Fatalf("d: one mount at the path, not the snapshot's under the new one: %+v", r)
	}

	// The same, but a process in the snapshot works in the old bundle (its working directory and an open file there):
	// the old bundle can't be unmounted, so its drive keeps its image (never changed under a live file system), the new
	// bundle's mount fails saying why, and the sandbox runs with the process's view of the old bundle intact.
	if r := sh("bundle-a", "sudo systemd-run --unit=bundle-holder --working-directory=/workspace/skills/skills/hello sh -c 'exec 3< data.txt; exec sleep 3600' && sleep 0.5 && systemctl is-active bundle-holder"); r.ExitCode != 0 {
		t.Fatalf("a: start a process in the bundle: %+v", r)
	}
	vmCall[proto.SandboxInfo](t, h, proto.MethodFork, proto.ForkParams{SandboxID: "bundle-a", NewID: "bundle-fork2", SnapshotID: "snap-a3"})
	e := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-e", Tier: "microvm", From: "snap-a3", Mounts: []proto.Mount{
		{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: otherDigest},
	}})
	t.Logf("e: state %s, mounts %+v", e.State, e.Mounts)
	if e.State != proto.StateRunning || len(e.Mounts) != 1 || e.Mounts[0].State != proto.MountFailed || !strings.Contains(e.Mounts[0].Error, "still in use in the sandbox") {
		t.Fatalf("e: the new bundle fails, the sandbox runs: %+v", e)
	}
	if r := sh("bundle-e", "pid=$(systemctl show -p MainPID --value bundle-holder); sudo cat /proc/$pid/cwd/data.txt; sudo cat /proc/$pid/fd/3; cat /workspace/skills/skills/hello/data.txt; findmnt -rno SOURCE,FSTYPE /workspace/skills"); r.ExitCode != 0 || r.Stdout != "bundle data\nbundle data\nbundle data\n/dev/vdc erofs\n" {
		t.Fatalf("e: the old bundle, as it was, for the process and at its path: %+v", r)
	}
	if r := sh("bundle-a", "sudo systemctl stop bundle-holder; true"); r.ExitCode != 0 {
		t.Fatalf("a: %+v", r)
	}

	// Nothing in the agent's mount namespace uses the old bundle, so its unmount there succeeds, but a file system on its
	// drive lives on: in another mount namespace (a container's private mount: f), or as a bind mount hidden under another
	// mount (g). Either way the drive is held, keeps its image, and the new bundle fails.
	for _, held := range []struct{ id, setup, read, cleanup string }{
		{"bundle-f",
			"sudo systemd-run --unit=bundle-ns unshare --mount --propagation private sleep 3600 && sleep 0.5 && systemctl is-active bundle-ns",
			"pid=$(systemctl show -p MainPID --value bundle-ns); sudo nsenter -t $pid -m cat /workspace/skills/skills/hello/data.txt",
			"sudo systemctl stop bundle-ns; true"},
		{"bundle-g",
			// Private, so the tmpfs over it (and its unmount) isn't propagated to the bundle's own mount point.
			"sudo mkdir -p /mnt/hidden && sudo mount --bind /workspace/skills /mnt/hidden && sudo mount --make-private /mnt/hidden && sudo mount -t tmpfs tmpfs /mnt/hidden && findmnt -rno FSTYPE /mnt/hidden | tail -1",
			"sudo umount /mnt/hidden && cat /mnt/hidden/skills/hello/data.txt",
			"sudo umount /mnt/hidden; sudo umount /mnt/hidden; true"},
	} {
		if r := sh("bundle-a", held.setup); r.ExitCode != 0 {
			t.Fatalf("%s: hold the bundle: %+v", held.id, r)
		}
		snapID := "snap-" + held.id
		vmCall[proto.SandboxInfo](t, h, proto.MethodFork, proto.ForkParams{SandboxID: "bundle-a", NewID: held.id + "-fork", SnapshotID: snapID})
		got := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: held.id, Tier: "microvm", From: snapID, Mounts: []proto.Mount{
			{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: otherDigest},
		}})
		t.Logf("%s: state %s, mounts %+v", held.id, got.State, got.Mounts)
		if got.State != proto.StateRunning || len(got.Mounts) != 1 || got.Mounts[0].State != proto.MountFailed || !strings.Contains(got.Mounts[0].Error, "can't be unmounted") {
			t.Fatalf("%s: the new bundle fails, the sandbox runs: %+v", held.id, got)
		}
		if r := sh(held.id, held.read); r.ExitCode != 0 || r.Stdout != "bundle data\n" {
			t.Fatalf("%s: the old bundle's file system still reads the old bundle: %+v", held.id, r)
		}
		if r := sh("bundle-a", held.cleanup); r.ExitCode != 0 {
			t.Fatalf("a: %+v", r)
		}
	}

	// Two bundles, one at two paths, and one that can't be fetched: the sandbox runs, that mount fails.
	c := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-c", Tier: "microvm", Mounts: []proto.Mount{
		{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: skillsDigest},
		{Path: "/opt/skills-again", Kind: proto.MountBundle, Digest: skillsDigest},
		{Path: "/home/user/notes", Kind: proto.MountBundle, Digest: otherDigest},
		{Path: "/mnt/missing", Kind: proto.MountBundle, Digest: missing},
	}})
	t.Logf("c: source %s, mounts %+v", c.Source, c.Mounts)
	byPath := map[string]proto.MountStatus{}
	for _, m := range c.Mounts {
		byPath[m.Path] = m
	}
	for _, p := range []string{"/workspace/skills", "/opt/skills-again", "/home/user/notes"} {
		if byPath[p].State != proto.MountReady {
			t.Fatalf("c: %s is %+v", p, byPath[p])
		}
	}
	if m := byPath["/mnt/missing"]; m.State != proto.MountFailed || !strings.Contains(m.Error, "404") {
		t.Fatalf("c: a bundle that can't be fetched fails with why: %+v", m)
	}
	if r := sh("bundle-c", "cat /home/user/notes/notes.md /opt/skills-again/skills/hello/data.txt"); r.ExitCode != 0 || r.Stdout != "# notes\nbundle data\n" {
		t.Fatalf("c: %+v", r)
	}
	check("bundle-c")

	// A sandbox without mounts is as before, with empty drives.
	plain := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "bundle-plain", Tier: "microvm"})
	if len(plain.Mounts) != 0 {
		t.Fatalf("plain: %+v", plain.Mounts)
	}
	if r := sh("bundle-plain", "cat /sys/block/vdc/size; lsblk -dno NAME | tr '\\n' ' '"); r.ExitCode != 0 || !strings.HasPrefix(r.Stdout, "0\n") {
		t.Fatalf("plain: %+v", r)
	}

	// Delete them all: the image is in use by no one, and may go.
	for _, id := range []string{"bundle-a", "bundle-b", "bundle-fork", "bundle-fork2", "bundle-c", "bundle-d", "bundle-e", "bundle-plain"} {
		vmCall[map[string]any](t, h, proto.MethodDelete, proto.SandboxRef{SandboxID: id})
	}
	if err := syscall.Stat(image, &st); err == nil && st.Nlink > 1 {
		// The automatic snapshot of a's stop and fork keep it until they go with a.
		t.Logf("image links after delete: %d", st.Nlink)
	}
	fmt.Fprintf(os.Stderr, "fetches: %v\n", fetches)
}
