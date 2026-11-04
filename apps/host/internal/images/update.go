package images

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// bundleFile is a manifest's cosign bundle, published beside it.
const bundleFile = manifestFile + ".sigstore.json"

// Updater moves a Store to the version the control plane's image channel names.
type Updater struct {
	Store    Store
	Verifier Verifier
	// Arch and KVM pick the files a version needs (Store.Install's).
	Arch string
	KVM  bool
	Log  *slog.Logger
	// OnActivate is called once a version is current, so the tiers start using it.
	OnActivate func(version string)

	// mu is one check (or prune) at a time.
	mu sync.Mutex
}

// Check installs and activates ch.Version when it isn't current: the manifest's signature is checked before anything
// else is downloaded, and every file is checked against the manifest's digest. A check that fails leaves current as
// it was.
func (u *Updater) Check(ctx context.Context, ch proto.ImageChannel) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if ch.Version == "" || ch.URL == "" {
		return errors.New("the image channel names no version or no URL")
	}
	if !ValidVersion(ch.Version) {
		return fmt.Errorf("the image channel's version %q can't name a directory", ch.Version)
	}
	if current, ok := u.Store.Current(); ok && current == ch.Version {
		return nil
	}
	if err := os.MkdirAll(u.Store.Dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(u.Store.Dir, "check-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	manifestPath, bundlePath := filepath.Join(tmp, manifestFile), filepath.Join(tmp, bundleFile)
	if err := download(ch.URL, manifestFile, manifestPath); err != nil {
		return fmt.Errorf("images %s: %w", ch.Version, err)
	}
	// A release without a bundle: Verify says what that means under the policy.
	bundleErr := download(ch.URL, bundleFile, bundlePath)
	if bundleErr != nil {
		_ = os.Remove(bundlePath)
	}
	if err := u.Verifier.Verify(ctx, manifestPath, bundlePath); err != nil {
		if bundleErr != nil {
			err = fmt.Errorf("%w (fetching the bundle: %v)", err, bundleErr)
		}
		return fmt.Errorf("images %s: %w", ch.Version, err)
	}
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return fmt.Errorf("images %s: manifest: %w", ch.Version, err)
	}
	// A manifest's own version is the kantel-host build that wrote it, not the release: the channel's names the
	// version here.
	m.Version = ch.Version
	if _, err := u.Store.Install(ctx, ch.URL, m, u.Arch, u.KVM); err != nil {
		return err
	}
	if err := u.Store.Activate(ch.Version); err != nil {
		return err
	}
	if u.Log != nil {
		u.Log.Info("host images updated; new sandboxes start on them", "version", ch.Version, "channel", ch.Channel)
	}
	if u.OnActivate != nil {
		u.OnActivate(ch.Version)
	}
	return nil
}

// Prune is Store.Prune, one at a time with Check, so a version being installed or activated is never removed.
func (u *Updater) Prune(keep func(version string) bool, keepNewest int) []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.Store.Prune(keep, keepNewest)
}

// download copies a small file (a manifest, a bundle) from a URL or a directory.
func download(base, rel, dst string) error {
	in, err := Open(base, rel)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.LimitReader(in, 16<<20)); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
