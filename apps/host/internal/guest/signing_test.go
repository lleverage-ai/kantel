package guest

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testSigningFiles(t *testing.T) gitSigningFiles {
	dir := t.TempDir()
	return gitSigningFiles{
		config: filepath.Join(dir, "etc/kantel/gitconfig"),
		pub:    filepath.Join(dir, "etc/kantel/signing.pub"),
		system: filepath.Join(dir, "etc/gitconfig"),
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestWriteGitSigningWritesUpdatesAndRemoves(t *testing.T) {
	files := testSigningFiles(t)
	if err := os.MkdirAll(filepath.Dir(files.system), 0o755); err != nil {
		t.Fatal(err)
	}
	// An image's own system configuration is kept, with the include added once.
	if err := os.WriteFile(files.system, []byte("[core]\n\tautocrlf = input\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gpg := &GitSigningConfig{Format: "gpg", KeyID: "key_1", Fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567", PublicKey: "\n-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmDMEZ\n-----END PGP PUBLIC KEY BLOCK-----\n\n"}
	if err := writeGitSigning(gpg, files, "/usr/local/bin/kantel-sign"); err != nil {
		t.Fatal(err)
	}
	want := "# Managed by Kantel: host-side Git signing (private key stays on the host).\n" +
		"[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n" +
		"[gpg]\n\tformat = openpgp\n\tprogram = /usr/local/bin/kantel-sign\n" +
		"[user]\n\tsigningkey = 0123456789ABCDEF0123456789ABCDEF01234567\n"
	if got := readFile(t, files.config); got != want {
		t.Fatalf("gitconfig:\n%s\nwant:\n%s", got, want)
	}
	if got := readFile(t, files.pub); got != "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmDMEZ\n-----END PGP PUBLIC KEY BLOCK-----\n" {
		t.Fatalf("signing.pub %q", got)
	}
	system := readFile(t, files.system)
	if system != "[core]\n\tautocrlf = input\n\n[include]\n\tpath = /etc/kantel/gitconfig\n" {
		t.Fatalf("/etc/gitconfig %q", system)
	}
	for _, f := range []string{files.config, files.pub, files.system} {
		if info, err := os.Stat(f); err != nil || info.Mode().Perm() != 0o644 {
			t.Fatalf("%s: %v %v", f, info.Mode(), err)
		}
	}

	// A new key, in the other format: replaced, and the include not added again.
	ssh := &GitSigningConfig{Format: "ssh", KeyID: "key_2", Fingerprint: "SHA256:abc", PublicKey: "ssh-ed25519 AAAAC3Nza jeff"}
	if err := writeGitSigning(ssh, files, "/.kantel/bin/kantel-sign"); err != nil {
		t.Fatal(err)
	}
	want = "# Managed by Kantel: host-side Git signing (private key stays on the host).\n" +
		"[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n" +
		"[gpg]\n\tformat = ssh\n[gpg \"ssh\"]\n\tprogram = /.kantel/bin/kantel-sign\n" +
		"[user]\n\tsigningkey = /etc/kantel/signing.pub\n"
	if got := readFile(t, files.config); got != want {
		t.Fatalf("gitconfig:\n%s\nwant:\n%s", got, want)
	}
	if got := readFile(t, files.pub); got != "ssh-ed25519 AAAAC3Nza jeff\n" {
		t.Fatalf("signing.pub %q", got)
	}
	if got := readFile(t, files.system); got != system {
		t.Fatalf("the include was added again: %q", got)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(files.config), "*.kantel-new"))
	if len(leftovers) > 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}

	// None: both files go (and going again is fine), the include stays (Git ignores a missing include).
	for range 2 {
		if err := writeGitSigning(nil, files, "x"); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{files.config, files.pub} {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Fatalf("%s is still there: %v", f, err)
		}
	}
	if err := writeGitSigning(&GitSigningConfig{}, files, "x"); err != nil {
		t.Fatal(err)
	}
}

func TestWriteGitSigningAddsTheIncludeToAnImageWithout(t *testing.T) {
	files := testSigningFiles(t)
	if err := writeGitSigning(&GitSigningConfig{Format: "ssh", PublicKey: "ssh-ed25519 AAAA"}, files, "/usr/local/bin/kantel-sign"); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, files.system); got != "\n[include]\n\tpath = /etc/kantel/gitconfig\n" {
		t.Fatalf("/etc/gitconfig %q", got)
	}
}

func TestWriteGitSigningRefusesBadConfig(t *testing.T) {
	files := testSigningFiles(t)
	for _, cfg := range []*GitSigningConfig{
		{Format: "x509", PublicKey: "k"},
		{Format: "gpg", Fingerprint: "ABC\n[core]\n\tsshCommand = evil", PublicKey: "k"},
	} {
		if err := writeGitSigning(cfg, files, "/usr/local/bin/kantel-sign"); err == nil {
			t.Fatalf("%+v was written", cfg)
		}
	}
}

// The image's own /etc/gitconfig includes the agent's.
func TestImageGitConfigIncludesKantels(t *testing.T) {
	raw, err := os.ReadFile("../../guest/rootfs/etc/gitconfig")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "[include]\n\tpath = "+GitConfigFile+"\n") {
		t.Fatalf("guest/rootfs/etc/gitconfig: %q", raw)
	}
}

// SetSigning reaches POST /signing, whose refusals come back as the agent's; an agent from before it answers 404.
func TestSetSigningReachesTheAgent(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	// An unknown format is refused before any file is touched.
	if err := client.SetSigning(context.Background(), &GitSigningConfig{Format: "x509"}); StatusOf(err) != 500 || !strings.Contains(err.Error(), "x509") {
		t.Fatalf("an unknown format: %v", err)
	}
	old := clientFor(t, http.NewServeMux())
	if err := old.SetSigning(context.Background(), nil); !IsNotFound(err) {
		t.Fatalf("an older agent: %v", err)
	}
}
