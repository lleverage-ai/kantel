package isolate

// The native runtime: kantel-isolate on the host itself, one process per account, for a host without KVM. With no VM
// around it, the host keeps accounts' runtimes apart itself:
//
//   - each runtime's directory (RunDir/rt-*, 0700, the runtime's own) holds its sockets: the runtime listens on
//     runtime.sock, and the host serves its blob store and egress proxy on store.sock and egress.sock, so no other
//     process on the host reaches them (on loopback TCP any local process could, and the bridges trust whoever
//     connects). A runtime whose `version` doesn't say it takes unix: addresses gets loopback TCP, with a warning;
//   - as root, each runtime runs as a uid of its own (UIDBase on), so one account's runtime can't open another's
//     directory, and none runs as kantel-host's user;
//   - as root, each runtime has a cgroup of its own under CgroupRoot, with memory.max (the account's memory, as its
//     VM would have) and pids.max.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// DefaultUIDBase is the first native runtime uid: above the ranges distributions and systemd give users,
	// services and containers (systemd's container range ends at 1879048191).
	DefaultUIDBase = 1_900_000_000
	// NativePids is a native runtime's pids.max: its threads (one per isolate, and its pools') with room.
	NativePids = 4096
)

// prepareNative fills the native runtime's defaults, and makes its run directory and cgroup root, clearing what an
// earlier run of the host left (its runtimes end with it, or are ended here).
func prepareNative(cfg *Config) error {
	root := os.Geteuid() == 0
	if cfg.RunDir == "" {
		cfg.RunDir = filepath.Join(cfg.Root, "runtimes")
		if root {
			cfg.RunDir = "/run/kantel-isolate"
		}
	}
	if cfg.UIDBase == 0 {
		cfg.UIDBase = DefaultUIDBase
	}
	if cfg.UIDs == 0 {
		cfg.UIDs = 65536
	}
	if cfg.CgroupRoot == "" && root {
		cfg.CgroupRoot = "/sys/fs/cgroup/kantel-isolate"
	}
	if err := os.MkdirAll(cfg.RunDir, 0o711); err != nil {
		return err
	}
	// Traversable, not listable: a runtime reaches its own directory by name, and finds no other's.
	if err := os.Chmod(cfg.RunDir, 0o711); err != nil {
		return err
	}
	entries, _ := os.ReadDir(cfg.RunDir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "rt-") {
			_ = os.RemoveAll(filepath.Join(cfg.RunDir, e.Name()))
		}
	}
	if cfg.CgroupRoot != "" {
		stale, _ := os.ReadDir(cfg.CgroupRoot)
		for _, e := range stale {
			if e.IsDir() && strings.HasPrefix(e.Name(), "rt-") {
				endCgroup(filepath.Join(cfg.CgroupRoot, e.Name()))
			}
		}
	}
	return nil
}

// isolated says each native runtime runs as a uid of its own (the host runs as root).
func (m *Manager) isolated() bool { return os.Geteuid() == 0 }

