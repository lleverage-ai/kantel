package agent

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// upgradeIsolateTier is an isolate tier with one sandbox's files, directories and links, exported as the isolate tier
// exports them (sorted, so a directory comes before what is in it).
type upgradeIsolateTier struct {
	Tier
	mu       sync.Mutex
	present  map[string]bool
	files    map[string]string
	dirs     []string
	links    map[string]string
	disposed []string
	failTar  error
	frozen   string
}

func (f *upgradeIsolateTier) Freeze(_, opID string, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.frozen != "" && f.frozen != opID {
		return &proto.Error{Code: proto.ErrConflict, Message: "held by another upgrade"}
	}
	f.frozen = opID
	return nil
}

func (f *upgradeIsolateTier) Thaw(_, opID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.frozen == opID {
		f.frozen = ""
	}
	return nil
}

func (f *upgradeIsolateTier) FrozenBy(string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frozen
}

func (f *upgradeIsolateTier) Get(id string) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.present[id] {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: isolate.Tier, State: proto.StateRunning}, nil
}

func (f *upgradeIsolateTier) EgressOf(string) (*proto.Egress, error) { return nil, nil }

func (f *upgradeIsolateTier) ExportTar(_ string, w io.Writer) (int, int64, error) {
	if f.failTar != nil {
		return 0, 0, f.failTar
	}
	var headers []*tar.Header
	for _, name := range f.dirs {
		headers = append(headers, &tar.Header{Name: name + "/", Mode: 0o755, Typeflag: tar.TypeDir})
	}
	for name, content := range f.files {
		headers = append(headers, &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg})
	}
	for name, target := range f.links {
		headers = append(headers, &tar.Header{Name: name, Mode: 0o777, Linkname: target, Typeflag: tar.TypeSymlink})
	}
	slices.SortFunc(headers, func(a, b *tar.Header) int { return strings.Compare(a.Name, b.Name) })
	tw := tar.NewWriter(w)
	var size int64
	for _, h := range headers {
		if err := tw.WriteHeader(h); err != nil {
			return 0, 0, err
		}
		if h.Typeflag == tar.TypeReg {
			content := f.files[h.Name]
			_, _ = tw.Write([]byte(content))
			size += int64(len(content))
		}
	}
	return len(headers), size, tw.Close()
}

func (f *upgradeIsolateTier) Dispose(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.present, id)
	f.disposed = append(f.disposed, id)
	return nil
}

// upgradeMicrovmTier is a microVM tier whose guest takes a file stream and extracts an archive as the guest agent
// does (guest.ExtractTar), into a directory standing for the guest's root.
type upgradeMicrovmTier struct {
	*lifecycleTier
	root       string
	failLink   bool
	failCreate bool
	deleted    []string
	// onCreate runs inside a create, as the microVM tier's events are sent while it makes a sandbox.
	onCreate func()
	// snapshots are the tier's snapshots by ID, each its files by path under the guest's root, which a create from it
	// writes into root as a restore leaves its disk.
	snapshots map[string]map[string]string
	created   []proto.CreateParams
}

func (f *upgradeMicrovmTier) HasSnapshot(id string) bool {
	_, ok := f.snapshots[id]
	return ok
}

func (f *upgradeMicrovmTier) Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if f.failCreate {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrCapacity, Message: "no room for the microVM"}
	}
	f.created = append(f.created, p)
	if f.onCreate != nil {
		f.onCreate()
	}
	for name, content := range f.snapshots[p.From] {
		path := filepath.Join(f.root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return proto.SandboxInfo{}, err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return proto.SandboxInfo{}, err
		}
	}
	return f.lifecycleTier.Create(ctx, p)
}

func (f *upgradeMicrovmTier) Delete(ctx context.Context, id string) error {
	f.deleted = append(f.deleted, id)
	return f.lifecycleTier.Delete(ctx, id)
}

func (f *upgradeMicrovmTier) ReadFileStream(context.Context, proto.FileParams) (io.ReadCloser, int64, error) {
	return nil, 0, errors.New("unused")
}

