package microvm

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestValidateStickyDisks(t *testing.T) {
	ok := []proto.StickyDisk{{DiskID: "sd_1", Path: "/var/lib/ci", SizeGiB: 200}, {DiskID: "sd_2", Path: "/cache", SizeGiB: 1, Version: "v_1"}}
	if err := validateStickyDisks(ok, []proto.Mount{{Path: "/workspace/skills"}}); err != nil {
		t.Fatal(err)
	}
	disk := func(id, path string, gib int, version string) proto.StickyDisk {
		return proto.StickyDisk{DiskID: id, Path: path, SizeGiB: gib, Version: version}
	}
	for name, disks := range map[string][]proto.StickyDisk{
		"three":          {disk("a", "/a", 1, ""), disk("b", "/b", 1, ""), disk("c", "/c", 1, "")},
		"id with dots":   {disk("..", "/a", 1, "")},
		"id with slash":  {disk("a/b", "/a", 1, "")},
		"bad version":    {disk("a", "/a", 1, "../v")},
		"twice":          {disk("a", "/a", 1, ""), disk("a", "/b", 1, "")},
		"no size":        {disk("a", "/a", 0, "")},
		"too big":        {disk("a", "/a", maxStickyGiB+1, "")},
		"relative":       {disk("a", "cache", 1, "")},
		"root":           {disk("a", "/", 1, "")},
		"proc":           {disk("a", "/proc/x", 1, "")},
		"sys":            {disk("a", "/sys", 1, "")},
		"dev":            {disk("a", "/dev/shm", 1, "")},
		"overlap":        {disk("a", "/a", 1, ""), disk("b", "/a/b", 1, "")},
		"meets a mount":  {disk("a", "/workspace", 1, "")},
		"not clean path": {disk("a", "/a/../b", 1, "")},
	} {
		var pe *proto.Error
		if err := validateStickyDisks(disks, []proto.Mount{{Path: "/workspace/skills"}}); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
			t.Errorf("%s: %v, want invalid", name, err)
		}
	}
}

// Every VM has the sticky drives after its bundle drives, writable; a template made before them isn't current.
func TestStickyDrivesInBootAndFingerprints(t *testing.T) {
	m := &Manager{}
	drives := m.bootConfig(shape{}, "vmlinux", "", "", 3, 2, StickyDrives).Drives
	if len(drives) != 4 || drives[2].ID != "sticky0" || drives[3].Path != "sticky1.ext4" || drives[2].ReadOnly || !drives[1].ReadOnly {
		t.Fatalf("%+v", drives)
	}
	if !strings.Contains(m.templateFingerprint(shape{}), " sticky=2") || !strings.Contains(m.runtimeFingerprint(""), "+sticky=2") {
		t.Fatal("templates made before the sticky drives must be made again")
	}
}

// A sandbox made from a snapshot gets clones of its sticky disks on the same drives, the others empty; one whose file
// the snapshot lacks fails. A boot has the host's sticky drives; a template snapshot's restore as many as it says.
func TestStickyDrivesFromASnapshot(t *testing.T) {
	m := &Manager{}
	sdir, tpl := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(sdir, stickyDriveFile(1)), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	origin := sandboxOrigin{stickyDir: sdir, stickyDisks: []stickyDisk{
		{DiskID: "kept", Path: "/a", Slot: 1, State: proto.StickyMounted},
		{DiskID: "lost", Path: "/b", Slot: 0, State: proto.StickyMounted},
	}}
	s := &sandbox{dir: t.TempDir()}
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.makeStickyDrives(s, origin); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(s.vmDir(), stickyDriveFile(1))); string(raw) != "cache" {
		t.Fatalf("drive 1 holds %q", raw)
	}
	if st, err := os.Stat(filepath.Join(s.vmDir(), stickyDriveFile(0))); err != nil || st.Size() != 0 {
		t.Fatal("drive 0 is empty", err)
	}
	got := stickyStatus(s.meta.StickyDisks)
	if s.meta.StickyDrives != StickyDrives || len(got) != 2 || got[0].State != proto.StickyMounted || got[1].State != proto.StickyFailed {
		t.Fatalf("%d %+v", s.meta.StickyDrives, got)
	}
	// Into another snapshot, and linked from it by a keep.
	next, kept := t.TempDir(), t.TempDir()
	if err := keepSticky(s.vmDir(), next, s.meta.StickyDisks); err != nil {
		t.Fatal(err)
	}
	if err := linkSticky(next, kept, s.meta.StickyDisks); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(kept, stickyDriveFile(1))); string(raw) != "cache" {
		t.Fatalf("the kept snapshot holds %q", raw)
	}
	// A template snapshot made before the sticky drives restores a VM without them.
	_ = os.WriteFile(filepath.Join(tpl, "state"), nil, 0o600)
	old := &sandbox{dir: t.TempDir()}
	_ = os.MkdirAll(old.vmDir(), 0o700)
	if err := m.makeStickyDrives(old, sandboxOrigin{state: filepath.Join(tpl, "state")}); err != nil || old.meta.StickyDrives != 0 {
		t.Fatal(old.meta.StickyDrives, err)
	}
}

