package microvm

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/signing"
)

var testGitSigning = &proto.GitSigning{Format: "gpg", KeyID: "key_1", Fingerprint: "ABCD", PublicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----", Version: 3}

func readMeta(t *testing.T, dir string) (meta, string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got meta
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	return got, string(raw)
}

// A sandbox's identity carries its key's public half, and none when it has none (which removes the guest's files).
func TestIdentityCarriesTheGitSigningKey(t *testing.T) {
	m := &Manager{}
	link := &network.Link{HostIP: netip.MustParseAddr("10.231.0.9"), GuestIP: netip.MustParseAddr("10.231.0.10")}
	s := &sandbox{meta: meta{ID: "sbx_1", GitSigning: testGitSigning}, link: link}
	got := m.identity(s, false).GitSigning
	if got == nil || *got != (guest.GitSigningConfig{Format: "gpg", KeyID: "key_1", Fingerprint: "ABCD", PublicKey: testGitSigning.PublicKey}) {
		t.Fatalf("identity's signing %+v", got)
	}
	s.meta.GitSigning = nil
	if got := m.identity(s, true).GitSigning; got != nil {
		t.Fatalf("a sandbox without a key: %+v", got)
	}
}

// A resume or fork clears the key, gives its own, or keeps (inherits) the one there is.
func TestNextGitSigning(t *testing.T) {
	other := &proto.GitSigning{Format: "ssh", Version: 4}
	if nextGitSigning(testGitSigning, other, true) != nil {
		t.Fatal("a clear kept a key")
	}
	if nextGitSigning(testGitSigning, other, false) != other {
		t.Fatal("the given key wasn't taken")
	}
	if nextGitSigning(testGitSigning, nil, false) != testGitSigning {
		t.Fatal("the key there was wasn't kept")
	}
}

// sandbox.signing of a stopped sandbox changes its record only; meta.json holds the public half and nothing private.
func TestSetSigningOfAStoppedSandbox(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sbx_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateStopped}, dir: dir}
	m := &Manager{sandboxes: map[string]*sandbox{"sbx_1": s}}
	if err := m.SetSigning(context.Background(), "sbx_1", testGitSigning); err != nil {
		t.Fatal(err)
	}
	got, raw := readMeta(t, dir)
	if got.GitSigning == nil || *got.GitSigning != *testGitSigning {
		t.Fatalf("meta.json %s", raw)
	}
	for _, private := range []string{"privateKey", "passphrase", "PRIVATE KEY"} {
		if strings.Contains(raw, private) {
			t.Fatalf("meta.json holds %q: %s", private, raw)
		}
	}
	if err := m.SetSigning(context.Background(), "sbx_1", nil); err != nil {
		t.Fatal(err)
	}
	if got, raw := readMeta(t, dir); got.GitSigning != nil || strings.Contains(raw, "gitSigning") {
		t.Fatalf("a cleared key stayed: %s", raw)
	}
	if err := m.SetSigning(context.Background(), "sbx_nope", nil); err == nil {
		t.Fatal("an unknown sandbox's key was set")
	}
}

// sandbox.signing of a running sandbox serves its signing socket and tells its guest; an agent from before POST
// /signing (a 404) still has its record changed.
func TestSetSigningOfARunningSandbox(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sbx_1")
	if err := os.MkdirAll(filepath.Join(dir, "vm"), 0o700); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var bodies []string
	agent := http.NewServeMux()
	agent.HandleFunc("POST /signing", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(raw))
		mu.Unlock()
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	mgr := signing.NewManager(signing.NewStore(func(context.Context, string) (proto.SigningKey, error) {
		return proto.SigningKey{Version: 3}, nil
	}))
	t.Cleanup(mgr.CloseAll)
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateRunning}, dir: dir, guest: guest.NewClient(handlerAgent(t, agent))}
	m := &Manager{cfg: Config{Signing: mgr}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{"sbx_1": s}}
	if err := m.SetSigning(context.Background(), "sbx_1", testGitSigning); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(bodies) != 1 || !strings.Contains(bodies[0], `"gitSigning":{"format":"gpg","keyId":"key_1","fingerprint":"ABCD"`) || strings.Contains(bodies[0], "version") {
		t.Fatalf("the guest got %v", bodies)
	}
	mu.Unlock()
	// The signing socket answers, where Firecracker hands the guest's connections to SignPort.
	conn, err := net.Dial("unix", signing.SocketPath(s.vmDir(), fc.VsockSocket))
	if err != nil {
		t.Fatalf("no signing socket: %v", err)
	}
	conn.Close()
	// Stopped: the socket goes.
	m.closeSigning(s)
	if _, err := net.Dial("unix", signing.SocketPath(s.vmDir(), fc.VsockSocket)); err == nil {
		t.Fatal("the signing socket outlived the VM")
	}

	// An older agent.
	s.guest = guest.NewClient(handlerAgent(t, http.NewServeMux()))
	if err := m.SetSigning(context.Background(), "sbx_1", nil); err != nil {
		t.Fatalf("an older agent: %v", err)
	}
	if got, _ := readMeta(t, dir); got.GitSigning != nil {
		t.Fatal("the record wasn't changed")
	}
}
