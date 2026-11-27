package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// signConfigFile is the agent's Git signing configuration (guest.GitConfigFile); tests point it elsewhere.
var signConfigFile = guest.GitConfigFile

// signStatusTimeout bounds the doctor's question to the host's signing.
const signStatusTimeout = 2 * time.Second

var (
	gitFormatLine     = regexp.MustCompile(`(?m)^\tformat = (\S+)$`)
	gitSigningKeyLine = regexp.MustCompile(`(?m)^\tsigningkey = (\S+)$`)
)

// checkGitSigning reports whether Git in the sandbox signs as the host's key does: the host's status for the
// sandbox, against the configuration and public key the agent wrote.
func checkGitSigning(report func(bool, string, string)) {
	ctx, cancel := context.WithTimeout(context.Background(), signStatusTimeout)
	defer cancel()
	st, statusErr := hostSignStatus(ctx)
	config, configErr := os.ReadFile(signConfigFile)
	configured := configErr == nil
	if configErr != nil && !errors.Is(configErr, os.ErrNotExist) {
		report(false, "git signing", configErr.Error())
		return
	}
	switch {
	case statusErr != nil && !configured:
		report(true, "git signing", "none configured")
	case statusErr != nil:
		report(false, "git signing", fmt.Sprintf("%s asks Git to sign, but %v", signConfigFile, statusErr))
	case !st.Enabled && !configured:
		report(true, "git signing", "none configured")
	case !st.Enabled:
		report(false, "git signing", fmt.Sprintf("the host has no signing key, but %s asks Git to sign", signConfigFile))
	case !configured:
		report(false, "git signing", fmt.Sprintf("the host has a %s key (%s), but %s isn't there", st.Format, st.KeyID, signConfigFile))
	default:
		if err := matchGitSigning(st, string(config)); err != nil {
			report(false, "git signing", err.Error())
			return
		}
		report(true, "git signing", fmt.Sprintf("%s %s (%s)", st.Format, st.KeyID, strings.Join(st.AllowedEmails, ", ")))
	}
}

// matchGitSigning checks the agent's configuration is for the host's key: its format, and its key (the OpenPGP
// fingerprint Git names, or the SSH public key Git reads from signPubFile).
func matchGitSigning(st guest.SignStatus, config string) error {
	format := ""
	if m := gitFormatLine.FindStringSubmatch(config); m != nil {
		format = m[1]
	}
	key := ""
	if m := gitSigningKeyLine.FindStringSubmatch(config); m != nil {
		key = m[1]
	}
	pub, err := os.ReadFile(signPubFile)
	if err != nil {
		return fmt.Errorf("the signing key's public half: %w", err)
	}
	switch st.Format {
	case "gpg":
		if format != "openpgp" {
			return fmt.Errorf("the host's key is gpg, but Git signs in %q", format)
		}
		if st.Fingerprint != "" && !strings.EqualFold(key, st.Fingerprint) {
			return fmt.Errorf("Git signs as %s, but the host's key is %s", key, st.Fingerprint)
		}
	case "ssh":
		if format != "ssh" {
			return fmt.Errorf("the host's key is ssh, but Git signs in %q", format)
		}
		if key != signPubFile {
			return fmt.Errorf("Git signs with %s, not %s", key, signPubFile)
		}
		parsed, _, _, _, err := ssh.ParseAuthorizedKey(pub)
		if err != nil {
			return fmt.Errorf("%s isn't an SSH public key: %w", signPubFile, err)
		}
		if fp := ssh.FingerprintSHA256(parsed); strings.HasPrefix(st.Fingerprint, "SHA256:") && fp != st.Fingerprint {
			return fmt.Errorf("%s is %s, but the host's key is %s", signPubFile, fp, st.Fingerprint)
		}
	default:
		return fmt.Errorf("the host's key is in an unknown format %q", st.Format)
	}
	return nil
}
