package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"golang.org/x/crypto/ssh"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/signing"
)

// The test binary is kantel-sign too, run through a symlink of that name (Git's gpg.program in the tests below),
// pointed by its environment at a test host's signing socket and files.
const (
	envSignSocket = "KANTEL_SIGN_TEST_SOCKET"
	envSignPub    = "KANTEL_SIGN_TEST_PUB"
	envVerifyHome = "KANTEL_SIGN_TEST_VERIFY_HOME"
)

func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "kantel-sign" {
		pointSignAt(os.Getenv(envSignSocket))
		signPubFile = os.Getenv(envSignPub)
		home := os.Getenv(envVerifyHome)
		verifyHome = func(int) string { return home }
		os.Exit(signMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

func pointSignAt(socket string) {
	signDial = func(ctx context.Context) (net.Conn, error) { return (&net.Dialer{}).DialContext(ctx, "unix", socket) }
}

const (
	jeffEmail = "jeff@lleverage.ai"
	alexEmail = "alex@lleverage.ai"
)

// testSigningHost is a host's signing for one sandbox, on a Unix socket, with the records it made.
type testSigningHost struct {
	socket  string
	mu      sync.Mutex
	records []proto.SigningRecord
}

func startSigningHost(t *testing.T, key proto.SigningKey) *testSigningHost {
	t.Helper()
	dir := shortDir(t, "ksock")
	m := signing.NewManager(signing.NewStore(func(context.Context, string) (proto.SigningKey, error) { return key, nil }))
	h := &testSigningHost{socket: signing.SocketPath(dir, "v.sock")}
	m.OnRecord = func(r proto.SigningRecord) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.records = append(h.records, r)
	}
	if err := m.Listen("sbx_1", dir, "v.sock"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.CloseAll)
	return h
}

func (h *testSigningHost) recorded() []proto.SigningRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.records)
}

