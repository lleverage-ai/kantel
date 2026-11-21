package guest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func sumOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// stagedFiles are the staged files of uploads in dir.
func stagedFiles(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*"+stagedInfix+"*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestUploadInParts(t *testing.T) {
	dir := t.TempDir()
	server := &Server{UploadsDir: filepath.Join(t.TempDir(), "uploads")}
	client := clientFor(t, server.Handler())
	ctx := context.Background()
	path := filepath.Join(dir, "sub", "big.bin")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("the old file"), 0o644); err != nil {
		t.Fatal(err)
	}
	content := make([]byte, 5000)
	for i := range content {
		content[i] = byte(i * 13)
	}
	const part = 1024
	// Out of order and at once, with one part sent twice (a retry).
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for _, offset := range []int{4096, 0, 2048, 1024, 3072, 2048} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n, err := client.WritePart(ctx, path, "upload-1", int64(offset), content[offset:min(offset+part, len(content))])
			if err == nil && n != int64(min(part, len(content)-offset)) {
				t.Errorf("part at %d: wrote %d", offset, n)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	// Nothing at the path until it is completed.
	if got, _ := os.ReadFile(path); string(got) != "the old file" {
		t.Fatalf("the path changed before completion: %q", got)
	}
	if records, _ := os.ReadDir(server.UploadsDir); len(records) != 1 {
		t.Fatalf("want one upload recorded, got %d", len(records))
	}

	size, mode, err := client.CompleteUpload(ctx, path, "upload-1", int64(len(content)), sumOf(content), 0o750)
	if err != nil || size != int64(len(content)) || mode != 0o750 {
		t.Fatalf("complete: %d, %o, %v", size, mode, err)
	}
	got, _ := os.ReadFile(path)
	if !bytes.Equal(got, content) {
		t.Fatal("the file isn't what was uploaded")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o750 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	if s := stagedFiles(t, filepath.Dir(path)); len(s) != 0 {
		t.Fatalf("staged files left: %v", s)
	}
	if records, _ := os.ReadDir(server.UploadsDir); len(records) != 0 {
		t.Fatalf("records left: %d", len(records))
	}

	// Completing again answers as the first did; a late part is refused.
	if size, _, err := client.CompleteUpload(ctx, path, "upload-1", int64(len(content)), sumOf(content), 0o750); err != nil || size != int64(len(content)) {
		t.Fatalf("repeated completion: %d, %v", size, err)
	}
	if _, err := client.WritePart(ctx, path, "upload-1", 0, content[:part]); !IsConflict(err) {
		t.Fatalf("a part after completion: %v", err)
	}
	// Once the file has changed, a repeat is refused rather than claiming success.
	if err := os.WriteFile(path, []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.CompleteUpload(ctx, path, "upload-1", int64(len(content)), sumOf(content), 0); !IsConflict(err) {
		t.Fatalf("repeat after a change: %v", err)
	}
}

func TestUploadRefusedChecks(t *testing.T) {
	dir := t.TempDir()
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	path := filepath.Join(dir, "f.bin")
	content := []byte("hello, parts")

	for _, c := range []struct {
		name, sum string
		size      int64
	}{
		{"wrong checksum", sumOf([]byte("something else")), int64(len(content))},
		{"wrong size", sumOf(content), int64(len(content)) + 1},
	} {
		if _, err := client.WritePart(ctx, path, "upload-2", 0, content); err != nil {
			t.Fatal(err)
		}
		_, _, err := client.CompleteUpload(ctx, path, "upload-2", c.size, c.sum, 0)
		if !IsRefused(err) {
			t.Fatalf("%s: %v", c.name, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s: something is at the path: %v", c.name, err)
		}
		if s := stagedFiles(t, dir); len(s) != 0 {
			t.Fatalf("%s: the upload wasn't discarded: %v", c.name, s)
		}
		// Discarded: completing it again finds nothing.
		if _, _, err := client.CompleteUpload(ctx, path, "upload-2", int64(len(content)), sumOf(content), 0); !IsConflict(err) {
			t.Fatalf("%s: completing a discarded upload: %v", c.name, err)
		}
	}

	if _, err := client.WritePart(ctx, path, "bad id", 0, content); !IsRefused(err) {
		t.Fatalf("a bad upload ID: %v", err)
	}
	if _, err := client.WritePart(ctx, filepath.Join(dir, "dir"), "upload-3", 0, content); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.CompleteUpload(ctx, filepath.Join(dir, "dir"), "upload-3", int64(len(content)), sumOf(content), 0); !IsConflict(err) || !strings.Contains(err.Error(), "directory") {
		t.Fatalf("over a directory: %v", err)
	}
}

func TestUploadsAbandoned(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(t.TempDir(), "uploads")
	server := &Server{UploadsDir: state}
	client := clientFor(t, server.Handler())
	ctx := context.Background()

	// Aborted.
	if _, err := client.WritePart(ctx, filepath.Join(dir, "a"), "upload-a", 0, []byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := client.AbortUpload(ctx, filepath.Join(dir, "a"), "upload-a"); err != nil {
		t.Fatal(err)
	}
	if s := stagedFiles(t, dir); len(s) != 0 {
		t.Fatalf("abort left %v", s)
	}
	if err := client.AbortUpload(ctx, filepath.Join(dir, "a"), "upload-a"); err != nil {
		t.Fatalf("aborting again: %v", err)
	}

	// Idle past UploadIdle: swept. One still being written to isn't.
	if _, err := client.WritePart(ctx, filepath.Join(dir, "b"), "upload-b", 0, []byte("b")); err != nil {
		t.Fatal(err)
	}
	server.sweepUploads(time.Now().Add(UploadIdle / 2))
	if s := stagedFiles(t, dir); len(s) != 1 {
		t.Fatalf("swept too soon: %v", s)
	}
	server.sweepUploads(time.Now().Add(UploadIdle + time.Minute))
	if s := stagedFiles(t, dir); len(s) != 0 {
		t.Fatalf("an idle upload wasn't swept: %v", s)
	}

	// A previous run's: removed when the next starts.
	if _, err := client.WritePart(ctx, filepath.Join(dir, "c"), "upload-c", 0, []byte("c")); err != nil {
		t.Fatal(err)
	}
	// A record can only ever remove a staged file the agent made: not a file of another name, nor a link.
	keep := filepath.Join(dir, "keep")
	lookalike := filepath.Join(dir, "report.kantel-part-backup")
	link := filepath.Join(dir, ".x"+stagedInfix+"123")
	for _, f := range []string{keep, lookalike} {
		if err := os.WriteFile(f, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(keep, link); err != nil {
		t.Fatal(err)
	}
	for i, forged := range []string{keep, lookalike, link} {
		if err := os.WriteFile(filepath.Join(state, "forged"+strconv.Itoa(i)), []byte(forged), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	(&Server{UploadsDir: state}).RestoreUploads()
	if s, _ := filepath.Glob(filepath.Join(dir, ".c"+stagedInfix+"*")); len(s) != 0 {
		t.Fatalf("a previous run's upload is left: %v", s)
	}
	for _, f := range []string{keep, lookalike, link} {
		if _, err := os.Lstat(f); err != nil {
			t.Fatalf("a forged record removed %s: %v", f, err)
		}
	}
	if records, _ := os.ReadDir(state); len(records) != 0 {
		t.Fatalf("records left: %d", len(records))
	}
}

// The staged file is written and checked through the agent's own descriptor, never by a name someone else could
// have changed: a staged name swapped for a link is refused at completion, and what it points to is untouched.
func TestUploadStagedFileSwapped(t *testing.T) {
	dir := t.TempDir()
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	path := filepath.Join(dir, "f.bin")
	victim := filepath.Join(dir, "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WritePart(ctx, path, "upload-s", 0, []byte("first")); err != nil {
		t.Fatal(err)
	}
	staged := stagedFiles(t, dir)
	if len(staged) != 1 {
		t.Fatalf("staged: %v", staged)
	}
	if err := os.Remove(staged[0]); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, staged[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WritePart(ctx, path, "upload-s", 5, []byte("second")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.CompleteUpload(ctx, path, "upload-s", 11, sumOf([]byte("firstsecond")), 0); !IsConflict(err) {
		t.Fatalf("a swapped staged file: %v", err)
	}
	if got, _ := os.ReadFile(victim); string(got) != "precious" {
		t.Fatalf("the link's target was written: %q", got)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("something is at the path: %v", err)
	}
}

// A first part whose record can't be written leaves nothing, and the next part makes and records the upload afresh.
func TestUploadRecordFailureRetried(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(t.TempDir(), "uploads")
	if err := os.WriteFile(state, nil, 0o600); err != nil { // not a directory: recording fails
		t.Fatal(err)
	}
	client := clientFor(t, (&Server{UploadsDir: state}).Handler())
	ctx := context.Background()
	path := filepath.Join(dir, "f.bin")
	if _, err := client.WritePart(ctx, path, "upload-r", 0, []byte("x")); err == nil {
		t.Fatal("a part was taken with no record")
	}
	if s := stagedFiles(t, dir); len(s) != 0 {
		t.Fatalf("a failed first part left %v", s)
	}
	if err := os.Remove(state); err != nil {
		t.Fatal(err)
	}
	if _, err := client.WritePart(ctx, path, "upload-r", 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if records, _ := os.ReadDir(state); len(records) != 1 {
		t.Fatalf("records: %d", len(records))
	}
}
