// Package microvm is the microVM tier: each sandbox is a Firecracker VM with its own kernel, systemd, Docker, SSH, a
// desktop and Chromium, and /dev/kvm when the host CPU nests.
//
// How a sandbox is fast to get:
//
//   - Template snapshots. For each size the host cold-boots one VM once, waits until every service is up, and
//     snapshots it (memory and disk). A new sandbox restores that snapshot instead of booting: the memory file is
//     mapped copy-on-write (MAP_PRIVATE), so every sandbox shares its unchanged pages.
//   - A warm pool. The host keeps a few sandboxes already restored and idle (no network, no identity). Creating one
//     claims it: it gets its own name, address, keys and entropy over vsock, and is running.
//   - Stop keeps memory. A stop snapshots memory and disk, so resume is a restore, not a boot, and the sandbox's
//     processes carry on.
//
// On disk (Root, default /var/lib/kantel-host):
//
//	images/vmlinux, images/sandbox.ext4      the kernel and the shared read-only root filesystem (with image
//	                                          patching, links to images/current: package images, base.go)
//	templates/<size>/{state,mem,disk.ext4}    each size's template snapshot (rootfs: the image it was made on)
//	sandboxes/<id>/meta.json                  the sandbox's record
//	sandboxes/<id>/vm/                        Firecracker's working directory: rootfs.ext4 (a link to the image),
//	                                          disk.ext4 (the sandbox's own disk), state and mem after a stop
//	snapshots/<id>/{meta.json,disk.ext4,...}  automatic and saved snapshots
//	pool/<n>/                                 pre-warmed sandboxes, moved to sandboxes/<id> when claimed
package microvm

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Tier is the microVM tier's name.
const Tier = "microvm"

// DefaultSizes are the shapes a host offers unless configured otherwise. Every microVM runs the desktop, whose
// stream (Selkies, H.264 on the CPU) takes about a core while the screen changes and saturates 2 vCPUs at 1080p, so
// the default has 4. vCPUs aren't reserved (the scheduler counts memory and disk), so this costs no density.
var DefaultSizes = []proto.Size{
	{Name: "small", VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10},
	{Name: "default", VCPUs: 4, MemoryMiB: 2048, DiskGiB: 20},
	{Name: "large", VCPUs: 4, MemoryMiB: 8192, DiskGiB: 50},
}

// Config is the tier's setup.
type Config struct {
	Root        string
	Firecracker string
	Kernel      string
	Rootfs      string
	Sizes       []proto.Size
	Network     *network.Manager
	// ProxyPort is the host egress proxy's port on each sandbox's gateway address.
	ProxyPort int
	// DNS is unused: no sandbox has a route to a DNS server since the proxy became the only way out. Kept so old
	// configs load.
	DNS []string
	// AutoSnapshots is how many automatic snapshots each sandbox keeps (default 5).
	AutoSnapshots int
	Log           *slog.Logger
	// Events receives state changes.
	Events func(proto.SandboxInfo)
	// Attach tells the host's egress proxy which sandbox (and account, and egress) a network slot is now; Detach that
	// it is no one's.
	Attach func(slot int, sandboxID, owner string, egress *proto.Egress)
	Detach func(slot int)
	// SpoolDir is a RAM file system (tmpfs) memory snapshots are written to first, so a stop or a fork doesn't wait
	// for the disk; SpoolMaxMiB caps it. Empty: straight to disk.
	SpoolDir    string
	SpoolMaxMiB int64
	// PinBase (image patching): each sandbox, snapshot and template links the file Rootfs resolves to when it is made,
	// so an update that repoints Rootfs changes only what new ones start on (base.go).
	PinBase bool
	// BackgroundTemplates (image patching): a template made with other images is still used while its replacement
	// builds in the background, rather than every create waiting for it.
	BackgroundTemplates bool
}