// startNative starts kantel-isolate on the host itself (or, on a host updated by its binary alone, workerd).
func (m *Manager) startNative(ctx context.Context, r *runtime) error {
	if m.cfg.Binary == "" && m.cfg.LegacyWorkerd != "" {
		return m.startNativeWorkerd(ctx, r)
	}
	var cred *syscall.Credential
	if m.isolated() {
		uid, err := m.takeUID(r)
		if err != nil {
			return err
		}
		// No supplementary groups: kept, root's group 0 would make root-group files' group bits apply to it.
		cred = &syscall.Credential{Uid: uid, Gid: uid, Groups: []uint32{}}
		if err := m.readableBy(m.cfg.Binary, m.cfg.Assets); err != nil {
			return err
		}
	}
	own := func(p string) error {
		if cred == nil {
			return nil
		}
		return os.Lchown(p, int(cred.Uid), int(cred.Gid))
	}
	if err := own(r.dir); err != nil {
		return err
	}
	tmp := filepath.Join(r.dir, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return err
	}
	if err := own(tmp); err != nil {
		return err
	}
	var listen, storeAt, egressAt, network, address string
	if m.unixSockets() {
		bridge := func(name string) (net.Listener, string, error) {
			p := filepath.Join(r.dir, name)
			l, err := m.listen(r, "unix", p)
			if err != nil {
				return nil, "", err
			}
			if err := os.Chmod(p, 0o600); err != nil {
				return nil, "", err
			}
			return l, "unix:" + p, own(p)
		}
		store, at, err := bridge("store.sock")
		if err != nil {
			return err
		}
		storeAt = at
		go m.serveStore(r, store)
		egressL, at, err := bridge("egress.sock")
		if err != nil {
			return err
		}
		egressAt = at
		go m.serveEgress(r, egressL)
		network, address = "unix", filepath.Join(r.dir, "runtime.sock")
		listen = "unix:" + address
	} else {
		m.noUnix.Do(func() {
			m.log.Warn("kantel-isolate doesn't say it takes unix: addresses: its runtimes' bridges are on loopback TCP, which any process on the host can reach; update it", "binary", m.cfg.Binary)
		})
		store, err := m.listen(r, "tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		egressL, err := m.listen(r, "tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		go m.serveStore(r, store)
		go m.serveEgress(r, egressL)
		storeAt, egressAt = "http://"+store.Addr().String(), "http://"+egressL.Addr().String()
		// A free port for the runtime to listen on: taken and given back, as the runtime binds it itself.
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		network, address = "tcp", l.Addr().String()
		listen = address
		l.Close()
	}
	logFile, err := os.Create(filepath.Join(r.dir, "kantel-isolate.log"))
	if err != nil {
		return err
	}
	argv := nativeArgs(m.cfg.Binary, listen, storeAt, egressAt, m.cfg.Assets)
	// Its own environment, not the host's (no KANTEL_ISOLATE_* setting the host's process happens to have).
	env := []string{"PATH=/usr/bin:/bin", "TMPDIR=" + tmp, "HOME=" + r.dir}
	sys := &syscall.SysProcAttr{Setpgid: true, Credential: cred}
	if fd := m.nativeCgroup(r); fd >= 0 {
		defer syscall.Close(fd)
		sys.UseCgroupFD, sys.CgroupFD = true, fd
	}
	proc, err := os.StartProcess(m.cfg.Binary, argv, &os.ProcAttr{Dir: r.dir, Env: env, Files: []*os.File{nil, logFile, logFile}, Sys: sys})
	logFile.Close()
	if err != nil {
		return err
	}
	r.proc = proc
	done := make(chan struct{})
	go func() { _, _ = proc.Wait(); close(done) }()
	r.done = done
	r.client = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, address)
	}}}
	readyCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := m.ready(readyCtx, r); err != nil {
		if tail := logTail(filepath.Join(r.dir, "kantel-isolate.log")); tail != "" {
			return fmt.Errorf("%w: %s", err, tail)
		}
		return err
	}
	return nil
}

// nativeArgs is kantel-isolate's command line on the host (the contract in apps/host/isolate-runtime: serve, where to
// listen, the host's two bridges and its assets).
func nativeArgs(binary, listen, store, egress, assets string) []string {
	return []string{binary, "serve", "--listen", listen, "--store", store, "--egress", egress, "--assets", assets}
}

// unixSockets says whether kantel-isolate takes unix: addresses for --listen, --store and --egress: its `version`
// says "unixSockets": true. Asked once.
func (m *Manager) unixSockets() bool {
	m.unixOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, m.cfg.Binary, "version")
		cmd.Env = []string{"PATH=/usr/bin:/bin"}
		out, err := cmd.Output()
		m.unixOK = err == nil && versionTakesUnix(out)
	})
	return m.unixOK
}

func versionTakesUnix(out []byte) bool {
	var v struct {
		UnixSockets bool `json:"unixSockets"`
	}
	return json.Unmarshal(out, &v) == nil && v.UnixSockets
}

// takeUID gives the runtime the lowest uid of the range no live runtime has, until it closes.
func (m *Manager) takeUID(r *runtime) (uint32, error) {
	m.uidMu.Lock()
	defer m.uidMu.Unlock()
	if m.uids == nil {
		m.uids = map[uint32]bool{}
	}
	for i := uint32(0); i < m.cfg.UIDs; i++ {
		uid := m.cfg.UIDBase + i
		if m.uids[uid] {
			continue
		}
		m.uids[uid] = true
		r.cleanup = append(r.cleanup, func() {
			m.uidMu.Lock()
			delete(m.uids, uid)
			m.uidMu.Unlock()
		})
		return uid, nil
	}
	return 0, fmt.Errorf("no free isolate runtime uid (%d in use)", m.cfg.UIDs)
}

// readableBy makes the binary and assets reachable by a runtime of another uid: every directory above them
// traversable (o+x, which lists nothing), and them readable (o+r, and o+x on directories and the binary). They are
// kantel-host's install, released files with nothing secret in them.
func (m *Manager) readableBy(binary, assets string) error {
	m.readableOnce.Do(func() {
		for _, p := range []string{binary, assets} {
			for dir := filepath.Dir(p); ; dir = filepath.Dir(dir) {
				if st, err := os.Stat(dir); err == nil && st.Mode().Perm()&0o001 == 0 {
					m.log.Info("isolate runtime: making a directory traversable for the runtimes' uids", "dir", dir)
					_ = os.Chmod(dir, st.Mode().Perm()|0o001)
				}
				if dir == "/" || dir == "." {
					break
				}
			}
		}
		_ = filepath.WalkDir(assets, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if st, err := os.Lstat(p); err == nil && st.Mode()&fs.ModeSymlink == 0 {
				want := st.Mode().Perm() | 0o004
				if d.IsDir() {
					want |= 0o001
				}
				if want != st.Mode().Perm() {
					_ = os.Chmod(p, want)
				}
			}
			return nil
		})
		if st, err := os.Stat(binary); err == nil {
			_ = os.Chmod(binary, st.Mode().Perm()|0o005)
		}
	})
	return nil
}

