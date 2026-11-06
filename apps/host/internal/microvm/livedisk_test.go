package microvm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeVMAPI is a Firecracker API for one VM: it records the states PATCH /vm asks for. dropPause applies a pause but
// closes the connection without an answer (a lost reply); failResume refuses every resume.
type fakeVMAPI struct {
	mu         sync.Mutex
	asked      []string
	barriers   int
	paused     bool
	dropPause  bool
	failResume bool
}

func (f *fakeVMAPI) serve(t *testing.T, dir string) {
	t.Helper()
	ln, err := net.Listen("unix", filepath.Join(dir, fc.APISocket))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/machine-config" {
			// The barrier: a round trip through the VMM thread.
			f.mu.Lock()
			f.barriers++
			f.mu.Unlock()
			_, _ = io.WriteString(w, `{"vcpu_count":2,"mem_size_mib":2048}`)
			return
		}
		var body struct {
			State string `json:"state"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.asked = append(f.asked, body.State)
		switch body.State {
		case "Paused":
			f.paused = true
			if f.dropPause {
				f.mu.Unlock()
				conn, _, _ := w.(http.Hijacker).Hijack()
				conn.Close()
				return
			}
		case "Resumed":
			if f.failResume {
				f.mu.Unlock()
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"fault_message":"no"}`)
				return
			}
			f.paused = false
		}
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { srv.Close() })
}

func (f *fakeVMAPI) state() (asked []string, paused bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.asked...), f.paused
}

// liveDiskSetup is a running sandbox for liveDiskSnapshot: a disk, a stand-in Firecracker (a sleep process with api)
// and a guest agent answering /sync with syncStatus.
func liveDiskSetup(t *testing.T, api *fakeVMAPI, syncStatus int) (*Manager, *sandbox) {
	t.Helper()
	// Short: a Unix socket's path is at most 108 bytes.
	root, err := os.MkdirTemp("", "ld")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	m := &Manager{cfg: Config{Root: root}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := os.MkdirAll(filepath.Join(root, "snapshots"), 0o700); err != nil {
		t.Fatal(err)
	}
	s := &sandbox{dir: filepath.Join(root, "s"), meta: meta{ID: "sbx_live", State: proto.StateRunning, Size: "default"}}
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.vmDir(), fc.DiskFile), bytes.Repeat([]byte("d"), 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	api.serve(t, s.vmDir())
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	machine, err := fc.Attach(s.vmDir(), cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	s.machine = machine
	s.guest = guest.NewClient(handlerAgent(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(syncStatus)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})))
	t.Cleanup(s.guest.Close)
	return m, s
}

