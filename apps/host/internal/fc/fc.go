// Package fc runs Firecracker microVMs through Firecracker's REST API on its Unix socket.
//
// We call the API directly rather than through firecracker-go-sdk: the SDK's last release (v1.0.0, 2022) predates the
// snapshot API this host relies on (`mem_backend`, `network_overrides`, `vsock_override`).
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
	// Initrd is an initramfs to boot through (Kantel's, which injects the guest agent); empty boots the image's own init.
	Initrd string
	// TapDevice is the host TAP for eth0; MAC its guest address.
	TapDevice string
	MAC       string
	// GuestCID is the vsock context ID (3 or more).
	GuestCID uint32
	// HotplugMiB, when set, adds a virtio-mem device with that much hotpluggable memory, all of it unplugged at boot
	// (a multiple of HotplugSlotMiB). PlugMemory plugs it later, on this VM or on one restored from its snapshot.
	HotplugMiB int
	// BalloonStatsSeconds, above 0, adds a virtio-balloon device that only reports: no memory taken (a target of 0
	// MiB, deflate_on_oom in case one is ever set), its guest driver's memory statistics refreshed this often, for
	// ReadBalloonStats. A snapshot keeps the device, so every VM restored from one made with it reports too.
	BalloonStatsSeconds int
	// FreePageReporting turns on the balloon's free page reporting (Firecracker v1.14 on, a guest kernel with
	// CONFIG_PAGE_REPORTING): the guest reports the memory it frees and Firecracker discards it, so the VM's resident
	// memory falls after a peak. Only with the balloon (BalloonStatsSeconds); a snapshot keeps it.
	FreePageReporting bool
	// Drives are attached after rootfs (/dev/vda) and disk (/dev/vdb), in order, as /dev/vdc on: a template builder's
	// output drive, or a sandbox's read-only bundle drives. Their paths are relative to the VM's directory, as the
	// others' are.
	Drives []Drive
	// Discard lets the guest discard (trim) blocks of its writable disk: Firecracker punches holes in disk.ext4 for
	// them, so space the guest frees is freed on the host too (DiscardSupported says which Firecracker can). Off, the
	// guest sees no discard support and its trims go nowhere. A snapshot keeps the device as it was booted.
	Discard bool
}

// DiscardSupported says whether a Firecracker version (`v1.17.0`, as hostinfo.FirecrackerVersion reports it) takes a
// drive's `discard` field: from v1.17, for writable drives on the Sync IO engine (the default). An earlier one refuses
// the field, so the boot would fail; an unknown version is taken as unable.
func DiscardSupported(version string) bool {
	var major, minor int
	if _, err := fmt.Sscanf(strings.TrimPrefix(version, "v"), "%d.%d", &major, &minor); err != nil {
		return false
	}
	return major > 1 || major == 1 && minor >= 17
}

// DiskEngine is the writable disk's IO engine, said outright rather than left to Firecracker's default (the same):
// Sync serves each guest request on the VMM thread, which Barrier relies on, and is the engine discard needs. Async
// (io_uring) would complete writes on its own, beyond Barrier.
const DiskEngine = "Sync"

// diskDrive is the writable disk's drive, with discard on when asked (BootConfig.Discard).
func diskDrive(discard bool) map[string]any {
	drive := map[string]any{"drive_id": "disk", "path_on_host": DiskFile, "is_root_device": false, "is_read_only": false, "io_engine": DiskEngine}
	if discard {
		drive["discard"] = true
	}
	return drive
}

// Drive is an extra block device. Path is relative to the VM's directory, as rootfs.ext4 is, so a snapshot of the VM
// restores beside any number of clones, each with its own file there.
type Drive struct {
	ID       string
	Path     string
	ReadOnly bool
}

// balloon is the balloon BootConfig.BalloonStatsSeconds asks for: a target of 0, so it only reports, and with free page
// reporting when asked.
func balloon(statsSeconds int, freePageReporting bool) map[string]any {
	b := map[string]any{"amount_mib": 0, "deflate_on_oom": true, "stats_polling_interval_s": statsSeconds}
	if freePageReporting {
		b["free_page_reporting"] = true
	}
	return b
}

func bootSource(cfg BootConfig) map[string]any {
	source := map[string]any{"kernel_image_path": cfg.Kernel, "boot_args": cfg.BootArgs}
	if cfg.Initrd != "" {
		source["initrd_path"] = cfg.Initrd
	}
	return source
}

// HotplugSlotMiB is the virtio-mem slot size Firecracker uses by default; the hotpluggable total is a multiple of it.
const HotplugSlotMiB = 128

// HotplugBlockMiB is the virtio-mem block size: what is plugged is a multiple of it.
const HotplugBlockMiB = 2

// UpdateDrive points a running VM's drive at another file (PATCH /drives/{id}): Firecracker opens path and tells the
// guest its size changed, which the guest's kernel picks up as a capacity change of the device.
func (m *Machine) UpdateDrive(ctx context.Context, id, path string) error {
	return m.call(ctx, http.MethodPatch, "/drives/"+id, map[string]any{"drive_id": id, "path_on_host": path})
}

