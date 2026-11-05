package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// One release holds both architectures: the kernel build's names (x86_64, aarch64) become Go's, so a host finds its
// own files by archName, and checkArch turns an architecture the release lacks into an error that says so.
func TestManifestHoldsBothArchitectures(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"vmlinux-x86_64", "vmlinux-aarch64", "vmlinux-aarch64.config", "sandbox-amd64.ext4.gz",
		"sandbox-arm64.ext4.gz", "isolate-arm64.ext4.gz", "SHA256SUMS", "source-x264-b35605ace3dd.tar.gz"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
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
	want := map[string]string{
		"vmlinux-amd64":      "vmlinux-x86_64",
		"vmlinux-arm64":      "vmlinux-aarch64",
		"sandbox-amd64.ext4": "sandbox-amd64.ext4.gz",
		"sandbox-arm64.ext4": "sandbox-arm64.ext4.gz",
		"isolate-arm64.ext4": "isolate-arm64.ext4.gz",
	}
	if len(manifest.Files) != len(want) {
		t.Fatalf("files = %v, want %v", manifest.Files, want)
	}
	for name, path := range want {
		if manifest.Files[name].Path != path {
			t.Errorf("%s = %+v, want path %s", name, manifest.Files[name], path)
		}
	}
	for _, arch := range []string{"amd64", "arm64"} {
		if err := checkArch(manifest, arch); err != nil {
			t.Errorf("checkArch(%s) = %v", arch, err)
		}
	}
	delete(manifest.Files, "vmlinux-arm64")
	delete(manifest.Files, "sandbox-arm64.ext4")
	err = checkArch(manifest, "arm64")
	if err == nil || !strings.Contains(err.Error(), "no arm64 images") || !strings.Contains(err.Error(), "only amd64") {
		t.Errorf("checkArch(arm64) on an amd64-only release = %v", err)
	}
	if err := checkArch(ImageManifest{Files: map[string]ImageFile{}}, "amd64"); err == nil {
		t.Error("checkArch on an empty manifest passed")
	}
}