// stickyFixture is a running sandbox with no VM: a Firecracker API socket and a guest agent that answer as theirs.
type stickyFixture struct {
	m      *Manager
	s      *sandbox
	mu     sync.Mutex
	drives []string
	calls  []string
	freeze error
	thaw   error
	thawed chan string
}

func newStickyFixture(t *testing.T, id string, m *Manager) *stickyFixture {
	t.Helper()
	f := &stickyFixture{m: m, thawed: make(chan string, 16)}
	f.s = &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", id), meta: meta{ID: id, State: proto.StateRunning, BundleDrives: 1}}
	vm := f.s.vmDir()
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.makeStickyDrives(f.s, sandboxOrigin{}); err != nil {
		t.Fatal(err)
	}
	api, err := net.Listen("unix", filepath.Join(vm, fc.APISocket))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { api.Close() })
	go func() {
		_ = http.Serve(api, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			f.drives = append(f.drives, r.Method+" "+r.URL.Path)
			f.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}))
	}()
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	if f.s.machine, err = fc.Attach(vm, cmd.Process.Pid); err != nil {
		t.Fatal(err)
	}
	f.s.guest = guest.NewClient(fakeGuest(t, f.agent))
	m.sandboxes[id] = f.s
	return f
}

// agent answers the guest agent's sticky calls: a mount succeeds on a sticky drive (after the one bundle drive) of a
// disk's size, a freeze as f.freeze says.
func (f *stickyFixture) agent(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.URL.Path)
	freeze, thaw := f.freeze, f.thaw
	f.mu.Unlock()
	switch r.URL.Path {
	case "/sticky":
		var req struct{ Mounts []guest.StickyMount }
		_ = json.NewDecoder(r.Body).Decode(&req)
		var out []guest.StickyResult
		for _, m := range req.Mounts {
			res := guest.StickyResult{Path: m.Path}
			if m.Drive < 1 || m.Bytes == 0 {
				res.Error = fmt.Sprintf("drive %d of %d bytes", m.Drive, m.Bytes)
			}
			out = append(out, res)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"mounts": out})
	case "/sticky/freeze":
		if freeze != nil {
			w.WriteHeader(500)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": freeze.Error()})
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	case "/sticky/thaw":
		var req struct{ Path string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.thawed <- req.Path
		if thaw != nil {
			w.WriteHeader(500)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": thaw.Error()})
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	default:
		_, _ = io.WriteString(w, `{"ok":true}`)
	}
}

func (f *stickyFixture) took(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == path {
			n++
		}
	}
	return n
}

// fakeGuest serves handler as a guest agent through a Firecracker-style vsock socket.
func fakeGuest(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vsock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	uds := filepath.Join(dir, "v.sock")
	ln, err := net.Listen("unix", uds)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				if _, err := r.ReadString('\n'); err != nil {
					return
				}
				fmt.Fprint(conn, "OK 1\n")
				for {
					req, err := http.ReadRequest(r)
					if err != nil {
						return
					}
					rec := httptest.NewRecorder()
					handler(rec, req)
					// What the handler didn't read, so the next request on the connection starts where it should.
					_, _ = io.Copy(io.Discard, req.Body)
					res := rec.Result()
					res.ContentLength = int64(rec.Body.Len())
					if err := res.Write(conn); err != nil {
						return
					}
				}
			}()
		}
	}()
	return uds
}

