package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileDurablyReplacesTheFileAndLeavesNoTemporary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "meta.json")
	for _, data := range []string{"one", "two"} {
		if err := WriteFileDurably(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(path); err != nil || string(got) != data {
			t.Fatalf("read %q %v, want %q", got, err, data)
		}
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode: %v %v", info, err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("the temporary file was left: %v", err)
	}
	// A directory that isn't there fails, and changes nothing.
	if err := WriteFileDurably(filepath.Join(dir, "missing", "meta.json"), []byte("x"), 0o600); err == nil {
		t.Fatal("a write into a missing directory worked")
	}
}
