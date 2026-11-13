package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Upgrading an isolate to a microVM on this host (sandbox.upgrade, FeatureIsolateUpgrade): the isolate is frozen (its
// commands and writes refused, any under way waited for), the microVM is made as sandbox.create makes one, with the
// isolate's sandbox ID; the isolate's files go from the host's blob store into the microVM as a tar streamed to its
// guest agent, which extracts it at proto.UpgradeWorkspace with its own code (as sandbox.files.extract does);
// /workspace becomes a link to it; and only then does the isolate go. Nothing passes through Kantel. Until the end the
// isolate is as it was, and the host sends no event for the ID, so Kantel never sees a half-made microVM or a deleted
// isolate; a failure deletes what was made, thaws the isolate and answers why.
//
// Each upgrade has Kantel's operation ID, and its outcome is kept on disk (Root/upgrades/<sandbox>.json) before it is
// answered, so an answer Kantel never got is not an unknown: sandbox.upgrade sent again answers the same outcome, and
// sandbox.upgrade.settle answers it, waiting for one under way, or rolls back and fails one that never finished (or
// never came), so it can't land after Kantel has given up on it.
//
// The microVM may start from one of this host's microVM snapshots (From) or a template (Template), as a create from
// them does (FeatureIsolateUpgradeFrom), its memory restored where the snapshot holds it: the files go in after it
// runs, laid over what the snapshot has at UpgradeWorkspace (an isolate's file replaces the snapshot's, nothing of the
// snapshot's is deleted).

// upgradeSource is the isolate tier as an upgrade's source.
type upgradeSource interface {
	ExportTar(id string, w io.Writer) (entries int, bytes int64, err error)
	Dispose(id string) error
	Freeze(id, opID string, wait time.Duration) error
	Thaw(id, opID string) error
	FrozenBy(id string) string
}

// upgradeStaging is where the tar is written in the microVM before its guest agent extracts it (and removes it).
const upgradeStaging = "/tmp/.kantel-upgrade.tar"

// upgradeFreezeWait is how long an upgrade waits for an isolate's command or write under way to end.
const upgradeFreezeWait = 2 * time.Minute

// upgradeLink makes /workspace a link to the upgraded files, as root: an empty directory there is replaced, anything
// else is left and refused.
const upgradeLink = `set -e
if [ -d /workspace ] && [ ! -L /workspace ]; then rmdir /workspace; fi
ln -sfn ` + proto.UpgradeWorkspace + ` /workspace`

// upgradeRecord is an upgrade's outcome as the host keeps it.
type upgradeRecord struct {
	OperationID string       `json:"operationId"`
	State       string       `json:"state"`
	Code        string       `json:"code,omitempty"`
	Error       string       `json:"error,omitempty"`
	Moved       *proto.Moved `json:"moved,omitempty"`
	At          int64        `json:"at"`
}

func (h *Host) upgradeRecordPath(id string) string {
	return filepath.Join(h.cfg.Root, "upgrades", id+".json")
}

func (h *Host) readUpgrade(id string) *upgradeRecord {
	raw, err := os.ReadFile(h.upgradeRecordPath(id))
	if err != nil {
		return nil
	}
	var rec upgradeRecord
	if json.Unmarshal(raw, &rec) != nil {
		return nil
	}
	return &rec
}

func (h *Host) writeUpgrade(id string, rec upgradeRecord) error {
	rec.At = time.Now().UnixMilli()
	raw, _ := json.Marshal(rec)
	if err := os.MkdirAll(filepath.Dir(h.upgradeRecordPath(id)), 0o700); err != nil {
		return err
	}
	return fsutil.WriteFileDurably(h.upgradeRecordPath(id), raw, 0o600)
}

func validUpgrade(id, op string) error {
	if id == "" || op == "" || strings.ContainsAny(id, "/\\.") {
		return invalid("an upgrade needs a sandboxId and an operationId")
	}
	return nil
}

// upgradeTiers are the isolate tier (as a source) and the microVM tier (as a target, streaming and extracting).
func (h *Host) upgradeTiers() (upgradeSource, Tier, FileStreamer, ArchiveExtractor, error) {
	iso, _ := h.tiers[isolate.Tier].(upgradeSource)
	mv, ok := h.tiers[microvm.Tier]
	if !ok {
		return nil, nil, nil, nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host runs no microVMs"}
	}
	streamer, okStream := mv.(FileStreamer)
	extractor, okExtract := mv.(ArchiveExtractor)
	if iso == nil || !okStream || !okExtract {
		return nil, nil, nil, nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't make a microVM from an isolate"}
	}
	return iso, mv, streamer, extractor, nil
}

// recorded answers an upgrade's kept outcome: the microVM (removing the isolate if a restart left it) or the error.
func (h *Host) recorded(id string, rec *upgradeRecord, source upgradeSource, mv Tier) (proto.SandboxInfo, error) {
	if rec.State != "done" {
		code := rec.Code
		if code == "" {
			code = proto.ErrConflict
		}
		return proto.SandboxInfo{}, &proto.Error{Code: code, Message: rec.Error}
	}
	if source != nil {
		if iso, err := h.tiers[isolate.Tier].Get(id); err == nil && iso.ID == id {
			_ = source.Dispose(id)
		}
	}
	info, err := mv.Get(id)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	info.Moved = rec.Moved
	return info, nil
}

func codeOf(err error) string {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

func (h *Host) upgrade(ctx context.Context, p proto.UpgradeParams) (proto.SandboxInfo, error) {
	if p.Tier != "" && p.Tier != microvm.Tier {
		return proto.SandboxInfo{}, invalid("an isolate is upgraded to a microVM, not %s", p.Tier)
	}
	p.Tier = microvm.Tier
	if err := validUpgrade(p.SandboxID, p.OperationID); err != nil {
		return proto.SandboxInfo{}, err
	}
	if len(p.Mounts) > 0 {
		return proto.SandboxInfo{}, invalid("an upgrade makes a microVM with no mounts")
	}
	if p.From != "" && p.Template != nil {
		return proto.SandboxInfo{}, invalid("an upgrade makes a microVM from a snapshot or a template, not both")
	}
	source, mv, streamer, extractor, err := h.upgradeTiers()
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	defer h.lifecycle.lock(p.SandboxID)()
	// Sent again: the first's outcome, even if its snapshot has gone since.
	if rec := h.readUpgrade(p.SandboxID); rec != nil && rec.OperationID == p.OperationID {
		return h.recorded(p.SandboxID, rec, source, mv)
	}
	// Only a microVM's snapshot: an isolate's (its own, perhaps) is no machine to start.
	if p.From != "" && !mv.HasSnapshot(p.From) {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no microVM snapshot %s on this host", p.From)}
	}
	_, name, err := h.tierOfNamed(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	if name != isolate.Tier {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s is a %s, not an isolate", p.SandboxID, name)}
	}
	// What failed is kept, so the same operation sent again answers it rather than trying again.
	failed := func(err error) (proto.SandboxInfo, error) {
		code := codeOf(err)
		if code == "" {
			code = proto.ErrUnavailable
		}
		if werr := h.writeUpgrade(p.SandboxID, upgradeRecord{OperationID: p.OperationID, State: "failed", Code: code, Error: err.Error()}); werr != nil {
			h.log.Warn("upgrade: its failure couldn't be kept", "sandbox", p.SandboxID, "err", werr)
		}
		return proto.SandboxInfo{}, err
	}
	began := time.Now()
	release := h.holdEvents(p.SandboxID)
	defer release()
	if err := source.Freeze(p.SandboxID, p.OperationID, upgradeFreezeWait); err != nil {
		return failed(err)
	}
	thaw := func() {
		if err := source.Thaw(p.SandboxID, p.OperationID); err != nil {
			h.log.Warn("upgrade: the isolate couldn't be thawed", "sandbox", p.SandboxID, "err", err)
		}
	}
	if p.Egress != nil {
		if err := h.orderNew(mv, p.SandboxID, p.Egress.Revision); err != nil {
			thaw()
			return failed(err)
		}
	}
	h.requireProtected(p.SandboxID, p.Egress)
	e, fresh, err := h.prepareEgress(microvm.Tier, p.SandboxID, p.Egress)
	if err != nil {
		thaw()
		return failed(err)
	}
	p.Egress = e
	info, err := mv.Create(ctx, p.CreateParams)
	if err != nil {
		if fresh {
			_ = h.cas.Forget(p.SandboxID)
		}
		thaw()
		return failed(err)
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
		thaw()
		return failed(cause)
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
		// A snapshot whose /workspace is a directory with files in it, say: those are left alone, so no link is made.
		return undo(fmt.Errorf("linking /workspace to %s: %w", proto.UpgradeWorkspace, err))
	}
	// Kept before the isolate goes and before it is answered: from here the upgrade is done, whatever becomes of the
	// answer.
	if err := h.writeUpgrade(p.SandboxID, upgradeRecord{OperationID: p.OperationID, State: "done", Moved: &moved}); err != nil {
		return undo(fmt.Errorf("keeping the upgrade's outcome: %w", err))
	}
	// The microVM runs with the files: the isolate goes, without an event (the sandbox lives on with its ID).
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

// settleUpgrade answers an upgrade's outcome for Kantel, which lost its answer: once one under way has ended (the
// lifecycle lock), its kept outcome; else it never finished here, or never came, and it is rolled back (a microVM
// made for it deleted, the isolate thawed) and kept as failed, so the operation sent late can't start.
func (h *Host) settleUpgrade(ctx context.Context, p proto.UpgradeRef) (proto.UpgradeOutcome, error) {
	if err := validUpgrade(p.SandboxID, p.OperationID); err != nil {
		return proto.UpgradeOutcome{}, err
	}
	source, mv, _, _, err := h.upgradeTiers()
	if err != nil {
		return proto.UpgradeOutcome{}, err
	}
	defer h.lifecycle.lock(p.SandboxID)()
	if rec := h.readUpgrade(p.SandboxID); rec != nil && rec.OperationID == p.OperationID {
		info, err := h.recorded(p.SandboxID, rec, source, mv)
		if err != nil {
			return proto.UpgradeOutcome{State: "failed", Error: err.Error()}, nil
		}
		return proto.UpgradeOutcome{State: "done", Sandbox: &info}, nil
	}
	if source.FrozenBy(p.SandboxID) == p.OperationID {
		if _, err := mv.Get(p.SandboxID); err == nil {
			if err := mv.Delete(ctx, p.SandboxID); err != nil {
				return proto.UpgradeOutcome{}, err
			}
		}
		if err := source.Thaw(p.SandboxID, p.OperationID); err != nil {
			return proto.UpgradeOutcome{}, err
		}
	}
	const why = "the upgrade didn't finish on its host, which rolled it back"
	if err := h.writeUpgrade(p.SandboxID, upgradeRecord{OperationID: p.OperationID, State: "failed", Code: proto.ErrUnavailable, Error: why}); err != nil {
		return proto.UpgradeOutcome{}, err
	}
	return proto.UpgradeOutcome{State: "failed", Error: why}, nil
}

// freezeIsolate and thawIsolate are sandbox.upgrade.freeze and .thaw: an isolate held still while Kantel copies its
// files to a microVM on another host, and let go again if that upgrade rolls back. The caller holds the sandbox's
// lifecycle lock, so a thaw follows a freeze that is still waiting for a command to end.
func (h *Host) freezeIsolate(p proto.UpgradeRef) error {
	if err := validUpgrade(p.SandboxID, p.OperationID); err != nil {
		return err
	}
	source, ok := h.tiers[isolate.Tier].(upgradeSource)
	if !ok {
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host runs no isolates"}
	}
	if _, name, err := h.tierOfNamed(p.SandboxID); err != nil {
		return err
	} else if name != isolate.Tier {
		return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s is a %s, not an isolate", p.SandboxID, name)}
	}
	wait := upgradeFreezeWait
	if p.WaitMs > 0 {
		wait = time.Duration(p.WaitMs) * time.Millisecond
	}
	return source.Freeze(p.SandboxID, p.OperationID, wait)
}

func (h *Host) thawIsolate(p proto.UpgradeRef) error {
	if err := validUpgrade(p.SandboxID, p.OperationID); err != nil {
		return err
	}
	source, ok := h.tiers[isolate.Tier].(upgradeSource)
	if !ok {
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host runs no isolates"}
	}
	if _, err := h.tiers[isolate.Tier].Get(p.SandboxID); err != nil {
		// Gone (the upgrade committed and deleted it): nothing to thaw.
		return nil
	}
	return source.Thaw(p.SandboxID, p.OperationID)
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