func (f *upgradeMicrovmTier) WriteFileStream(_ context.Context, p proto.FileParams, r io.Reader) (int64, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return 0, err
	}
	path := filepath.Join(f.root, p.Path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, err
	}
	return int64(len(data)), os.WriteFile(path, data, 0o600)
}

func (f *upgradeMicrovmTier) ExtractArchive(_ context.Context, p proto.FileExtractParams) error {
	archive := filepath.Join(f.root, p.Archive)
	defer os.Remove(archive)
	return guest.ExtractTar(archive, filepath.Join(f.root, p.Target), os.Getuid(), os.Getgid())
}

func (f *upgradeMicrovmTier) Exec(ctx context.Context, p proto.ExecParams, out func(string, string)) (proto.ExecResult, error) {
	res, err := f.lifecycleTier.Exec(ctx, p, out)
	if f.failLink {
		return proto.ExecResult{ExitCode: 1, Stderr: "rmdir: /workspace: Directory not empty"}, nil
	}
	return res, err
}

func newUpgradeHost(t *testing.T) (*Host, *upgradeIsolateTier, *upgradeMicrovmTier, *[]proto.Event) {
	t.Helper()
	iso := &upgradeIsolateTier{present: map[string]bool{"sbx_up": true}, files: map[string]string{"src/a.txt": "hello\n", "notes.md": "# notes\n"}}
	mv := &upgradeMicrovmTier{lifecycleTier: newLifecycleTier(), root: t.TempDir()}
	h := newLifecycleHost(t, mv.lifecycleTier)
	h.tiers = map[string]Tier{microvm.Tier: mv, isolate.Tier: iso}
	h.order = []string{microvm.Tier, isolate.Tier}
	events := &[]proto.Event{}
	var mu sync.Mutex
	h.events = func(e proto.Event) {
		mu.Lock()
		defer mu.Unlock()
		*events = append(*events, e)
	}
	return h, iso, mv, events
}

func upgradeCall(t *testing.T, h *Host, params proto.CreateParams, op ...string) (proto.SandboxInfo, error) {
	t.Helper()
	id := "upg_1"
	if len(op) > 0 {
		id = op[0]
	}
	raw, _ := json.Marshal(proto.UpgradeParams{CreateParams: params, OperationID: id})
	out, err := h.Call(context.Background(), proto.MethodUpgrade, raw, nil)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	return out.(proto.SandboxInfo), nil
}

