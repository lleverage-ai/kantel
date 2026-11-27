package signing

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"golang.org/x/crypto/ssh"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const testEmail = "jeff@lleverage.ai"

// testCommit is a commit Git would hand its signing program, committed by testEmail.
func testCommit() []byte {
	return []byte("tree " + treeSHA1 + "\nparent " + parentA + "\nauthor " + alex + "\ncommitter " + jeff + "\n\nAdd the thing\n")
}

// gpgKey is a generated OpenPGP key: its armoured secret key (encrypted with passphrase when there is one) and
// armoured public key.
type gpgKey struct {
	private, public, passphrase string
}

// newGPGKey makes an OpenPGP key with go-crypto: algo is packet.PubKeyAlgoEdDSA or packet.PubKeyAlgoRSA; subkey adds
// a signing subkey, which then signs.
func newGPGKey(t *testing.T, algo packet.PublicKeyAlgorithm, passphrase string, subkey bool) gpgKey {
	t.Helper()
	config := &packet.Config{Algorithm: algo, RSABits: 2048}
	e, err := openpgp.NewEntity("Jeff", "", testEmail, config)
	if err != nil {
		t.Fatal(err)
	}
	if subkey {
		if err := e.AddSigningSubkey(config); err != nil {
			t.Fatal(err)
		}
	}
	var pub bytes.Buffer
	w, _ := armor.Encode(&pub, openpgp.PublicKeyType, nil)
	if err := e.Serialize(w); err != nil {
		t.Fatal(err)
	}
	w.Close()
	if passphrase != "" {
		if err := e.EncryptPrivateKeys([]byte(passphrase), nil); err != nil {
			t.Fatal(err)
		}
	}
	var priv bytes.Buffer
	w, _ = armor.Encode(&priv, openpgp.PrivateKeyType, nil)
	if err := e.SerializePrivateWithoutSigning(w, nil); err != nil {
		t.Fatal(err)
	}
	w.Close()
	return gpgKey{private: priv.String(), public: pub.String(), passphrase: passphrase}
}

// gpgVerify checks sig of payload with the real gpg, if it is installed, against a keyring holding only public.
func gpgVerify(t *testing.T, public string, payload []byte, sig string) {
	t.Helper()
	gpg, err := exec.LookPath("gpg")
	if err != nil {
		t.Log("gpg isn't installed: checked with go-crypto only")
		return
	}
	home := shortTempDir(t)
	dir := t.TempDir()
	files := map[string][]byte{"key.asc": []byte(public), "payload": payload, "payload.asc": []byte(sig)}
	for name, raw := range files {
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if out, err := exec.Command(gpg, "--homedir", home, "--batch", "--import", filepath.Join(dir, "key.asc")).CombinedOutput(); err != nil {
		t.Fatalf("gpg --import: %v: %s", err, out)
	}
	out, err := exec.Command(gpg, "--homedir", home, "--batch", "--status-fd", "1", "--verify", filepath.Join(dir, "payload.asc"), filepath.Join(dir, "payload")).CombinedOutput()
	if err != nil || !strings.Contains(string(out), "[GNUPG:] GOODSIG ") {
		t.Fatalf("gpg --verify: %v: %s", err, out)
	}
}

// shortTempDir is a GnuPG home: gpg keeps its sockets under it, whose paths must be short.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kgpg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if gpgconf, err := exec.LookPath("gpgconf"); err == nil {
			_ = exec.Command(gpgconf, "--homedir", dir, "--kill", "all").Run()
		}
		_ = os.RemoveAll(dir)
	})
	return dir
}

