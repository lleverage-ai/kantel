package microvm

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A stop that lands while the previous stop's memory is still being copied: the copy must not be renamed over the
// newer symlink (seen end to end: stop, resume, stop again within seconds, and the next resume's guest hung).
func TestSpoolNeverRenamesOverANewerStop(t *testing.T) {
	root := t.TempDir()
	sp := newSpool(filepath.Join(root, "spool"), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	vm := filepath.Join(root, "mem")
	write := func(b byte) string {
		path := sp.reserve(4096)
		if path == "" {
			t.Fatal("no room")
		}
		if err := os.WriteFile(path, bytes.Repeat([]byte{b}, 4096), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	old := write(1)
	newer := write(2)
	var once bool
	sp.beforeRename = func(target string) {
		if once {
			return
		}
		once = true
		// The second stop, while the first one's copy is done but not yet renamed. The worker is busy here, so the
		// second place queues behind it.
		_ = os.Remove(vm)
		if err := sp.place(newer, vm); err != nil {
			t.Error(err)
		}
	}
	if err := sp.place(old, vm); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		sp.mu.Lock()
		pending := len(sp.targets)
		sp.mu.Unlock()
		if pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the spool never drained")
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, err := os.ReadFile(vm)
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != 2 {
		t.Fatalf("mem holds stop %d's memory, want the newer stop's (2)", got[0])
	}
	left, _ := filepath.Glob(filepath.Join(root, ".*"))
	if len(left) != 0 {
		t.Fatalf("copies left behind: %v", left)
	}
}

func TestSpoolMovesMemoryToDiskAndKeepsLinks(t *testing.T) {
	root := t.TempDir()
	sp := newSpool(filepath.Join(root, "spool"), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if sp.reserve(2<<20) != "" {
		t.Fatal("reserved more than the spool holds")
	}
	path := sp.reserve(4096)
	if path == "" {
		t.Fatal("no room")
	}
	data := bytes.Repeat([]byte{7}, 4096)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	vm := filepath.Join(root, "vm-mem")
	snap := filepath.Join(root, "snap-mem")
	gone := filepath.Join(root, "gone-mem")
	// Hold the worker off while the links are made, as a stop's snapshot does right after the stop.
	sp.mu.Lock()
	sp.targets[path] = append(sp.targets[path], vm)
	if err := os.Symlink(path, vm); err != nil {
		t.Fatal(err)
	}
	sp.mu.Unlock()
	if err := sp.link(vm, snap); err != nil {
		t.Fatal(err)
	}
	if err := sp.link(vm, gone); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(gone) // a pruned snapshot
	sp.queue <- path
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("spool file never moved")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, p := range []string{vm, snap} {
		info, err := os.Lstat(p)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("%s: still a link or missing (%v)", p, err)
		}
		got, _ := os.ReadFile(p)
		if !bytes.Equal(got, data) {
			t.Fatalf("%s: wrong contents", p)
		}
	}
	if _, err := os.Lstat(gone); !os.IsNotExist(err) {
		t.Fatal("a deleted target came back")
	}
	sp.mu.Lock()
	used := sp.used
	sp.mu.Unlock()
	if used != 0 {
		t.Fatalf("spool still counts %d bytes", used)
	}
}
