package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/images"
)

// The host's own image source (Config.ImageSource): with image patching on, the host follows it instead of the
// control plane's image channel. Each check reads the headers file again (so a fixed mode or a rotated token takes
// effect without a restart), asks the source for its version, and when that isn't current runs the same update as
// the channel's (checkImages): the manifest's signature first, every file's digest, then one rename. Sandboxes stay on
// the version they were made on; new ones, and the templates rebuilt for it, start on the new one. Pointing the
// source back at a version the host still has (the newest two, and any a sandbox is on) rolls back without a
// download beyond the manifest and its bundle.

// imageSource is the source the config names, with its headers read and checked: a headers file anyone but its owner
// can read is refused, and so is the source with it.
func (h *Host) imageSource() (images.Source, error) {
	c := h.cfg.ImageSource
	if c == nil {
		return images.Source{}, errors.New("no image source is configured (imageSource)")
	}
	src := images.Source{Type: c.Type, URL: c.URL}
	if c.HeadersFile != "" {
		headers, err := images.ReadHeaders(c.HeadersFile)
		if err != nil {
			return src, err
		}
		src.Headers = headers
	}
	return src, src.Validate()
}

func (h *Host) followSourceEvery(stop <-chan struct{}, every time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-stop
		cancel()
	}()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		_ = h.followSource(ctx)
		select {
		case <-stop:
			return
		case <-ticker.C:
		}
	}
}

// followSource checks the image source once and updates to the version it names, logging what went wrong: the
// error's text never holds a header's value.
func (h *Host) followSource(ctx context.Context) error {
	u := h.patching.updater
	if u == nil || h.cfg.ImageSource == nil {
		return nil
	}
	url := h.cfg.ImageSource.URL
	src, err := h.imageSource()
	if err != nil {
		h.log.Error("not following the image source: new sandboxes stay on the current images", "url", url, "error", err)
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	sctx, ch, err := src.Latest(ctx)
	if err != nil {
		h.log.Error("couldn't read the image source's version; new sandboxes stay on the current images", "url", url, "error", err)
		return err
	}
	if current, ok := u.Store.Current(); ok && current == ch.Version {
		return nil
	}
	if !h.patching.busy.CompareAndSwap(false, true) {
		return nil
	}
	defer h.patching.busy.Store(false)
	h.log.Info("updating host images from the image source", "to", ch.Version, "url", url)
	if err := h.checkImages(sctx, u, ch); err != nil {
		h.log.Error("host images update from the image source failed; new sandboxes stay on the current images", "to", ch.Version, "url", url, "error", err)
		return err
	}
	return nil
}

// sourceImage installs (without making it current) a version of the image source the host hasn't got, for a
// snapshot fetched from a peer, and is its microVM root filesystem.
func (h *Host) sourceImage(ctx context.Context, version string) (string, error) {
	u := h.patching.updater
	src, err := h.imageSource()
	if err != nil {
		return "", err
	}
	sctx, ch, err := src.At(ctx, version)
	if err != nil {
		return "", err
	}
	if err := u.Install(sctx, ch); err != nil {
		return "", err
	}
	if p := u.Store.SandboxImage(version); p != "" {
		return p, nil
	}
	return "", fmt.Errorf("host images %s were installed without a microVM root filesystem", version)
}