type meta struct {
	ID        string            `json:"id"`
	Size      string            `json:"size"`
	State     string            `json:"state"`
	CreatedAt int64             `json:"createdAt"`
	Slot      int               `json:"slot"`
	Pid       int               `json:"pid"`
	CID       uint32            `json:"cid"`
	Memory    bool              `json:"memory"`
	Egress    *proto.Egress     `json:"egress,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	SSHKeys   []string          `json:"sshKeys,omitempty"`
	Owner     string            `json:"owner,omitempty"`
	Error     string            `json:"error,omitempty"`
}

type sandbox struct {
	mu      sync.Mutex
	meta    meta
	dir     string
	machine *fc.Machine
	guest   *guest.Client
	link    *network.Link
	// unsaved: meta differs from meta.json (a write failed). A call that would otherwise change nothing, a retried
	// start, writes it before it answers.
	unsaved bool
}

func (s *sandbox) vmDir() string { return filepath.Join(s.dir, "vm") }

type warm struct {
	dir     string
	size    string
	machine *fc.Machine
	guest   *guest.Client
	link    network.Link
	cid     uint32
}

// Manager runs the tier.
type Manager struct {
	cfg       Config
	log       *slog.Logger
	mu        sync.Mutex
	sandboxes map[string]*sandbox
	pool      map[string][]*warm
	poolWant  map[string]int
	filling   map[string]bool
	templates map[string]*sync.Mutex
	nextCID   atomic.Uint32
	closed    atomic.Bool
	spool     *spool
	// inUse is held (read) from picking a size's template until restoring it, so a background rebuild swaps it in
	// between creates (base.go).
	inUse map[string]*sync.RWMutex
	// rebuilding are the sizes whose template is being rebuilt in the background; rebuild does it (swapTemplate when
	// nil, tests replace it).
	rebuilding map[string]bool
	rebuild    func(ctx context.Context, size proto.Size) error
}

func New(cfg Config) (*Manager, error) {
	if cfg.AutoSnapshots <= 0 {
		cfg.AutoSnapshots = 5
	}
	if len(cfg.Sizes) == 0 {
		cfg.Sizes = DefaultSizes
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	for _, dir := range []string{"templates", "sandboxes", "snapshots", "pool"} {
		if err := os.MkdirAll(filepath.Join(cfg.Root, dir), 0o700); err != nil {
			return nil, err
		}
	}
	m := &Manager{cfg: cfg, log: cfg.Log.With("tier", Tier), sandboxes: map[string]*sandbox{}, pool: map[string][]*warm{}, poolWant: map[string]int{}, filling: map[string]bool{}, templates: map[string]*sync.Mutex{}, inUse: map[string]*sync.RWMutex{}, rebuilding: map[string]bool{}}
	m.nextCID.Store(uint32(time.Now().UnixMilli()%100000) + 100)
	m.spool = newSpool(cfg.SpoolDir, cfg.SpoolMaxMiB<<20, m.log)
	for _, size := range cfg.Sizes {
		m.templates[size.Name] = &sync.Mutex{}
		m.inUse[size.Name] = &sync.RWMutex{}
	}
	// Leftover pool VMs from a previous run aren't adopted: they are cheap to make again.
	entries, _ := os.ReadDir(filepath.Join(cfg.Root, "pool"))
	for _, e := range entries {
		dir := filepath.Join(cfg.Root, "pool", e.Name())
		fc.KillLeftover(filepath.Join(dir, "vm"))
		fc.KillLeftover(dir)
		_ = os.RemoveAll(dir)
	}
	if err := m.adopt(); err != nil {
		return nil, err
	}
	m.pinBases()
	// Memory files a previous run spooled and hadn't yet moved to disk.
	vmMems, _ := filepath.Glob(filepath.Join(cfg.Root, "sandboxes", "*", "vm", "mem"))
	snapMems, _ := filepath.Glob(filepath.Join(cfg.Root, "snapshots", "*", "mem"))
	m.spool.adopt(append(vmMems, snapMems...))
	return m, nil
}

// memFile is where a snapshot's memory is written: the spool when it has room, else path itself. done places it
// at path (or gives the room back when the snapshot failed).
func (m *Manager) memFile(sizeName, path string) (write string, done func(ok bool) error) {
	size, err := m.size(sizeName)
	if err != nil || m.spool == nil {
		return path, func(bool) error { return nil }
	}
	n := int64(size.MemoryMiB) << 20
	spooled := m.spool.reserve(n)
	if spooled == "" {
		return path, func(bool) error { return nil }
	}
	return spooled, func(ok bool) error {
		if !ok {
			m.spool.cancel(spooled, n)
			return nil
		}
		return m.spool.place(spooled, path)
	}
}

func (m *Manager) size(name string) (proto.Size, error) {
	if name == "" {
		name = "default"
	}
	for _, s := range m.cfg.Sizes {
		if s.Name == name {
			return s, nil
		}
	}
	return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("no size %q on this host", name)}
}

func notFound(id string) error {
	return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no sandbox %s on this host", id)}
}

func conflict(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf(format, args...)}
}

func (m *Manager) writeMeta(s *sandbox) error {
	raw, err := json.MarshalIndent(s.meta, "", "  ")
	if err != nil {
		return err
	}
	// Durably: what it holds (its egress, and that egress's revision) is what the host has acknowledged.
	err = fsutil.WriteFileDurably(filepath.Join(s.dir, "meta.json"), raw, 0o600)
	s.unsaved = err != nil
	return err
}

func (m *Manager) info(s *sandbox) proto.SandboxInfo {
	info := proto.SandboxInfo{ID: s.meta.ID, Tier: Tier, Size: s.meta.Size, State: s.meta.State, Memory: s.meta.Memory, Error: s.meta.Error, CreatedAt: s.meta.CreatedAt, Owner: s.meta.Owner, Base: baseOf(s.vmDir())}
	if s.link != nil {
		info.Address = s.link.GuestIP.String()
	}
	return info
}

func (m *Manager) emit(s *sandbox) {
	if m.cfg.Events != nil {
		m.cfg.Events(m.info(s))
	}
}

// adopt picks up the sandboxes a previous run of the host left: running VMs whose Firecracker is still alive keep
// running; the rest are stopped.
func (m *Manager) adopt() error {
	entries, err := os.ReadDir(filepath.Join(m.cfg.Root, "sandboxes"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		dir := filepath.Join(m.cfg.Root, "sandboxes", e.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			continue
		}
		s := &sandbox{dir: dir}
		if err := json.Unmarshal(raw, &s.meta); err != nil {
			continue
		}
		if s.meta.State == proto.StateRunning && s.meta.Pid > 0 && processAlive(s.meta.Pid) {
			machine, err := fc.Attach(s.vmDir(), s.meta.Pid)
			if err == nil {
				link := m.cfg.Network.LinkFor(s.meta.Slot, egressMode(s.meta.Egress))
				if err := m.cfg.Network.Adopt(link); err != nil {
					m.log.Warn("adopted sandbox's network rules", "sandbox", s.meta.ID, "error", err)
				}
				s.machine, s.link = machine, &link
				s.guest = guest.NewClient(filepath.Join(s.vmDir(), fc.VsockSocket))
				m.attach(s, link.Slot)
				m.watch(s, machine)
				m.sandboxes[s.meta.ID] = s
				m.log.Info("adopted running sandbox", "sandbox", s.meta.ID, "pid", s.meta.Pid)
				continue
			}
		}
		if s.meta.State != proto.StateStopped {
			s.meta.State = proto.StateStopped
			s.meta.Error = "the host restarted while it ran"
			_ = m.writeMeta(s)
		}
		m.sandboxes[s.meta.ID] = s
	}
	return nil
}

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func egressMode(e *proto.Egress) string {
	if e == nil || e.Mode == "" {
		return network.EgressOpen
	}
	return e.Mode
}

// watch marks a sandbox stopped (with an error) when its VM exits without being asked to.
func (m *Manager) watch(s *sandbox, machine *fc.Machine) {
	go func() {
		<-machine.Done()
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.machine != machine {
			return
		}
		s.machine = nil
		if s.link != nil {
			m.cfg.Network.Remove(*s.link)
			m.detach(s.link.Slot)
			s.link = nil
		}
		s.meta.State = proto.StateStopped
		s.meta.Memory = false
		s.meta.Error = "the VM exited"
		s.meta.Pid = 0
		_ = m.writeMeta(s)
		m.log.Warn("sandbox VM exited", "sandbox", s.meta.ID)
		m.emit(s)
	}()
}

func (m *Manager) cid() uint32 { return m.nextCID.Add(1) }

func (m *Manager) attach(s *sandbox, slot int) {
	if m.cfg.Attach != nil {
		m.cfg.Attach(slot, s.meta.ID, s.meta.Owner, s.meta.Egress)
	}
}

func (m *Manager) detach(slot int) {
	if m.cfg.Detach != nil {
		m.cfg.Detach(slot)
	}
}

func randomEntropy() string {
	buf := make([]byte, 64)
	_, _ = rand.Read(buf)
	return base64.StdEncoding.EncodeToString(buf)
}

// identity is what a sandbox is told after a restore.
func (m *Manager) identity(s *sandbox, fresh bool) guest.Identity {
	id := guest.Identity{
		SandboxID:  s.meta.ID,
		Hostname:   hostname(s.meta.ID),
		Address:    s.link.GuestCIDR(),
		Gateway:    s.link.HostIP.String(),
		Entropy:    randomEntropy(),
		UnixTimeMs: time.Now().UnixMilli(),
		Fresh:      fresh,
		Env:        s.meta.Env,
	}
	if fresh {
		id.SSHAuthorizedKeys = append([]string{}, s.meta.SSHKeys...)
	}
	// The host's egress proxy is a sandbox's only way out, whatever its mode (package network): "open" is the proxy
	// with no rules. With no route out there is no DNS to give either; the proxy resolves names.
	mode := egressMode(s.meta.Egress)
	if mode != network.EgressNone && m.cfg.ProxyPort > 0 {
		// The user is the sandbox's label for its requests ("sandbox" is none). Its password is empty, and given: with
		// none, git asks for one, and with no terminal (an exec, a clone at start) fails rather than connecting.
		proxy := fmt.Sprintf("http://sandbox:@%s:%d", s.link.HostIP, m.cfg.ProxyPort)
		id.ProxyEnv = map[string]string{
			"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
			"NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1",
			// Node's fetch takes the proxy from the environment only when asked (Node 24 and later).
			"NODE_USE_ENV_PROXY": "1",
			// Node (and Bun) and Python's requests trust bundles of their own, not the system's: pointed at the system's,
			// they trust the egress proxy's CA too (installed there, and replaced there when the intercepted hosts
			// change), so a protected variable's bound host works from them as from curl or git.
			"NODE_EXTRA_CA_CERTS": systemCABundle,
			"REQUESTS_CA_BUNDLE":  systemCABundle,
		}
	}
	if s.meta.Egress != nil {
		id.CACert = s.meta.Egress.CACert
	}
	return id
}

// systemCABundle is the guest's system trust store, as update-ca-certificates writes it.
const systemCABundle = "/etc/ssl/certs/ca-certificates.crt"

func hostname(id string) string {
	name := strings.ToLower(id)
	name = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			return r
		}
		return '-'
	}, name)
	if len(name) > 60 {
		name = name[:60]
	}
	return name
}

// copySparse copies a disk image, keeping holes (cp's SEEK_DATA/SEEK_HOLE).
func copySparse(src, dst string) error {
	out, err := exec.Command("cp", "--sparse=always", src, dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("copy %s: %v: %s", filepath.Base(src), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// newDisk makes an empty sparse ext4 disk of the size.
func newDisk(path string, gib int) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := f.Truncate(int64(gib) << 30); err != nil {
		f.Close()
		return err
	}
	f.Close()
	out, err := exec.Command("mkfs.ext4", "-q", "-F", "-L", "kantel-disk", "-E", "lazy_itable_init=1,lazy_journal_init=1,discard", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mkfs.ext4: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func diskUsage(path string) int64 {
	var st syscall.Stat_t
	if syscall.Stat(path, &st) != nil {
		return 0
	}
	return st.Blocks * 512
}

const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/usr/sbin/kantel-init quiet loglevel=3 systemd.show_status=false"

// Since is a timer for step timings.
type timings map[string]float64

func (t timings) step(name string, since *time.Time) {
	now := time.Now()
	t[name] = float64(now.Sub(*since).Microseconds()) / 1000
	*since = now
}

// templateShape is the size's part of a template's fingerprint: a snapshot restores the vCPUs and memory it was made
// with, so a size that changes (a new default, or the host's settings) needs a new template.
func templateShape(size proto.Size) string {
	return fmt.Sprintf(" size=%d/%d/%d", size.VCPUs, size.MemoryMiB, size.DiskGiB)
}

// templateFingerprint is what a size's template is made with: Firecracker, the kernel, the images and the shape.
func (m *Manager) templateFingerprint(size proto.Size) string {
	return fc.Fingerprint(m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs) + templateShape(size)
}

// template returns the size's template snapshot, cold-booting one if there is none. With BackgroundTemplates, one
// made with other images (but the same shape) is still returned while its replacement builds (base.go).
func (m *Manager) template(ctx context.Context, size proto.Size) (string, timings, error) {
	lock := m.templates[size.Name]
	lock.Lock()
	defer lock.Unlock()
	dir := filepath.Join(m.cfg.Root, "templates", size.Name)
	if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
		made, _ := os.ReadFile(filepath.Join(dir, "images"))
		if string(made) == m.templateFingerprint(size) {
			return dir, nil, nil
		}
		if m.cfg.BackgroundTemplates && strings.HasSuffix(string(made), templateShape(size)) {
			// Sandboxes made from it meanwhile are on its images, as their Base says.
			m.rebuildTemplate(size)
			return dir, nil, nil
		}
		// Made with other images (an update) or another shape: running sandboxes keep their mapping of the old memory file.
		m.log.Info("template is for other images or another shape; rebuilding", "size", size.Name)
	}
	t, err := m.buildTemplate(ctx, size, dir)
	if err != nil {
		return "", nil, err
	}
	return dir, t, nil
}

// buildTemplate cold-boots a VM of the size on the current images, waits for its services, and snapshots it into
// dir (replacing what is there), recording the images it was made with.
func (m *Manager) buildTemplate(ctx context.Context, size proto.Size, dir string) (timings, error) {
	fingerprint := m.templateFingerprint(size)
	rootfs := m.baseRootfs()
	t := timings{}
	start := time.Now()
	building := dir + ".building"
	_ = os.RemoveAll(building)
	_ = os.RemoveAll(dir)
	vm := filepath.Join(building, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return nil, err
	}
	if err := m.linkRootfs(vm, rootfs); err != nil {
		return nil, err
	}
	if err := newDisk(filepath.Join(vm, fc.DiskFile), size.DiskGiB); err != nil {
		return nil, err
	}
	t.step("disk", &start)
	link, err := m.cfg.Network.Add(network.EgressNone)
	if err != nil {
		return nil, err
	}
	defer m.cfg.Network.Remove(link)
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return nil, err
	}
	defer machine.Kill()
	t.step("launch", &start)
	if err := machine.Boot(ctx, fc.BootConfig{VCPUs: size.VCPUs, MemoryMiB: size.MemoryMiB, Kernel: m.cfg.Kernel, BootArgs: bootArgs, TapDevice: link.Tap, MAC: link.MAC, GuestCID: m.cid()}); err != nil {
		return nil, err
	}
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	defer client.Close()
	bootCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if _, err := client.WaitReady(bootCtx); err != nil {
		return nil, fmt.Errorf("template boot: %w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	t.step("agent", &start)
	// What the image says it runs (/etc/kantel/ready), else the desktop, browser and Docker. Not SSH: the image has
	// no host keys, so sshd starts only once a sandbox has its identity.
	if _, err := client.WaitExpected(bootCtx, "desktop", "browser", "docker"); err != nil {
		m.log.Warn("template services not all ready; snapshotting anyway", "size", size.Name, "error", err)
	}
	t.step("services", &start)
	_ = client.Sync(ctx)
	client.Close()
	if err := machine.Pause(ctx); err != nil {
		return nil, err
	}
	if err := machine.Snapshot(ctx, filepath.Join(building, "state"), filepath.Join(building, "mem")); err != nil {
		return nil, err
	}
	t.step("snapshot", &start)
	machine.Kill()
	if err := os.Rename(filepath.Join(vm, fc.DiskFile), filepath.Join(building, fc.DiskFile)); err != nil {
		return nil, err
	}
	_ = os.RemoveAll(vm)
	if err := os.Rename(building, dir); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(map[string]any{"size": size, "timings": t, "at": time.Now().UnixMilli()})
	_ = os.WriteFile(filepath.Join(dir, "images"), []byte(fingerprint), 0o600)
	// The root filesystem its memory state is over: sandboxes restored from it link this one.
	_ = os.WriteFile(filepath.Join(dir, "rootfs"), []byte(rootfs), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "ready"), raw, 0o600)
	m.log.Info("template ready", "size", size.Name, "timings", t)
	return t, nil
}

func tail(path string) string {
	raw, _ := os.ReadFile(path)
	if len(raw) > 1500 {
		raw = raw[len(raw)-1500:]
	}
	return strings.TrimSpace(string(raw))
}

// restore starts a VM in dir/vm from a snapshot (state and memory, with dir/vm/disk.ext4 already in place).
func (m *Manager) restore(ctx context.Context, vmDir, statePath, memPath string, link network.Link) (*fc.Machine, *guest.Client, error) {
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vmDir)
	if err != nil {
		return nil, nil, err
	}
	if err := machine.Load(ctx, statePath, memPath, link.Tap); err != nil {
		machine.Kill()
		return nil, nil, fmt.Errorf("%w (firecracker log: %s)", err, tail(filepath.Join(vmDir, fc.LogFile)))
	}
	client := guest.NewClient(filepath.Join(vmDir, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := client.WaitReady(readyCtx); err != nil {
		machine.Kill()
		return nil, nil, err
	}
	return machine, client, nil
}

// SetPools sets how many warm sandboxes to keep per size, and starts filling.
func (m *Manager) SetPools(want map[string]int) {
	m.mu.Lock()
	m.poolWant = map[string]int{}
	for size, n := range want {
		m.poolWant[size] = n
	}
	m.mu.Unlock()
	for size := range want {
		m.fill(size)
	}
}

func (m *Manager) fill(sizeName string) {
	m.mu.Lock()
	if m.filling[sizeName] || m.closed.Load() {
		m.mu.Unlock()
		return
	}
	m.filling[sizeName] = true
	m.mu.Unlock()
	go func() {
		defer func() {
			m.mu.Lock()
			m.filling[sizeName] = false
			m.mu.Unlock()
		}()
		for !m.closed.Load() {
			m.mu.Lock()
			short := len(m.pool[sizeName]) < m.poolWant[sizeName]
			m.mu.Unlock()
			if !short {
				return
			}
			w, err := m.warmOne(context.Background(), sizeName)
			if err != nil {
				m.log.Error("warm pool fill failed", "size", sizeName, "error", err)
				time.Sleep(10 * time.Second)
				continue
			}
			m.mu.Lock()
			m.pool[sizeName] = append(m.pool[sizeName], w)
			m.mu.Unlock()
		}
	}()
}

func (m *Manager) warmOne(ctx context.Context, sizeName string) (*warm, error) {
	size, err := m.size(sizeName)
	if err != nil {
		return nil, err
	}
	defer m.useTemplate(sizeName)()
	tpl, _, err := m.template(ctx, size)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(filepath.Join(m.cfg.Root, "pool"), sizeName+"-")
	if err != nil {
		return nil, err
	}
	vm := filepath.Join(dir, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return nil, err
	}
	// The template's own images: its memory state is over them.
	if err := m.linkRootfs(vm, m.templateRootfs(tpl)); err != nil {
		return nil, err
	}
	if err := copySparse(filepath.Join(tpl, fc.DiskFile), filepath.Join(vm, fc.DiskFile)); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	link, err := m.cfg.Network.Add(network.EgressNone)
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	machine, client, err := m.restore(ctx, vm, filepath.Join(tpl, "state"), filepath.Join(tpl, "mem"), link)
	if err != nil {
		m.cfg.Network.Remove(link)
		os.RemoveAll(dir)
		return nil, err
	}
	return &warm{dir: dir, size: sizeName, machine: machine, guest: client, link: link}, nil
}

func (m *Manager) claim(sizeName string) *warm {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := m.pool[sizeName]
	if len(list) == 0 {
		return nil
	}
	w := list[0]
	m.pool[sizeName] = list[1:]
	go m.fill(sizeName)
	return w
}

// Warm is how many pre-warmed sandboxes each size has.
func (m *Manager) Warm() map[string]int {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]int{}
	for size, list := range m.pool {
		out[size] = len(list)
	}
	return out
}

func (m *Manager) get(id string) (*sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sandboxes[id]
	if !ok {
		return nil, notFound(id)
	}
	return s, nil
}

func (m *Manager) register(s *sandbox) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sandboxes[s.meta.ID]; ok {
		return conflict("sandbox %s already exists on this host", s.meta.ID)
	}
	m.sandboxes[s.meta.ID] = s
	return nil
}

func (m *Manager) unregister(id string) {
	m.mu.Lock()
	delete(m.sandboxes, id)
	m.mu.Unlock()
}

func validID(id string) bool {
	if id == "" || len(id) > 100 {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// Create makes a sandbox: from a warm sandbox when the pool has one, else by restoring the size's template (or
// p.From, a snapshot).
func (m *Manager) Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if !validID(p.SandboxID) {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID"}
	}
	size, err := m.size(p.Size)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	t := timings{}
	start := time.Now()
	began := start
	dir := filepath.Join(m.cfg.Root, "sandboxes", p.SandboxID)
	s := &sandbox{dir: dir, meta: meta{ID: p.SandboxID, Size: size.Name, State: proto.StateStarting, CreatedAt: time.Now().UnixMilli(), Egress: p.Egress, Env: p.Env, SSHKeys: p.SSHAuthorizedKeys, Owner: p.Owner}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := m.register(s); err != nil {
		return proto.SandboxInfo{}, err
	}
	fail := func(err error) (proto.SandboxInfo, error) {
		if s.machine != nil {
			s.machine.Kill()
		}
		if s.link != nil {
			m.cfg.Network.Remove(*s.link)
		}
		_ = os.RemoveAll(dir)
		m.unregister(p.SandboxID)
		return proto.SandboxInfo{}, err
	}
	source := "pool"
	if p.From == "" {
		if w := m.claim(size.Name); w != nil {
			if err := os.Rename(w.dir, dir); err != nil {
				w.machine.Kill()
				m.cfg.Network.Remove(w.link)
				return fail(err)
			}
			s.machine, s.link = fc.Moved(w.machine, filepath.Join(dir, "vm")), &w.link
			w.guest.Close()
			s.guest = guest.NewClient(filepath.Join(dir, "vm", fc.VsockSocket))
			s.meta.CID = w.cid
			t.step("claim", &start)
		}
	}
	if s.machine == nil {
		vm := filepath.Join(dir, "vm")
		if err := os.MkdirAll(vm, 0o700); err != nil {
			return fail(err)
		}
		// rootfs is the images the snapshot or template it starts from is over, so its memory matches its disk.
		var statePath, memPath, diskPath, rootfs string
		if p.From != "" {
			snap, err := m.readSnapshot(p.From)
			if err != nil {
				return fail(err)
			}
			if snap.Size != size.Name && snap.Memory {
				return fail(&proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("snapshot %s is of a %s sandbox; a sandbox made from it is that size too", p.From, snap.Size)})
			}
			sdir := m.snapshotDir(p.From)
			diskPath = filepath.Join(sdir, fc.DiskFile)
			if snap.Memory {
				statePath, memPath = filepath.Join(sdir, "state"), filepath.Join(sdir, "mem")
			}
			rootfs = m.snapshotRootfs(snap)
			source = "snapshot"
		} else {
			// Until it is restored (the function's end): a background rebuild swaps the template in between creates.
			defer m.useTemplate(size.Name)()
			tpl, tt, err := m.template(ctx, size)
			if err != nil {
				return fail(err)
			}
			for k, v := range tt {
				t["template."+k] = v
			}
			statePath, memPath, diskPath = filepath.Join(tpl, "state"), filepath.Join(tpl, "mem"), filepath.Join(tpl, fc.DiskFile)
			rootfs = m.templateRootfs(tpl)
			source = "snapshot"
			if tt != nil {
				source = "boot"
			}
		}
		if err := m.linkRootfs(vm, rootfs); err != nil {
			return fail(err)
		}
		start = time.Now()
		if err := copySparse(diskPath, filepath.Join(vm, fc.DiskFile)); err != nil {
			return fail(err)
		}
		t.step("disk", &start)
		link, err := m.cfg.Network.Add(egressMode(p.Egress))
		if err != nil {
			return fail(err)
		}
		s.link = &link
		t.step("network", &start)
		if statePath != "" {
			machine, client, err := m.restore(ctx, vm, statePath, memPath, link)
			if err != nil {
				return fail(err)
			}
			s.machine, s.guest = machine, client
			t.step("restore", &start)
		} else {
			if err := m.boot(ctx, s, size); err != nil {
				return fail(err)
			}
			source = "boot"
			t.step("boot", &start)
		}
	}
	if err := m.cfg.Network.SetEgress(s.link, egressMode(p.Egress)); err != nil {
		return fail(err)
	}
	m.attach(s, s.link.Slot)
	if err := s.guest.SetIdentity(ctx, m.identity(s, true)); err != nil {
		return fail(fmt.Errorf("identity: %w", err))
	}
	t.step("identity", &start)
	s.meta.State = proto.StateRunning
	s.meta.Slot = s.link.Slot
	s.meta.Pid = s.machine.Pid()
	if err := m.writeMeta(s); err != nil {
		return fail(err)
	}
	m.watch(s, s.machine)
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info := m.info(s)
	info.Timings, info.Source = t, source
	m.emit(s)
	return info, nil
}

// boot cold-boots s from its own disk (Start, or a snapshot with no memory).
func (m *Manager) boot(ctx context.Context, s *sandbox, size proto.Size) error {
	vm := s.vmDir()
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return err
	}
	s.meta.CID = m.cid()
	if err := machine.Boot(ctx, fc.BootConfig{VCPUs: size.VCPUs, MemoryMiB: size.MemoryMiB, Kernel: m.cfg.Kernel, BootArgs: bootArgs, TapDevice: s.link.Tap, MAC: s.link.MAC, GuestCID: s.meta.CID}); err != nil {
		machine.Kill()
		return err
	}
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, err := client.WaitReady(readyCtx); err != nil {
		machine.Kill()
		return fmt.Errorf("boot: %w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	s.machine, s.guest = machine, client
	return nil
}

// Stop snapshots a running sandbox (memory too unless asked not to) and ends its VM. The snapshot is also kept as
// the sandbox's newest automatic snapshot.
func (m *Manager) Stop(ctx context.Context, p proto.StopParams) (proto.SnapshotInfo, error) {
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SnapshotInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning || s.machine == nil {
		return proto.SnapshotInfo{}, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	keepMemory := p.Memory == nil || *p.Memory
	vm := s.vmDir()
	t := timings{}
	start := time.Now()
	defer func() { m.log.Debug("stop", "sandbox", s.meta.ID, "timings", t) }()
	_ = s.guest.Sync(ctx)
	t.step("sync", &start)
	s.guest.Close()
	machine := s.machine
	if err := machine.Pause(ctx); err != nil {
		return proto.SnapshotInfo{}, err
	}
	t.step("pause", &start)
	beside := filepath.Join(vm, "mem.new")
	memWrite, memDone := beside, func(bool) error { return nil }
	if keepMemory {
		memWrite, memDone = m.memFile(s.meta.Size, filepath.Join(vm, "mem"))
		if memWrite == filepath.Join(vm, "mem") {
			// On disk: written beside the old one, renamed over it once the VM is gone.
			memWrite = beside
		}
		if err := machine.Snapshot(ctx, filepath.Join(vm, "state.new"), memWrite); err != nil {
			_ = memDone(false)
			_ = machine.Resume(ctx)
			return proto.SnapshotInfo{}, err
		}
		t.step("snapshot", &start)
	}
	s.machine = nil
	machine.Kill()
	t.step("kill", &start)
	_ = os.Remove(filepath.Join(vm, "state"))
	_ = os.Remove(filepath.Join(vm, "mem"))
	if keepMemory {
		_ = os.Rename(filepath.Join(vm, "state.new"), filepath.Join(vm, "state"))
		if memWrite == beside {
			_ = os.Rename(beside, filepath.Join(vm, "mem"))
		} else if err := memDone(true); err != nil {
			keepMemory = false
		}
	}
	if s.link != nil {
		m.cfg.Network.Remove(*s.link)
		m.detach(s.link.Slot)
		s.link = nil
	}
	s.meta.State = proto.StateStopped
	s.meta.Memory = keepMemory
	s.meta.Pid = 0
	s.meta.Error = ""
	if err := m.writeMeta(s); err != nil {
		return proto.SnapshotInfo{}, err
	}
	m.emit(s)
	snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Memory: keepMemory, Tier: Tier}
	if p.SnapshotID != "" {
		if err := m.saveSnapshot(s, &snap, true); err != nil {
			return snap, err
		}
		t.step("save", &start)
		m.pruneAuto(s.meta.ID)
		t.step("prune", &start)
	}
	return snap, nil
}

// Resume restores a stopped sandbox from its memory snapshot, or boots it from its disk when it has none.
func (m *Manager) Resume(ctx context.Context, p proto.ResumeParams, coldBoot bool) (proto.SandboxInfo, error) {
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State == proto.StateRunning {
		// Running already (a retry, say). What it holds is on disk before it says so: an earlier boot that couldn't
		// write it failed, and a restart mustn't bring back the egress before it.
		if s.unsaved {
			if err := m.writeMeta(s); err != nil {
				return proto.SandboxInfo{}, err
			}
		}
		return m.info(s), nil
	}
	if s.meta.State != proto.StateStopped {
		return proto.SandboxInfo{}, conflict("sandbox %s is %s", s.meta.ID, s.meta.State)
	}
	size, err := m.size(s.meta.Size)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	if p.Egress != nil {
		s.meta.Egress = p.Egress
		s.unsaved = true
	}
	if coldBoot && p.Rebase {
		if err := m.rebase(s); err != nil {
			return proto.SandboxInfo{}, err
		}
	}
	t := timings{}
	start := time.Now()
	began := start
	link, err := m.cfg.Network.Add(egressMode(s.meta.Egress))
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.link = &link
	t.step("network", &start)
	vm := s.vmDir()
	source := "snapshot"
	_, statErr := os.Stat(filepath.Join(vm, "mem"))
	if s.meta.Memory && statErr == nil && !coldBoot {
		machine, client, err := m.restore(ctx, vm, filepath.Join(vm, "state"), filepath.Join(vm, "mem"), link)
		if err != nil {
			m.cfg.Network.Remove(link)
			s.link = nil
			return proto.SandboxInfo{}, err
		}
		s.machine, s.guest = machine, client
		t.step("restore", &start)
	} else {
		if err := m.boot(ctx, s, size); err != nil {
			m.cfg.Network.Remove(link)
			s.link = nil
			return proto.SandboxInfo{}, err
		}
		source = "boot"
		t.step("boot", &start)
	}
	m.attach(s, link.Slot)
	// A cold boot needs the sandbox's identity like a fresh one, but keeps its SSH host keys.
	if err := s.guest.SetIdentity(ctx, m.identity(s, false)); err != nil {
		s.machine.Kill()
		m.cfg.Network.Remove(link)
		s.machine, s.link = nil, nil
		return proto.SandboxInfo{}, fmt.Errorf("identity: %w", err)
	}
	t.step("identity", &start)
	s.meta.State = proto.StateRunning
	s.meta.Slot = link.Slot
	s.meta.Pid = s.machine.Pid()
	s.meta.Error = ""
	if err := m.writeMeta(s); err != nil {
		return proto.SandboxInfo{}, err
	}
	m.watch(s, s.machine)
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info := m.info(s)
	info.Timings, info.Source = t, source
	m.emit(s)
	return info, nil
}

// Fork makes a new sandbox from the source's current state: a running source is snapshotted live (paused for the
// snapshot only), a stopped one forks from its newest snapshot.
func (m *Manager) Fork(ctx context.Context, p proto.ForkParams) (proto.SandboxInfo, error) {
	src, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	t := timings{}
	start := time.Now()
	began := start
	var snapID string
	src.mu.Lock()
	switch src.meta.State {
	case proto.StateRunning:
		if p.SnapshotID == "" {
			src.mu.Unlock()
			return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "forking a running sandbox needs snapshotId"}
		}
		snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: src.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Memory: true, Tier: Tier}
		if err := m.liveSnapshot(ctx, src, &snap, t); err != nil {
			src.mu.Unlock()
			return proto.SandboxInfo{}, err
		}
		snapID = snap.ID
	case proto.StateStopped:
		latest := m.latestSnapshot(src.meta.ID)
		if latest == "" {
			src.mu.Unlock()
			return proto.SandboxInfo{}, conflict("sandbox %s has no snapshot to fork", src.meta.ID)
		}
		snapID = latest
	default:
		src.mu.Unlock()
		return proto.SandboxInfo{}, conflict("sandbox %s is %s", src.meta.ID, src.meta.State)
	}
	env := src.meta.Env
	if p.Env != nil {
		// The fork's own: its protected placeholders aren't its source's.
		env = p.Env
	}
	params := proto.CreateParams{SandboxID: p.NewID, Size: src.meta.Size, From: snapID, Env: env, SSHAuthorizedKeys: src.meta.SSHKeys, Egress: p.Egress, Owner: src.meta.Owner}
	if params.Egress == nil {
		params.Egress = src.meta.Egress
	}
	src.mu.Unlock()
	m.pruneAuto(src.meta.ID)
	t.step("prune", &start)
	info, err := m.Create(ctx, params)
	if err != nil {
		return info, err
	}
	for k, v := range info.Timings {
		t["clone."+k] = v
	}
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info.Timings = t
	info.Source = "fork"
	return info, nil
}

// liveSnapshot snapshots a running sandbox (memory and disk) and lets it carry on. Called with s.mu held.
func (m *Manager) liveSnapshot(ctx context.Context, s *sandbox, snap *proto.SnapshotInfo, t timings) error {
	// Before anything is written: the ID is joined under snapshots/, so one such as ../sandboxes/<id>/vm would put this
	// sandbox's disk into another's.
	if !validID(snap.ID) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	start := time.Now()
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return err
	}
	_ = s.guest.Sync(ctx)
	t.step("sync", &start)
	// Firecracker resets the VM's vsock connections when it snapshots: a kept-alive one would answer the next call
	// with EOF (seen after a live fork). Drop them so the next call dials afresh.
	s.guest.Close()
	if err := s.machine.Pause(ctx); err != nil {
		return err
	}
	defer func() {
		_ = s.machine.Resume(context.Background())
		s.guest.Close()
		t.step("resume", &start)
	}()
	memWrite, memDone := m.memFile(s.meta.Size, filepath.Join(sdir, "mem"))
	if err := s.machine.Snapshot(ctx, filepath.Join(sdir, "state"), memWrite); err != nil {
		_ = memDone(false)
		os.RemoveAll(sdir)
		return err
	}
	if err := memDone(true); err != nil {
		os.RemoveAll(sdir)
		return err
	}
	t.step("snapshot", &start)
	if err := copySparse(filepath.Join(s.vmDir(), fc.DiskFile), filepath.Join(sdir, fc.DiskFile)); err != nil {
		os.RemoveAll(sdir)
		return err
	}
	t.step("disk", &start)
	snap.SizeBytes = diskUsage(filepath.Join(sdir, fc.DiskFile)) + diskUsage(filepath.Join(sdir, "mem"))
	return m.writeSnapshotMeta(s, snap)
}

type snapshotMeta struct {
	proto.SnapshotInfo
	Size string `json:"size"`
	// Rootfs is the root filesystem its disk is a layer over (base.go); empty in snapshots from before it was kept.
	Rootfs string `json:"rootfs,omitempty"`
}

func (m *Manager) snapshotDir(id string) string {
	return filepath.Join(m.cfg.Root, "snapshots", id)
}

func (m *Manager) writeSnapshotMeta(s *sandbox, snap *proto.SnapshotInfo) error {
	rootfs, base := rootfsOf(s.vmDir())
	snap.Base = base
	raw, _ := json.MarshalIndent(snapshotMeta{SnapshotInfo: *snap, Size: s.meta.Size, Rootfs: rootfs}, "", "  ")
	return os.WriteFile(filepath.Join(m.snapshotDir(snap.ID), "meta.json"), raw, 0o600)
}

func (m *Manager) readSnapshot(id string) (snapshotMeta, error) {
	if !validID(id) {
		return snapshotMeta{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	raw, err := os.ReadFile(filepath.Join(m.snapshotDir(id), "meta.json"))
	if err != nil {
		return snapshotMeta{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no snapshot %s on this host", id)}
	}
	var out snapshotMeta
	return out, json.Unmarshal(raw, &out)
}

// saveSnapshot keeps a stopped sandbox's state as a snapshot: its disk copied, its memory (if any) linked, since a
// memory file is never written after it is made. Called with s.mu held.
func (m *Manager) saveSnapshot(s *sandbox, snap *proto.SnapshotInfo, fromStop bool) error {
	if !validID(snap.ID) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return err
	}
	vm := s.vmDir()
	if err := copySparse(filepath.Join(vm, fc.DiskFile), filepath.Join(sdir, fc.DiskFile)); err != nil {
		os.RemoveAll(sdir)
		return err
	}
	if snap.Memory {
		if err := os.Link(filepath.Join(vm, "state"), filepath.Join(sdir, "state")); err != nil {
			snap.Memory = false
		} else if err := m.spool.link(filepath.Join(vm, "mem"), filepath.Join(sdir, "mem")); err != nil {
			snap.Memory = false
		}
	}
	snap.SizeBytes = diskUsage(filepath.Join(sdir, fc.DiskFile))
	if snap.Memory {
		snap.SizeBytes += diskUsage(filepath.Join(sdir, "mem"))
	}
	return m.writeSnapshotMeta(s, snap)
}

func (m *Manager) snapshotsOf(sandboxID string) []snapshotMeta {
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "snapshots"))
	var out []snapshotMeta
	for _, e := range entries {
		snap, err := m.readSnapshot(e.Name())
		if err == nil && (sandboxID == "" || snap.SandboxID == sandboxID) {
			out = append(out, snap)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

func (m *Manager) latestSnapshot(sandboxID string) string {
	for _, snap := range m.snapshotsOf(sandboxID) {
		return snap.ID
	}
	return ""
}

// pruneAuto keeps the newest AutoSnapshots automatic snapshots of a sandbox, and memory only on the newest one.
func (m *Manager) pruneAuto(sandboxID string) {
	auto := 0
	for _, snap := range m.snapshotsOf(sandboxID) {
		if snap.Kind != "auto" {
			continue
		}
		auto++
		dir := m.snapshotDir(snap.ID)
		if auto > m.cfg.AutoSnapshots {
			_ = os.RemoveAll(dir)
			continue
		}
		if auto > 1 && snap.Memory {
			_ = os.Remove(filepath.Join(dir, "mem"))
			_ = os.Remove(filepath.Join(dir, "state"))
			snap.Memory = false
			raw, _ := json.MarshalIndent(snap, "", "  ")
			_ = os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600)
		}
	}
}

// Snapshots lists a sandbox's snapshots, newest first.
func (m *Manager) Snapshots(sandboxID string) []proto.SnapshotInfo {
	var out []proto.SnapshotInfo
	for _, snap := range m.snapshotsOf(sandboxID) {
		out = append(out, snap.SnapshotInfo)
	}
	return out
}

// SaveSnapshot keeps a sandbox's current state under a name, until it is deleted: live for a running sandbox
// (memory too), from its newest snapshot for a stopped one.
func (m *Manager) SaveSnapshot(ctx context.Context, p proto.SnapshotParams) (proto.SnapshotInfo, error) {
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SnapshotInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "saved", Name: p.Name, CreatedAt: time.Now().UnixMilli(), Tier: Tier}
	if !validID(snap.ID) {
		return snap, &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	switch s.meta.State {
	case proto.StateRunning:
		snap.Memory = true
		return snap, m.liveSnapshot(ctx, s, &snap, timings{})
	case proto.StateStopped:
		snap.Memory = s.meta.Memory
		return snap, m.saveSnapshot(s, &snap, false)
	default:
		return snap, conflict("sandbox %s is %s", s.meta.ID, s.meta.State)
	}
}

// DeleteSnapshot removes a snapshot.
func (m *Manager) DeleteSnapshot(id string) error {
	if _, err := m.readSnapshot(id); err != nil {
		return err
	}
	return os.RemoveAll(m.snapshotDir(id))
}

// Delete ends a sandbox and removes its disk and automatic snapshots. Saved snapshots stay.
func (m *Manager) Delete(ctx context.Context, id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.machine != nil {
		machine := s.machine
		s.machine = nil
		machine.Kill()
	}
	if s.guest != nil {
		s.guest.Close()
	}
	if s.link != nil {
		m.cfg.Network.Remove(*s.link)
		m.detach(s.link.Slot)
		s.link = nil
	}
	for _, snap := range m.snapshotsOf(id) {
		if snap.Kind == "auto" {
			_ = os.RemoveAll(m.snapshotDir(snap.ID))
		}
	}
	if err := os.RemoveAll(s.dir); err != nil {
		return err
	}
	m.unregister(id)
	s.meta.State = proto.StateDeleted
	m.emit(s)
	return nil
}

// Get is one sandbox.
func (m *Manager) Get(id string) (proto.SandboxInfo, error) {
	s, err := m.get(id)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return m.info(s), nil
}

// List is every sandbox of the tier.
func (m *Manager) List() []proto.SandboxInfo {
	m.mu.Lock()
	list := make([]*sandbox, 0, len(m.sandboxes))
	for _, s := range m.sandboxes {
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]proto.SandboxInfo, 0, len(list))
	for _, s := range list {
		s.mu.Lock()
		out = append(out, m.info(s))
		s.mu.Unlock()
	}
	return out
}

func (m *Manager) running(id string) (*guest.Client, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning || s.guest == nil {
		return nil, conflict("sandbox %s is %s, not running", id, s.meta.State)
	}
	return s.guest, nil
}

// Exec runs a command in a running sandbox. With onOutput, output is streamed to it as it comes.
func (m *Manager) Exec(ctx context.Context, p proto.ExecParams, onOutput func(stdout, stderr string)) (proto.ExecResult, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return proto.ExecResult{}, err
	}
	req := guest.ExecRequest{Command: p.Command, Argv: p.Argv, Cwd: p.Cwd, Env: p.Env, User: p.User, TimeoutMs: p.TimeoutMs, Stdin: p.Stdin, Detached: p.Detached}
	if p.Attribution != "" {
		req.ProxyUser = "sandbox-" + sanitizeUser(p.Attribution)
	}
	if !p.Stream || onOutput == nil {
		res, err := client.Exec(ctx, req)
		return proto.ExecResult(res), err
	}
	started := time.Now()
	result := proto.ExecResult{}
	err = client.ExecStream(ctx, req, func(event guest.ExecEvent) error {
		if event.Stdout != "" || event.Stderr != "" {
			onOutput(event.Stdout, event.Stderr)
		}
		if event.Exit != nil {
			result.ExitCode = *event.Exit
			result.TimedOut = event.TimedOut
		}
		if event.Error != "" {
			return errors.New(event.Error)
		}
		return nil
	})
	result.DurationMs = time.Since(started).Milliseconds()
	return result, err
}

func sanitizeUser(s string) string {
	s = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '-'
	}, s)
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

func (m *Manager) ReadFile(ctx context.Context, p proto.FileParams) ([]byte, uint32, int64, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return nil, 0, 0, err
	}
	data, mode, size, err := client.ReadFile(ctx, p.Path, p.Offset, p.Length)
	if guest.IsNotFound(err) {
		return nil, 0, 0, &proto.Error{Code: proto.ErrNotFound, Message: err.Error()}
	}
	return data, mode, size, err
}

func (m *Manager) WriteFile(ctx context.Context, p proto.FileParams, data []byte) error {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return err
	}
	return client.WriteFile(ctx, p.Path, data, p.Mode)
}

func (m *Manager) DeleteFile(ctx context.Context, p proto.FileParams) error {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return err
	}
	return client.DeleteFile(ctx, p.Path, p.Recursive)
}

func (m *Manager) ListFiles(ctx context.Context, p proto.FileParams) ([]proto.FileEntry, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return nil, err
	}
	entries, err := client.ListFiles(ctx, p.Path)
	if guest.IsNotFound(err) {
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: err.Error()}
	}
	out := make([]proto.FileEntry, len(entries))
	for i, e := range entries {
		out[i] = proto.FileEntry(e)
	}
	return out, err
}

// DialPort opens a stream to a port on a running sandbox's loopback (22 SSH, 5901 the desktop's VNC, 9222
// Chromium's DevTools, or an app's).
func (m *Manager) DialPort(ctx context.Context, id string, port int) (net.Conn, error) {
	client, err := m.running(id)
	if err != nil {
		return nil, err
	}
	return client.DialPort(ctx, port)
}

// Close stops filling the pool and ends the warm VMs. Sandboxes keep running.
func (m *Manager) Close() {
	m.closed.Store(true)
	m.mu.Lock()
	pools := m.pool
	m.pool = map[string][]*warm{}
	m.mu.Unlock()
	for _, list := range pools {
		for _, w := range list {
			w.machine.Kill()
			m.cfg.Network.Remove(w.link)
			_ = os.RemoveAll(w.dir)
		}
	}
}

// Usage is the memory the tier's running sandboxes were given, and how many run and are stopped.
func (m *Manager) Usage() (memoryMiB int64, running int, stopped int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sandboxes {
		switch s.meta.State {
		case proto.StateRunning, proto.StateStarting:
			running++
			if size, err := m.size(s.meta.Size); err == nil {
				memoryMiB += int64(size.MemoryMiB)
			}
		case proto.StateStopped:
			stopped++
		}
	}
	return
}

// TemplateTimings is the cold boot of each size's template, as measured when it was made.
func (m *Manager) TemplateTimings() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for _, size := range m.cfg.Sizes {
		if raw, err := os.ReadFile(filepath.Join(m.cfg.Root, "templates", size.Name, "ready")); err == nil {
			out[size.Name] = raw
		}
	}
	return out
}

var _ = io.EOF
var _ = strconv.Itoa

// SetEgress replaces a sandbox's egress: a running one's rules, upstream and headers change at once, and so does a
// move to or from "none" (the only mode the network itself knows about).
// EgressOf answers a sandbox's egress as it keeps it in meta.json (CA certificate included), which a fork with none
// of its own inherits.
func (m *Manager) EgressOf(id string) (*proto.Egress, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Egress == nil {
		return nil, nil
	}
	e := *s.meta.Egress
	return &e, nil
}

func (m *Manager) SetEgress(id string, e *proto.Egress) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.meta.Egress = e
	running, slot := s.meta.State == proto.StateRunning, s.meta.Slot
	err = m.writeMeta(s)
	if running {
		m.attach(s, slot)
		// A move to or from "none" opens or shuts the proxy to it at once; the rest is the proxy's rules.
		if s.link != nil {
			if nerr := m.cfg.Network.SetEgress(s.link, egressMode(e)); nerr != nil && err == nil {
				err = nerr
			}
		}
	}
	s.mu.Unlock()
	return err
}
