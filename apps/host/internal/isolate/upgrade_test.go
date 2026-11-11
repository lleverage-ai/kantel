package isolate

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// upgradeManager is a Manager with one sandbox, iso_1 of acct, holding a manifest of the given files (path → content)
// and links, its blobs in the account's store.
func upgradeManager(t *testing.T, state string, files map[string]string, modes map[string]uint32, links map[string]string) (*Manager, *[]proto.SandboxInfo) {
	t.Helper()
	root := t.TempDir()
	events := &[]proto.SandboxInfo{}
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 5, Events: func(info proto.SandboxInfo) { *events = append(*events, info) }}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	dir := filepath.Join(root, "sandboxes", "iso_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	man := Manifest{}
	for p, content := range files {
		sha, err := m.putBlob("acct", []byte(content))
		if err != nil {
			t.Fatal(err)
		}
		man[p] = Entry{Kind: "file", SHA: sha, Size: int64(len(content)), Mode: modes[p]}
		for d := filepath.Dir(p); d != "."; d = filepath.Dir(d) {
			man[d] = Entry{Kind: "dir"}
		}
	}
	for p, target := range links {
		man[p] = Entry{Kind: "symlink", Target: target}
	}
	// An entry that would climb out is never exported.
	man["../escape"] = Entry{Kind: "symlink", Target: "/etc"}
	if err := writeJSONFile(filepath.Join(dir, "manifest.json"), man); err != nil {
		t.Fatal(err)
	}
	m.sandboxes["iso_1"] = &sandbox{dir: dir, meta: meta{ID: "iso_1", Owner: "acct", State: state}}
	writeAuto(t, m, "snap_auto", 1)
	return m, events
}

