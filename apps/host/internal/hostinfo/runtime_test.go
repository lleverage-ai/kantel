package hostinfo

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestParseFirecrackerVersion(t *testing.T) {
	for out, want := range map[string]string{
		"Firecracker v1.17.0\n\nSupported snapshot data format versions: v5.0.0\n": "v1.17.0",
		"v1.9.1\n": "v1.9.1",
		"":         "",
	} {
		if got := parseFirecrackerVersion(out); got != want {
			t.Fatalf("parseFirecrackerVersion(%q) = %q, want %q", out, got, want)
		}
	}
}

func TestGuestKernelIsItsVersionAndAHashPrefix(t *testing.T) {
	dir := t.TempDir()
	// A format string before the banner, and the banner across the 1 MiB chunk boundary.
	image := append(bytes.Repeat([]byte{0}, 1<<20-10), []byte("Linux version %s\x00Linux version 6.1.102 (builder@ci) #1 SMP\n")...)
	image = append([]byte("Linux version %s (%s)\x00"), image...)
	kernel := filepath.Join(dir, "vmlinux")
	if err := os.WriteFile(kernel, image, 0o600); err != nil {
		t.Fatal(err)
	}
	got := GuestKernel(kernel)
	if !regexp.MustCompile(`^6\.1\.102\+[0-9a-f]{12}$`).MatchString(got) {
		t.Fatalf("GuestKernel = %q", got)
	}
	// Another build of the same version is another kernel.
	other := filepath.Join(dir, "vmlinux.other")
	if err := os.WriteFile(other, append(image, 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if again := GuestKernel(other); again == got || again[:8] != "6.1.102+" {
		t.Fatalf("another build: %q (first %q)", again, got)
	}
	bare := filepath.Join(dir, "bzImage")
	if err := os.WriteFile(bare, []byte("compressed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := GuestKernel(bare); !regexp.MustCompile(`^sha256:[0-9a-f]{12}$`).MatchString(got) {
		t.Fatalf("without a banner: %q", got)
	}
	if got := GuestKernel(filepath.Join(dir, "missing")); got != "" {
		t.Fatalf("missing: %q", got)
	}
}