// An upgrade makes the microVM with the isolate's ID, streams the isolate's files into it, extracted at
// /home/user/workspace, links /workspace to them as root, then lets the isolate go, and tells Kantel once.
func TestUpgradeMovesTheIsolatesFilesIntoTheMicrovm(t *testing.T) {
	h, iso, mv, events := newUpgradeHost(t)
	if !h.upgradesIsolates() {
		t.Fatal("a host with both tiers says it can't upgrade")
	}
	h.facts = h.makeFacts()
	found := false
	for _, f := range h.facts.Features {
		found = found || f == proto.FeatureIsolateUpgrade
	}
	if !found {
		t.Fatalf("its features %v don't say %s", h.facts.Features, proto.FeatureIsolateUpgrade)
	}
	// An event the microVM tier sends while it is made is held: Kantel hears of it once it's done.
	mv.onCreate = func() {
		h.sandboxEvent(proto.SandboxInfo{ID: "sbx_up", Tier: microvm.Tier, State: proto.StateStarting})
	}
	info, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", Size: "default", Owner: "acct"})
	if err != nil {
		t.Fatal(err)
	}
	if info.ID != "sbx_up" || info.Tier != microvm.Tier || info.State != proto.StateRunning {
		t.Fatalf("answered %+v", info)
	}
	if info.Moved == nil || info.Moved.Files != 2 || info.Moved.Bytes != int64(len("hello\n")+len("# notes\n")) {
		t.Fatalf("moved %+v", info.Moved)
	}
	if info.Timings["upgrade.total"] <= 0 {
		t.Fatalf("timings %v", info.Timings)
	}
	got, err := os.ReadFile(filepath.Join(mv.root, "home", "user", "workspace", "src", "a.txt"))
	if err != nil || string(got) != "hello\n" {
		t.Fatalf("the microVM's src/a.txt: %q %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(mv.root, upgradeStaging)); !os.IsNotExist(err) {
		t.Fatalf("the staged tar is still there: %v", err)
	}
	execs := mv.execs
	if len(execs) != 1 || execs[0].User != "root" || !strings.Contains(strings.Join(execs[0].Argv, " "), "ln -sfn /home/user/workspace /workspace") {
		t.Fatalf("ran %+v", execs)
	}
	if len(iso.disposed) != 1 || iso.disposed[0] != "sbx_up" {
		t.Fatalf("disposed %v", iso.disposed)
	}
	if _, name, err := h.tierOfNamed("sbx_up"); err != nil || name != microvm.Tier {
		t.Fatalf("sbx_up is now %s (%v)", name, err)
	}
	var said []string
	for _, e := range *events {
		if e.Sandbox != nil && e.Sandbox.ID == "sbx_up" {
			said = append(said, e.Sandbox.Tier+":"+e.Sandbox.State)
		}
	}
	if strings.Join(said, ",") != "microvm:running" {
		t.Fatalf("events for it: %v", said)
	}
	if iso.frozen != "upg_1" {
		t.Fatalf("the isolate wasn't frozen for the upgrade (%q)", iso.frozen)
	}
	// The same operation again (its answer lost): its outcome, nothing made twice.
	again, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"})
	if err != nil || again.Tier != microvm.Tier || again.Moved == nil || again.Moved.Files != 2 {
		t.Fatalf("the same upgrade again: %+v %v", again, err)
	}
	if len(mv.deleted) != 0 {
		t.Fatalf("the microVM was touched again: %v", mv.deleted)
	}
	settled := settleCall(t, h, "sbx_up", "upg_1")
	if settled.State != "done" || settled.Sandbox == nil || settled.Sandbox.Tier != microvm.Tier {
		t.Fatalf("settling it: %+v", settled)
	}
	// Another operation: it is a microVM now, not an isolate.
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}, "upg_2"); codeOf(err) != proto.ErrConflict {
		t.Fatalf("upgrading a microVM: %v", err)
	}
}

func settleCall(t *testing.T, h *Host, id, op string) proto.UpgradeOutcome {
	t.Helper()
	raw, _ := json.Marshal(proto.UpgradeRef{SandboxID: id, OperationID: op})
	out, err := h.Call(context.Background(), proto.MethodUpgradeSettle, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return out.(proto.UpgradeOutcome)
}

// An upgrade the host never finished, or never got, is settled failed: rolled back, the isolate thawed, and the same
// operation arriving later doesn't start.
func TestSettlingAnUpgradeTheHostNeverDidFailsIt(t *testing.T) {
	h, iso, mv, _ := newUpgradeHost(t)
	// A freeze landed (a cross-host copy), then Kantel lost track: settling thaws it.
	if err := iso.Freeze("sbx_up", "upg_lost", 0); err != nil {
		t.Fatal(err)
	}
	if out := settleCall(t, h, "sbx_up", "upg_lost"); out.State != "failed" {
		t.Fatalf("settled %+v", out)
	}
	if iso.frozen != "" {
		t.Fatalf("the isolate is still frozen by %q", iso.frozen)
	}
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}, "upg_lost"); err == nil {
		t.Fatal("an upgrade settled failed ran after all")
	}
	if len(iso.disposed) != 0 || mv.execCount() != 0 {
		t.Fatalf("it ran: disposed %v, %d execs", iso.disposed, mv.execCount())
	}
	// A new operation upgrades it.
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}, "upg_new"); err != nil {
		t.Fatal(err)
	}
}

