package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const sourceToken = "Bearer test-token-never-logged"

// publishVersion writes a host-images version under an http image source's directory, as its operator uploads one: the
// manifest, its bundle, an amd64 kernel and a gzipped sandbox image.
func publishVersion(t *testing.T, dir, version, rootfs string) {
	t.Helper()
	v := filepath.Join(dir, version)
	kernel := []byte("kernel " + version)
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(rootfs))
	_ = w.Close()
	writeFile(t, filepath.Join(v, "vmlinux-amd64"), string(kernel))
	writeFile(t, filepath.Join(v, "sandbox-amd64.ext4.gz"), gz.String())
	sum := func(b []byte) string {
		s := sha256.Sum256(b)
		return hex.EncodeToString(s[:])
	}
	raw, _ := json.Marshal(images.Manifest{Version: version, Files: map[string]images.File{
		"vmlinux-amd64":      {Path: "vmlinux-amd64", SHA256: sum(kernel), Size: int64(len(kernel))},
		"sandbox-amd64.ext4": {Path: "sandbox-amd64.ext4.gz", SHA256: sum(gz.Bytes()), Size: int64(gz.Len()), Gzip: true},
	}})
	writeFile(t, filepath.Join(v, "manifest.json"), string(raw))
	writeFile(t, filepath.Join(v, "manifest.json.sigstore.json"), "{}")
}

func pointSource(t *testing.T, dir, version string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, "channel.json"), `{"version": "`+version+`"}`)
}

// sourceHost is a host with image patching on, following an image source on an HTTPS-less test server that wants
// sourceToken, with a tier whose sandboxes are on the versions in inUse. Its log is kept.
func sourceHost(t *testing.T, srvURL string, signed *bool) (*Host, *baseTier, *bytes.Buffer) {
	t.Helper()
	h := newLifecycleHost(t, newLifecycleTier())
	var logs bytes.Buffer
	h.log = slog.New(slog.NewTextHandler(&logs, nil))
	headers := filepath.Join(t.TempDir(), "image-source.headers")
	if err := os.WriteFile(headers, []byte("Authorization: "+sourceToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.cfg.ImagePatching = true
	h.cfg.ImageKey = "/etc/kantel-host/image.pub"
	h.cfg.ImageSource = &ImageSourceConfig{URL: srvURL, HeadersFile: headers}
	tier := &baseTier{inUse: map[string]bool{}}
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.order = []string{microvm.Tier}
	cosign := filepath.Join(t.TempDir(), "cosign")
	writeFile(t, cosign, "")
	h.patching.updater = &images.Updater{
		Store: images.Store{Dir: filepath.Join(h.cfg.Root, "images")}, Arch: "amd64", KVM: true, Log: h.log,
		Verifier: images.Verifier{Key: h.cfg.ImageKey, Cosign: cosign, Log: h.log, Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if !*signed || !strings.Contains(strings.Join(args, " "), "--key "+h.cfg.ImageKey) {
				return []byte("signature mismatch"), errors.New("exit status 1")
			}
			return nil, nil
		}},
	}
	return h, tier, &logs
}

func sourceServer(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != sourceToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, filepath.FromSlash(r.URL.Path)))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Without imageSource in its config a host follows the control plane's channel, as before; with one it follows the
// source alone, and says it doesn't follow the channel.
func TestAnImageSourceIsOffByDefault(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, p, `{"controlPlane": "https://kantel.example", "imagePatching": true}`)
	cfg, err := LoadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ImageSource != nil {
		t.Fatalf("a config without imageSource has one: %+v", cfg.ImageSource)
	}
	h := newLifecycleHost(t, newLifecycleTier())
	h.cfg.ImagePatching = true
	ch := &proto.ImageChannel{Channel: "stable", Version: "host-images-20261117", URL: "https://example.invalid/r"}
	h.followImages(context.Background(), ch)
	if got := h.patching.channel.Load(); got == nil || got.Version != ch.Version {
		t.Fatalf("a host without an image source didn't follow the channel: %+v", got)
	}

	signed := true
	h, _, _ = sourceHost(t, "https://images.example.invalid", &signed)
	h.followImages(context.Background(), ch)
	if got := h.patching.channel.Load(); got != nil {
		t.Fatalf("a host on an image source followed the channel to %s", got.Version)
	}
	if h.patching.busy.Load() {
		t.Fatal("a host on an image source started a channel update")
	}
}

