package signing

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/packet"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// signingHost is a Manager serving one sandbox on a Unix socket, as Firecracker hands its guest's connections over.
type signingHost struct {
	m       *Manager
	kantel  *fakeKantel
	client  *http.Client
	mu      sync.Mutex
	records []proto.SigningRecord
}

func newSigningHost(t *testing.T, answer proto.SigningKey) *signingHost {
	t.Helper()
	kantel := &fakeKantel{}
	kantel.set(answer, nil)
	h := &signingHost{m: NewManager(NewStore(kantel.fetch)), kantel: kantel}
	h.m.OnRecord = func(r proto.SigningRecord) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.records = append(h.records, r)
	}
	dir := t.TempDir()
	if err := h.m.Listen("sbx_1", dir, "vsock.sock"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.m.CloseAll)
	path := SocketPath(dir, "vsock.sock")
	if !strings.HasSuffix(path, "/vsock.sock_1028") {
		t.Fatalf("socket %s", path)
	}
	h.client = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}}
	return h
}

func (h *signingHost) sign(t *testing.T, format string, payload []byte) (int, guest.SignAnswer, string) {
	t.Helper()
	body, _ := json.Marshal(guest.SignRequest{Format: format, Payload: base64.StdEncoding.EncodeToString(payload)})
	res, err := h.client.Post("http://host/sign", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var answer guest.SignAnswer
	_ = json.Unmarshal(raw, &answer)
	return res.StatusCode, answer, string(raw)
}

func (h *signingHost) last() proto.SigningRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.records) == 0 {
		return proto.SigningRecord{}
	}
	return h.records[len(h.records)-1]
}

func (h *signingHost) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.records)
}

func TestSignServesOnlyAllowedGitObjects(t *testing.T) {
	k := newGPGKey(t, packet.PubKeyAlgoEdDSA, "pass", false)
	answer := proto.SigningKey{Version: 1, Enabled: true, Format: FormatGPG, KeyID: "key_1", Fingerprint: "ABCD", AllowedEmails: []string{testEmail}, PrivateKey: k.private, Passphrase: k.passphrase}
	h := newSigningHost(t, answer)

	// Allowed: committed by jeff (authored by alex, as a cherry-pick or rebase leaves it).
	status, got, raw := h.sign(t, FormatGPG, testCommit())
	if status != http.StatusOK {
		t.Fatalf("%d %s", status, raw)
	}
	ring, _ := openpgp.ReadArmoredKeyRing(strings.NewReader(k.public))
	if _, err := openpgp.CheckArmoredDetachedSignature(ring, bytes.NewReader(testCommit()), strings.NewReader(got.Signature), nil); err != nil {
		t.Fatal(err)
	}
	if got.Format != FormatGPG || got.KeyID != "key_1" || got.PKAlgo != 22 || got.HashAlgo != 8 || got.Timestamp == 0 || len(got.Fingerprint) != 40 {
		t.Fatalf("answer %+v", got)
	}
	if strings.Contains(raw, "PRIVATE KEY") || strings.Contains(raw, k.passphrase) {
		t.Fatal("the answer holds the key")
	}
	rec := h.last()
	if !rec.Allowed || rec.SandboxID != "sbx_1" || rec.Format != FormatGPG || rec.KeyID != "key_1" || rec.Fingerprint != "ABCD" ||
		rec.ObjectType != ObjectCommit || rec.Committer != testEmail || rec.Object != treeSHA1 || rec.At == 0 || rec.Reason != "" {
		t.Fatalf("record %+v", rec)
	}

	// Spoofed: the same commit as alex, whom the key doesn't sign for.
	spoofed := []byte(strings.ReplaceAll(string(testCommit()), "committer Jeff <Jeff@Lleverage.ai>", "committer Alex <alex@lleverage.ai>"))
	if status, _, raw := h.sign(t, FormatGPG, spoofed); status != http.StatusForbidden || !strings.Contains(raw, "alex@lleverage.ai") {
		t.Fatalf("spoofed committer: %d %s", status, raw)
	}
	if rec := h.last(); rec.Allowed || rec.Committer != "alex@lleverage.ai" || rec.ObjectType != ObjectCommit || rec.Object != treeSHA1 || rec.Reason == "" {
		t.Fatalf("record %+v", rec)
	}

	// Not a Git object.
	if status, _, _ := h.sign(t, "", []byte("-----BEGIN PGP MESSAGE-----\nchallenge\n")); status != http.StatusForbidden {
		t.Fatalf("a challenge: %d", status)
	}
	if rec := h.last(); rec.Allowed || rec.ObjectType != "unknown" || rec.Reason == "" {
		t.Fatalf("record %+v", rec)
	}

	// Another format than the key's.
	if status, _, _ := h.sign(t, FormatSSH, testCommit()); status != http.StatusForbidden {
		t.Fatalf("format mismatch: %d", status)
	}
	if rec := h.last(); rec.Allowed || rec.Format != FormatGPG || !strings.Contains(rec.Reason, "ssh") {
		t.Fatalf("record %+v", rec)
	}

	// A tag by jeff.
	tag := []byte("object " + parentA + "\ntype commit\ntag v1\ntagger " + jeff + "\n\nRelease\n")
	if status, _, raw := h.sign(t, "", tag); status != http.StatusOK {
		t.Fatalf("tag: %d %s", status, raw)
	}
	if rec := h.last(); !rec.Allowed || rec.ObjectType != ObjectTag || rec.Object != parentA {
		t.Fatalf("record %+v", rec)
	}

	// A malformed request is refused before anything else.
	res, err := h.client.Post("http://host/sign", "application/json", strings.NewReader("{"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad JSON: %d", res.StatusCode)
	}
	if h.kantel.fetches.Load() != 1 {
		t.Fatalf("%d fetches: the key wasn't cached", h.kantel.fetches.Load())
	}
}

func TestStatusNeverShowsTheKey(t *testing.T) {
	k := newSSHKey(t, "ed25519", "pass")
	h := newSigningHost(t, proto.SigningKey{Version: 1, Enabled: true, Format: FormatSSH, KeyID: "key_2", Fingerprint: "SHA256:x", AllowedEmails: []string{"B@x.io", testEmail}, PrivateKey: k.private, Passphrase: k.passphrase})
	res, err := h.client.Get("http://host/status")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var st guest.SignStatus
	if err := json.Unmarshal(raw, &st); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", res.StatusCode, raw)
	}
	if !st.Enabled || st.Format != FormatSSH || st.KeyID != "key_2" || st.Fingerprint != "SHA256:x" || strings.Join(st.AllowedEmails, ",") != "b@x.io,"+testEmail {
		t.Fatalf("status %+v", st)
	}
	if strings.Contains(string(raw), "PRIVATE") || strings.Contains(string(raw), "pass") {
		t.Fatalf("status holds the key: %s", raw)
	}
}