// When the files can't be moved, or /workspace can't be linked, the microVM made goes and the isolate stays as it
// was, with nothing said to Kantel.
func TestAFailedUpgradeLeavesTheIsolate(t *testing.T) {
	for _, fail := range []string{"create", "tar", "link"} {
		t.Run(fail, func(t *testing.T) {
			h, iso, mv, events := newUpgradeHost(t)
			switch fail {
			case "create":
				mv.failCreate = true
			case "tar":
				iso.failTar = errors.New("blob gone")
			case "link":
				mv.failLink = true
			}
			if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}); err == nil {
				t.Fatal("the upgrade succeeded")
			}
			if len(iso.disposed) != 0 {
				t.Fatalf("the isolate was disposed of: %v", iso.disposed)
			}
			if _, name, err := h.tierOfNamed("sbx_up"); err != nil || name != isolate.Tier {
				t.Fatalf("sbx_up is %s (%v)", name, err)
			}
			if fail != "create" && (len(mv.deleted) != 1 || mv.deleted[0] != "sbx_up") {
				t.Fatalf("the microVM made wasn't deleted: %v", mv.deleted)
			}
			if len(*events) != 0 {
				t.Fatalf("it told Kantel %v", *events)
			}
			if iso.frozen != "" {
				t.Fatalf("the isolate is still frozen by %q", iso.frozen)
			}
			// Sent again, it answers the same failure rather than trying again.
			if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}); err == nil {
				t.Fatal("the failed upgrade succeeded when sent again")
			}
		})
	}
}

// An upgrade into one of the host's microVM snapshots makes the microVM from it as a create does, then lays the
// isolate's files over what the snapshot has at /home/user/workspace: the isolate's win where both have a file, and
// nothing of the snapshot's is deleted, there or anywhere else.
func TestUpgradeIntoASnapshotLaysTheIsolatesFilesOverIt(t *testing.T) {
	h, iso, mv, _ := newUpgradeHost(t)
	if !slices.Contains(h.makeFacts().Features, proto.FeatureIsolateUpgradeFrom) {
		t.Fatalf("its features %v don't say %s", h.makeFacts().Features, proto.FeatureIsolateUpgradeFrom)
	}
	mv.snapshots = map[string]map[string]string{"snap_project": {
		"home/user/workspace/src/a.txt":         "the snapshot's\n",
		"home/user/workspace/package.json":      "{}\n",
		"home/user/workspace/node_modules/x.js": "x\n",
		"etc/project.conf":                      "kept\n",
	}}
	info, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", Size: "default", From: "snap_project"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Tier != microvm.Tier || info.Moved == nil || info.Moved.Files != 2 {
		t.Fatalf("answered %+v", info)
	}
	if len(mv.created) != 1 || mv.created[0].From != "snap_project" || mv.created[0].SandboxID != "sbx_up" {
		t.Fatalf("created %+v", mv.created)
	}
	for name, want := range map[string]string{
		"home/user/workspace/src/a.txt":         "hello\n",
		"home/user/workspace/notes.md":          "# notes\n",
		"home/user/workspace/package.json":      "{}\n",
		"home/user/workspace/node_modules/x.js": "x\n",
		"etc/project.conf":                      "kept\n",
	} {
		if got, err := os.ReadFile(filepath.Join(mv.root, name)); err != nil || string(got) != want {
			t.Errorf("%s: %q %v, want %q", name, got, err, want)
		}
	}
	if len(iso.disposed) != 1 {
		t.Fatalf("disposed %v", iso.disposed)
	}
}

// Where the isolate and the snapshot have different kinds of entry at one path, the guest's extractor decides: the
// isolate's directory replaces the snapshot's file or link, and its link replaces the snapshot's file, as a file
// replaces a file.
func TestUpgradeIntoASnapshotReplacesItsFilesAndLinks(t *testing.T) {
	h, iso, mv, _ := newUpgradeHost(t)
	mv.snapshots = map[string]map[string]string{"snap_project": {
		"home/user/workspace/build":   "the snapshot's file\n",
		"home/user/workspace/current": "the snapshot's file\n",
	}}
	iso.dirs = []string{"build", "src"}
	iso.files["build/out.js"] = "built\n"
	iso.links = map[string]string{"current": "src/a.txt"}
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", From: "snap_project"}); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(mv.root, "home", "user", "workspace")
	if got, err := os.ReadFile(filepath.Join(workspace, "build", "out.js")); err != nil || string(got) != "built\n" {
		t.Fatalf("build/out.js: %q %v", got, err)
	}
	if target, err := os.Readlink(filepath.Join(workspace, "current")); err != nil || target != "src/a.txt" {
		t.Fatalf("current: %q %v", target, err)
	}
}

