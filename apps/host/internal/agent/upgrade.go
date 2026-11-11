package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Upgrading an isolate to a microVM on this host (sandbox.upgrade, FeatureIsolateUpgrade): the microVM is made as
// sandbox.create makes one, with the isolate's sandbox ID; the isolate's files go from the host's blob store into the
// microVM as a tar streamed to its guest agent, which extracts it at proto.UpgradeWorkspace with its own code (as
// sandbox.files.extract does); /workspace becomes a link to it; and only then does the isolate go. Nothing passes
// through Kantel. Until the end the isolate is as it was, and the host sends no event for the ID, so Kantel never sees
// a half-made microVM or a deleted isolate; a failure deletes what was made and answers why.

// upgradeSource is the isolate tier as an upgrade's source.
type upgradeSource interface {
	ExportTar(id string, w io.Writer) (entries int, bytes int64, err error)
	Dispose(id string) error
}

// upgradeStaging is where the tar is written in the microVM before its guest agent extracts it (and removes it).
const upgradeStaging = "/tmp/.kantel-upgrade.tar"

// upgradeLink makes /workspace a link to the upgraded files, as root: an empty directory there is replaced, anything
// else is left and refused.
const upgradeLink = `set -e
if [ -d /workspace ] && [ ! -L /workspace ]; then rmdir /workspace; fi
ln -sfn ` + proto.UpgradeWorkspace + ` /workspace`

func (h *Host) upgrade(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if p.Tier != "" && p.Tier != microvm.Tier {
		return proto.SandboxInfo{}, invalid("an isolate is upgraded to a microVM, not %s", p.Tier)
	}
	p.Tier = microvm.Tier
	if p.Template != nil || len(p.Mounts) > 0 || p.From != "" {
		return proto.SandboxInfo{}, invalid("an upgrade makes a microVM from no template, snapshot or mounts")
	}
	mv, ok := h.tiers[microvm.Tier]
	if !ok {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrUnsupported, Message: "this host runs no microVMs"}
	}
	streamer, okStream := mv.(FileStreamer)
	extractor, okExtract := mv.(ArchiveExtractor)
	if !okStream || !okExtract {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrUnsupported, Message: "this host's microVMs don't take files from an isolate"}
	}
	defer h.lifecycle.lock(p.SandboxID)()
	t, name, err := h.tierOfNamed(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	if name != isolate.Tier {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s is a %s, not an isolate", p.SandboxID, name)}
	}
	source, ok := t.(upgradeSource)
	if !ok {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrUnsupported, Message: "this host's isolates can't be upgraded"}
	}
	began := time.Now()
	release := h.holdEvents(p.SandboxID)
	defer release()
	if p.Egress != nil {
		if err := h.orderNew(mv, p.SandboxID, p.Egress.Revision); err != nil {
			return proto.SandboxInfo{}, err
		}
	}
	h.requireProtected(p.SandboxID, p.Egress)
	e, fresh, err := h.prepareEgress(microvm.Tier, p.SandboxID, p.Egress)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	p.Egress = e
	info, err := mv.Create(ctx, p)
	if err != nil {
		if fresh {
			_ = h.cas.Forget(p.SandboxID)
		}
		return proto.SandboxInfo{}, err
	}
	made := time.Now()
	undo := func(cause error) (proto.SandboxInfo, error) {
		// Its own context: the call's may be what ended.
		cleanup, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := mv.Delete(cleanup, p.SandboxID); err != nil {
			h.log.Warn("upgrade: the microVM made for it couldn't be deleted", "sandbox", p.SandboxID, "err", err)
		}
		if fresh {
			_ = h.cas.Forget(p.SandboxID)
		}
		return proto.SandboxInfo{}, cause
	}
	moved, err := h.moveFiles(ctx, source, streamer, extractor, p.SandboxID)
	if err != nil {
		return undo(fmt.Errorf("moving the isolate's files into the microVM: %w", err))
	}
	res, err := mv.Exec(ctx, proto.ExecParams{SandboxID: p.SandboxID, Argv: []string{"sh", "-c", upgradeLink}, User: "root", TimeoutMs: 30_000}, nil)
	if err == nil && res.ExitCode != 0 {
		err = fmt.Errorf("exit %d: %s", res.ExitCode, res.Stderr)
	}
	if err != nil {
		return undo(fmt.Errorf("linking /workspace to %s: %w", proto.UpgradeWorkspace, err))
	}
	// The microVM runs with the files: the isolate goes, without an event (the sandbox lives on with its ID). One that
	// can't be removed is left on the disk, unlisted after a restart only if its meta is gone; the microVM answers.
	if err := source.Dispose(p.SandboxID); err != nil {
		h.log.Warn("upgrade: the isolate couldn't be removed", "sandbox", p.SandboxID, "err", err)
	}
	h.forgetSecrets(p.SandboxID)
	if info.Timings == nil {
		info.Timings = map[string]float64{}
	}
	info.Timings["upgrade.create"] = ms(made.Sub(began))
	info.Timings["upgrade.files"] = ms(time.Since(made))
	info.Timings["upgrade.total"] = ms(time.Since(began))
	info.Moved = &moved
	if now, err := mv.Get(p.SandboxID); err == nil {
		info.State = now.State
	}
	release()
	// What Kantel would have heard from the create, sent now it is done.
	h.sandboxEvent(info)
	return info, nil
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// moveFiles streams the isolate's tar into the microVM and has its guest agent extract it at UpgradeWorkspace.
func (h *Host) moveFiles(ctx context.Context, source upgradeSource, streamer FileStreamer, extractor ArchiveExtractor, id string) (proto.Moved, error) {
	pr, pw := io.Pipe()
	var moved proto.Moved
	exported := make(chan error, 1)
	go func() {
		entries, bytes, err := source.ExportTar(id, pw)
		moved = proto.Moved{Files: entries, Bytes: bytes}
		// A failed export fails the write, which then leaves nothing in place.
		_ = pw.CloseWithError(err)
		exported <- err
	}()
	_, werr := streamer.WriteFileStream(ctx, proto.FileParams{SandboxID: id, Path: upgradeStaging, Mode: 0o600}, pr)
	_ = pr.CloseWithError(errors.New("the write ended"))
	eerr := <-exported
	if eerr != nil {
		return moved, eerr
	}
	if werr != nil {
		return moved, werr
	}
	if err := extractor.ExtractArchive(ctx, proto.FileExtractParams{SandboxID: id, Archive: upgradeStaging, Target: proto.UpgradeWorkspace}); err != nil {
		return moved, err
	}
	return moved, nil
}

// upgradesIsolates says the host runs both tiers, its isolates can give their files and its microVMs take them.
func (h *Host) upgradesIsolates() bool {
	iso, okIso := h.tiers[isolate.Tier]
	mv, okMv := h.tiers[microvm.Tier]
	if !okIso || !okMv {
		return false
	}
	_, source := iso.(upgradeSource)
	_, streams := mv.(FileStreamer)
	_, extracts := mv.(ArchiveExtractor)
	return source && streams && extracts
}

// holdEvents keeps the sandbox's events from Kantel until the release it answers (called once or more).
func (h *Host) holdEvents(id string) (release func()) {
	h.mu.Lock()
	if h.held == nil {
		h.held = map[string]int{}
	}
	h.held[id]++
	h.mu.Unlock()
	done := false
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if done {
			return
		}
		done = true
		if h.held[id]--; h.held[id] <= 0 {
			delete(h.held, id)
		}
	}
}