func TestOpenPGPSignaturesVerify(t *testing.T) {
	cases := map[string]struct {
		algo       packet.PublicKeyAlgorithm
		passphrase string
		subkey     bool
		pkAlgo     uint8
	}{
		"ed25519":                     {algo: packet.PubKeyAlgoEdDSA, pkAlgo: 22},
		"ed25519 encrypted":           {algo: packet.PubKeyAlgoEdDSA, passphrase: "correct horse", pkAlgo: 22},
		"ed25519 with a subkey":       {algo: packet.PubKeyAlgoEdDSA, subkey: true, pkAlgo: 22},
		"ed25519 encrypted subkey":    {algo: packet.PubKeyAlgoEdDSA, passphrase: "correct horse", subkey: true, pkAlgo: 22},
		"rsa":                         {algo: packet.PubKeyAlgoRSA, pkAlgo: 1},
		"rsa encrypted with a subkey": {algo: packet.PubKeyAlgoRSA, passphrase: "battery staple", subkey: true, pkAlgo: 1},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			k := newGPGKey(t, c.algo, c.passphrase, c.subkey)
			now := time.Now()
			key, err := ParseKey(proto.SigningKey{Enabled: true, Format: FormatGPG, KeyID: "key_1", PrivateKey: k.private, Passphrase: k.passphrase, AllowedEmails: []string{"Jeff@lleverage.ai"}}, now)
			if err != nil {
				t.Fatal(err)
			}
			if !key.Allows("JEFF@LLEVERAGE.AI") || key.Allows("alex@lleverage.ai") {
				t.Fatalf("allowed emails %v", key.AllowedEmails)
			}
			payload := testCommit()
			sig, err := key.Sign(payload, now)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(sig.Text, "-----BEGIN PGP SIGNATURE-----") || !strings.HasSuffix(sig.Text, "-----END PGP SIGNATURE-----\n") {
				t.Fatalf("signature %q", sig.Text)
			}
			if sig.PKAlgo != c.pkAlgo || sig.HashAlgo != 8 || sig.Timestamp != now.Unix() || len(sig.Fingerprint) != 40 || strings.ToUpper(sig.Fingerprint) != sig.Fingerprint {
				t.Fatalf("status %+v", sig)
			}
			ring, err := openpgp.ReadArmoredKeyRing(strings.NewReader(k.public))
			if err != nil {
				t.Fatal(err)
			}
			signer, err := openpgp.CheckArmoredDetachedSignature(ring, bytes.NewReader(payload), strings.NewReader(sig.Text), nil)
			if err != nil || signer == nil {
				t.Fatalf("go-crypto verify: %v", err)
			}
			// The fingerprint is the key that signed: the subkey, when there is one.
			wantFP := signer.PrimaryKey.Fingerprint
			if c.subkey {
				wantFP = signer.Subkeys[len(signer.Subkeys)-1].PublicKey.Fingerprint
			}
			if sig.Fingerprint != fmt.Sprintf("%X", wantFP) {
				t.Fatalf("fingerprint %s, want %X", sig.Fingerprint, wantFP)
			}
			if _, err := openpgp.CheckArmoredDetachedSignature(ring, bytes.NewReader(append(payload, 'x')), strings.NewReader(sig.Text), nil); err == nil {
				t.Fatal("a changed payload verified")
			}
			gpgVerify(t, k.public, payload, sig.Text)
		})
	}
}