// A create's new disk is a fresh ext4, mounted; a commit freezes and thaws it around its clone, and the host keeps the
// disk's two newest versions, which the next sandbox clones from and every capacity report lists. A commit is refused
// for a disk the sandbox hasn't or a sandbox that isn't running, and thaws even when the freeze fails.
func TestStickyAttachCommitAndKeep(t *testing.T) {
	if _, err := exec.LookPath("mkfs.ext4"); err != nil {
		t.Skip("no mkfs.ext4")
	}
	root, err := os.MkdirTemp("", "sticky")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	m := &Manager{cfg: Config{Root: root}, sandboxes: map[string]*sandbox{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()
	if got := m.StickyHoldings(); got == nil || len(got) != 0 {
		t.Fatalf("holdings %v, want []", got)
	}
	if raw, _ := json.Marshal(proto.Capacity{StickyDisks: m.StickyHoldings()}); !strings.Contains(string(raw), `"stickyDisks":[]`) {
		t.Fatalf("a report says it holds none: %s", raw)
	}

	a := newStickyFixture(t, "sbx_a", m)
	m.attachSticky(ctx, a.s, []proto.StickyDisk{{DiskID: "ci", Path: "/var/lib/ci", SizeGiB: 1}})
	m.mountSticky(ctx, a.s)
	st := stickyStatus(a.s.meta.StickyDisks)
	if len(st) != 1 || st[0].State != proto.StickyMounted || st[0].Version != "" {
		t.Fatalf("%+v", st)
	}
	if strings.Join(a.drives, ",") != "PATCH /drives/sticky0" {
		t.Fatalf("drive calls %v", a.drives)
	}
	// Labelled for the guest: the superblock's volume name, at 1024 + 0x78.
	sb := make([]byte, 16)
	if disk, err := os.Open(filepath.Join(a.s.vmDir(), stickyDriveFile(0))); err != nil {
		t.Fatal(err)
	} else if _, err := disk.ReadAt(sb, 1024+0x78); err != nil || strings.TrimRight(string(sb), "\x00") != guest.StickyLabel {
		t.Fatalf("label %q %v", sb, err)
	} else {
		disk.Close()
	}

	// Published in this order: newest is the last published, whatever the names (or a clock tie) say.
	for _, v := range []string{"v3", "v2", "v1"} {
		res, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "ci", Version: v})
		if err != nil || res.Version != v || res.SizeBytes != 1<<30 || res.AllocatedBytes <= 0 {
			t.Fatalf("commit %s: %+v %v", v, res, err)
		}
	}
	if a.took("/sticky/freeze") != 3 || a.took("/sticky/thaw") != 3 {
		t.Fatalf("calls %v", a.calls)
	}
	for _, v := range []string{"v2", "v1"} {
		same := time.UnixMilli(1_800_000_000_000)
		_ = os.Chtimes(m.stickyVersionFile("ci", v), same, same)
	}
	held := m.StickyHoldings()
	if len(held) != 1 || held[0].DiskID != "ci" || len(held[0].Versions) != 2 || held[0].Versions[0].Version != "v1" || held[0].Versions[1].Version != "v2" || held[0].Versions[0].At <= 0 {
		t.Fatalf("holdings %+v", held)
	}
	code := func(err error) string {
		var pe *proto.Error
		if errors.As(err, &pe) {
			return pe.Code
		}
		return fmt.Sprint(err)
	}
	if _, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "ci", Version: "v1"}); code(err) != proto.ErrConflict {
		t.Fatalf("a version the host has: %v", err)
	}
	if _, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "other", Version: "v1"}); code(err) != proto.ErrNotFound {
		t.Fatalf("no such disk: %v", err)
	}
	if _, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "ci", Version: "../x"}); code(err) != proto.ErrInvalid {
		t.Fatalf("a bad version: %v", err)
	}
	a.freeze = errors.New("frozen already")
	thawed := a.took("/sticky/thaw")
	if _, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "ci", Version: "v4"}); err == nil || a.took("/sticky/thaw") != thawed+1 {
		t.Fatalf("a failed freeze is thawed and fails the commit: %v", err)
	}
	if fileExists(m.stickyVersionFile("ci", "v4")) {
		t.Fatal("a failed commit leaves no version")
	}
	// A thaw that fails after a whole clone: published, and said so.
	a.freeze, a.thaw = nil, errors.New("the agent went away")
	if res, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_a", DiskID: "ci", Version: "v0"}); err != nil || !strings.Contains(res.ThawError, "went away") {
		t.Fatalf("%+v %v", res, err)
	}
	a.thaw = nil
	if left, _ := filepath.Glob(filepath.Join(m.stickyRoot(), "ci", ".*.new")); len(left) != 0 {
		t.Fatalf("commits leave their own temporary files behind: %v", left)
	}
	// A host that restarts thaws every sticky disk of the sandboxes it adopts running.
	for len(a.thawed) > 0 {
		<-a.thawed
	}
	m.thawStickyAfterRestart(a.s)
	if path := <-a.thawed; path != "/var/lib/ci" {
		t.Fatalf("thawed %q", path)
	}

	// The next sandbox clones the newest version; one asking for a version the host hasn't gets the newest too.
	b := newStickyFixture(t, "sbx_b", m)
	m.attachSticky(ctx, b.s, []proto.StickyDisk{{DiskID: "ci", Path: "/var/lib/ci", SizeGiB: 1, Version: "gone"}})
	m.mountSticky(ctx, b.s)
	if st := stickyStatus(b.s.meta.StickyDisks); len(st) != 1 || st[0].Version != "v0" || st[0].State != proto.StickyMounted {
		t.Fatalf("%+v", st)
	}
	b.s.meta.State = proto.StateStopped
	if _, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: "sbx_b", DiskID: "ci", Version: "v5"}); code(err) != proto.ErrConflict {
		t.Fatalf("a stopped sandbox: %v", err)
	}

	if err := m.DeleteSticky(proto.StickyDeleteParams{DiskID: "ci", Version: "v1"}); err != nil {
		t.Fatal(err)
	}
	if held := m.StickyHoldings(); len(held) != 1 || len(held[0].Versions) != 1 {
		t.Fatalf("holdings %+v", held)
	}
	if err := m.DeleteSticky(proto.StickyDeleteParams{DiskID: "ci"}); err != nil {
		t.Fatal(err)
	}
	if held := m.StickyHoldings(); len(held) != 0 {
		t.Fatalf("holdings %+v", held)
	}
}

