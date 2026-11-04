package images

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func touch(t *testing.T, p string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

// release writes a host-images release to dir, as a GitHub Release holds one: a kernel, a gzipped sandbox image, and
// the manifest listing them with their digests.
func release(t *testing.T, dir, kernel, rootfs string) Manifest {
	t.Helper()
	touch(t, filepath.Join(dir, "vmlinux-amd64"), []byte(kernel))
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(rootfs))
	_ = w.Close()
	touch(t, filepath.Join(dir, "sandbox-amd64.ext4.gz"), gz.Bytes())
	m := Manifest{Version: "0.0.0-dev", Files: map[string]File{
		"vmlinux-amd64":      {Path: "vmlinux-amd64", SHA256: digest([]byte(kernel)), Size: int64(len(kernel))},
		"sandbox-amd64.ext4": {Path: "sandbox-amd64.ext4.gz", SHA256: digest(gz.Bytes()), Size: int64(gz.Len()), Gzip: true},
	}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	touch(t, filepath.Join(dir, manifestFile), raw)
	return m
}

// Each policy: off checks nothing; a missing bundle or cosign is refused under require (saying how to relax it) and
// let through under warn; cosign is asked keyless with the expected identity, or with the key; a signature that
// doesn't check out is refused under require only.
func TestVerifier(t *testing.T) {
	dir := t.TempDir()
	artifact := filepath.Join(dir, manifestFile)
	bundle := filepath.Join(dir, bundleFile)
	cosign := filepath.Join(dir, "cosign")
	missing := filepath.Join(dir, "missing")
	touch(t, artifact, []byte("{}"))
	touch(t, bundle, []byte("{}"))
	touch(t, cosign, nil)
	keyless := []string{"verify-blob", "--bundle", bundle, "--certificate-identity-regexp", DefaultIdentity, "--certificate-oidc-issuer", DefaultIssuer, artifact}
	withKey := []string{"verify-blob", "--bundle", bundle, "--key", "/etc/kantel-host/cosign.pub", artifact}
	for _, c := range []struct {
		name   string
		v      Verifier
		bundle string
		// fail: cosign exits non-zero.
		fail bool
		// wantErr is in the error ("": no error); wantArgs are cosign's (nil: not run).
		wantErr  string
		wantArgs []string
	}{
		{name: "off checks nothing", v: Verifier{Policy: PolicyOff}, bundle: missing},
		{name: "require: no bundle", v: Verifier{Cosign: cosign}, bundle: missing, wantErr: `"imageSignatures": "warn"`},
		{name: "warn: no bundle", v: Verifier{Policy: PolicyWarn, Cosign: cosign}, bundle: missing},
		{name: "require: no cosign", v: Verifier{Policy: PolicyRequire, Cosign: missing}, bundle: bundle, wantErr: "no cosign at"},
		{name: "warn: no cosign", v: Verifier{Policy: PolicyWarn, Cosign: missing}, bundle: bundle},
		{name: "keyless", v: Verifier{Cosign: cosign}, bundle: bundle, wantArgs: keyless},
		{name: "key", v: Verifier{Cosign: cosign, Key: "/etc/kantel-host/cosign.pub"}, bundle: bundle, wantArgs: withKey},
		{name: "require: mis-signed", v: Verifier{Cosign: cosign}, bundle: bundle, fail: true, wantErr: "doesn't check out", wantArgs: keyless},
		{name: "warn: mis-signed", v: Verifier{Policy: PolicyWarn, Cosign: cosign}, bundle: bundle, fail: true, wantArgs: keyless},
		{name: "unknown policy", v: Verifier{Policy: "sometimes", Cosign: cosign}, bundle: bundle, wantErr: `want "require"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			var ran []string
			v := c.v
			v.Log = quiet()
			v.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
				if name != v.Cosign {
					t.Errorf("ran %s, want %s", name, v.Cosign)
				}
				ran = args
				if c.fail {
					return []byte("none of the expected identities matched"), errors.New("exit status 1")
				}
				return nil, nil
			}
			err := v.Verify(context.Background(), artifact, c.bundle)
			if c.wantErr == "" && err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("Verify = %v, want an error with %q", err, c.wantErr)
			}
			if !slices.Equal(ran, c.wantArgs) {
				t.Fatalf("cosign args %q, want %q", ran, c.wantArgs)
			}
		})
	}
}

func TestVersionOf(t *testing.T) {
	for p, want := range map[string]string{
		"/var/lib/kantel-host/images/v/host-images-20261103/sandbox.ext4": "host-images-20261103",
		"/var/lib/kantel-host/images/v/initial.1793836800/vmlinux":        "initial.1793836800",
		"/var/lib/kantel-host/images/sandbox.ext4":                        "",
		"/var/lib/kantel-host/images/v/x.part/sandbox.ext4":               "",
		"/srv/v/../sandbox.ext4":                                          "",
		"":                                                                "",
	} {
		if got := VersionOf(p); got != want {
			t.Errorf("VersionOf(%q) = %q, want %q", p, got, want)
		}
	}
}

// A version is fetched into v/<version> (gzip unpacked), becomes current only when activated, is kept as it is once
// installed, and its files say which version they are.
func TestStoreInstallsAndActivatesAVersion(t *testing.T) {
	ctx := context.Background()
	src, store := t.TempDir(), Store{Dir: t.TempDir()}
	m := release(t, src, "kernel", "rootfs")
	m.Version = "host-images-20261103"
	if _, ok := store.Current(); ok {
		t.Fatal("a new store has a current version")
	}
	dir, err := store.Install(ctx, src, m, "amd64", true)
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(store.Dir, "v", m.Version) {
		t.Fatalf("installed into %s", dir)
	}
	for name, want := range map[string]string{"vmlinux": "kernel", "sandbox.ext4": "rootfs"} {
		if raw, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(raw) != want {
			t.Fatalf("%s = %q (%v), want %q", name, raw, err, want)
		}
	}
	if _, ok := store.Current(); ok {
		t.Fatal("installing made it current")
	}
	if err := store.Activate(m.Version); err != nil {
		t.Fatal(err)
	}
	if v, ok := store.Current(); !ok || v != m.Version {
		t.Fatalf("current = %q, %v", v, ok)
	}
	if target, _ := os.Readlink(filepath.Join(store.Dir, "current")); target != filepath.Join("v", m.Version) {
		t.Fatalf("current links %q, want a relative link", target)
	}
	// Installed, it is kept as it is: the release isn't read again.
	touch(t, filepath.Join(src, "vmlinux-amd64"), []byte("changed"))
	if _, err := store.Install(ctx, src, m, "amd64", true); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "vmlinux")); string(raw) != "kernel" {
		t.Fatalf("a second install replaced the kernel: %q", raw)
	}
	for p, want := range map[string]string{
		filepath.Join(dir, "sandbox.ext4"):                     m.Version,
		"/elsewhere/v/" + m.Version + "/sandbox.ext4":          "",
		filepath.Join(store.Dir, "sandbox.ext4"):               "",
		filepath.Join(store.Dir, "current", "sandbox.ext4"):    "",
		filepath.Join(store.Dir, "v", "..", "sandbox.ext4"):    "",
		filepath.Join(store.Dir, "v", m.Version, "vmlinux"):    m.Version,
		filepath.Join(store.Dir, "v", "other", "sandbox.ext4"): "other",
	} {
		if got := store.Version(p); got != want {
			t.Errorf("Version(%s) = %q, want %q", p, got, want)
		}
	}
}

// What can't be installed isn't: a version that would name another directory, an architecture the release lacks,
// a file whose digest doesn't match. None leaves a version to activate.
func TestStoreInstallRefuses(t *testing.T) {
	ctx := context.Background()
	src, store := t.TempDir(), Store{Dir: t.TempDir()}
	m := release(t, src, "kernel", "rootfs")
	for _, v := range []string{"", ".", "..", "../escape", "a/b", "x.part"} {
		m.Version = v
		if _, err := store.Install(ctx, src, m, "amd64", true); err == nil {
			t.Fatalf("installed version %q", v)
		}
	}
	m.Version = "host-images-20261103"
	if _, err := store.Install(ctx, src, m, "arm64", true); err == nil || !strings.Contains(err.Error(), "vmlinux-arm64") {
		t.Fatalf("an amd64-only release on arm64: %v", err)
	}
	f := m.Files["vmlinux-amd64"]
	f.SHA256 = digest([]byte("another kernel"))
	m.Files["vmlinux-amd64"] = f
	if _, err := store.Install(ctx, src, m, "amd64", true); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("a mismatched digest: %v", err)
	}
	if store.installed(m.Version) {
		t.Fatal("a failed install left a whole version")
	}
	if err := store.Activate(m.Version); err == nil {
		t.Fatal("activated a version that isn't installed")
	}
}

// An install from before versioned images has plain files at the default paths: Link moves them, once, into a
// version that becomes current, and leaves links in their place; a custom path is never touched.
func TestStoreLinkMovesPlainImagesIntoAVersion(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	custom := filepath.Join(t.TempDir(), "isolate.ext4")
	touch(t, filepath.Join(store.Dir, "vmlinux"), []byte("kernel"))
	touch(t, filepath.Join(store.Dir, "vmlinux.sha256-source"), []byte(digest([]byte("kernel"))))
	touch(t, filepath.Join(store.Dir, "sandbox.ext4"), []byte("rootfs"))
	touch(t, custom, []byte("custom"))
	paths := Paths{Kernel: filepath.Join(store.Dir, "vmlinux"), SandboxImage: filepath.Join(store.Dir, "sandbox.ext4"), IsolateImage: custom}
	if err := store.Link(paths); err != nil {
		t.Fatal(err)
	}
	if v, ok := store.Current(); !ok || v != "initial" {
		t.Fatalf("current = %q, %v; want initial", v, ok)
	}
	for p, want := range map[string]string{paths.Kernel: "kernel", paths.SandboxImage: "rootfs"} {
		if target, err := os.Readlink(p); err != nil || target != filepath.Join("current", filepath.Base(p)) {
			t.Fatalf("%s links %q (%v)", p, target, err)
		}
		if raw, _ := os.ReadFile(p); string(raw) != want {
			t.Fatalf("%s reads %q, want %q", p, raw, want)
		}
	}
	if info, err := os.Lstat(custom); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the custom isolate image was touched: %v", err)
	}
	// Its recorded digest came along, so a version with the same kernel links it rather than downloading it.
	if _, err := os.Stat(filepath.Join(store.Dir, "v", "initial", "vmlinux.sha256-source")); err != nil {
		t.Fatal(err)
	}
	// Linked, a second Link changes nothing.
	if err := store.Link(paths); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(store.Dir, "v")); len(entries) != 1 {
		t.Fatalf("versions after a second Link: %v", entries)
	}
}

// A migration stopped at any step (a crash) loses nothing: every original image is still read at its default path,
// and the next Link finishes it, into one version, with the bytes it had.
func TestAnInterruptedMigrationIsFinishedByTheNextLink(t *testing.T) {
	for _, step := range []string{"staging", "staged", "committed", "activated", "replacing"} {
		t.Run(step, func(t *testing.T) {
			store := Store{Dir: t.TempDir()}
			want := map[string]string{"vmlinux": "kernel", "sandbox.ext4": "rootfs"}
			for name, content := range want {
				touch(t, filepath.Join(store.Dir, name), []byte(content))
			}
			touch(t, filepath.Join(store.Dir, "vmlinux.sha256-source"), []byte(digest([]byte("kernel"))))
			paths := Paths{Kernel: filepath.Join(store.Dir, "vmlinux"), SandboxImage: filepath.Join(store.Dir, "sandbox.ext4")}
			crash := errors.New("the daemon stopped")
			saved := migrationStep
			t.Cleanup(func() { migrationStep = saved })
			migrationStep = func(at string) error {
				if at == step {
					return crash
				}
				return nil
			}
			if err := store.Link(paths); !errors.Is(err, crash) {
				t.Fatalf("Link = %v, want it stopped at %s", err, step)
			}
			migrationStep = saved
			for name, content := range want {
				if raw, err := os.ReadFile(filepath.Join(store.Dir, name)); err != nil || string(raw) != content {
					t.Fatalf("stopped at %s, %s reads %q (%v), want %q", step, name, raw, err, content)
				}
			}
			// The retry finishes it; one more changes nothing.
			for range 2 {
				if err := store.Link(paths); err != nil {
					t.Fatal(err)
				}
			}
			if v, ok := store.Current(); !ok || v != "initial" {
				t.Fatalf("current = %q, %v; want initial", v, ok)
			}
			for name, content := range want {
				p := filepath.Join(store.Dir, name)
				if target, err := os.Readlink(p); err != nil || target != filepath.Join("current", name) {
					t.Fatalf("%s links %q (%v)", p, target, err)
				}
				for _, read := range []string{p, filepath.Join(store.Dir, "v", "initial", name)} {
					if raw, err := os.ReadFile(read); err != nil || string(raw) != content {
						t.Fatalf("%s reads %q (%v), want %q", read, raw, err, content)
					}
				}
			}
			if _, err := os.Stat(filepath.Join(store.Dir, "v", "initial", "vmlinux.sha256-source")); err != nil {
				t.Fatalf("the kernel's recorded digest: %v", err)
			}
			entries, _ := os.ReadDir(filepath.Join(store.Dir, "v"))
			if len(entries) != 1 || entries[0].Name() != "initial" {
				t.Fatalf("versions after the retry: %v", entries)
			}
		})
	}
}

// A check whose download stalls ends at its deadline and lets the next check, or a prune, go ahead.
func TestACheckEndsAtItsDeadline(t *testing.T) {
	stalled := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Headers and a first byte, then nothing: the body's read is what has to end.
		w.Header().Set("Content-Length", "4096")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{"))
		w.(http.Flusher).Flush()
		select {
		case <-stalled:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(stalled)
	u := &Updater{Store: Store{Dir: t.TempDir()}, Verifier: Verifier{Policy: PolicyOff, Log: quiet()}, Arch: "amd64", Log: quiet()}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	checked := make(chan error, 1)
	go func() {
		checked <- u.Check(ctx, proto.ImageChannel{Channel: "stable", Version: "host-images-20261104", URL: srv.URL})
	}()
	select {
	case err := <-checked:
		if err == nil {
			t.Fatal("a stalled download was taken")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the check outlived its deadline")
	}
	pruned := make(chan []string, 1)
	go func() { pruned <- u.Prune(nil, 2) }()
	select {
	case <-pruned:
	case <-time.After(5 * time.Second):
		t.Fatal("the check kept the updater's lock")
	}
	if _, ok := u.Store.Current(); ok {
		t.Fatal("a failed check changed current")
	}
}

// A prune keeps the current version, the newest few, and what the tiers still use; a version being fetched isn't
// one yet.
func TestStorePruneKeepsCurrentNewestAndKept(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e"} {
		dir := filepath.Join(store.Dir, "v", v)
		touch(t, filepath.Join(dir, manifestFile), []byte("{}"))
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	touch(t, filepath.Join(store.Dir, "v", "f.part", "vmlinux"), nil)
	if err := store.Activate("a"); err != nil {
		t.Fatal(err)
	}
	removed := store.Prune(func(v string) bool { return v == "b" }, 2)
	if !slices.Equal(removed, []string{"c"}) {
		t.Fatalf("removed %v, want [c]", removed)
	}
	for _, v := range []string{"a", "b", "d", "e", "f.part"} {
		if _, err := os.Stat(filepath.Join(store.Dir, "v", v)); err != nil {
			t.Errorf("%s: %v", v, err)
		}
	}
	if _, err := os.Stat(filepath.Join(store.Dir, "v", "c")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("c is still there: %v", err)
	}
}

// The manifest's signature is checked before anything else is fetched: a check that doesn't pass downloads no image
// and leaves current where it was. One that passes installs, activates and says so; a release without a bundle is
// refused under require.
func TestUpdaterChecksTheSignatureFirst(t *testing.T) {
	ctx := context.Background()
	src, store := t.TempDir(), Store{Dir: t.TempDir()}
	release(t, src, "kernel", "rootfs")
	touch(t, filepath.Join(src, bundleFile), []byte("{}"))
	cosign := filepath.Join(t.TempDir(), "cosign")
	touch(t, cosign, nil)
	oldSrc := t.TempDir()
	old := release(t, oldSrc, "old kernel", "old rootfs")
	old.Version = "host-images-20261001"
	if _, err := store.Install(ctx, oldSrc, old, "amd64", true); err != nil {
		t.Fatal(err)
	}
	if err := store.Activate(old.Version); err != nil {
		t.Fatal(err)
	}

	var checked, activated []string
	signed := false
	u := &Updater{
		Store: store, Arch: "amd64", KVM: true, Log: quiet(),
		OnActivate: func(v string) { activated = append(activated, v) },
		Verifier: Verifier{Cosign: cosign, Log: quiet(), Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			checked = append(checked, args[len(args)-1])
			if !signed {
				return []byte("bad signature"), errors.New("exit status 1")
			}
			return nil, nil
		}},
	}
	ch := proto.ImageChannel{Channel: "stable", Version: "host-images-20261103", URL: src}
	if err := u.Check(ctx, ch); err == nil {
		t.Fatal("a mis-signed release was taken")
	}
	if len(checked) != 1 || filepath.Base(checked[0]) != manifestFile {
		t.Fatalf("cosign checked %v, want the manifest", checked)
	}
	if _, err := os.Stat(filepath.Join(store.Dir, "v", ch.Version+".part")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("images were fetched before the signature checked out: %v", err)
	}
	if v, _ := store.Current(); v != old.Version || len(activated) != 0 {
		t.Fatalf("current = %s, activated %v", v, activated)
	}

	signed = true
	if err := u.Check(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if v, _ := store.Current(); v != ch.Version {
		t.Fatalf("current = %s, want %s", v, ch.Version)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); string(raw) != "rootfs" {
		t.Fatalf("current sandbox.ext4 = %q", raw)
	}
	if !slices.Equal(activated, []string{ch.Version}) {
		t.Fatalf("activated %v", activated)
	}
	// The old version is still there for the sandboxes on it.
	if !store.installed(old.Version) {
		t.Fatal("the update removed the old version")
	}
	// Current already: nothing is fetched or checked.
	checked = nil
	if err := u.Check(ctx, ch); err != nil || len(checked) != 0 {
		t.Fatalf("a check of the current version: %v, cosign ran %d times", err, len(checked))
	}
	// No bundle: refused under require, before cosign runs.
	if err := os.Remove(filepath.Join(src, bundleFile)); err != nil {
		t.Fatal(err)
	}
	next := ch
	next.Version = "host-images-20261104"
	if err := u.Check(ctx, next); err == nil || !strings.Contains(err.Error(), "signature bundle") {
		t.Fatalf("a release without a bundle: %v", err)
	}
	if v, _ := store.Current(); v != ch.Version || len(checked) != 0 {
		t.Fatalf("current = %s, cosign ran %d times", v, len(checked))
	}
}

func TestFetchCosign(t *testing.T) {
	if os.Getenv("KANTEL_NETWORK_TESTS") == "" {
		t.Skip("downloads cosign from GitHub: set KANTEL_NETWORK_TESTS=1")
	}
	dst := filepath.Join(t.TempDir(), "cosign")
	if err := FetchCosign(context.Background(), dst); err != nil {
		t.Fatal(err)
	}
	// Fetched, it is kept.
	if err := FetchCosign(context.Background(), dst); err != nil {
		t.Fatal(err)
	}
}