// A host on an image source takes each version the source names, after its signature (against the configured key)
// and its files' digests check out; anything that doesn't leaves the current images as they are. A sandbox keeps its
// version through every update, and pointing the source back rolls back. Nothing logged holds the headers' values.
func TestAHostFollowsItsImageSource(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	srv := sourceServer(t, dir)
	signed := true
	h, tier, logs := sourceHost(t, srv.URL, &signed)
	store := h.patching.updater.Store
	current := func() string {
		v, _ := store.Current()
		return v
	}
	age := func(v string, ago time.Duration) {
		at := time.Now().Add(-ago)
		if err := os.Chtimes(filepath.Join(store.Dir, "v", v), at, at); err != nil {
			t.Fatal(err)
		}
	}

	publishVersion(t, dir, "cft-157-1", "rootfs 1")
	pointSource(t, dir, "cft-157-1")
	if err := h.followSource(ctx); err != nil {
		t.Fatal(err)
	}
	if current() != "cft-157-1" {
		t.Fatalf("current = %q", current())
	}
	age("cft-157-1", 3*time.Hour)
	// A sandbox is made, and runs, on cft-157-1.
	tier.inUse["cft-157-1"] = true

	publishVersion(t, dir, "cft-157-2", "rootfs 2")
	pointSource(t, dir, "cft-157-2")
	if err := h.followSource(ctx); err != nil {
		t.Fatal(err)
	}
	if current() != "cft-157-2" {
		t.Fatalf("current = %q", current())
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); string(raw) != "rootfs 2" {
		t.Fatalf("new sandboxes would boot %q", raw)
	}
	age("cft-157-2", 2*time.Hour)

	// A file whose digest doesn't match the manifest's: refused, nothing activated, nothing half-installed kept.
	publishVersion(t, dir, "cft-157-3", "rootfs 3")
	writeFile(t, filepath.Join(dir, "cft-157-3", "vmlinux-amd64"), "tampered")
	pointSource(t, dir, "cft-157-3")
	if err := h.followSource(ctx); err == nil {
		t.Fatal("a version with a tampered kernel was taken")
	}
	if current() != "cft-157-2" {
		t.Fatalf("current = %q after a bad digest", current())
	}
	if _, err := os.Stat(filepath.Join(store.Dir, "v", "cft-157-3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a version that failed its digest was installed: %v", err)
	}

	// Signed by another key: refused before any file is fetched.
	publishVersion(t, dir, "cft-157-3", "rootfs 3")
	signed = false
	if err := h.followSource(ctx); err == nil {
		t.Fatal("a version signed by another key was taken")
	}
	if current() != "cft-157-2" {
		t.Fatalf("current = %q after a bad signature", current())
	}
	signed = true

	// The source can't be reached: the host stays where it is.
	h.cfg.ImageSource.URL = "http://127.0.0.1:1"
	if err := h.followSource(ctx); err == nil {
		t.Fatal("an unreachable source was followed")
	}
	if current() != "cft-157-2" {
		t.Fatalf("current = %q with the source unreachable", current())
	}
	h.cfg.ImageSource.URL = srv.URL

	// A headers file the group or anyone can read: refused, and the source isn't asked at all.
	for _, mode := range []os.FileMode{0o640, 0o604} {
		if err := os.Chmod(h.cfg.ImageSource.HeadersFile, mode); err != nil {
			t.Fatal(err)
		}
		if err := h.followSource(ctx); err == nil || !strings.Contains(err.Error(), "chmod 600") {
			t.Fatalf("a headers file of mode %#o: %v", mode, err)
		}
		if current() != "cft-157-2" {
			t.Fatalf("current = %q with a readable headers file", current())
		}
	}
	if !strings.Contains(logs.String(), "only its owner may read") {
		t.Fatalf("the refusal wasn't logged with its reason:\n%s", logs.String())
	}
	if err := os.Chmod(h.cfg.ImageSource.HeadersFile, 0o600); err != nil {
		t.Fatal(err)
	}

	// cft-157-3, fixed, is taken; the running sandbox's version is still there, and a prune keeps it while it runs.
	if err := h.followSource(ctx); err != nil {
		t.Fatal(err)
	}
	if current() != "cft-157-3" {
		t.Fatalf("current = %q", current())
	}
	if removed := h.pruneImages(); len(removed) != 0 {
		t.Fatalf("a prune removed %v while a sandbox ran on cft-157-1", removed)
	}

	// Rollback: the source names cft-157-2 again, which the host still has.
	pointSource(t, dir, "cft-157-2")
	if err := h.followSource(ctx); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); current() != "cft-157-2" || string(raw) != "rootfs 2" {
		t.Fatalf("after the rollback current = %q, sandbox.ext4 = %q", current(), raw)
	}

	// The sandbox on cft-157-1 is gone: the next prune lets its version go.
	delete(tier.inUse, "cft-157-1")
	if removed := h.pruneImages(); !slices.Equal(removed, []string{"cft-157-1"}) {
		t.Fatalf("a prune removed %v, want [cft-157-1]", removed)
	}

	if strings.Contains(logs.String(), "test-token-never-logged") {
		t.Fatalf("the log holds a header's value:\n%s", logs.String())
	}
}

// A snapshot from a peer, on a version of the source the host hasn't got, has that version installed from the source
// (not the channel), without making it current.
func TestASnapshotsVersionComesFromTheImageSource(t *testing.T) {
	dir := t.TempDir()
	srv := sourceServer(t, dir)
	signed := true
	h, _, _ := sourceHost(t, srv.URL, &signed)
	publishVersion(t, dir, "cft-157-1", "rootfs 1")
	publishVersion(t, dir, "cft-157-2", "rootfs 2")
	pointSource(t, dir, "cft-157-2")
	if err := h.followSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	p, err := h.hostImage(context.Background(), "cft-157-1")
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(p); string(raw) != "rootfs 1" {
		t.Fatalf("%s = %q", p, raw)
	}
	if v, _ := h.patching.updater.Store.Current(); v != "cft-157-2" {
		t.Fatalf("installing a snapshot's version made it current: %s", v)
	}
}
