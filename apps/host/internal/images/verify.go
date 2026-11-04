package images

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Signature policies (the config's imageSignatures).
const (
	// PolicyRequire refuses images whose manifest isn't signed by the expected identity (the default).
	PolicyRequire = "require"
	// PolicyWarn logs what it couldn't check and uses the images anyway.
	PolicyWarn = "warn"
	// PolicyOff checks nothing.
	PolicyOff = "off"
)

// DefaultIdentity and DefaultIssuer are who signs Kantel's published host images: the sandbox-image workflow on main,
// with GitHub Actions' OIDC token (a cosign keyless signature).
const (
	DefaultIdentity = `^https://github\.com/lleverage-ai/kantel/\.github/workflows/sandbox-image\.yml@refs/heads/main$`
	DefaultIssuer   = "https://token.actions.githubusercontent.com"
)

// relax is how an operator uses images whose signature can't be checked.
const relax = `to use them anyway, set "imageSignatures": "warn" in /etc/kantel-host/config.json`

// Verifier checks a file's cosign signature bundle.
type Verifier struct {
	// Policy is PolicyRequire (also when empty), PolicyWarn or PolicyOff.
	Policy string
	// Cosign is the cosign binary.
	Cosign string
	// Identity (a regexp) and Issuer are the signing certificate's, for a keyless signature.
	Identity, Issuer string
	// Key, when set, is a cosign public key the file is signed with instead (images an install builds and signs
	// itself).
	Key string
	Log *slog.Logger
	// Run runs cosign (default exec.CommandContext's CombinedOutput).
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
}

// Verify checks artifact against its bundle. Under PolicyRequire a missing bundle, a missing cosign or a signature
// that doesn't check out is an error; under PolicyWarn each is logged and the file used.
func (v Verifier) Verify(ctx context.Context, artifact, bundle string) error {
	policy := v.Policy
	if policy == "" {
		policy = PolicyRequire
	}
	switch policy {
	case PolicyOff:
		return nil
	case PolicyRequire, PolicyWarn:
	default:
		return fmt.Errorf(`imageSignatures %q: want "require", "warn" or "off"`, policy)
	}
	name := filepath.Base(artifact)
	if _, err := os.Stat(bundle); err != nil {
		return v.unverified(policy, fmt.Sprintf("%s has no signature bundle (%s)", name, filepath.Base(bundle)), true)
	}
	if v.Cosign == "" {
		return v.unverified(policy, fmt.Sprintf("no cosign to check %s's signature with", name), true)
	}
	if _, err := os.Stat(v.Cosign); err != nil {
		return v.unverified(policy, fmt.Sprintf("no cosign at %s to check %s's signature with (kantel-host fetches it at start)", v.Cosign, name), true)
	}
	run := v.Run
	if run == nil {
		run = combinedOutput
	}
	if out, err := run(ctx, v.Cosign, v.args(artifact, bundle)...); err != nil {
		// Signed by someone else, or not this file: never relaxed by the hint, though "warn" still uses it.
		return v.unverified(policy, fmt.Sprintf("%s's signature doesn't check out: %v: %s", name, err, strings.TrimSpace(string(out))), false)
	}
	return nil
}

// args are cosign's: keyless with the expected identity and issuer, or with Key.
func (v Verifier) args(artifact, bundle string) []string {
	if v.Key != "" {
		return []string{"verify-blob", "--bundle", bundle, "--key", v.Key, artifact}
	}
	identity, issuer := v.Identity, v.Issuer
	if identity == "" {
		identity = DefaultIdentity
	}
	if issuer == "" {
		issuer = DefaultIssuer
	}
	return []string{"verify-blob", "--bundle", bundle, "--certificate-identity-regexp", identity, "--certificate-oidc-issuer", issuer, artifact}
}

func (v Verifier) unverified(policy, problem string, hint bool) error {
	if policy == PolicyWarn {
		log := v.Log
		if log == nil {
			log = slog.Default()
		}
		log.Warn("using host images whose signature isn't checked (imageSignatures is warn)", "problem", problem)
		return nil
	}
	if hint {
		return fmt.Errorf("%s: %s", problem, relax)
	}
	return fmt.Errorf("%s", problem)
}

func combinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// CosignVersion is the cosign release FetchCosign installs.
const CosignVersion = "v3.1.4"

// The SHA-256 of cosign's Linux binaries at CosignVersion, from that release's cosign_checksums.txt.
const (
	cosignAMD64SHA256 = "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa"
	cosignARM64SHA256 = "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2"
)

// FetchCosign installs cosign at dst from its GitHub release, checked against the pinned digest; one that already
// reports CosignVersion is kept.
func FetchCosign(ctx context.Context, dst string) error {
	if out, err := exec.CommandContext(ctx, dst, "version").CombinedOutput(); err == nil && reports(string(out), CosignVersion) {
		return nil
	}
	arch := Arch()
	want := cosignAMD64SHA256
	if arch == "arm64" {
		want = cosignARM64SHA256
	}
	u := "https://github.com/sigstore/cosign/releases/download/" + CosignVersion + "/cosign-linux-" + arch
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("GET %s: %s", u, res.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 512<<20))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("cosign %s (%s): digest doesn't match the pinned one", CosignVersion, arch)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".part"
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, raw, 0o755); err != nil {
		return err
	}
	// WriteFile's mode is under the umask.
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// reports says whether a version command's output names version as a word of its own (v3.1.4, not v3.1.40).
func reports(out, version string) bool {
	for _, f := range strings.Fields(out) {
		if f == version {
			return true
		}
	}
	return false
}