// A sandbox made from a snapshot has its sticky disks: a requested one at a path meeting one of them, or the same disk at
// another path, is refused before anything is made; the same disk at the same path is kept, not attached twice.
func TestValidateEffectiveSticky(t *testing.T) {
	inherited := []stickyDisk{{DiskID: "a", Path: "/cache", Slot: 0}}
	ok := [][]proto.StickyDisk{nil, {{DiskID: "a", Path: "/cache", SizeGiB: 1}}, {{DiskID: "b", Path: "/other", SizeGiB: 1}}}
	for _, req := range ok {
		if err := validateEffectiveSticky(inherited, req, nil); err != nil {
			t.Errorf("%+v: %v", req, err)
		}
	}
	for name, c := range map[string]struct {
		req    []proto.StickyDisk
		mounts []proto.Mount
	}{
		"another disk at its path": {req: []proto.StickyDisk{{DiskID: "b", Path: "/cache", SizeGiB: 1}}},
		"another disk inside it":   {req: []proto.StickyDisk{{DiskID: "b", Path: "/cache/b", SizeGiB: 1}}},
		"it at another path":       {req: []proto.StickyDisk{{DiskID: "a", Path: "/elsewhere", SizeGiB: 1}}},
		"a mount over it":          {mounts: []proto.Mount{{Path: "/cache/skills"}}},
		"one too many":             {req: []proto.StickyDisk{{DiskID: "b", Path: "/b", SizeGiB: 1}, {DiskID: "c", Path: "/c", SizeGiB: 1}}},
	} {
		var pe *proto.Error
		if err := validateEffectiveSticky(inherited, c.req, c.mounts); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
			t.Errorf("%s: %v, want invalid", name, err)
		}
	}
}