// shortDir is a temporary directory with a short path: a Unix socket's or GnuPG's sockets go in it.
func shortDir(t *testing.T, prefix string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", prefix)
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

func newOpenPGPKey(t *testing.T) (private, public, fingerprint string) {
	t.Helper()
	e, err := openpgp.NewEntity("Jeff", "", jeffEmail, &packet.Config{Algorithm: packet.PubKeyAlgoEdDSA})
	if err != nil {
		t.Fatal(err)
	}
	var pub, priv bytes.Buffer
	w, _ := armor.Encode(&pub, openpgp.PublicKeyType, nil)
	if err := e.Serialize(w); err != nil {
		t.Fatal(err)
	}
	w.Close()
	w, _ = armor.Encode(&priv, openpgp.PrivateKeyType, nil)
	if err := e.SerializePrivateWithoutSigning(w, nil); err != nil {
		t.Fatal(err)
	}
	w.Close()
	return priv.String(), pub.String(), fmt.Sprintf("%X", e.PrimaryKey.Fingerprint)
}

func newOpenSSHKey(t *testing.T) (private, public string) {
	t.Helper()
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(k, "jeff")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(block)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

// gitRepo is a repository whose Git signs with kantel-sign (this test binary) against host, with nothing from the
// machine's own Git configuration.
type gitRepo struct {
	t   *testing.T
	dir string
	env []string
}

func newGitRepo(t *testing.T, host *testSigningHost, pubFile string, config ...string) *gitRepo {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git isn't installed")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	signer := filepath.Join(bin, "kantel-sign")
	if err := os.Symlink(self, signer); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	r := &gitRepo{t: t, dir: t.TempDir(), env: append(os.Environ(),
		"HOME="+home, "XDG_CONFIG_HOME="+home, "GIT_CONFIG_NOSYSTEM=1", "GNUPGHOME="+shortDir(t, "kgh"),
		envSignSocket+"="+host.socket, envSignPub+"="+pubFile, envVerifyHome+"="+filepath.Join(shortDir(t, "kvh"), "v"),
	)}
	r.git("init", "-q", "-b", "main")
	settings := append([]string{"user.name", "Jeff", "user.email", jeffEmail, "commit.gpgsign", "true", "tag.gpgsign", "true"}, config...)
	for i := 0; i < len(settings); i += 2 {
		value := strings.ReplaceAll(settings[i+1], "{signer}", signer)
		r.git("config", settings[i], value)
	}
	return r
}

func (r *gitRepo) run(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir, cmd.Env = r.dir, r.env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (r *gitRepo) git(args ...string) string {
	r.t.Helper()
	out, err := r.run(args...)
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

func writePub(t *testing.T, public string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "signing.pub")
	if err := os.WriteFile(path, []byte(public+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func checkRecords(t *testing.T, records []proto.SigningRecord, want []string) {
	t.Helper()
	var got []string
	for _, r := range records {
		got = append(got, fmt.Sprintf("%v %s %s %s", r.Allowed, r.Format, r.ObjectType, r.Committer))
	}
	if !slices.Equal(got, want) {
		t.Fatalf("records\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestGitSignsAndVerifiesWithAnOpenPGPKeyOnTheHost(t *testing.T) {
	if _, err := exec.LookPath(systemGPG); err != nil {
		t.Skip("gpg isn't installed at " + systemGPG)
	}
	private, public, fingerprint := newOpenPGPKey(t)
	host := startSigningHost(t, proto.SigningKey{Version: 1, Enabled: true, Format: "gpg", KeyID: "key_1", Fingerprint: fingerprint, AllowedEmails: []string{jeffEmail}, PrivateKey: private})
	repo := newGitRepo(t, host, writePub(t, public), "gpg.format", "openpgp", "gpg.program", "{signer}", "user.signingkey", fingerprint)

	repo.git("commit", "-q", "--allow-empty", "-m", "Signed on the host")
	if out := repo.git("verify-commit", "--raw", "HEAD"); !strings.Contains(out, "[GNUPG:] GOODSIG ") || !strings.Contains(out, fingerprint) {
		t.Fatalf("verify-commit: %s", out)
	}
	if out := repo.git("log", "-1", "--format=%G?"); strings.TrimSpace(out) == "N" || strings.TrimSpace(out) == "B" {
		t.Fatalf("%%G? = %s", out)
	}
	repo.git("tag", "-s", "v1.0.0", "-m", "Release v1.0.0")
	if out := repo.git("verify-tag", "--raw", "v1.0.0"); !strings.Contains(out, "[GNUPG:] GOODSIG ") {
		t.Fatalf("verify-tag: %s", out)
	}
	// Committed by alex, whom the key doesn't sign for: refused, and no commit made.
	head := repo.git("rev-parse", "HEAD")
	out, err := repo.run("-c", "user.email="+alexEmail, "commit", "--allow-empty", "-m", "Spoofed")
	if err == nil || !strings.Contains(out, "kantel-sign: the host refused (403)") || !strings.Contains(out, alexEmail) {
		t.Fatalf("a spoofed committer: %v\n%s", err, out)
	}
	if repo.git("rev-parse", "HEAD") != head {
		t.Fatal("the refused commit was made")
	}
	// Authored by alex and committed by jeff (a cherry-pick or rebase): signed.
	repo.git("commit", "-q", "--allow-empty", "--author", "Alex <"+alexEmail+">", "-m", "Alex's change")
	repo.git("verify-commit", "HEAD")
	checkRecords(t, host.recorded(), []string{
		"true gpg commit " + jeffEmail,
		"true gpg tag " + jeffEmail,
		"false gpg commit " + alexEmail,
		"true gpg commit " + jeffEmail,
	})
}

func TestGitSignsAndVerifiesWithAnSSHKeyOnTheHost(t *testing.T) {
	if _, err := exec.LookPath(systemSSHKeygen); err != nil {
		t.Skip("ssh-keygen isn't installed at " + systemSSHKeygen)
	}
	private, public := newOpenSSHKey(t)
	host := startSigningHost(t, proto.SigningKey{Version: 1, Enabled: true, Format: "ssh", KeyID: "key_2", AllowedEmails: []string{jeffEmail}, PrivateKey: private})
	pub := writePub(t, public)
	allowed := filepath.Join(t.TempDir(), "allowed_signers")
	if err := os.WriteFile(allowed, []byte(jeffEmail+" "+public+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repo := newGitRepo(t, host, pub, "gpg.format", "ssh", "gpg.ssh.program", "{signer}", "user.signingkey", pub, "gpg.ssh.allowedSignersFile", allowed)

	repo.git("commit", "-q", "--allow-empty", "-m", "Signed on the host")
	if out := repo.git("verify-commit", "HEAD"); !strings.Contains(out, `Good "git" signature for `+jeffEmail) {
		t.Fatalf("verify-commit: %s", out)
	}
	repo.git("tag", "-s", "v1.0.0", "-m", "Release v1.0.0")
	if out := repo.git("verify-tag", "v1.0.0"); !strings.Contains(out, `Good "git" signature for `+jeffEmail) {
		t.Fatalf("verify-tag: %s", out)
	}
	out, err := repo.run("-c", "user.email="+alexEmail, "commit", "--allow-empty", "-m", "Spoofed")
	if err == nil || !strings.Contains(out, "kantel-sign: the host refused (403)") {
		t.Fatalf("a spoofed committer: %v\n%s", err, out)
	}
	// An openpgp request of an ssh key is refused.
	out, err = repo.run("-c", "gpg.format=openpgp", "-c", "gpg.program={signer}", "commit", "--allow-empty", "-m", "Wrong format")
	if err == nil {
		t.Fatalf("the wrong format signed:\n%s", out)
	}
	checkRecords(t, host.recorded(), []string{
		"true ssh commit " + jeffEmail,
		"true ssh tag " + jeffEmail,
		"false ssh commit " + alexEmail,
	})
}

// kantel-sign as gpg: the signature on stdout (or -o), and the status lines Git reads on --status-fd.
func TestSignAsGPGWritesTheSignatureAndStatus(t *testing.T) {
	private, _, fingerprint := newOpenPGPKey(t)
	host := startSigningHost(t, proto.SigningKey{Version: 1, Enabled: true, Format: "gpg", KeyID: "key_1", Fingerprint: fingerprint, AllowedEmails: []string{jeffEmail}, PrivateKey: private})
	pointSignAt(host.socket)
	t.Cleanup(func() { pointSignAt("") })
	commit := "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Jeff <jeff@lleverage.ai> 1764000000 +0000\ncommitter Jeff <jeff@lleverage.ai> 1764000000 +0000\n\nmsg\n"

	var stdout, stderr bytes.Buffer
	if code := signMain([]string{"--status-fd=2", "-bsau", fingerprint}, strings.NewReader(commit), &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), "-----BEGIN PGP SIGNATURE-----") {
		t.Fatalf("stdout %q", stdout.String())
	}
	lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
	if len(lines) != 2 || lines[0] != "[GNUPG:] BEGIN_SIGNING H8" || !strings.HasPrefix(lines[1], "[GNUPG:] SIG_CREATED D 22 8 00 ") || !strings.HasSuffix(lines[1], " "+fingerprint) {
		t.Fatalf("status %q", stderr.String())
	}

	// --output, --status-fd 1 and --detach-sign --armor spelt out, the payload in a file.
	dir := t.TempDir()
	in, out := filepath.Join(dir, "commit"), filepath.Join(dir, "commit.asc")
	if err := os.WriteFile(in, []byte(commit), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	if code := signMain([]string{"--batch", "--no-tty", "--status-fd", "1", "--detach-sign", "--armor", "--local-user=" + fingerprint, "--output", out, in}, nil, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if raw, _ := os.ReadFile(out); !bytes.HasPrefix(raw, []byte("-----BEGIN PGP SIGNATURE-----")) {
		t.Fatalf("output %q", raw)
	}
	if !strings.Contains(stdout.String(), "[GNUPG:] SIG_CREATED D 22 8 00 ") {
		t.Fatalf("status %q", stdout.String())
	}

	// A refusal: a FAILURE status line, a message, exit 2.
	stdout.Reset()
	stderr.Reset()
	if code := signMain([]string{"--status-fd=2", "-bsau", fingerprint}, strings.NewReader("not a commit"), &stdout, &stderr); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "[GNUPG:] FAILURE sign 1\n") || !strings.Contains(stderr.String(), "kantel-sign: the host refused (403)") {
		t.Fatalf("stdout %q stderr %q", stdout.String(), stderr.String())
	}
	// Not detached: refused without asking the host.
	stderr.Reset()
	n := len(host.recorded())
	if code := signMain([]string{"-sa"}, strings.NewReader(commit), &stdout, &stderr); code != 2 || len(host.recorded()) != n {
		t.Fatalf("exit %d, %d records: %s", code, len(host.recorded()), stderr.String())
	}
}

// What isn't signing goes to the real program, with every argument.
func TestSignHandsTheRestToTheRealPrograms(t *testing.T) {
	var gotProgram string
	var gotArgs []string
	execProgram = func(program string, argv, _ []string) error {
		gotProgram, gotArgs = program, argv
		return fmt.Errorf("not run")
	}
	t.Cleanup(func() { execProgram = syscall.Exec })
	signPubFile = filepath.Join(t.TempDir(), "none")
	t.Cleanup(func() { signPubFile = guest.SigningPubFile })
	cases := []struct {
		args    []string
		program string
		argv    []string
	}{
		{[]string{"--keyid-format=long", "--status-fd=1", "--verify", "/tmp/sig", "-"}, systemGPG, []string{"gpg", "--keyid-format=long", "--status-fd=1", "--verify", "/tmp/sig", "-"}},
		{[]string{"--version"}, systemGPG, []string{"gpg", "--version"}},
		{[]string{"-Y", "verify", "-n", "git", "-f", "allowed", "-I", "jeff", "-s", "sig"}, systemSSHKeygen, []string{"ssh-keygen", "-Y", "verify", "-n", "git", "-f", "allowed", "-I", "jeff", "-s", "sig"}},
		{[]string{"-Y", "find-principals", "-f", "allowed", "-s", "sig"}, systemSSHKeygen, []string{"ssh-keygen", "-Y", "find-principals", "-f", "allowed", "-s", "sig"}},
		{[]string{"-lf", "/etc/kantel/signing.pub"}, systemSSHKeygen, []string{"ssh-keygen", "-lf", "/etc/kantel/signing.pub"}},
	}
	for _, c := range cases {
		var stderr bytes.Buffer
		if code := signMain(c.args, nil, &bytes.Buffer{}, &stderr); code != 2 {
			t.Fatalf("%v: exit %d", c.args, code)
		}
		if gotProgram != c.program || !slices.Equal(gotArgs, c.argv) {
			t.Fatalf("%v ran %s %v", c.args, gotProgram, gotArgs)
		}
	}
	// -Y sign outside Git's namespace isn't signed.
	var stderr bytes.Buffer
	if code := signMain([]string{"-Y", "sign", "-n", "file", "-f", "key", "payload"}, nil, &bytes.Buffer{}, &stderr); code != 2 || !strings.Contains(stderr.String(), "git namespace") {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
}

func TestParseGPGArgs(t *testing.T) {
	cases := []struct {
		args []string
		want gpgArgs
	}{
		{[]string{"--status-fd=2", "-bsau", "ABC"}, gpgArgs{sign: true, detach: true, statusFD: 2}},
		{[]string{"-bsa", "-u", "ABC", "-o", "out", "in"}, gpgArgs{sign: true, detach: true, statusFD: -1, output: "out", files: []string{"in"}}},
		{[]string{"-uABC", "-b", "--output=x", "--", "-in"}, gpgArgs{sign: true, detach: true, statusFD: -1, output: "x", files: []string{"-in"}}},
		{[]string{"--homedir", "/h", "--verify", "s", "-"}, gpgArgs{verify: true, homedir: true, statusFD: -1, files: []string{"s", "-"}}},
		{[]string{"-v", "--keyid-format", "long", "--digest-algo=SHA512", "--sign"}, gpgArgs{sign: true, statusFD: -1}},
	}
	for _, c := range cases {
		got, err := parseGPGArgs(c.args)
		if err != nil || fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", c.want) {
			t.Fatalf("%v: %+v %v, want %+v", c.args, got, err, c.want)
		}
	}
	for _, bad := range [][]string{{"--status-fd"}, {"--status-fd=x"}, {"-u"}} {
		if _, err := parseGPGArgs(bad); err == nil {
			t.Fatalf("%v parsed", bad)
		}
	}
}

func TestDoctorChecksGitSigning(t *testing.T) {
	private, public, fingerprint := newOpenPGPKey(t)
	dir := t.TempDir()
	signConfigFile, signPubFile = filepath.Join(dir, "gitconfig"), filepath.Join(dir, "signing.pub")
	t.Cleanup(func() { signConfigFile, signPubFile = guest.GitConfigFile, guest.SigningPubFile })
	check := func() string {
		var lines []string
		checkGitSigning(func(ok bool, check, detail string) {
			lines = append(lines, fmt.Sprintf("%v %s: %s", ok, check, detail))
		})
		return strings.Join(lines, "\n")
	}
	write := func(cfg *guest.GitSigningConfig) {
		if err := os.WriteFile(signConfigFile, []byte(guest.GitSigningConfigContent(cfg, "/usr/local/bin/kantel-sign")), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(signPubFile, []byte(cfg.PublicKey), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// No host listener, nothing configured.
	pointSignAt(filepath.Join(dir, "absent.sock"))
	t.Cleanup(func() { pointSignAt("") })
	if got := check(); got != "true git signing: none configured" {
		t.Fatal(got)
	}
	// Configured, but the host isn't there.
	write(&guest.GitSigningConfig{Format: "gpg", Fingerprint: fingerprint, PublicKey: public})
	if got := check(); !strings.HasPrefix(got, "false git signing: ") {
		t.Fatal(got)
	}
	// The host's key, and the configuration for it.
	host := startSigningHost(t, proto.SigningKey{Version: 1, Enabled: true, Format: "gpg", KeyID: "key_1", Fingerprint: fingerprint, AllowedEmails: []string{jeffEmail, "b@x.io"}, PrivateKey: private})
	pointSignAt(host.socket)
	if got := check(); got != "true git signing: gpg key_1 (b@x.io, "+jeffEmail+")" {
		t.Fatal(got)
	}
	// Another key's configuration.
	write(&guest.GitSigningConfig{Format: "gpg", Fingerprint: "0000000000000000000000000000000000000000", PublicKey: public})
	if got := check(); !strings.HasPrefix(got, "false git signing: Git signs as 0000") {
		t.Fatal(got)
	}
	write(&guest.GitSigningConfig{Format: "ssh", PublicKey: "ssh-ed25519 AAAA"})
	if got := check(); !strings.Contains(got, "false git signing: the host's key is gpg") {
		t.Fatal(got)
	}
	// The host has no key: the configuration is stale.
	none := startSigningHost(t, proto.SigningKey{Version: 2})
	pointSignAt(none.socket)
	if got := check(); !strings.HasPrefix(got, "false git signing: the host has no signing key") {
		t.Fatal(got)
	}
	_ = os.Remove(signConfigFile)
	if got := check(); got != "true git signing: none configured" {
		t.Fatal(got)
	}
}
