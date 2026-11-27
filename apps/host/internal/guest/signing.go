package guest

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// SystemGitConfig is Git's system-wide configuration, which includes GitConfigFile (the image ships the include, and
// the agent adds it to an image that doesn't).
const SystemGitConfig = "/etc/gitconfig"

// gitSigningFiles are where applyGitSigning writes: the guest's paths, or a test's.
type gitSigningFiles struct {
	config, pub, system string
}

var guestGitSigningFiles = gitSigningFiles{config: GitConfigFile, pub: SigningPubFile, system: SystemGitConfig}

// setSigning is POST /signing: the sandbox's signing key changed while it runs.
func (s *Server) setSigning(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GitSigning *GitSigningConfig `json:"gitSigning"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if err := s.applyGitSigning(req.GitSigning); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// applyGitSigning makes Git in the guest sign through kantel-sign with cfg's key, or not at all for nil.
func (s *Server) applyGitSigning(cfg *GitSigningConfig) error {
	return writeGitSigning(cfg, guestGitSigningFiles, s.signProgram())
}

// signProgram is kantel-sign's path: beside this agent, else where Kantel's image or its initramfs puts it.
func (s *Server) signProgram() string {
	if self, err := os.Executable(); err == nil {
		sibling := filepath.Join(filepath.Dir(self), "kantel-sign")
		if _, err := os.Stat(sibling); err == nil {
			return sibling
		}
	}
	if s.Injected {
		return InjectedBin + "/kantel-sign"
	}
	return "/usr/local/bin/kantel-sign"
}

// GitSigningConfigContent is GitConfigFile's content for cfg, with signer as Git's signing program.
func GitSigningConfigContent(cfg *GitSigningConfig, signer string) string {
	var b strings.Builder
	b.WriteString("# Managed by Kantel: host-side Git signing (private key stays on the host).\n")
	b.WriteString("[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n")
	if cfg.Format == "ssh" {
		fmt.Fprintf(&b, "[gpg]\n\tformat = ssh\n[gpg \"ssh\"]\n\tprogram = %s\n[user]\n\tsigningkey = %s\n", signer, SigningPubFile)
	} else {
		fmt.Fprintf(&b, "[gpg]\n\tformat = openpgp\n\tprogram = %s\n[user]\n\tsigningkey = %s\n", signer, cfg.Fingerprint)
	}
	return b.String()
}

// gitConfigInclude is what includes GitConfigFile in SystemGitConfig.
const gitConfigInclude = "\n[include]\n\tpath = " + GitConfigFile + "\n"

func writeGitSigning(cfg *GitSigningConfig, files gitSigningFiles, signer string) error {
	if cfg == nil || cfg.Format == "" {
		var errs []error
		for _, path := range []string{files.config, files.pub} {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	}
	if cfg.Format != "gpg" && cfg.Format != "ssh" {
		return fmt.Errorf("git signing format %q is neither gpg nor ssh", cfg.Format)
	}
	if strings.ContainsAny(cfg.Fingerprint, "\n\r\"\\") {
		return errors.New("git signing: the key's fingerprint isn't one")
	}
	if err := os.MkdirAll(filepath.Dir(files.config), 0o755); err != nil {
		return err
	}
	if err := writeAtomic(files.pub, []byte(strings.TrimSpace(cfg.PublicKey)+"\n")); err != nil {
		return err
	}
	if err := writeAtomic(files.config, []byte(GitSigningConfigContent(cfg, signer))); err != nil {
		return err
	}
	system, err := os.ReadFile(files.system)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if strings.Contains(string(system), GitConfigFile) {
		return nil
	}
	return writeAtomic(files.system, append(system, gitConfigInclude...))
}

// writeAtomic replaces path with raw (mode 0644) in one rename, so Git reads the old file or the new one.
func writeAtomic(path string, raw []byte) error {
	tmp := path + ".kantel-new"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