// nativeCgroup makes the runtime's cgroup (CgroupRoot/<its directory's name>) with memory.max and pids.max, and
// answers it opened for CLONE_INTO_CGROUP, or -1 with none (no CgroupRoot, or cgroup v2 not writable here: logged
// once). Closing the runtime kills what is left in it and removes it.
func (m *Manager) nativeCgroup(r *runtime) int {
	if m.cfg.CgroupRoot == "" {
		return -1
	}
	fail := func(err error) int {
		m.noCgroup.Do(func() {
			m.log.Warn("isolate runtimes run without a cgroup of their own (no memory or pids limit)", "cgroupRoot", m.cfg.CgroupRoot, "error", err)
		})
		return -1
	}
	if err := os.MkdirAll(m.cfg.CgroupRoot, 0o755); err != nil {
		return fail(err)
	}
	for _, dir := range []string{filepath.Dir(m.cfg.CgroupRoot), m.cfg.CgroupRoot} {
		if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte("+memory +pids"), 0o644); err != nil {
			return fail(err)
		}
	}
	dir := filepath.Join(m.cfg.CgroupRoot, filepath.Base(r.dir))
	if err := os.Mkdir(dir, 0o755); err != nil {
		return fail(err)
	}
	r.cleanup = append(r.cleanup, func() { endCgroup(dir) })
	limits := map[string]string{"memory.max": strconv.Itoa(m.cfg.MemoryMiB << 20), "pids.max": strconv.Itoa(NativePids)}
	for file, value := range limits {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(value), 0o644); err != nil {
			return fail(err)
		}
	}
	// Not into swap, where the VM it stands in for has none.
	_ = os.WriteFile(filepath.Join(dir, "memory.swap.max"), []byte("0"), 0o644)
	fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	return fd
}

// endCgroup kills what is left in a runtime's cgroup and removes it.
func endCgroup(dir string) {
	_ = os.WriteFile(filepath.Join(dir, "cgroup.kill"), []byte("1"), 0o644)
	for range 100 {
		if err := os.Remove(dir); err == nil || errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// logTail is the end of a runtime's log, for the error when it never came up.
func logTail(p string) string {
	raw, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	if len(raw) > 2000 {
		raw = raw[len(raw)-2000:]
	}
	return strings.TrimSpace(string(raw))
}

// startNativeWorkerd runs workerd and its isolate worker, the native runtime from before kantel-isolate, for a host
// updated by its binary alone: as such a host always did, as kantel-host's user, on loopback TCP.
func (m *Manager) startNativeWorkerd(ctx context.Context, r *runtime) error {
	store, err := m.listen(r, "tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	egressL, err := m.listen(r, "tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	worker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	workerAddr := worker.Addr().String()
	worker.Close()
	go m.serveStore(r, store)
	go m.serveEgress(r, egressL)
	config, err := os.ReadFile(filepath.Join(m.cfg.LegacyBundle, "config.capnp"))
	if err != nil {
		return err
	}
	text := strings.NewReplacer(
		"127.0.0.1:7001", store.Addr().String(),
		"127.0.0.1:7002", egressL.Addr().String(),
		"127.0.0.1:8080", workerAddr,
		`embed "dist/`, `embed "`+filepath.Join(m.cfg.LegacyBundle, "dist")+"/",
	).Replace(string(config))
	if err := os.WriteFile(filepath.Join(r.dir, "config.capnp"), []byte(text), 0o600); err != nil {
		return err
	}
	logFile, err := os.Create(filepath.Join(r.dir, "workerd.log"))
	if err != nil {
		return err
	}
	proc, err := os.StartProcess(m.cfg.LegacyWorkerd, []string{m.cfg.LegacyWorkerd, "serve", "config.capnp", "--experimental"}, &os.ProcAttr{Dir: r.dir, Files: []*os.File{nil, logFile, logFile}})
	logFile.Close()
	if err != nil {
		return err
	}
	r.proc = proc
	done := make(chan struct{})
	go func() { _, _ = proc.Wait(); close(done) }()
	r.done = done
	r.client = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", workerAddr)
	}}}
	readyCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err = m.ready(readyCtx, r)
	return err
}