func TestSignRefusesWithoutAKey(t *testing.T) {
	h := newSigningHost(t, proto.SigningKey{Version: 3})
	if status, _, _ := h.sign(t, FormatGPG, testCommit()); status != http.StatusForbidden {
		t.Fatalf("no key: %d", status)
	}
	if rec := h.last(); rec.Allowed || rec.Reason != "no git signing key configured" {
		t.Fatalf("record %+v", rec)
	}
	// Kantel unreachable: unavailable, and not a decision to record.
	h.kantel.set(proto.SigningKey{}, errors.New("disconnected"))
	h.m.Store().Invalidate("sbx_1")
	n := h.count()
	if status, _, _ := h.sign(t, FormatGPG, testCommit()); status != http.StatusServiceUnavailable {
		t.Fatalf("unavailable: %d", status)
	}
	if h.count() != n {
		t.Fatal("an unavailable key was recorded")
	}
}

func TestSignIsRateLimited(t *testing.T) {
	h := newSigningHost(t, proto.SigningKey{Version: 1})
	clock := time.Unix(1_800_000_000, 0)
	h.m.now = func() time.Time { return clock }
	for i := range signBurst {
		if status, _, _ := h.sign(t, "", testCommit()); status != http.StatusForbidden {
			t.Fatalf("request %d: %d", i, status)
		}
	}
	if status, _, _ := h.sign(t, "", testCommit()); status != http.StatusTooManyRequests {
		t.Fatalf("past the burst: %d", status)
	}
	if rec := h.last(); rec.Allowed || rec.Reason != "rate limit exceeded" {
		t.Fatalf("record %+v", rec)
	}
	// A second later, one more.
	clock = clock.Add(time.Second)
	if status, _, _ := h.sign(t, "", testCommit()); status != http.StatusForbidden {
		t.Fatalf("after a second: %d", status)
	}
	if status, _, _ := h.sign(t, "", testCommit()); status != http.StatusTooManyRequests {
		t.Fatalf("again: %d", status)
	}
}

// A stopped VM's listener closes and its key leaves memory; a deleted sandbox's rate limit goes too.
func TestCloseAndForgetLetGoOfTheSandbox(t *testing.T) {
	h := newSigningHost(t, proto.SigningKey{Version: 1})
	if status, _, _ := h.sign(t, "", testCommit()); status != http.StatusForbidden {
		t.Fatal(status)
	}
	h.m.Close("sbx_1")
	h.m.store.mu.Lock()
	_, cached := h.m.store.entries["sbx_1"]
	h.m.store.mu.Unlock()
	if cached {
		t.Fatal("a stopped sandbox's key stayed in memory")
	}
	h.client.CloseIdleConnections()
	if _, err := h.client.Get("http://host/status"); err == nil {
		t.Fatal("the listener still answers")
	}
	h.m.Forget("sbx_1")
	h.m.mu.Lock()
	_, limited := h.m.limiters["sbx_1"]
	h.m.mu.Unlock()
	if limited {
		t.Fatal("a deleted sandbox's rate limit stayed")
	}
}
