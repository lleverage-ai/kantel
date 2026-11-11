package agent

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// upgradeIsolateTier is an isolate tier with one sandbox's files, exported as the isolate tier exports them.
type upgradeIsolateTier struct {
	Tier
	mu       sync.Mutex
	present  map[string]bool
	files    map[string]string
	disposed []string
	failTar  error
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
	tw := tar.NewWriter(w)
	var size int64
	for name, content := range f.files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			return 0, 0, err
		}
		_, _ = tw.Write([]byte(content))
		size += int64(len(content))
	}
	return len(f.files), size, tw.Close()
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
}

func (f *upgradeMicrovmTier) Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if f.failCreate {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrCapacity, Message: "no room for the microVM"}
	}
	if f.onCreate != nil {
		f.onCreate()
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

func upgradeCall(t *testing.T, h *Host, params proto.CreateParams) (proto.SandboxInfo, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
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
	// Again: it is a microVM now, not an isolate.
	if _, err := upgradeCall(t, h, proto.CreateParams{SandboxID: "sbx_up"}); codeOf(err) != proto.ErrConflict {
		t.Fatalf("upgrading a microVM: %v", err)
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

func codeOf(err error) string {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}
