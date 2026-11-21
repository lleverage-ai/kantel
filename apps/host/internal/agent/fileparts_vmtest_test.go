//go:build vmtest

// Real-VM test of files written in parts (sandbox.files.part, .complete and .abort): a file of several hundred MiB
// sent in parts at once and out of order, checked and moved into place; a wrong checksum refused with nothing at the
// path; an aborted upload, and one a cold stop leaves, cleaned up; one a stop with memory keeps, completed after.
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker \
//	  go test -tags vmtest -run FileParts -v ./internal/agent/
//
// Run it in a privileged container: KANTEL_VMTEST_RUN=FileParts apps/host/test/isolation.sh <images> <firecracker>,
// with images whose guest agent takes files in parts.
package agent

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestFileParts(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	cfg := Config{
		Root: t.TempDir(), Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open", SpoolMaxMiB: -1,
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	const id = "sbx_parts"
	vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Size: "default"})
	t.Cleanup(func() { _ = call(t, h, proto.MethodDelete, proto.SandboxRef{SandboxID: id}) })
	sh := func(command string) string {
		t.Helper()
		res := run(t, h, id, command)
		if res.ExitCode != 0 {
			t.Fatalf("%s: exit %d: %s", command, res.ExitCode, res.Stderr)
		}
		return strings.TrimSpace(res.Stdout)
	}
	staged := func(dir string) string {
		t.Helper()
		return strings.TrimSpace(run(t, h, id, "ls -a "+dir+" | grep kantel-part- || true").Stdout)
	}
	put := func(path, upload string, offset int64, data []byte) {
		t.Helper()
		vmCall[map[string]int64](t, h, proto.MethodFilePart, proto.FilePartParams{
			SandboxID: id, Path: path, Upload: upload, Offset: offset, Data: base64.StdEncoding.EncodeToString(data),
		})
	}
	complete := func(path, upload string, size int64, sum string) error {
		t.Helper()
		return call(t, h, proto.MethodFileComplete, proto.FilePartParams{SandboxID: id, Path: path, Upload: upload, Size: size, SHA256: sum})
	}

	// 384 MiB in 2 MiB parts, four at a time, in reverse order.
	const size = 384 << 20
	content := make([]byte, size)
	rng := rand.NewChaCha8([32]byte{1})
	_, _ = rng.Read(content)
	sum := sha256.Sum256(content)
	want := hex.EncodeToString(sum[:])
	const path = "/home/user/big/archive.bin"
	offsets := make(chan int64)
	var wg sync.WaitGroup
	began := time.Now()
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for offset := range offsets {
				put(path, "big-upload", offset, content[offset:min(offset+proto.FilePartMaxBytes, size)])
			}
		}()
	}
	for offset := int64(size - proto.FilePartMaxBytes); offset >= 0; offset -= proto.FilePartMaxBytes {
		offsets <- offset
	}
	close(offsets)
	wg.Wait()
	sent := time.Since(began)
	if got := run(t, h, id, "test -e "+path).ExitCode; got == 0 {
		t.Fatal("the file is at its path before it was completed")
	}
	if staged("/home/user/big") == "" {
		t.Fatal("no staged file beside the path")
	}
	began = time.Now()
	if err := complete(path, "big-upload", size, want); err != nil {
		t.Fatal(err)
	}
	t.Logf("%d MiB sent in %v (%.0f MiB/s), checked and moved in %v", size>>20, sent, float64(size>>20)/sent.Seconds(), time.Since(began))
	if got := sh("sha256sum " + path + " | cut -d' ' -f1"); got != want {
		t.Fatalf("the sandbox's file has SHA-256 %s, want %s", got, want)
	}
	if got := sh("stat -c '%s %a %U' " + path); got != strconv.Itoa(size)+" 644 user" {
		t.Fatalf("stat: %q", got)
	}
	if s := staged("/home/user/big"); s != "" {
		t.Fatalf("staged files left: %s", s)
	}
	if err := complete(path, "big-upload", size, want); err != nil {
		t.Fatalf("completing again: %v", err)
	}

	// A wrong checksum: refused, nothing at the path, nothing staged.
	small := []byte("part one, part two")
	put("/home/user/wrong.txt", "wrong-upload", 0, small[:9])
	put("/home/user/wrong.txt", "wrong-upload", 9, small[9:])
	err = complete("/home/user/wrong.txt", "wrong-upload", int64(len(small)), strings.Repeat("0", 64))
	if pe := asProtoError(err); pe == nil || pe.Code != proto.ErrInvalid {
		t.Fatalf("a wrong checksum: %v", err)
	}
	t.Logf("a wrong checksum: %v", err)
	if run(t, h, id, "test -e /home/user/wrong.txt").ExitCode == 0 {
		t.Fatal("a refused upload left a file at its path")
	}
	if s := staged("/home/user"); s != "" {
		t.Fatalf("a refused upload left %s", s)
	}

	// Aborted: cleaned up.
	put("/home/user/abandoned.bin", "abort-upload", 0, small)
	vmCall[struct{}](t, h, proto.MethodFileAbort, proto.FilePartParams{SandboxID: id, Path: "/home/user/abandoned.bin", Upload: "abort-upload"})
	if s := staged("/home/user"); s != "" {
		t.Fatalf("an aborted upload left %s", s)
	}

	// A stop with memory keeps an upload; a cold stop and start discards one.
	put("/home/user/paused.bin", "pause-upload", 0, small)
	keep := true
	vmCall[proto.SandboxInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: id, Memory: &keep})
	vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.SandboxRef{SandboxID: id})
	smallSum := sha256.Sum256(small)
	if err := complete("/home/user/paused.bin", "pause-upload", int64(len(small)), hex.EncodeToString(smallSum[:])); err != nil {
		t.Fatalf("completing after a stop with memory: %v", err)
	}
	put("/home/user/cold.bin", "cold-upload", 0, small)
	if staged("/home/user") == "" {
		t.Fatal("nothing staged before the cold stop")
	}
	cold := false
	vmCall[proto.SandboxInfo](t, h, proto.MethodStop, proto.StopParams{SandboxID: id, Memory: &cold})
	vmCall[proto.SandboxInfo](t, h, proto.MethodResume, proto.SandboxRef{SandboxID: id})
	if s := staged("/home/user"); s != "" {
		t.Fatalf("a cold stop left %s", s)
	}
	err = complete("/home/user/cold.bin", "cold-upload", int64(len(small)), hex.EncodeToString(smallSum[:]))
	if pe := asProtoError(err); pe == nil || pe.Code != proto.ErrConflict {
		t.Fatalf("completing an upload a cold stop discarded: %v", err)
	}
}

func asProtoError(err error) *proto.Error {
	pe, _ := err.(*proto.Error)
	return pe
}