// A file or link of the isolate's where the snapshot has a directory is refused by the guest's extractor, which never
// deletes a directory (the microVM tier answers its refusal invalid): the upgrade fails, the microVM goes, the isolate
// stays as it was, and the snapshot's directory kept its files until then.
func TestUpgradeIntoASnapshotRefusesAFileOrLinkOverItsDirectory(t *testing.T) {
	for name, lay := range map[string]func(*upgradeIsolateTier){
		"link": func(iso *upgradeIsolateTier) { iso.links = map[string]string{"lib": "src/a.txt"} },
		"file": func(iso *upgradeIsolateTier) { iso.files["lib"] = "a file\n" },
	} {
		t.Run(name, func(t *testing.T) {
			h, iso, mv, events := newUpgradeHost(t)
			mv.snapshots = map[string]map[string]string{"snap_project": {"home/user/workspace/lib/kept.js": "kept\n"}}
			lay(iso)
			_, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", From: "snap_project"})
			if err == nil || !strings.Contains(err.Error(), "where a directory is") {
				t.Fatalf("got %v, want the extractor's refusal", err)
			}
			if got, err := os.ReadFile(filepath.Join(mv.root, "home", "user", "workspace", "lib", "kept.js")); err != nil || string(got) != "kept\n" {
				t.Fatalf("the snapshot's lib/kept.js: %q %v", got, err)
			}
			if len(mv.deleted) != 1 || len(iso.disposed) != 0 || iso.frozen != "" || len(*events) != 0 || mv.execCount() != 0 {
				t.Fatalf("deleted %v, disposed %v, frozen %q, events %v, %d execs", mv.deleted, iso.disposed, iso.frozen, *events, mv.execCount())
			}
			if _, name, err := h.tierOfNamed("sbx_up"); err != nil || name != isolate.Tier {
				t.Fatalf("sbx_up is %s (%v)", name, err)
			}
		})
	}
}

// An upgrade into a snapshot sent again answers its kept outcome even once the snapshot is deleted; a new operation
// naming the deleted snapshot is refused before anything is frozen, and one settled failed doesn't start.
func TestAnUpgradeIntoASnapshotSentAgainAnswersItsOutcome(t *testing.T) {
	h, iso, mv, _ := newUpgradeHost(t)
	mv.snapshots = map[string]map[string]string{"snap_project": {"home/user/workspace/package.json": "{}\n"}}
	params := proto.CreateParams{SandboxID: "sbx_up", From: "snap_project"}
	first, err := upgradeCall(t, h, params)
	if err != nil {
		t.Fatal(err)
	}
	delete(mv.snapshots, "snap_project")
	again, err := upgradeCall(t, h, params)
	if err != nil || again.Tier != microvm.Tier || again.Moved == nil || *again.Moved != *first.Moved {
		t.Fatalf("the same upgrade again: %+v %v", again, err)
	}
	if len(mv.created) != 1 || len(mv.deleted) != 0 {
		t.Fatalf("created %v, deleted %v", mv.created, mv.deleted)
	}

	h, iso, mv, _ = newUpgradeHost(t)
	if _, err := upgradeCall(t, h, params, "upg_new"); codeOf(err) != proto.ErrNotFound {
		t.Fatalf("a new upgrade into a deleted snapshot: %v", err)
	}
	if iso.frozen != "" || len(mv.created) != 0 {
		t.Fatalf("it acted: frozen %q, created %v", iso.frozen, mv.created)
	}
	mv.snapshots = map[string]map[string]string{"snap_project": {}}
	if out := settleCall(t, h, "sbx_up", "upg_lost"); out.State != "failed" {
		t.Fatalf("settled %+v", out)
	}
	if _, err := upgradeCall(t, h, params, "upg_lost"); err == nil || codeOf(err) == proto.ErrNotFound {
		t.Fatalf("an upgrade settled failed: %v", err)
	}
	if iso.frozen != "" || len(mv.created) != 0 || len(iso.disposed) != 0 {
		t.Fatalf("it ran: frozen %q, created %v, disposed %v", iso.frozen, mv.created, iso.disposed)
	}
}

