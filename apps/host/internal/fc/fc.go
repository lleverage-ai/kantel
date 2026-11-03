// Package fc runs Firecracker microVMs through Firecracker's REST API on its Unix socket.
//
// We call the API directly rather than through firecracker-go-sdk: the SDK's last release (v1.0.0, 2022) predates the
// snapshot API this host relies on (`mem_backend`, `network_overrides`, `vsock_override`, `clock_realtime`).
//
// Every VM runs with its own directory as the working directory, and its drives and vsock socket are given by
// relative paths (rootfs.ext4, disk.ext4, v.sock). A snapshot records those relative paths, so any number of clones
// restore from one snapshot side by side, each finding its own files in its own directory.
package fc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Files in a VM's directory.
const (
	APISocket   = "api.sock"
	VsockSocket = "v.sock"
	RootfsFile  = "rootfs.ext4"
	DiskFile    = "disk.ext4"
	LogFile     = "firecracker.log"
)

// Machine is one Firecracker process.
type Machine struct {
	Dir  string
	pid  int
	http *http.Client
	done chan struct{}
	err  error
}

func apiClient(dir string) *http.Client {
	socket := filepath.Join(dir, APISocket)
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns: 2,
	}}
}

// Attach takes over a Firecracker process a previous run of the host started (it is no longer our child, so its
// exit is noticed by polling).
func Attach(dir string, pid int) (*Machine, error) {
	if syscall.Kill(pid, 0) != nil {
		return nil, fmt.Errorf("firecracker %d is gone", pid)
	}
	if _, err := os.Stat(filepath.Join(dir, APISocket)); err != nil {
		return nil, err
	}
	m := &Machine{Dir: dir, pid: pid, http: apiClient(dir), done: make(chan struct{})}
	go func() {
		for syscall.Kill(pid, 0) == nil {
			time.Sleep(time.Second)
		}
		close(m.done)
	}()
	return m, nil
}

// Moved is m after its directory was renamed to dir: the process's working directory follows the rename, but the
// API socket's path changed.
func Moved(m *Machine, dir string) *Machine {
	m.Dir = dir
	m.http = apiClient(dir)
	return m
}

// Launch starts Firecracker in dir, with no VM configured yet.
func Launch(ctx context.Context, binary, dir string) (*Machine, error) {
	_ = os.Remove(filepath.Join(dir, APISocket))
	_ = os.Remove(filepath.Join(dir, VsockSocket))
	logFile, err := os.OpenFile(filepath.Join(dir, LogFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(binary, "--api-sock", APISocket, "--level", "Warning")
	cmd.Dir = dir
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// Its own process group, so stopping the host (or a restart for an update) doesn't take the VMs with it: the next
	// run adopts them (Attach).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, err
	}
	m := &Machine{Dir: dir, pid: cmd.Process.Pid, http: apiClient(dir), done: make(chan struct{})}
	_ = os.WriteFile(filepath.Join(dir, PidFile), []byte(fmt.Sprint(cmd.Process.Pid)), 0o600)
	go func() {
		m.err = cmd.Wait()
		logFile.Close()
		close(m.done)
	}()
	socket := filepath.Join(dir, APISocket)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if conn, err := net.Dial("unix", socket); err == nil {
			conn.Close()
			break
		}
		select {
		case <-m.done:
			return nil, fmt.Errorf("firecracker exited at start: %v (%s)", m.err, m.tailLog())
		case <-ctx.Done():
			m.Kill()
			return nil, ctx.Err()
		default:
		}
		if time.Now().After(deadline) {
			m.Kill()
			return nil, errors.New("firecracker's API socket never appeared")
		}
		time.Sleep(2 * time.Millisecond)
	}
	return m, nil
}

func (m *Machine) tailLog() string {
	raw, _ := os.ReadFile(filepath.Join(m.Dir, LogFile))
	if len(raw) > 2000 {
		raw = raw[len(raw)-2000:]
	}
	return strings.TrimSpace(string(raw))
}

// Pid is the Firecracker process's.
func (m *Machine) Pid() int { return m.pid }

// Done is closed when the process exits.
func (m *Machine) Done() <-chan struct{} { return m.done }