func noSnapshotDir(t *testing.T, m *Manager, id string) {
	t.Helper()
	if _, err := os.Stat(m.snapshotDir(id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a failed save left its directory: %v", err)
	}
}

func TestLiveDiskSnapshot(t *testing.T) {
	api := &fakeVMAPI{}
	m, s := liveDiskSetup(t, api, http.StatusOK)
	snap := proto.SnapshotInfo{ID: "snap_ok", SandboxID: s.meta.ID, Kind: "saved", Memory: true}
	if err := m.liveDiskSnapshot(context.Background(), s, &snap, nil); err != nil {
		t.Fatal(err)
	}
	if asked, paused := api.state(); paused || strings.Join(asked, ",") != "Paused,Resumed" {
		t.Fatalf("the VM was asked %v (paused now: %v)", asked, paused)
	}
	if snap.Memory {
		t.Fatal("a disk-only snapshot says it holds memory")
	}
	api.mu.Lock()
	barriers := api.barriers
	api.mu.Unlock()
	if barriers != 1 {
		t.Fatalf("the copy was checked after %d barriers, want 1", barriers)
	}
	if got, _ := os.ReadFile(filepath.Join(m.snapshotDir(snap.ID), fc.DiskFile)); len(got) != 1<<16 {
		t.Fatalf("the snapshot's disk is %d bytes", len(got))
	}
}

// With no memory kept, a guest that couldn't write its page cache back would lose it silently: the save fails, and the
// VM is never paused.
func TestLiveDiskSnapshotFailsWhenTheGuestCantSync(t *testing.T) {
	api := &fakeVMAPI{}
	m, s := liveDiskSetup(t, api, http.StatusInternalServerError)
	snap := proto.SnapshotInfo{ID: "snap_nosync", SandboxID: s.meta.ID, Kind: "saved"}
	if err := m.liveDiskSnapshot(context.Background(), s, &snap, nil); err == nil {
		t.Fatal("a save whose guest couldn't sync worked")
	}
	if asked, _ := api.state(); len(asked) != 0 {
		t.Fatalf("the VM was asked %v", asked)
	}
	noSnapshotDir(t, m, snap.ID)
}

// A pause whose answer is lost may still have applied: the VM is resumed, and the save fails.
func TestLiveDiskSnapshotResumesAPauseWhoseAnswerWasLost(t *testing.T) {
	api := &fakeVMAPI{dropPause: true}
	m, s := liveDiskSetup(t, api, http.StatusOK)
	snap := proto.SnapshotInfo{ID: "snap_dropped", SandboxID: s.meta.ID, Kind: "saved"}
	if err := m.liveDiskSnapshot(context.Background(), s, &snap, nil); err == nil {
		t.Fatal("a save whose pause wasn't answered worked")
	}
	if asked, paused := api.state(); paused || strings.Join(asked, ",") != "Paused,Resumed" {
		t.Fatalf("the VM was asked %v and is paused: %v", asked, paused)
	}
	noSnapshotDir(t, m, snap.ID)
}

// A VM that won't resume isn't left frozen while reported running: it is stopped, and the save fails.
func TestLiveDiskSnapshotStopsAVMThatWontResume(t *testing.T) {
	api := &fakeVMAPI{failResume: true}
	m, s := liveDiskSetup(t, api, http.StatusOK)
	snap := proto.SnapshotInfo{ID: "snap_frozen", SandboxID: s.meta.ID, Kind: "saved"}
	err := m.liveDiskSnapshot(context.Background(), s, &snap, nil)
	if err == nil || !strings.Contains(err.Error(), "couldn't be resumed") {
		t.Fatalf("a save whose VM wouldn't resume answered %v", err)
	}
	if asked, _ := api.state(); strings.Count(strings.Join(asked, ","), "Resumed") != resumeTries {
		t.Fatalf("the VM was asked %v", asked)
	}
	select {
	case <-s.machine.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the VM that wouldn't resume is still there")
	}
	noSnapshotDir(t, m, snap.ID)
}

// A disk that can't be watched can't be shown quiet by its stamps alone: on a file system without reflinks its copy
// fails rather than risk a torn one, writes landing or not.
func TestCopyQuietDiskFailsClosedWithoutAWatch(t *testing.T) {
	dir := t.TempDir()
	if tryReflink(t, dir) {
		t.Skip("this file system has reflinks, which make a copy at one instant without a watch")
	}
	watchDisk = func(string) (*writeWatch, error) { return nil, errors.New("too many inotify instances") }
	t.Cleanup(func() { watchDisk = watchWrites })
	disk, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "snap.ext4")
	if err := os.WriteFile(disk, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(disk, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = f.WriteAt([]byte{byte(i)}, int64(i%(1<<20)))
		}
	}()
	err = copyQuietDisk(disk, dst, diskCopies, noBarrier)
	close(stop)
	<-done
	if err == nil {
		t.Fatal("a disk that couldn't be watched was copied")
	}
	if _, err := os.Stat(dst); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused copy left a file: %v", err)
	}
}