// A snapshot the microVM tier doesn't hold (an isolate's, or none) is refused before anything is frozen or made, as
// a create from it would be; so are mounts, and a snapshot with a template.
func TestUpgradeIntoASnapshotRefusesWhatItCantStartFrom(t *testing.T) {
	for name, p := range map[string]proto.CreateParams{
		"no such snapshot": {SandboxID: "sbx_up", From: "snap_gone"},
		"mounts":           {SandboxID: "sbx_up", Mounts: []proto.Mount{{Path: "/data"}}},
		"both":             {SandboxID: "sbx_up", From: "snap_project", Template: &proto.TemplateBoot{}},
	} {
		t.Run(name, func(t *testing.T) {
			h, iso, mv, events := newUpgradeHost(t)
			mv.snapshots = map[string]map[string]string{"snap_project": {}}
			_, err := upgradeCall(t, h, p)
			want := proto.ErrInvalid
			if name == "no such snapshot" {
				want = proto.ErrNotFound
			}
			if codeOf(err) != want {
				t.Fatalf("got %v, want %s", err, want)
			}
			if iso.frozen != "" || len(mv.created) != 0 || len(iso.disposed) != 0 || len(*events) != 0 {
				t.Fatalf("it acted: frozen %q, created %v, disposed %v, events %v", iso.frozen, mv.created, iso.disposed, *events)
			}
			if _, name, err := h.tierOfNamed("sbx_up"); err != nil || name != isolate.Tier {
				t.Fatalf("sbx_up is %s (%v)", name, err)
			}
		})
	}
}

// An upgrade into a snapshot that fails once the microVM is made (the files won't go in, or /workspace is the
// snapshot's own directory of files and can't be linked) deletes that microVM and leaves the isolate as it was.
func TestAFailedUpgradeIntoASnapshotLeavesTheIsolate(t *testing.T) {
	for _, fail := range []string{"tar", "link"} {
		t.Run(fail, func(t *testing.T) {
			h, iso, mv, events := newUpgradeHost(t)
			mv.snapshots = map[string]map[string]string{"snap_project": {"workspace/README": "the snapshot's\n"}}
			if fail == "tar" {
				iso.failTar = errors.New("blob gone")
			} else {
				mv.failLink = true
			}
			if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", From: "snap_project"}); err == nil {
				t.Fatal("the upgrade succeeded")
			}
			if len(mv.deleted) != 1 || len(iso.disposed) != 0 || iso.frozen != "" || len(*events) != 0 {
				t.Fatalf("deleted %v, disposed %v, frozen %q, events %v", mv.deleted, iso.disposed, iso.frozen, *events)
			}
			if _, name, err := h.tierOfNamed("sbx_up"); err != nil || name != isolate.Tier {
				t.Fatalf("sbx_up is %s (%v)", name, err)
			}
		})
	}
}

// Only an isolate is upgraded, on a host that runs microVMs.
func TestUpgradeRefusesWhatIsntAnIsolate(t *testing.T) {
	h, _, _, _ := newUpgradeHost(t)
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_none"}); codeOf(err) != proto.ErrNotFound {
		t.Fatalf("a sandbox the host doesn't have: %v", err)
	}
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up", Tier: isolate.Tier}); codeOf(err) != proto.ErrInvalid {
		t.Fatalf("an upgrade to an isolate: %v", err)
	}
	delete(h.tiers, microvm.Tier)
	h.order = []string{isolate.Tier}
	if h.upgradesIsolates() {
		t.Fatal("a host without microVMs says it upgrades")
	}
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}); codeOf(err) != proto.ErrUnsupported {
		t.Fatalf("on a host without microVMs: %v", err)
	}
}