// A key exported by the real gpg (an Ed25519 primary that only certifies, a signing subkey, a passphrase) signs, and
// gpg verifies it.
func TestOpenPGPSignsWithAKeyGPGExported(t *testing.T) {
	gpg, err := exec.LookPath("gpg")
	if err != nil {
		t.Skip("gpg isn't installed")
	}
	home := shortTempDir(t)
	run := func(args ...string) []byte {
		t.Helper()
		out, err := exec.Command(gpg, append([]string{"--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase", "s3cret"}, args...)...).Output()
		if err != nil {
			t.Fatalf("gpg %v: %v", args, err)
		}
		return out
	}
	run("--quick-gen-key", "Jeff <"+testEmail+">", "ed25519", "cert", "never")
	fpr := ""
	for _, line := range strings.Split(string(run("--with-colons", "--list-keys", testEmail)), "\n") {
		if strings.HasPrefix(line, "fpr:") {
			fpr = strings.Split(line, ":")[9]
			break
		}
	}
	run("--quick-add-key", fpr, "ed25519", "sign", "never")
	private := string(run("--armor", "--export-secret-keys", testEmail))
	public := string(run("--armor", "--export", testEmail))
	if _, err := ParseKey(proto.SigningKey{Enabled: true, Format: FormatGPG, PrivateKey: private}, time.Now()); err == nil || !strings.Contains(err.Error(), "no passphrase") {
		t.Fatalf("an encrypted key without its passphrase: %v", err)
	}
	if _, err := ParseKey(proto.SigningKey{Enabled: true, Format: FormatGPG, PrivateKey: private, Passphrase: "wrong"}, time.Now()); err == nil {
		t.Fatal("the wrong passphrase unlocked it")
	} else if strings.Contains(err.Error(), "wrong") {
		t.Fatalf("the error quotes the passphrase: %v", err)
	}
	key, err := ParseKey(proto.SigningKey{Enabled: true, Format: FormatGPG, PrivateKey: private, Passphrase: "s3cret"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	sig, err := key.Sign(testCommit(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if sig.Fingerprint == fpr {
		t.Fatal("signed with the certify-only primary rather than the signing subkey")
	}
	gpgVerify(t, public, testCommit(), sig.Text)
}

func TestOpenPGPRefusesUnusableKeys(t *testing.T) {
	k := newGPGKey(t, packet.PubKeyAlgoEdDSA, "", false)
	cases := map[string]proto.SigningKey{
		"public key only": {Format: FormatGPG, PrivateKey: k.public},
		"not a key":       {Format: FormatGPG, PrivateKey: "-----BEGIN " + openpgp.PrivateKeyType + "-----\n\nnope\n-----END " + openpgp.PrivateKeyType + "-----\n"},
		"no key":          {Format: FormatGPG},
		"other format":    {Format: "x509", PrivateKey: k.private},
	}
	for name, sk := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseKey(sk, time.Now()); err == nil {
				t.Fatal("parsed")
			}
		})
	}
	// Expired: a key whose lifetime ended has no signing key now.
	config := &packet.Config{Algorithm: packet.PubKeyAlgoEdDSA, KeyLifetimeSecs: 60, Time: func() time.Time { return time.Now().Add(-time.Hour) }}
	e, err := openpgp.NewEntity("Jeff", "", testEmail, config)
	if err != nil {
		t.Fatal(err)
	}
	var priv bytes.Buffer
	w, _ := armor.Encode(&priv, openpgp.PrivateKeyType, nil)
	if err := e.SerializePrivateWithoutSigning(w, nil); err != nil {
		t.Fatal(err)
	}
	w.Close()
	if _, err := ParseKey(proto.SigningKey{Format: FormatGPG, PrivateKey: priv.String()}, time.Now()); err == nil || !strings.Contains(err.Error(), "valid now") {
		t.Fatalf("an expired key: %v", err)
	}
}

// sshKey is a generated OpenSSH key: its private key (encrypted with passphrase when there is one) and its
// authorized_keys line.
type sshKey struct {
	private, public, passphrase string
}

func newSSHKey(t *testing.T, kind, passphrase string) sshKey {
	t.Helper()
	var priv any
	switch kind {
	case "ed25519":
		_, k, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		priv = k
	case "rsa":
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		priv = k
	}
	var block *pem.Block
	var err error
	if passphrase != "" {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "jeff", []byte(passphrase))
	} else {
		block, err = ssh.MarshalPrivateKey(priv, "jeff")
	}
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return sshKey{private: string(pem.EncodeToMemory(block)), public: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), passphrase: passphrase}
}

// sshKeygenVerify checks sig of payload with the real ssh-keygen, if it is installed, in Git's namespace.
func sshKeygenVerify(t *testing.T, public string, payload []byte, sig string) {
	t.Helper()
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Log("ssh-keygen isn't installed: checked in Go only")
		return
	}
	dir := t.TempDir()
	signers, sigFile := filepath.Join(dir, "allowed_signers"), filepath.Join(dir, "payload.sig")
	if err := os.WriteFile(signers, []byte(testEmail+" "+public+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sigFile, []byte(sig), 0o600); err != nil {
		t.Fatal(err)
	}
	verify := func(namespace string, payload []byte) ([]byte, error) {
		cmd := exec.Command(keygen, "-Y", "verify", "-f", signers, "-I", testEmail, "-n", namespace, "-s", sigFile)
		cmd.Stdin = bytes.NewReader(payload)
		return cmd.CombinedOutput()
	}
	if out, err := verify("git", payload); err != nil {
		t.Fatalf("ssh-keygen didn't verify the signature: %v: %s", err, out)
	}
	if _, err := verify("file", payload); err == nil {
		t.Fatal("the signature verified in another namespace")
	}
	if _, err := verify("git", append(payload, 'x')); err == nil {
		t.Fatal("a changed payload verified")
	}
}