// Saving a stopped sandbox keeps what its stop kept: memory only matters to a running one's save, so a stop that kept
// memory is saved with it whether memory is asked for or not, and one that didn't is saved without.
func TestSaveSnapshotOfAStoppedSandboxKeepsWhatItsStopKept(t *testing.T) {
	for _, stopKept := range []bool{true, false} {
		for _, asked := range []bool{false, true} {
			root := t.TempDir()
			m := &Manager{cfg: Config{Root: root}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
			s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_stopped"), meta: meta{ID: "sbx_stopped", State: proto.StateStopped, Size: "default", Memory: stopKept}}
			if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
				t.Fatal(err)
			}
			files := []string{fc.DiskFile}
			if stopKept {
				files = append(files, "state", "mem")
			}
			for _, name := range files {
				if err := os.WriteFile(filepath.Join(s.vmDir(), name), []byte(name), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			m.sandboxes[s.meta.ID] = s
			snap, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: s.meta.ID, SnapshotID: "snap_saved", Name: "saved", Memory: asked})
			if err != nil {
				t.Fatal(err)
			}
			if snap.Memory != stopKept {
				t.Fatalf("stop kept memory %v, memory asked %v: the save has memory %v", stopKept, asked, snap.Memory)
			}
			_, memErr := os.Stat(filepath.Join(m.snapshotDir(snap.ID), "mem"))
			if (memErr == nil) != stopKept {
				t.Fatalf("stop kept memory %v, memory asked %v: the save's memory file: %v", stopKept, asked, memErr)
			}
		}
	}
}

// tryReflink says whether dir's file system can reflink.
func tryReflink(t *testing.T, dir string) bool {
	t.Helper()
	src, dst := filepath.Join(dir, "probe"), filepath.Join(dir, "probe.clone")
	if err := os.WriteFile(src, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(src)
	defer os.Remove(dst)
	return exec.Command("cp", "--reflink=always", src, dst).Run() == nil
}

// The room a live save reserves is measured once the VM is paused, its disk still: a disk the guest's sync grew past the
// room just before the pause is refused there, the VM resumed, nothing copied and nothing left reserved.
func TestLiveDiskSnapshotMeasuresItsRoomOncePaused(t *testing.T) {
	api := &fakeVMAPI{}
	m, s := liveDiskSetup(t, api, http.StatusOK)
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	size := diskUsage(disk)
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(int64(snapshotHeadroom)+size+(1<<20))
		return nil
	}
	s.guest.Close()
	s.guest = guest.NewClient(handlerAgent(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync" {
			http.NotFound(w, r)
			return
		}
		// The page cache written back: the disk grows by 4 MiB.
		if err := os.WriteFile(disk, make([]byte, 4<<20), 0o600); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	})))
	t.Cleanup(s.guest.Close)
	// The early check, before the sync, passes.
	early, err := m.roomToSave(s, false)
	if err != nil {
		t.Fatalf("the early check: %v", err)
	}
	early()
	snap := proto.SnapshotInfo{ID: "snap_grown", SandboxID: s.meta.ID, Kind: "saved"}
	err = m.liveDiskSnapshot(context.Background(), s, &snap, func() (func(), error) {
		// Measured once the VM is paused and its writes settled (a barrier).
		api.mu.Lock()
		barriers := api.barriers
		api.mu.Unlock()
		if asked, paused := api.state(); !paused || barriers != 1 || strings.Join(asked, ",") != "Paused" {
			t.Errorf("the room was measured with the VM asked %v (paused: %v) after %d barriers", asked, paused, barriers)
		}
		return m.roomToSave(s, false)
	})
	var refused *proto.Error
	if !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("a disk grown past the room by its sync: %v, want a capacity error", err)
	}
	if asked, paused := api.state(); paused || strings.Join(asked, ",") != "Paused,Resumed" {
		t.Fatalf("the VM was asked %v (paused now: %v)", asked, paused)
	}
	noSnapshotDir(t, m, snap.ID)
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved", m.snapshotReserved)
	}
}