// isolateWithSandbox is the real isolate tier with one running sandbox on disk (as after a restart), and no runtime:
// its freeze, thaw and file writes need none.
func isolateWithSandbox(t *testing.T, id string) *isolate.Manager {
	t.Helper()
	root := t.TempDir()
	images := t.TempDir()
	cfg := isolate.Config{Root: root, Firecracker: filepath.Join(images, "firecracker"), Kernel: filepath.Join(images, "vmlinux"), Rootfs: filepath.Join(images, "isolate.ext4"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, p := range []string{cfg.Firecracker, cfg.Kernel, cfg.Rootfs} {
		if err := os.WriteFile(p, []byte(p), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(root, "sandboxes", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"id": id, "owner": "acct", "state": proto.StateRunning})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := isolate.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

// A cross-host upgrade's freeze waits for a command or file write under way. If Kantel loses the connection and rolls
// the upgrade back meanwhile, its thaw (on a new connection) must come after that freeze, not before: else the freeze
// lands after the acknowledged thaw and the isolate stays held by an upgrade that is over.
func TestAThawWaitsForTheFreezeUnderWay(t *testing.T) {
	const id, op = "sbx_fz", "upg_lost"
	iso := isolateWithSandbox(t, id)
	ctx := context.Background()
	if err := iso.WriteFile(ctx, proto.FileParams{SandboxID: id, Path: "/workspace/a.txt"}, []byte("a\n")); err != nil {
		t.Fatal(err)
	}
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers[isolate.Tier] = iso
	h.order = append(h.order, isolate.Tier)

	// The isolate's work under way: an export, holding the isolate's commands and writes until its tar is read.
	pr, pw := io.Pipe()
	exported := make(chan error, 1)
	go func() {
		_, _, err := iso.ExportTar(id, pw)
		pw.CloseWithError(err)
		exported <- err
	}()
	if _, err := pr.Read(make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	ref := proto.UpgradeRef{SandboxID: id, OperationID: op, WaitMs: 10_000}
	froze := make(chan error, 1)
	go func() { froze <- call(t, h, proto.MethodUpgradeFreeze, ref) }()
	time.Sleep(100 * time.Millisecond) // the freeze waits for the export
	thawed := make(chan error, 1)
	go func() { thawed <- call(t, h, proto.MethodUpgradeThaw, ref) }()
	select {
	case err := <-thawed:
		t.Errorf("the thaw answered (%v) while the freeze still waited", err)
		thawed <- err
	case <-time.After(200 * time.Millisecond):
	}
	go func() { _, _ = io.Copy(io.Discard, pr) }()
	if err := <-exported; err != nil {
		t.Fatal(err)
	}
	if err := <-froze; err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if err := <-thawed; err != nil {
		t.Fatalf("thaw: %v", err)
	}
	if by := iso.FrozenBy(id); by != "" {
		t.Fatalf("held by %s after its thaw", by)
	}
	if err := iso.WriteFile(ctx, proto.FileParams{SandboxID: id, Path: "/workspace/b.txt"}, []byte("b\n")); err != nil {
		t.Fatalf("a write after the thaw: %v", err)
	}
}

// The isolate a cross-host upgrade leaves is deleted by Kantel with keepSnapshots: it goes, as it does on the same
// host (Dispose), and its automatic snapshots stay, Kantel listing them as the upgraded sandbox's; a plain delete still
// removes them with it.
func TestDeletingAnUpgradedIsolateKeepsItsSnapshots(t *testing.T) {
	ctx := context.Background()
	for _, keep := range []bool{true, false} {
		const id = "sbx_moved"
		iso := isolateWithSandbox(t, id)
		if err := iso.WriteFile(ctx, proto.FileParams{SandboxID: id, Path: "/workspace/a.txt"}, []byte("a\n")); err != nil {
			t.Fatal(err)
		}
		if _, err := iso.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_stopped"}); err != nil {
			t.Fatal(err)
		}
		h := newLifecycleHost(t, newLifecycleTier())
		h.tiers[isolate.Tier] = iso
		h.order = append(h.order, isolate.Tier)
		if err := call(t, h, proto.MethodDelete, proto.DeleteParams{SandboxID: id, KeepSnapshots: keep}); err != nil {
			t.Fatal(err)
		}
		if _, err := iso.Get(id); err == nil {
			t.Fatalf("keep %v: the isolate is still there", keep)
		}
		data, err := iso.SnapshotRead("snap_stopped", "/workspace/a.txt")
		switch {
		case keep && (err != nil || string(data) != "a\n"):
			t.Fatalf("its snapshot after the upgrade's delete: %q %v", data, err)
		case !keep && iso.HasSnapshot("snap_stopped"):
			t.Fatal("a plain delete left its automatic snapshot")
		}
	}
}