func TestSSHSignaturesVerify(t *testing.T) {
	for _, c := range []struct{ kind, passphrase string }{{"ed25519", ""}, {"ed25519", "correct horse"}, {"rsa", ""}, {"rsa", "battery staple"}} {
		t.Run(c.kind+" "+c.passphrase, func(t *testing.T) {
			k := newSSHKey(t, c.kind, c.passphrase)
			now := time.Now()
			key, err := ParseKey(proto.SigningKey{Enabled: true, Format: FormatSSH, KeyID: "key_2", PrivateKey: k.private, Passphrase: k.passphrase, AllowedEmails: []string{testEmail}}, now)
			if err != nil {
				t.Fatal(err)
			}
			payload := testCommit()
			sig, err := key.Sign(payload, now)
			if err != nil {
				t.Fatal(err)
			}
			pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k.public))
			if err != nil {
				t.Fatal(err)
			}
			if sig.Fingerprint != ssh.FingerprintSHA256(pub) || sig.Timestamp != now.Unix() {
				t.Fatalf("status %+v", sig)
			}
			checkSSHSIG(t, pub, payload, sig.Text)
			sshKeygenVerify(t, k.public, payload, sig.Text)
		})
	}
}

// checkSSHSIG reads an armoured SSHSIG as PROTOCOL.sshsig lays it out and verifies it with pub.
func checkSSHSIG(t *testing.T, pub ssh.PublicKey, payload []byte, text string) {
	t.Helper()
	block, rest := pem.Decode([]byte(text))
	if block == nil || block.Type != "SSH SIGNATURE" || len(bytes.TrimSpace(rest)) != 0 {
		t.Fatalf("not one armoured SSH signature: %q", text)
	}
	var blob struct {
		Version   uint32
		PublicKey []byte
		Namespace string
		Reserved  string
		Hash      string
		Signature []byte
	}
	raw, ok := bytes.CutPrefix(block.Bytes, []byte("SSHSIG"))
	if !ok {
		t.Fatal("no SSHSIG magic")
	}
	if err := ssh.Unmarshal(raw, &blob); err != nil {
		t.Fatal(err)
	}
	if blob.Version != 1 || !bytes.Equal(blob.PublicKey, pub.Marshal()) || blob.Namespace != "git" || blob.Reserved != "" || blob.Hash != "sha512" {
		t.Fatalf("blob %+v", blob)
	}
	var sig ssh.Signature
	if err := ssh.Unmarshal(blob.Signature, &sig); err != nil {
		t.Fatal(err)
	}
	if pub.Type() == ssh.KeyAlgoRSA && sig.Format != ssh.KeyAlgoRSASHA512 {
		t.Fatalf("an RSA key signed with %s", sig.Format)
	}
	digest := sha512.Sum512(payload)
	var signed []byte
	signed = append(signed, "SSHSIG"...)
	signed = appendSSHString(signed, []byte("git"))
	signed = appendSSHString(signed, nil)
	signed = appendSSHString(signed, []byte("sha512"))
	signed = appendSSHString(signed, digest[:])
	if err := pub.Verify(signed, &sig); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestSSHRefusesUnusableKeys(t *testing.T) {
	k := newSSHKey(t, "ed25519", "correct horse")
	if _, err := ParseKey(proto.SigningKey{Format: FormatSSH, PrivateKey: k.private}, time.Now()); err == nil || !strings.Contains(err.Error(), "no passphrase") {
		t.Fatalf("an encrypted key without its passphrase: %v", err)
	}
	if _, err := ParseKey(proto.SigningKey{Format: FormatSSH, PrivateKey: k.private, Passphrase: "wrong horse"}, time.Now()); err == nil || strings.Contains(err.Error(), "wrong horse") {
		t.Fatalf("the wrong passphrase: %v", err)
	}
	if _, err := ParseKey(proto.SigningKey{Format: FormatSSH, PrivateKey: k.public}, time.Now()); err == nil {
		t.Fatal("a public key parsed as a private one")
	}
	// A passphrase for a key without one isn't needed.
	plain := newSSHKey(t, "ed25519", "")
	if _, err := ParseKey(proto.SigningKey{Format: FormatSSH, PrivateKey: plain.private, Passphrase: "unneeded"}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidateAllReconcilesRevocationsAndKeepsFloor(t *testing.T) {
	k1 := newSSHKey(t, "ed25519", "")
	k2 := newSSHKey(t, "ed25519", "")
	var mu sync.Mutex
	current := proto.SigningKey{
		Version:       10,
		Enabled:       true,
		Format:        FormatSSH,
		KeyID:         "k1",
		Fingerprint:   "fp1",
		AllowedEmails: []string{testEmail, "extra@lleverage.ai"},
		PrivateKey:    k1.private,
	}
	store := NewStore(func(_ context.Context, _ string) (proto.SigningKey, error) {
		mu.Lock()
		defer mu.Unlock()
		return current, nil
	})
	mgr := NewManager(store)
	handler := mgr.Handler("sbx_1")
	sign := func(payload []byte) (string, error) {
		body, err := json.Marshal(guest.SignRequest{
			Format:  FormatSSH,
			Payload: base64.StdEncoding.EncodeToString(payload),
		})
		if err != nil {
			return "", err
		}
		req := httptest.NewRequest(http.MethodPost, "/sign", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			return "", fmt.Errorf("status %d: %s", rec.Code, strings.TrimSpace(rec.Body.String()))
		}
		var ans guest.SignAnswer
		if err := json.Unmarshal(rec.Body.Bytes(), &ans); err != nil {
			return "", err
		}
		return ans.Signature, nil
	}
	pub1, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k1.public))
	if err != nil {
		t.Fatal(err)
	}
	pub2, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k2.public))
	if err != nil {
		t.Fatal(err)
	}

	// Warm the cache with v10 and verify signing works.
	commit := testCommit()
	sig1, err := sign(commit)
	if err != nil {
		t.Fatalf("initial sign failed: %v", err)
	}
	checkSSHSIG(t, pub1, commit, sig1)

	// Upstream removes testEmail at v11 (delivery lost while disconnected); reconnect triggers InvalidateAll.
	mu.Lock()
	current.Version = 11
	current.AllowedEmails = []string{"extra@lleverage.ai"}
	mu.Unlock()
	store.InvalidateAll()
	if _, err := sign(commit); err == nil {
		t.Fatal("removed email still signed after reconnect invalidation")
	}

	// Upstream rotates to k2 with testEmail allowed at v12.
	mu.Lock()
	current.Version = 12
	current.KeyID = "k2"
	current.Fingerprint = "fp2"
	current.AllowedEmails = []string{testEmail}
	current.PrivateKey = k2.private
	mu.Unlock()
	store.InvalidateAll()
	sig2, err := sign(commit)
	if err != nil {
		t.Fatalf("rotated sign failed: %v", err)
	}
	checkSSHSIG(t, pub2, commit, sig2)

	// Upstream deletes the key at v13; after reconnect invalidation signing must be refused.
	mu.Lock()
	current = proto.SigningKey{Version: 13, Enabled: false}
	mu.Unlock()
	store.InvalidateAll()
	if _, err := sign(commit); err == nil {
		t.Fatal("deleted key still signed after reconnect invalidation")
	}

	// Floor was preserved at v13: a stale fetch returning v12 must be rejected.
	store.Require("sbx_1", 13)
	mu.Lock()
	current = proto.SigningKey{
		Version:       12,
		Enabled:       true,
		Format:        FormatSSH,
		KeyID:         "k2",
		Fingerprint:   "fp2",
		AllowedEmails: []string{testEmail},
		PrivateKey:    k2.private,
	}
	mu.Unlock()
	store.InvalidateAll()
	if _, err := sign(commit); err == nil {
		t.Fatal("stale version below floor was accepted after InvalidateAll")
	}
}

func TestListenRejectsUnsafeSocketNames(t *testing.T) {
	mgr := NewManager(NewStore(func(_ context.Context, _ string) (proto.SigningKey, error) {
		return proto.SigningKey{}, nil
	}))
	defer mgr.CloseAll()
	dir := t.TempDir()
	for _, bad := range []string{"", "..", "../escape", "sub/vsock", `sub\vsock`} {
		if err := mgr.Listen("sbx_1", dir, bad); err == nil {
			t.Fatalf("Listen accepted unsafe udsName %q", bad)
		}
	}
}