// Boot configures the VM (rootfs.ext4 read-only, disk.ext4 writable, any extra drives, eth0, vsock) and
// starts it.
func (m *Machine) Boot(ctx context.Context, cfg BootConfig) error {
	type step struct {
		path string
		body any
	}
	steps := []step{
		{"/machine-config", map[string]any{"vcpu_count": cfg.VCPUs, "mem_size_mib": cfg.MemoryMiB, "smt": false}},
		{"/boot-source", bootSource(cfg)},
		{"/drives/rootfs", map[string]any{"drive_id": "rootfs", "path_on_host": RootfsFile, "is_root_device": true, "is_read_only": true}},
		{"/drives/disk", diskDrive(cfg.Discard)},
	}
	// Block devices are attached in the order they're configured, so these are vdc, vdd, ... after vda and vdb.
	for _, d := range cfg.Drives {
		steps = append(steps, step{"/drives/" + d.ID, map[string]any{"drive_id": d.ID, "path_on_host": d.Path, "is_root_device": false, "is_read_only": d.ReadOnly}})
	}
	steps = append(steps,
		step{"/network-interfaces/eth0", map[string]any{"iface_id": "eth0", "host_dev_name": cfg.TapDevice, "guest_mac": cfg.MAC}},
		step{"/vsock", map[string]any{"guest_cid": cfg.GuestCID, "uds_path": VsockSocket}},
		step{"/entropy", map[string]any{}},
		step{"/hotplug/memory", map[string]any{"total_size_mib": cfg.HotplugMiB, "block_size_mib": HotplugBlockMiB, "slot_size_mib": HotplugSlotMiB}},
		step{"/balloon", balloon(cfg.BalloonStatsSeconds, cfg.FreePageReporting)},
	)
	for _, step := range steps {
		if step.path == "/network-interfaces/eth0" && cfg.TapDevice == "" {
			// No network device (the isolate tier's VM talks to the host over vsock only).
			continue
		}
		if step.path == "/hotplug/memory" && cfg.HotplugMiB <= 0 || step.path == "/balloon" && cfg.BalloonStatsSeconds <= 0 {
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

// Barrier returns once the VM's VMM thread has handled a request (GET /machine-config) sent now. Firecracker runs every
// virtio device on that one thread, its block device included, and the disk is on the Sync engine (DiskEngine): each
// guest write to disk.ext4 is a write the thread makes and finishes before it handles its next event. So when Barrier
// returns, every write to the disk that was under way when it was called has finished, and raised its IN_MODIFY: a
// paused VM's disk copy checked for writes after a Barrier can't miss one still in flight. (Firecracker's
// docs/design.md: "The VMM thread exposes the machine model, minimal legacy device model, MMDS, and VirtIO device
// emulated Net, Block and Vsock devices"; the API thread hands each request to it.)
func (m *Machine) Barrier(ctx context.Context) error {
	return m.call(ctx, http.MethodGet, "/machine-config", nil)
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
//
// kvmclock resumes where it was when the snapshot was taken (clock_realtime off). Advancing it by the time since
// (clock_realtime) moves only the guest's scheduler clock, which reads kvmclock, and not its time of day, which reads
// the TSC: the scheduler then charges the whole gap to the task each vCPU was running when the snapshot was taken,
// which waits behind every other task until it has caught up. On a 1-vCPU template that task is a kworker, and the
// guest agent answered 4-20 s late, or not within a restore's wait (TASK-5137). The guest's time of day is set by its
// agent instead, from the identity every restore sends (microvm and isolate alike).
func (m *Machine) Load(ctx context.Context, statePath, memPath, tap string) error {
	body := map[string]any{
		"snapshot_path":     statePath,
		"mem_backend":       map[string]string{"backend_type": "File", "backend_path": memPath},
		"resume_vm":         true,
		"clock_realtime":    false,
		"vsock_override":    map[string]string{"uds_path": VsockSocket},
		"track_dirty_pages": false,
	}
	if tap != "" {
		body["network_overrides"] = []map[string]string{{"iface_id": "eth0", "host_dev_name": tap}}
	}
	return m.call(ctx, http.MethodPut, "/snapshot/load", body)
}

// HotplugStatus is the virtio-mem device's state (GET /hotplug/memory).
type HotplugStatus struct {
	TotalMiB     int `json:"total_size_mib"`
	PluggedMiB   int `json:"plugged_size_mib"`
	RequestedMiB int `json:"requested_size_mib"`
}

// PlugMemory asks the guest to plug mib of the VM's hotpluggable memory (a multiple of HotplugBlockMiB). The guest
// driver plugs it asynchronously: Hotplug says how far it has got.
func (m *Machine) PlugMemory(ctx context.Context, mib int) error {
	return m.call(ctx, http.MethodPatch, "/hotplug/memory", map[string]int{"requested_size_mib": mib})
}

// Hotplug reads the virtio-mem device's state.
func (m *Machine) Hotplug(ctx context.Context) (HotplugStatus, error) {
	var out HotplugStatus
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://firecracker/hotplug/memory", nil)
	if err != nil {
		return out, err
	}
	res, err := m.http.Do(req)
	if err != nil {
		return out, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(res.Body)
		return out, fmt.Errorf("firecracker GET /hotplug/memory: %d %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	return out, json.NewDecoder(res.Body).Decode(&out)
}

// RescanDrive tells the guest a drive's file changed size (after the host grew it): Firecracker re-reads it and
// signals the guest, which sees the new capacity.
func (m *Machine) RescanDrive(ctx context.Context, id, path string) error {
	return m.call(ctx, http.MethodPatch, "/drives/"+id, map[string]string{"drive_id": id, "path_on_host": path})
}

// BalloonStats is what GET /balloon/statistics answers that the host reads: the guest's own count of its memory, as its
// virtio_balloon driver last reported it (MemTotal, MemAvailable and MemFree, in bytes). A figure the driver hasn't
// reported yet is nil.
type BalloonStats struct {
	TotalMemory     *int64 `json:"total_memory"`
	AvailableMemory *int64 `json:"available_memory"`
	FreeMemory      *int64 `json:"free_memory"`
	// TargetMiB is the balloon's target, ActualMiB what it holds now (SetBalloon).
	TargetMiB int64 `json:"target_mib"`
	ActualMiB int64 `json:"actual_mib"`
}

// SetBalloon sets the balloon's target of the Firecracker running in dir (PATCH /balloon): the guest's driver gives it
// that much memory, dropping page cache to, and Firecracker frees it on the host; 0 gives it all back. With
// deflate_on_oom the guest takes pages back from it rather than kill a process. Its own connection, as
// ReadBalloonStats.
func SetBalloon(ctx context.Context, dir string, mib int64) error {
	socket := filepath.Join(dir, APISocket)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}}
	raw, err := json.Marshal(map[string]int64{"amount_mib": max(0, mib)})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, "http://firecracker/balloon", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("firecracker PATCH /balloon: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		return fmt.Errorf("firecracker PATCH /balloon: %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// ReadBalloonStats asks the Firecracker running in dir for its balloon's statistics. It fails for a VM booted without
// the balloon (or restored from a snapshot made without it): Firecracker answers 400.
//
// It opens its own connection to the API socket and closes it, so it needs no Machine (and none of its locks).
func ReadBalloonStats(ctx context.Context, dir string) (BalloonStats, error) {
	socket := filepath.Join(dir, APISocket)
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives: true,
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://firecracker/balloon/statistics", nil)
	if err != nil {
		return BalloonStats{}, err
	}
	req.Header.Set("accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return BalloonStats{}, fmt.Errorf("firecracker GET /balloon/statistics: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return BalloonStats{}, err
	}
	if res.StatusCode >= 300 {
		return BalloonStats{}, fmt.Errorf("firecracker GET /balloon/statistics: %d %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	var stats BalloonStats
	if err := json.Unmarshal(raw, &stats); err != nil {
		return BalloonStats{}, fmt.Errorf("firecracker GET /balloon/statistics: %w", err)
	}
	return stats, nil
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

// leftoverExit is how long KillLeftover waits for a killed process to have gone.
const leftoverExit = 10 * time.Second

// KillLeftover ends the Firecracker process a crashed daemon left running in dir, if there is one, and waits (up to
// leftoverExit) until it has exited, so its memory is free when it returns.
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
	if !workingIn(pid, dir) {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	for deadline := time.Now().Add(leftoverExit); !exited(pid) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
}

// workingIn says process pid's working directory is dir. They are compared as directories (device and inode), not
// as paths: /proc gives the working directory's resolved path, so a dir reached through a symlink (the host's state
// directory, say) never equals it as text. A working directory since removed (" (deleted)") is compared by path.
func workingIn(pid int, dir string) bool {
	proc := fmt.Sprintf("/proc/%d/cwd", pid)
	if cwd, err := os.Stat(proc); err == nil {
		if want, err := os.Stat(dir); err == nil && os.SameFile(cwd, want) {
			return true
		}
	}
	cwd, err := os.Readlink(proc)
	if err != nil {
		return false
	}
	cwd = strings.TrimSuffix(cwd, " (deleted)")
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		if abs, err := filepath.Abs(resolved); err == nil && cwd == abs {
			return true
		}
	}
	return cwd == filepath.Clean(dir)
}

// exited says a process is gone, or a zombie (its memory freed, waiting for its parent to reap it).
func exited(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return true
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	// pid (comm) state ...: comm may hold spaces and parentheses, so the state follows the last ")".
	_, rest, ok := strings.Cut(string(raw[bytes.LastIndexByte(raw, ')')+1:]), " ")
	return ok && strings.HasPrefix(rest, "Z")
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