// The isolate's files, as an upgrade moves them: exported as a tar from the blob store and extracted by the guest
// agent's own code, they are the same files, modes and links under the microVM's workspace.
func TestExportTarIsTheWorkspaceAsTheGuestExtractsIt(t *testing.T) {
	for _, state := range []string{proto.StateRunning, proto.StateStopped} {
		m, _ := upgradeManager(t, state,
			map[string]string{"src/a.txt": "hello\n", "run.sh": "#!/bin/sh\necho run\n", "deep/er/x.json": "{}"},
			map[string]uint32{"run.sh": 0o755},
			map[string]string{"link": "src/a.txt"},
		)
		var buf bytes.Buffer
		entries, size, err := m.ExportTar("iso_1", &buf)
		if err != nil {
			t.Fatal(err)
		}
		// src, deep, deep/er; three files; one link.
		if entries != 7 || size != int64(len("hello\n")+len("#!/bin/sh\necho run\n")+len("{}")) {
			t.Fatalf("exported %d entries of %d bytes", entries, size)
		}
		archive := filepath.Join(t.TempDir(), "upgrade.tar")
		if err := os.WriteFile(archive, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(t.TempDir(), "home", "user", "workspace")
		if err := guest.ExtractTar(archive, target, os.Getuid(), os.Getgid()); err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(filepath.Join(target, "src", "a.txt")); string(got) != "hello\n" {
			t.Fatalf("src/a.txt is %q", got)
		}
		if got, _ := os.ReadFile(filepath.Join(target, "deep", "er", "x.json")); string(got) != "{}" {
			t.Fatalf("deep/er/x.json is %q", got)
		}
		if info, err := os.Stat(filepath.Join(target, "run.sh")); err != nil || info.Mode().Perm() != 0o755 {
			t.Fatalf("run.sh: %v %v", info, err)
		}
		if info, _ := os.Stat(filepath.Join(target, "src", "a.txt")); info.Mode().Perm() != 0o644 {
			t.Fatalf("src/a.txt's mode is %v", info.Mode())
		}
		if link, err := os.Readlink(filepath.Join(target, "link")); err != nil || link != "src/a.txt" {
			t.Fatalf("link: %q %v", link, err)
		}
		if _, err := os.Lstat(filepath.Join(filepath.Dir(target), "escape")); !os.IsNotExist(err) {
			t.Fatalf("an entry outside the workspace was exported: %v", err)
		}
	}
}

// A blob that is gone fails the export: an upgrade never makes a microVM with a file missing.
func TestExportTarFailsOnAMissingBlob(t *testing.T) {
	m, _ := upgradeManager(t, proto.StateRunning, map[string]string{"a.txt": "a"}, nil, nil)
	if err := os.RemoveAll(filepath.Join(m.cfg.Root, "accounts")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.ExportTar("iso_1", io.Discard); err == nil {
		t.Fatal("an export with a missing blob succeeded")
	}
}

// Dispose lets the isolate go, but says nothing (the sandbox lives on as a microVM) and leaves its snapshots, automatic
// ones too: Kantel keeps listing them as the sandbox's, an isolate's, and a sandbox is made from one, read or saved as
// before; they go when they expire or when the sandbox is deleted.
func TestDisposeRemovesTheIsolateButKeepsItsSnapshots(t *testing.T) {
	m, events := upgradeManager(t, proto.StateRunning, map[string]string{"a.txt": "a"}, nil, nil)
	// An automatic snapshot taken as it stops, as before an upgrade of a stopped isolate.
	if _, err := m.Stop(context.Background(), proto.StopParams{SandboxID: "iso_1", SnapshotID: "snap_stop"}); err != nil {
		t.Fatal(err)
	}
	*events = nil
	if err := m.Dispose("iso_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get("iso_1"); err == nil {
		t.Fatal("the isolate is still there")
	}
	if _, err := os.Stat(filepath.Join(m.cfg.Root, "sandboxes", "iso_1")); !os.IsNotExist(err) {
		t.Fatalf("its directory is still there: %v", err)
	}
	if len(*events) != 0 {
		t.Fatalf("it sent %v", *events)
	}
	for _, id := range []string{"snap_auto", "snap_stop"} {
		if !m.HasSnapshot(id) {
			t.Fatalf("its automatic snapshot %s is gone", id)
		}
	}
	// The one it stopped with is whole: listed, read, made a sandbox from (its manifest, as a create reads it), saved.
	if list, err := m.SnapshotFiles("snap_stop", "/workspace"); err != nil || len(list) != 1 || list[0].Name != "a.txt" {
		t.Fatalf("its files: %v %v", list, err)
	}
	if data, err := m.SnapshotRead("snap_stop", "/workspace/a.txt"); err != nil || string(data) != "a" {
		t.Fatalf("read %q %v", data, err)
	}
	if man, err := m.snapshotManifest("snap_stop", "acct"); err != nil || man["a.txt"].Kind != "file" {
		t.Fatalf("its manifest for a create: %v %v", man, err)
	}
	if _, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_kept", From: "snap_stop"}); err != nil {
		t.Fatalf("saving it: %v", err)
	}
	// Deleting one is still Kantel's to do (its expiry, or the sandbox's delete).
	if err := m.DeleteSnapshot("snap_stop"); err != nil || m.HasSnapshot("snap_stop") {
		t.Fatalf("deleting it: %v", err)
	}
}

// A delete, unlike Dispose, removes the sandbox's automatic snapshots with it, and keeps its saved ones.
func TestDeleteRemovesTheAutomaticSnapshots(t *testing.T) {
	m, events := upgradeManager(t, proto.StateRunning, map[string]string{"a.txt": "a"}, nil, nil)
	if _, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: "iso_1", SnapshotID: "snap_saved"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(context.Background(), "iso_1"); err != nil {
		t.Fatal(err)
	}
	if m.HasSnapshot("snap_auto") {
		t.Fatal("its automatic snapshot is still there")
	}
	if !m.HasSnapshot("snap_saved") {
		t.Fatal("its saved snapshot is gone")
	}
	if n := len(*events); n == 0 || (*events)[n-1].State != proto.StateDeleted {
		t.Fatalf("it sent %v", *events)
	}
}

// An isolate's links to absolute paths in its /workspace go into the microVM as links relative to where they are,
// which the guest's extractor takes (it refuses an absolute link) and which point at the same files there, whether
// reached through /workspace or /home/user/workspace. A link out of the workspace is still refused.
func TestExportTarMakesWorkspaceLinksRelative(t *testing.T) {
	links := map[string]string{
		"abs":           "/workspace/src/a.txt",
		"src/up":        "/workspace/top.txt",
		"src/deep/root": "/workspace",
		"src/dir":       "/workspace/src/deep/",
		"dotdot":        "/workspace/src/../top.txt",
		"missing":       "/workspace/nope.txt",
		"double":        "/workspace//src/a.txt",
		"rel":           "src/a.txt",
		// Through a link, then up: out of the workspace as text, in it where the isolate resolves it.
		"jump":        "/workspace/src/deep",
		"to-file":     "/workspace/jump/../../top.txt",
		"rel-through": "jump/../../top.txt",
		"src/via":     "../jump/../x",
	}
	m, _ := upgradeManager(t, proto.StateRunning, map[string]string{"src/a.txt": "a\n", "top.txt": "top\n", "src/deep/x": "x", "src/x": "sx"}, nil, links)
	var buf bytes.Buffer
	if _, _, err := m.ExportTar("iso_1", &buf); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(t.TempDir(), "upgrade.tar")
	if err := os.WriteFile(archive, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "home", "user", "workspace")
	if err := guest.ExtractTar(archive, target, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"abs":           "src/a.txt",
		"src/up":        "../top.txt",
		"src/deep/root": "../..",
		"src/dir":       "../src/deep/",
		"dotdot":        "src/../top.txt",
		"missing":       "nope.txt",
		"double":        "src/a.txt",
		"rel":           "src/a.txt",
		"jump":          "src/deep",
		"to-file":       "top.txt",
		"rel-through":   "top.txt",
		"src/via":       "../jump/../x",
	}
	for name, link := range want {
		if got, err := os.Readlink(filepath.Join(target, name)); err != nil || got != link {
			t.Errorf("%s -> %q (%v), want %q", name, got, err, link)
		}
	}
	read := func(p string) string {
		data, _ := os.ReadFile(filepath.Join(target, p))
		return string(data)
	}
	for p, content := range map[string]string{"abs": "a\n", "src/up": "top\n", "src/deep/root/top.txt": "top\n", "src/dir/x": "x", "dotdot": "top\n", "double": "a\n", "to-file": "top\n", "rel-through": "top\n", "src/via": "sx", "jump/x": "x"} {
		if got := read(p); got != content {
			t.Errorf("%s reads %q, want %q", p, got, content)
		}
	}
	// A link that pointed nowhere still does, at the same name.
	if _, err := os.Stat(filepath.Join(target, "missing")); !os.IsNotExist(err) {
		t.Errorf("missing resolves: %v", err)
	}

	// One out of the workspace, absolute or climbing through it, is left as it was, and the extractor refuses it.
	// So is one the isolate can't resolve, through a missing directory or a file, though it would land on a file there
	// as text; and one too long to resolve.
	for _, out := range []string{
		"/etc/passwd", "/workspace/../etc/passwd", "/workspaces/x", "jump/../../../etc/passwd", "/workspace/jump/../../..",
		"jump/../../missing/../top.txt", "jump/../../top.txt/../top.txt",
		"jump/../../top.txt/.", "jump/../../top.txt/./.", "jump/../../top.txt/", "jump/../../missing/.",
		strings.Repeat("./", 100_000) + "../top.txt", strings.Repeat("a/", 3000) + strings.Repeat("../", 3001) + "top.txt",
	} {
		m, _ := upgradeManager(t, proto.StateRunning, map[string]string{"top.txt": "top\n", "src/deep/x": "x"}, nil, map[string]string{"out": out, "jump": "/workspace/src/deep"})
		var buf bytes.Buffer
		if _, _, err := m.ExportTar("iso_1", &buf); err != nil {
			t.Fatal(err)
		}
		archive := filepath.Join(t.TempDir(), "upgrade.tar")
		if err := os.WriteFile(archive, buf.Bytes(), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := guest.ExtractTar(archive, filepath.Join(t.TempDir(), "w"), os.Getuid(), os.Getgid()); err == nil {
			t.Errorf("a link to %s was extracted", out)
		}
	}
}

// A command needs a microVM when it ran a program only a microVM has: the shell's refusal, or a microVM program it
// didn't find. A typo, or another exit code, isn't one.
func TestNeedsMicrovmReadsTheShellsAnswer(t *testing.T) {
	cases := []struct {
		exit   int
		stderr string
		want   string
	}{
		{127, "tar: not available in an isolate, which runs only its shell's own commands. Use a microVM.\n", "tar"},
		{127, "bash: python3: command not available in browser environments. Exclude 'python3'\n", "python3"},
		{127, "bash: git: command not found\n", "git"},
		{127, "bash: line 2: npm: command not found\n", "npm"},
		{127, "bash: gti: command not found\n", ""},
		{1, "bash: git: command not found\n", ""},
		{127, "", ""},
	}
	for _, c := range cases {
		got := needsMicrovm(c.exit, c.stderr)
		switch {
		case c.want == "" && got != nil:
			t.Errorf("%d %q: %+v, want none", c.exit, c.stderr, got)
		case c.want != "" && (got == nil || got.Command != c.want || got.Reason == ""):
			t.Errorf("%d %q: %+v, want %s", c.exit, c.stderr, got, c.want)
		}
	}
}

// Freeze waits for a command or write under way (one holding the exec lock) to end, then refuses every write until
// Thaw, so the files an upgrade copies are one version; a freeze that waits too long fails, and the isolate is as it
// was. It is kept on disk.
func TestFreezeHoldsTheIsolateStillForItsUpgrade(t *testing.T) {
	m, _ := upgradeManager(t, proto.StateRunning, map[string]string{"a.txt": "a"}, nil, nil)
	s := m.sandboxes["iso_1"]
	// A command runs: a freeze that can't wait for it fails.
	s.exec.Lock()
	if err := m.Freeze("iso_1", "upg_1", 50*time.Millisecond); err == nil {
		t.Fatal("froze under a running command")
	}
	if m.FrozenBy("iso_1") != "" {
		t.Fatal("a failed freeze left it frozen")
	}
	// One that ends while the freeze waits: the freeze waits for it.
	frozen := make(chan error, 1)
	go func() { frozen <- m.Freeze("iso_1", "upg_1", 5*time.Second) }()
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-frozen:
		t.Fatalf("froze while the command ran: %v", err)
	default:
	}
	s.exec.Unlock()
	if err := <-frozen; err != nil {
		t.Fatal(err)
	}
	write := func() error {
		return m.WriteFile(context.Background(), proto.FileParams{SandboxID: "iso_1", Path: "/workspace/b.txt"}, []byte("b"))
	}
	if err := write(); err == nil {
		t.Fatal("a write landed in a frozen isolate")
	}
	if _, err := m.Exec(context.Background(), proto.ExecParams{SandboxID: "iso_1", Command: "true"}, nil); err == nil {
		t.Fatal("a command ran in a frozen isolate")
	}
	// Reads go on.
	if data, _, _, err := m.ReadFile(context.Background(), proto.FileParams{SandboxID: "iso_1", Path: "/workspace/a.txt"}); err != nil || string(data) != "a" {
		t.Fatalf("read %q %v", data, err)
	}
	if err := m.Freeze("iso_1", "upg_1", 0); err != nil {
		t.Fatalf("freezing again for the same upgrade: %v", err)
	}
	if err := m.Freeze("iso_1", "upg_2", 0); err == nil {
		t.Fatal("another upgrade froze it too")
	}
	raw, _ := os.ReadFile(filepath.Join(s.dir, "meta.json"))
	if !strings.Contains(string(raw), `"frozen": "upg_1"`) {
		t.Fatalf("meta.json doesn't keep it: %s", raw)
	}
	if err := m.Thaw("iso_1", "upg_2"); err != nil || m.FrozenBy("iso_1") != "upg_1" {
		t.Fatal("another upgrade thawed it")
	}
	if err := m.Thaw("iso_1", "upg_1"); err != nil {
		t.Fatal(err)
	}
	if err := write(); err != nil {
		t.Fatalf("a write after the thaw: %v", err)
	}
}

// While an upgrade holds the isolate still, its reads are answered from the manifest as the first of them read it (an
// upgrade to another host reads each file in its own call, and parsing a manifest of 20,000 entries for each made the
// move quadratic); a thaw lets them read the file again.
func TestAFrozenIsolatesReadsKeepItsManifest(t *testing.T) {
	m, _ := upgradeManager(t, proto.StateRunning, map[string]string{"a.txt": "a"}, nil, nil)
	s := m.sandboxes["iso_1"]
	read := func() (string, error) {
		data, _, _, err := m.ReadFile(context.Background(), proto.FileParams{SandboxID: "iso_1", Path: "/workspace/a.txt"})
		return string(data), err
	}
	manifest := filepath.Join(s.dir, "manifest.json")
	good, _ := os.ReadFile(manifest)
	if err := m.Freeze("iso_1", "upg_1", time.Second); err != nil {
		t.Fatal(err)
	}
	if got, err := read(); err != nil || got != "a" {
		t.Fatalf("read %q %v", got, err)
	}
	// Not read again while it is frozen: a manifest.json nothing can parse doesn't matter.
	if err := os.WriteFile(manifest, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if got, err := read(); err != nil || got != "a" {
			t.Fatalf("a frozen isolate's read: %q %v", got, err)
		}
	}
	if list, err := m.ListFiles(context.Background(), proto.FileParams{SandboxID: "iso_1", Path: "/workspace"}); err != nil || len(list) == 0 {
		t.Fatalf("a frozen isolate's list: %v %v", list, err)
	}
	// Thawed, it reads the file again.
	if err := m.Thaw("iso_1", "upg_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := read(); err == nil {
		t.Fatal("a thawed isolate's read kept the manifest it was frozen with")
	}
	if err := os.WriteFile(manifest, good, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := read(); err != nil || got != "a" {
		t.Fatalf("read %q %v", got, err)
	}
}