func (m *Machine) call(ctx context.Context, method, path string, body any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://firecracker"+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := m.http.Do(req)
	if err != nil {
		return fmt.Errorf("firecracker %s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(res.Body)
		return fmt.Errorf("firecracker %s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(raw)))
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return nil
}

// BootConfig is a cold boot's VM.
type BootConfig struct {
	VCPUs     int
	MemoryMiB int
	Kernel    string
	BootArgs  string
	// TapDevice is the host TAP for eth0; MAC its guest address.
	TapDevice string
	MAC       string
	// GuestCID is the vsock context ID (3 or more).
	GuestCID uint32
}

// Boot configures the VM (rootfs.ext4 read-only, disk.ext4 writable, eth0, vsock) and starts it.
func (m *Machine) Boot(ctx context.Context, cfg BootConfig) error {
	steps := []struct {
		path string
		body any
	}{
		{"/machine-config", map[string]any{"vcpu_count": cfg.VCPUs, "mem_size_mib": cfg.MemoryMiB, "smt": false}},
		{"/boot-source", map[string]any{"kernel_image_path": cfg.Kernel, "boot_args": cfg.BootArgs}},
		{"/drives/rootfs", map[string]any{"drive_id": "rootfs", "path_on_host": RootfsFile, "is_root_device": true, "is_read_only": true}},
		{"/drives/disk", map[string]any{"drive_id": "disk", "path_on_host": DiskFile, "is_root_device": false, "is_read_only": false}},
		{"/network-interfaces/eth0", map[string]any{"iface_id": "eth0", "host_dev_name": cfg.TapDevice, "guest_mac": cfg.MAC}},
		{"/vsock", map[string]any{"guest_cid": cfg.GuestCID, "uds_path": VsockSocket}},
		{"/entropy", map[string]any{}},
	}
	for _, step := range steps {
		if step.path == "/network-interfaces/eth0" && cfg.TapDevice == "" {
			// No network device (the isolate tier's VM talks to the host over vsock only).
			continue
		}
		if err := m.call(ctx, http.MethodPut, step.path, step.body); err != nil {
			return err
		}
	}
	return m.call(ctx, http.MethodPut, "/actions", map[string]string{"action_type": "InstanceStart"})
}

// Pause and Resume stop and restart the vCPUs.
func (m *Machine) Pause(ctx context.Context) error {
	return m.call(ctx, http.MethodPatch, "/vm", map[string]string{"state": "Paused"})
}

func (m *Machine) Resume(ctx context.Context) error {
	return m.call(ctx, http.MethodPatch, "/vm", map[string]string{"state": "Resumed"})
}

// Snapshot writes a full snapshot of a paused VM: its state and its memory. The disk is the caller's to copy.
func (m *Machine) Snapshot(ctx context.Context, statePath, memPath string) error {
	return m.call(ctx, http.MethodPut, "/snapshot/create", map[string]any{
		"snapshot_type": "Full",
		"snapshot_path": statePath,
		"mem_file_path": memPath,
	})
}

// Load restores a snapshot into this (fresh) process and resumes it. tap replaces the snapshot's eth0 device.
func (m *Machine) Load(ctx context.Context, statePath, memPath, tap string) error {
	body := map[string]any{
		"snapshot_path":     statePath,
		"mem_backend":       map[string]string{"backend_type": "File", "backend_path": memPath},
		"resume_vm":         true,
		"clock_realtime":    true,
		"vsock_override":    map[string]string{"uds_path": VsockSocket},
		"track_dirty_pages": false,
	}
	if tap != "" {
		body["network_overrides"] = []map[string]string{{"iface_id": "eth0", "host_dev_name": tap}}
	}
	return m.call(ctx, http.MethodPut, "/snapshot/load", body)
}

// Kill ends the process and waits for it.
func (m *Machine) Kill() {
	_ = syscall.Kill(m.pid, syscall.SIGKILL)
	select {
	case <-m.done:
	case <-time.After(5 * time.Second):
	}
}

// Shutdown asks the guest to stop (Ctrl-Alt-Del), then kills the process after the grace period.
func (m *Machine) Shutdown(ctx context.Context, grace time.Duration) {
	_ = m.call(ctx, http.MethodPut, "/actions", map[string]string{"action_type": "SendCtrlAltDel"})
	select {
	case <-m.done:
	case <-time.After(grace):
		m.Kill()
	}
}

// PidFile is where Launch notes the process, so a VM left behind by a crashed daemon can be found.
const PidFile = "firecracker.pid"

// KillLeftover ends the Firecracker process a crashed daemon left running in dir, if there is one.
func KillLeftover(dir string) {
	raw, err := os.ReadFile(filepath.Join(dir, PidFile))
	if err != nil {
		return
	}
	var pid int
	if _, err := fmt.Sscan(strings.TrimSpace(string(raw)), &pid); err != nil || pid <= 1 {
		return
	}
	// Only if that PID is still a process working in dir (PIDs are reused).
	cwd, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	if err != nil || strings.TrimSuffix(cwd, " (deleted)") != dir {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

// Fingerprint identifies the files a snapshot was made with (Firecracker, the kernel, the root filesystem): a
// snapshot only restores onto the same ones, so a template whose fingerprint differs is rebuilt.
func Fingerprint(paths ...string) string {
	var b strings.Builder
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			fmt.Fprintf(&b, "%s:missing;", p)
			continue
		}
		var ino uint64
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			ino = st.Ino
		}
		fmt.Fprintf(&b, "%s:%d:%d:%d;", p, info.Size(), info.ModTime().UnixNano(), ino)
	}
	return b.String()
}
