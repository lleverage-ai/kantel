package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The manifest lists each image by Go's architecture name with the digest of its bytes, the gzipped file winning
// over a plain one, and skips what install never asks for.
func TestManifestHashesTheImages(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("vmlinux-x86_64", "kernel")
	write("vmlinux-x86_64.config", "config")
	write("sandbox-amd64.ext4", "plain")
	write("sandbox-amd64.ext4.gz", "gzipped")
	write("notes.txt", "ignored")
	if err := manifestCmd([]string{dir}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest ImageManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	digest := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:])
	}
	if len(manifest.Files) != 2 {
		t.Fatalf("files = %v, want vmlinux-amd64 and sandbox-amd64.ext4", manifest.Files)
	}
	if f := manifest.Files["vmlinux-amd64"]; f.Path != "vmlinux-x86_64" || f.SHA256 != digest("kernel") || f.Size != 6 {
		t.Errorf("vmlinux-amd64 = %+v", f)
	}
	if f := manifest.Files["sandbox-amd64.ext4"]; f.Path != "sandbox-amd64.ext4.gz" || !f.Gzip || f.SHA256 != digest("gzipped") {
		t.Errorf("sandbox-amd64.ext4 = %+v", f)
	}
}