// Two commits of one version: the second is refused while the first holds it, and a publish never replaces a version
// the host has. A copy that can't end within the freeze's lease isn't published.
func TestStickyCommitsNeverShareOrReplaceAVersion(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir()}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	release, err := m.reserveStickyVersion("ci", "v1")
	if err != nil {
		t.Fatal(err)
	}
	var pe *proto.Error
	if _, err := m.reserveStickyVersion("ci", "v1"); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("a second commit of the version: %v", err)
	}
	release()
	tmp := filepath.Join(m.stickyRoot(), "ci", ".v1.mine.new")
	_ = os.WriteFile(tmp, []byte("mine"), 0o600)
	_ = os.WriteFile(m.stickyVersionFile("ci", "v1"), []byte("theirs"), 0o600)
	if err := m.publishSticky("ci", "v1", tmp); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("publishing over a version: %v", err)
	}
	if raw, _ := os.ReadFile(m.stickyVersionFile("ci", "v1")); string(raw) != "theirs" {
		t.Fatalf("the version was replaced: %q", raw)
	}
	dst := filepath.Join(t.TempDir(), "late")
	if err := cloneWithin(context.Background(), tmp, dst, time.Now().Add(-time.Second), nil); err == nil || !strings.Contains(err.Error(), "no reflinks") || fileExists(dst) {
		t.Fatalf("a late copy: %v", err)
	}
}

// A recovery thaw waits for the sandbox's lock, which a commit holds from its freeze to its thaw: it can't reach the
// guest inside a commit's frozen copy, whichever starts first. One whose sandbox stopped meanwhile, or runs on another
// guest now, sends nothing.
func TestRecoveryThawWaitsForACommit(t *testing.T) {
	// Short, for the sockets in it.
	root, err := os.MkdirTemp("", "sticky")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	m := &Manager{cfg: Config{Root: root}, sandboxes: map[string]*sandbox{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	f := newStickyFixture(t, "sbx_a", m)
	f.s.meta.StickyDisks = []stickyDisk{{DiskID: "ci", Path: "/var/lib/ci", Slot: 0, State: proto.StickyMounted}}
	// The guest sees whether the sandbox's lock, which CommitSticky holds from its freeze to its thaw, is held as each
	// thaw arrives: held by the recovery itself, no commit can be between its freeze and thaw.
	var unlocked atomic.Int32
	f.s.guest = guest.NewClient(fakeGuest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sticky/thaw" && f.s.mu.TryLock() {
			f.s.mu.Unlock()
			unlocked.Add(1)
		}
		f.agent(w, r)
	}))

	<-m.thawStickyAfterRestart(f.s)
	if f.took("/sticky/thaw") != 1 || <-f.thawed != "/var/lib/ci" {
		t.Fatalf("calls %v", f.calls)
	}
	if unlocked.Load() != 0 {
		t.Fatal("a recovery thaw reached the guest without the sandbox's lock")
	}

	// Stopped, or running on another guest, by the time it has the lock: nothing is sent.
	for name, change := range map[string]func(){
		"stopped":       func() { f.s.meta.State = proto.StateStopped },
		"another guest": func() { f.s.guest = guest.NewClient(fakeGuest(t, f.agent)) },
	} {
		f.s.mu.Lock()
		done := m.thawStickyAfterRestart(f.s)
		change()
		f.s.mu.Unlock()
		<-done
		if n := f.took("/sticky/thaw"); n != 1 {
			t.Fatalf("%s: %d thaws", name, n)
		}
		f.s.meta.State = proto.StateRunning
	}
}
