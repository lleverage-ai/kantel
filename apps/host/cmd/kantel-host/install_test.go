package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
)

// fetchImages fetches none of the operator's own files, even one at the very path the installer would use, and
// still fetches its own.
func TestFetchImagesLeavesKeptFilesAlone(t *testing.T) {
	source, root := t.TempDir(), t.TempDir()
	arch := archName()
	files := map[string]ImageFile{}
	for _, name := range []string{"vmlinux-" + arch, "sandbox-" + arch + ".ext4", "kantel-guest-" + arch} {
		if err := os.WriteFile(filepath.Join(source, name), []byte("release "+name), 0o644); err != nil {
			t.Fatal(err)
		}
		files[name] = ImageFile{Path: name}
	}
	raw, _ := json.Marshal(ImageManifest{Version: "test", Files: files})
	if err := os.WriteFile(filepath.Join(source, "manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := agent.Config{Root: root, InjectGuestAgent: true}
	cfg.Defaults()
	// A firecracker that's up to date, so nothing is downloaded.
	if err := os.MkdirAll(filepath.Dir(cfg.Firecracker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.Firecracker, []byte("#!/bin/sh\necho Firecracker "+FirecrackerVersion+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// The operator's own image, at the installer's own path.
	if err := os.MkdirAll(filepath.Dir(cfg.SandboxImage), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.SandboxImage, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := fetchImages(cfg, source, true, kept{image: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(cfg.SandboxImage); string(got) != "mine" {
		t.Errorf("the operator's image was replaced: %q", got)
	}
	if got, _ := os.ReadFile(cfg.GuestAgent); !strings.HasPrefix(string(got), "release kantel-guest") {
		t.Errorf("the installer's own agent wasn't fetched: %q", got)
	}
	// A kept file that isn't there is an error, not a silent download.
	_ = os.Remove(cfg.GuestAgent)
	if err := fetchImages(cfg, source, true, kept{image: true, agent: true}); err == nil || !strings.Contains(err.Error(), "guestAgent") {
		t.Errorf("a missing kept agent: %v", err)
	}
}

// Rerunning install keeps an operator's own sandbox image and guest agent (a custom image), and puts back only the
// installer's own paths.
func TestInstallKeepsACustomImage(t *testing.T) {
	for _, c := range []struct{ root, configured, name, want string }{
		{"/var/lib/kantel-host", "/srv/images/debian.sqfs", "sandbox.ext4", "/srv/images/debian.sqfs"},
		{"/var/lib/kantel-host", "/var/lib/kantel-host/images/sandbox.ext4", "sandbox.ext4", ""},
		{"", "/var/lib/kantel-host/images/kantel-guest", "kantel-guest", ""},
		{"/opt/kh", "/opt/kh/images//sandbox.ext4", "sandbox.ext4", ""},
		{"/opt/kh", "/var/lib/kantel-host/images/sandbox.ext4", "sandbox.ext4", "/var/lib/kantel-host/images/sandbox.ext4"},
		{"/opt/kh", "/srv/kantel-guest", "kantel-guest", "/srv/kantel-guest"},
		{"/opt/kh", "", "kantel-guest", ""},
	} {
		if got := custom(c.root, c.configured, c.name); got != c.want {
			t.Errorf("custom(%q, %q, %q) = %q, want %q", c.root, c.configured, c.name, got, c.want)
		}
	}
}
