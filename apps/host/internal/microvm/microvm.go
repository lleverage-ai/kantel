// Package microvm is the microVM tier: each sandbox is a Firecracker VM with its own kernel, systemd, Docker, SSH, a
// desktop and Chromium, and /dev/kvm when the host CPU nests.
//
// How a sandbox is fast to get:
//
//   - Template snapshots. For each size the host cold-boots one VM once, waits until every service is up, and
//     snapshots it (memory and disk). A new sandbox restores that snapshot instead of booting: the memory file is
//     mapped copy-on-write (MAP_PRIVATE), so every sandbox shares its unchanged pages.
//   - No warm pool. The host keeps no idle running VMs waiting for a create: a create restores a snapshot.
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
//	images/templates/<key>.ext4               templates' root filesystems, made from their pulled bases (rootfs.go)
//	template-snapshots/<id>/                  templates' snapshots (templates.go), never under snapshots/
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
	"runtime"
	"slices"
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
	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
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

// A custom size is a shape off the named sizes, named custom-<vcpus>c-<memoryMiB>m-<diskGiB>g (such as
// custom-5c-8192m-60g); names starting custom- are kept for them. It cold-boots: the host keeps no template or warm
// pool for it.
const (
	customPrefix       = "custom-"
	maxCustomVCPUs     = 32
	minCustomMemoryMiB = 128
	maxCustomDiskGiB   = 4096
)

// CustomSizeName is the size name of a custom shape.
func CustomSizeName(vcpus, memoryMiB, diskGiB int) string {
	return fmt.Sprintf("%s%dc-%dm-%dg", customPrefix, vcpus, memoryMiB, diskGiB)
}

// isCustom says a size name is a custom shape's, not one of the host's named sizes.
func isCustom(name string) bool {
	return strings.HasPrefix(name, customPrefix)
}

// parseCustomSize reads a name as CustomSizeName writes it; ok is false for anything else (signs, leading zeros,
// other units).
func parseCustomSize(name string) (vcpus, memoryMiB, diskGiB int, ok bool) {
	rest, found := strings.CutPrefix(name, customPrefix)
	if !found {
		return 0, 0, 0, false
	}
	parts := strings.Split(rest, "-")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	var n [3]int
	for i, unit := range []string{"c", "m", "g"} {
		digits, found := strings.CutSuffix(parts[i], unit)
		if !found || digits == "" || len(digits) > 9 {
			return 0, 0, 0, false
		}
		for _, r := range digits {
			if r < '0' || r > '9' {
				return 0, 0, 0, false
			}
		}
		v, err := strconv.Atoi(digits)
		if err != nil {
			return 0, 0, 0, false
		}
		n[i] = v
	}
	// One name per shape: custom-05c-... isn't custom-5c-....
	if CustomSizeName(n[0], n[1], n[2]) != name {
		return 0, 0, 0, false
	}
	return n[0], n[1], n[2], true
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
	// Initrd is Kantel's initramfs (guestinit.Build): when set, every cold boot goes through it, which puts the guest
	// agent into the image, so Rootfs may be any Linux root filesystem (injectGuestAgent, experimental). Empty boots
	// the image's own kantel-init and agent.
	Initrd string
	// SharedTemplate: a template snapshot per vCPU count, each serving every memory and disk of that count (named
	// sizes and custom shapes alike), instead of one per named size, so any shape the sliders pick restores in a
	// fraction of a second (shared.go). After a restore the sandbox's extra memory is plugged (virtio-mem) and its
	// disk grown. The named sizes' counts are made in the background when the tier starts; a create of a count with
	// no template yet cold-boots while its template is made. A shape that doesn't fit (more vCPUs than
	// TemplateVCPUs, less memory than its count boots with or more than it grows to, a smaller disk) cold-boots.
	// Unset, the Template fields default as sharedShape says. Off: a template per named size, and custom shapes
	// cold-boot.
	SharedTemplate       bool
	TemplateVCPUs        int
	TemplateMemoryMiB    int
	TemplateMaxMemoryMiB int
	TemplateDiskGiB      int
	// TemplateRegistry is the operator's registry templates' Kantel base images are pulled from by digest, such as
	// ghcr.io/lleverage-ai (rootfs.go). Empty: templates are made only from Rootfs, the host's own image.
	TemplateRegistry string
	// Budget is what the tier may use now: the host's memory budget less what its other tiers use, and its free disk.
	// Each create, start or resume and template build is admitted against it (admit), beside what the tier holds. It is
	// called with the tier's lock held, so it mustn't call the tier. Nil admits everything.
	Budget func() (memoryMiB, diskGiB int64)
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
	// GrowDisk: the disk (its file, or the guest's file system) may still be smaller than the size's, as a sandbox
	// restored from a shared template's or a snapshot's disk starts. Set until growDisk has made it the size's, so a
	// stop, a host restart or a snapshot before then doesn't leave it smaller for good.
	GrowDisk bool `json:"growDisk,omitempty"`
	// Rootfs is the root filesystem when it isn't the host's image: a template's (images/templates/<key>.ext4). Its
	// snapshots keep it, so a sandbox made from one reads the same.
	Rootfs string `json:"rootfs,omitempty"`
	// Guest is what its image has when it was made from a template (of a pulled base or of the host's image), as that
	// template's agent reported it (nil: an agent too old to say). Other sandboxes of the host's image have none and
	// report the shared Manager.guest instead. Its snapshots keep it.
	Guest *proto.GuestCapabilities `json:"guest,omitempty"`
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

// Manager runs the tier.
type Manager struct {
	cfg       Config
	log       *slog.Logger
	mu        sync.Mutex
	sandboxes map[string]*sandbox
	// templates are the template directories' locks, by name: a named size's (with shared templates off) or a
	// shared template's (shared-<n>vcpu, made on first use).
	templates map[string]*sync.Mutex
	// shared is the shared templates' shape when Config.SharedTemplate is on, and sharedOff set once the guest
	// kernel turns out unable to grow one. preparing are the vCPU counts whose template is being made in the
	// background, sharedFailed when a count's last failed.
	shared       *sharedConfig
	sharedOff    atomic.Bool
	preparing    map[int]bool
	sharedFailed map[int]time.Time
	// sharedDeferred: until when a count whose template had no room on the host waits (holdOwnBuild).
	sharedDeferred map[int]time.Time
	// sizeTemplatesDropped: the named sizes' templates (from shared templates off, or a host from before them) are
	// removed once, when a shared template is first ready.
	sizeTemplatesDropped sync.Once
	nextCID              atomic.Uint32
	closed               atomic.Bool
	// bg is the background template builds' context, ended by Close, which waits for builders (counted, under mu, only
	// while not closed) to settle: their VMs are disposable, unlike sandboxes', which outlive the daemon.
	bg       context.Context
	bgStop   context.CancelFunc
	builders sync.WaitGroup
	// holdGrowth (tests) makes growDisk give up as a stop or a restart before it would: the growth stays pending.
	holdGrowth atomic.Bool
	spool      *spool
	// inUse is held (read) from picking a template until restoring it, so a background rebuild swaps it in between
	// creates (base.go): a named size's (made in New) or a shared template's (made on first use), by name.
	inUse map[string]*sync.RWMutex
	// rebuilding are the templates being rebuilt in the background, by name; rebuild does it (swapTemplate when nil,
	// tests replace it).
	rebuilding map[string]bool
	rebuild    func(ctx context.Context, sh shape) error
	// bases is the base lock: read while a reference to an image version is made or moved, written by a prune from its
	// walk of what is in use until its removals (base.go).
	bases sync.RWMutex
	// pinning serialises PinBases; pinned is its first success (base.go).
	pinning sync.Mutex
	pinned  atomic.Bool
	// guests are what each image has, as the agent in a template on it reported (guestFile), by that image's version
	// ("" when the images aren't versioned); a nil report is an agent too old to say. A sandbox is told its own base's:
	// with image patching, sandboxes on older versions run beside ones on the current version.
	guestsMu sync.Mutex
	guests   map[string]*proto.GuestCapabilities
	// hostMemoryMiB is the machine's memory, a custom shape's ceiling (0: unknown, no ceiling but the sanity cap).
	hostMemoryMiB int64
	// tpl is templates' root filesystems and snapshots (templates.go).
	tpl *templateCache
	// builds are the template builds admitted and not yet ended, by snapshot ID, with their machines: guarded by mu,
	// with sandboxes, so a create and a build are admitted one at a time against what both hold.
	builds map[string]proto.Size
	// resuming are the stopped sandboxes admitted to start again (Resume) and not yet running, by ID, with the memory
	// and disk each holds meanwhile (holdResume): guarded by mu, as builds are.
	resuming map[string]proto.Size
	// ownBuilds are the tier's own background template builds (a shared template's, or a template's rebuild on new
	// images) admitted and not yet ended, with their machines (holdOwnBuild): held as builds are, but no control plane
	// asked for them, so TemplateBuilds counts them without naming them. Guarded by mu; ownBuildSeq names them.
	ownBuilds   map[int]proto.Size
	ownBuildSeq int
	// prepareOnce starts the shared templates' preparation once (PrepareTemplates).
	prepareOnce sync.Once
}

// guestFile, in a template, is its agent's capability report. The manager's root keeps each image's too (guestPath),
// from a template or a custom shape's boot (which has no template), so a host that restarts still has them, and a
// sandbox on an older version still has its own once its template has been rebuilt.
const (
	guestFile = "guest.json"
	guestsDir = "guests"
)

// bootConfig is a cold boot of a shape on kernel (kernelFor: its root filesystem's version's): through Kantel's
// initramfs when the host injects the agent, with its hotpluggable memory when it has some (a shared template).
func (m *Manager) bootConfig(sh shape, kernel, tap, mac string, cid uint32) fc.BootConfig {
	cfg := fc.BootConfig{VCPUs: sh.VCPUs, MemoryMiB: sh.MemoryMiB, Kernel: kernel, BootArgs: bootArgs, TapDevice: tap, MAC: mac, GuestCID: cid, HotplugMiB: sh.HotplugMiB}
	if m.cfg.Initrd != "" {
		cfg.Initrd, cfg.BootArgs = m.cfg.Initrd, guestinit.BootArgs
	}
	if sh.HotplugMiB > 0 {
		cfg.BootArgs += hotplugBootArgs
	}
	return cfg
}

// noteGuest keeps what a template's agent reported (nil: an agent too old to say), as what the image version the
// template is on has.
func (m *Manager) noteGuest(dir string, caps *proto.GuestCapabilities) {
	// Even nil: a template with no report mustn't keep the one before it on the same image.
	base := images.VersionOf(m.sizeTemplateRootfs(dir))
	m.keepGuest(base, caps)
	writeGuest(filepath.Join(dir, guestFile), caps)
}

// noteBootGuest keeps what a custom shape's boot on image version base reported: there is no template to keep it in,
// so the root does.
func (m *Manager) noteBootGuest(base string, caps *proto.GuestCapabilities) {
	m.keepGuest(base, caps)
}

// keepGuest is what image version base has, in memory and in the root (guestPath).
func (m *Manager) keepGuest(base string, caps *proto.GuestCapabilities) {
	m.guestsMu.Lock()
	if m.guests == nil {
		m.guests = map[string]*proto.GuestCapabilities{}
	}
	m.guests[base] = caps
	m.guestsMu.Unlock()
	if m.cfg.Root != "" {
		writeGuest(m.guestPath(base), caps)
	}
}

// guestPath is where the root keeps image version base's report: guest.json for images that aren't versioned, as
// before versions, and guests/<version>.json for each version.
func (m *Manager) guestPath(base string) string {
	if base == "" {
		return filepath.Join(m.cfg.Root, guestFile)
	}
	return filepath.Join(m.cfg.Root, guestsDir, base+".json")
}

// writeGuest puts a report in file, or removes it for nil.
func writeGuest(file string, caps *proto.GuestCapabilities) {
	if caps == nil {
		_ = os.Remove(file)
		return
	}
	if raw, err := json.Marshal(caps); err == nil {
		_ = os.MkdirAll(filepath.Dir(file), 0o700)
		_ = fsutil.WriteFileDurably(file, raw, 0o600)
	}
}

// sandboxGuest is what a sandbox's image has: its template's own report, else (a sandbox of the host's image with
// none, such as one of an agent too old to say) the report of the host image version it is on (guestOf).
func (m *Manager) sandboxGuest(s *sandbox) *proto.GuestCapabilities {
	if s.meta.Guest != nil || s.meta.Rootfs != "" {
		return s.meta.Guest
	}
	return m.guestOf(baseOf(s.vmDir()))
}

// guestReport asks a freshly booted guest's agent what its image has, before the image's services start (detection
// reads its files). An injected agent always reports, so an error then is the boot's; an agent too old to say answers
// nil.
func (m *Manager) guestReport(ctx context.Context, client *guest.Client, name string) (*proto.GuestCapabilities, error) {
	capsCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	caps, err := client.Capabilities(capsCtx)
	if err != nil && m.cfg.Initrd != "" {
		return nil, fmt.Errorf("the guest agent's capabilities: %w", err)
	}
	if err != nil {
		m.log.Warn("guest agent's capabilities", "boot", name, "error", err)
		return nil, nil
	}
	return caps, nil
}

// loadGuest reads a ready template's report, for a host that restarted (its templates are kept), unless its image's is
// already known. A versioned image's is kept in the root too: a template from before reports were kept by version (one
// PinBases has just pinned) would otherwise take its image's report with it when it is rebuilt on another.
func (m *Manager) loadGuest(dir string) {
	base := images.VersionOf(m.sizeTemplateRootfs(dir))
	m.guestsMu.Lock()
	defer m.guestsMu.Unlock()
	if _, known := m.guests[base]; known {
		return
	}
	var caps proto.GuestCapabilities
	if raw, err := os.ReadFile(filepath.Join(dir, guestFile)); err == nil && json.Unmarshal(raw, &caps) == nil {
		if m.guests == nil {
			m.guests = map[string]*proto.GuestCapabilities{}
		}
		m.guests[base] = &caps
		if base != "" && m.cfg.Root != "" {
			writeGuest(m.guestPath(base), &caps)
		}
	}
}

// loadGuests reads the reports kept for each image version (guestsDir), for a host that restarted.
func (m *Manager) loadGuests() {
	bases := []string{""}
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, guestsDir))
	for _, e := range entries {
		if base, ok := strings.CutSuffix(e.Name(), ".json"); ok && images.ValidVersion(base) {
			bases = append(bases, base)
		}
	}
	m.guestsMu.Lock()
	defer m.guestsMu.Unlock()
	for _, base := range bases {
		var caps proto.GuestCapabilities
		if raw, err := os.ReadFile(m.guestPath(base)); err == nil && json.Unmarshal(raw, &caps) == nil {
			if m.guests == nil {
				m.guests = map[string]*proto.GuestCapabilities{}
			}
			m.guests[base] = &caps
		}
	}
}

// guestOf is what the image version base has, as its template's agent reported (nil when no report is known).
func (m *Manager) guestOf(base string) *proto.GuestCapabilities {
	m.guestsMu.Lock()
	defer m.guestsMu.Unlock()
	return m.guests[base]
}

// rebasedGuest asks the guest a rebase has just booted what its image has, unless image version base's report is kept
// already (a template built on it, or an earlier boot): a host on custom shapes alone may have no template on it, and a
// sandbox without its version's report would be offered what that image may lack. An injected agent that can't say
// fails the boot, as for a custom shape's create.
func (m *Manager) rebasedGuest(ctx context.Context, client *guest.Client, base string, size proto.Size) error {
	m.guestsMu.Lock()
	_, known := m.guests[base]
	m.guestsMu.Unlock()
	if known {
		return nil
	}
	caps, err := m.guestReport(ctx, client, size.Name)
	if err != nil {
		return err
	}
	if caps != nil {
		m.noteBootGuest(base, caps)
	}
	return nil
}

// ForgetGuests drops the reports kept for image versions a prune removed.
func (m *Manager) ForgetGuests(versions []string) {
	m.guestsMu.Lock()
	defer m.guestsMu.Unlock()
	for _, v := range versions {
		if !images.ValidVersion(v) {
			continue
		}
		delete(m.guests, v)
		_ = os.Remove(m.guestPath(v))
	}
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
	for _, dir := range []string{"templates", "sandboxes", "snapshots"} {
		if err := os.MkdirAll(filepath.Join(cfg.Root, dir), 0o700); err != nil {
			return nil, err
		}
	}
	m := &Manager{cfg: cfg, log: cfg.Log.With("tier", Tier), sandboxes: map[string]*sandbox{}, templates: map[string]*sync.Mutex{}, inUse: map[string]*sync.RWMutex{}, rebuilding: map[string]bool{}, preparing: map[int]bool{}, sharedFailed: map[int]time.Time{}}
	m.bg, m.bgStop = context.WithCancel(context.Background())
	// Template builds a previous run left (it stopped or crashed mid-build) are ended by reapInterruptedBuilds, below.
	m.hostMemoryMiB = hostinfo.MemoryMiB()
	m.shared = sharedShape(cfg, m.hostMemoryMiB, defaultCPUs())
	m.nextCID.Store(uint32(time.Now().UnixMilli()%100000) + 100)
	m.spool = newSpool(cfg.SpoolDir, cfg.SpoolMaxMiB<<20, m.log)
	// Each image's report, a custom shape's boot's included; a host from before the root kept them has its templates'.
	m.loadGuests()
	m.tpl = newTemplateCache(cfg.Root, execRunner, cfg.TemplateRegistry)
	for _, size := range cfg.Sizes {
		m.templates[size.Name] = &sync.Mutex{}
		m.inUse[size.Name] = &sync.RWMutex{}
		// What the image has, before any sandbox needs a template: from one made before a restart.
		m.loadGuest(filepath.Join(cfg.Root, "templates", size.Name))
	}
	// Warm VMs a host before warm pools were removed left behind: ended, with their directory.
	entries, _ := os.ReadDir(filepath.Join(cfg.Root, "pool"))
	for _, e := range entries {
		dir := filepath.Join(cfg.Root, "pool", e.Name())
		fc.KillLeftover(filepath.Join(dir, "vm"))
		fc.KillLeftover(dir)
		_ = os.RemoveAll(dir)
	}
	_ = os.Remove(filepath.Join(cfg.Root, "pool"))
	if err := m.adopt(); err != nil {
		return nil, err
	}
	// After adopt, which takes the running sandboxes' network slots: a build's or an unfinished create's is freed only if
	// no sandbox has it.
	m.reapInterruptedBuilds()
	m.reapInterruptedCreates()
	if err := m.PinBases(); err != nil {
		// Retried before each image update and prune, which wait for it.
		m.log.Warn("couldn't pin everything to its images; image updates and prunes wait until it is", "error", err)
	}
	// A template from before its base was recorded is on a version now it is pinned: its report is that version's.
	for _, size := range cfg.Sizes {
		m.loadGuest(filepath.Join(cfg.Root, "templates", size.Name))
	}
	if m.shared != nil && cfg.Budget == nil {
		// Made now, on disk, so the first create restores one rather than booting: they cost disk, not memory. With a
		// budget, once it can say what is free (PrepareTemplates).
		m.PrepareTemplates()
	}
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
			m.spool.cancel(spooled)
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
	if vcpus, memoryMiB, diskGiB, ok := parseCustomSize(name); ok {
		maxVCPUs := min(maxCustomVCPUs, runtime.NumCPU())
		maxMemoryMiB := 1 << 20
		if m.hostMemoryMiB > 0 {
			maxMemoryMiB = int(min(m.hostMemoryMiB, 1<<20))
		}
		if vcpus < 1 || vcpus > maxVCPUs || memoryMiB < minCustomMemoryMiB || memoryMiB > maxMemoryMiB || diskGiB < 1 || diskGiB > maxCustomDiskGiB {
			return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("a custom size on this host is 1 to %d vCPUs, %d to %d MiB of memory and 1 to %d GiB of disk", maxVCPUs, minCustomMemoryMiB, maxMemoryMiB, maxCustomDiskGiB)}
		}
		return proto.Size{Name: name, VCPUs: vcpus, MemoryMiB: memoryMiB, DiskGiB: diskGiB}, nil
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
	if info.Base != "" {
		info.BaseAt = baseAtOf(s.vmDir())
	}
	if s.link != nil {
		info.Address = s.link.GuestIP.String()
	}
	// Its own image's report: its template's, else its version's (a template rebuilt on a newer version doesn't change
	// what this one boots).
	info.Guest = m.sandboxGuest(s)
	return info
}

func (m *Manager) emit(s *sandbox) {
	if m.cfg.Events != nil {
		m.cfg.Events(m.info(s))
	}
}

// adopt picks up the sandboxes a previous run of the host left: running VMs whose Firecracker is still alive keep
// running; the rest are stopped. Creates it left unfinished (starting) aren't sandboxes: reapInterruptedCreates ends them.
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
		if err := json.Unmarshal(raw, &s.meta); err != nil || s.meta.State == proto.StateStarting {
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
				if s.meta.GrowDisk {
					// The previous run answered its create but restarted before growing its disk.
					if size, err := m.size(s.meta.Size); err == nil {
						go m.growDisk(s, size.DiskGiB)
					}
				}
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
		MAC:        s.link.MAC,
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

// templateLock is the lock a template's directory is made under: a named size's, or a shared template's (made on
// first use). nil for any other name: no template is kept for a custom shape.
func (m *Manager) templateLock(name string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	lock := m.templates[name]
	if lock == nil && strings.HasPrefix(name, sharedPrefix) {
		lock = &sync.Mutex{}
		m.templates[name] = lock
	}
	return lock
}

// templateShape is the size's part of a template's fingerprint: a snapshot restores the vCPUs and memory it was made
// with, so a size that changes (a new default, or the host's settings) needs a new template.
func templateShape(size proto.Size) string {
	return fmt.Sprintf(" size=%d/%d/%d", size.VCPUs, size.MemoryMiB, size.DiskGiB)
}

// shapeKey is a shape's part of its template's fingerprint: the size's, and a shared template's hotpluggable memory
// and the boot arguments its guest needs to plug it.
func (m *Manager) shapeKey(sh shape) string {
	key := templateShape(sh.Size)
	if sh.HotplugMiB > 0 {
		key += fmt.Sprintf(" hotplug=%d args=%q", sh.HotplugMiB, m.bootConfig(sh, "", "", "", 0).BootArgs)
	}
	return key
}

// templateFingerprint is what a shape's template is made with: Firecracker, the kernel, the images, Kernel's
// initramfs when it injects the guest agent (its name has the agent's digest: another agent, or turning injection on
// or off, makes a new template) and the shape.
func (m *Manager) templateFingerprint(sh shape) string {
	images := []string{m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs}
	if m.cfg.Initrd != "" {
		images = append(images, m.cfg.Initrd)
	}
	return fc.Fingerprint(images...) + m.shapeKey(sh)
}

// templateReady says whether the shape's template can be restored now without making it: made for these images, or,
// with BackgroundTemplates, for others but the same shape (template then starts its rebuild and returns it meanwhile).
func (m *Manager) templateReady(sh shape) bool {
	dir := filepath.Join(m.cfg.Root, "templates", sh.Name)
	if _, err := os.Stat(filepath.Join(dir, "ready")); err != nil {
		return false
	}
	made, _ := os.ReadFile(filepath.Join(dir, "images"))
	return string(made) == m.templateFingerprint(sh) || m.cfg.BackgroundTemplates && strings.HasSuffix(string(made), m.shapeKey(sh))
}

// template returns the shape's template snapshot (a named size's, or a shared one), cold-booting one if there is none.
// With BackgroundTemplates, one made with other images (but the same shape) is still returned while its replacement
// builds (base.go).
func (m *Manager) template(ctx context.Context, sh shape) (string, timings, error) {
	size := sh.Size
	lock := m.templateLock(size.Name)
	if lock == nil {
		// A custom shape (or a size this host doesn't have): templates are kept for the named sizes only.
		return "", nil, &proto.Error{Code: proto.ErrInternal, Message: fmt.Sprintf("no template is kept for size %q", size.Name)}
	}
	lock.Lock()
	defer lock.Unlock()
	dir := filepath.Join(m.cfg.Root, "templates", size.Name)
	if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
		made, _ := os.ReadFile(filepath.Join(dir, "images"))
		if string(made) == m.templateFingerprint(sh) {
			m.loadGuest(dir)
			return dir, nil, nil
		}
		if m.cfg.BackgroundTemplates && strings.HasSuffix(string(made), m.shapeKey(sh)) {
			// Sandboxes made from it meanwhile are on its images, as their Base says.
			m.rebuildTemplate(sh)
			return dir, nil, nil
		}
		// Made with other images (an update) or another shape: running sandboxes keep their mapping of the old memory file.
		m.log.Info("template is for other images or another shape; rebuilding", "size", size.Name)
	}
	t, err := m.buildTemplate(ctx, sh, dir)
	if err != nil {
		return "", nil, err
	}
	return dir, t, nil
}

// buildTemplate cold-boots a VM of the shape on the current images, waits for its services, and snapshots it into
// dir (replacing what is there), recording the images it was made with and the root filesystem it is over (rootfs).
func (m *Manager) buildTemplate(ctx context.Context, sh shape, dir string) (timings, error) {
	size := sh.Size
	fingerprint := m.templateFingerprint(sh)
	_ = os.RemoveAll(dir)
	t, caps, _, err := m.bootSnapshot(ctx, snapshotBoot{
		dir: dir, name: size.Name, rootfs: m.cfg.Rootfs, size: size, hotplugMiB: sh.HotplugMiB, egress: network.EgressNone,
		record: func(building, rootfs string) error {
			return os.WriteFile(filepath.Join(building, "rootfs"), []byte(rootfs), 0o600)
		},
	})
	if err != nil {
		return nil, err
	}
	start := time.Now()
	if sh.HotplugMiB > 0 {
		// The memory file holds every page of the boot memory, most of them never touched (zero): holes cost no disk.
		_ = exec.Command("fallocate", "--dig-holes", filepath.Join(dir, "mem")).Run()
		t.step("holes", &start)
	}
	raw, _ := json.Marshal(map[string]any{"size": size, "hotplugMiB": sh.HotplugMiB, "timings": t, "at": time.Now().UnixMilli()})
	m.noteGuest(dir, caps)
	_ = os.WriteFile(filepath.Join(dir, "images"), []byte(fingerprint), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "ready"), raw, 0o600)
	m.log.Info("template ready", "size", size.Name, "timings", t)
	return t, nil
}

// snapshotBoot is one cold boot made into a snapshot: a size's template, or a template build's.
type snapshotBoot struct {
	// dir gets the snapshot (state, mem, disk.ext4); it is made in dir.building and renamed into place.
	dir string
	// name is what the log calls it.
	name string
	// rootfs is the root filesystem it boots: Rootfs, the host's image, boots the version it resolves to (pinRootfs).
	rootfs string
	size   proto.Size
	// hotplugMiB is the memory it can have plugged after a restore, beyond size's (virtio-mem: a shared template's).
	hotplugMiB int
	// egress is the boot's network mode.
	egress string
	// record writes, in the building directory, the snapshot's own reference to the root filesystem it boots, which
	// moves with it to dir: a prune finds the base there once the VM directory has gone.
	record func(building, rootfs string) error
	// prepare, when set, runs once the guest's services are up and before the snapshot (a template build's setup).
	prepare func(ctx context.Context, client *guest.Client, link network.Link) error
}

// bootSnapshot cold-boots a VM of b.rootfs with an empty disk, waits for its services, prepares it, and snapshots its
// memory and disk into b.dir. It answers what the image has, as its guest agent reported it (nil: an agent too old to
// say), and the root filesystem it booted (b.rootfs, or the host image version Rootfs resolved to). The kernel is that
// root filesystem's version's (kernelFor), chosen with it, so an activation while it builds can't pair one version's
// kernel with another's root filesystem.
func (m *Manager) bootSnapshot(ctx context.Context, b snapshotBoot) (timings, *proto.GuestCapabilities, string, error) {
	t := timings{}
	start := time.Now()
	building := b.dir + ".building"
	// A boot this run abandoned may still have its VM: its PID file goes with the directory.
	fc.KillLeftover(filepath.Join(building, "vm"))
	_ = os.RemoveAll(building)
	defer os.RemoveAll(building)
	vm := filepath.Join(building, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return nil, nil, "", err
	}
	// The base is picked and linked under the base lock, and recorded (b.record) before the VM directory goes, so a
	// prune finds it in the building directory, then in the snapshot, from here on.
	unhold := m.holdBases()
	rootfs := m.pinRootfs(b.rootfs)
	err := m.linkRootfs(vm, rootfs)
	if err == nil && b.record != nil {
		err = b.record(building, rootfs)
	}
	unhold()
	if err != nil {
		return nil, nil, "", err
	}
	kernel := m.kernelFor(rootfs)
	if err := newDisk(filepath.Join(vm, fc.DiskFile), b.size.DiskGiB); err != nil {
		return nil, nil, "", err
	}
	t.step("disk", &start)
	link, err := m.cfg.Network.Add(b.egress)
	if err != nil {
		return nil, nil, "", err
	}
	defer m.cfg.Network.Remove(link)
	// So a host that restarts while the boot runs can free its link (reapInterruptedBuilds).
	if err := os.WriteFile(filepath.Join(building, buildSlotFile), []byte(strconv.Itoa(link.Slot)), 0o600); err != nil {
		return nil, nil, "", err
	}
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return nil, nil, "", err
	}
	// Until the process has gone, whatever ended the boot: a template build holds its machine's memory until it returns.
	defer func() {
		machine.Kill()
		<-machine.Done()
	}()
	t.step("launch", &start)
	if err := machine.Boot(ctx, m.bootConfig(shape{Size: b.size, HotplugMiB: b.hotplugMiB}, kernel, link.Tap, link.MAC, m.cid())); err != nil {
		return nil, nil, "", err
	}
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	defer client.Close()
	bootCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if _, err := client.WaitReady(bootCtx); err != nil {
		return nil, nil, "", fmt.Errorf("template boot: %w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	t.step("agent", &start)
	if b.hotplugMiB > 0 {
		if err := checkVirtioMem(bootCtx, client); err != nil {
			return nil, nil, "", fmt.Errorf("template boot: %w", err)
		}
	}
	// What the image has, which detection reads from its files: so before the service wait, whose timeout would
	// otherwise cancel this too.
	caps, err := m.guestReport(ctx, client, b.name)
	if err != nil {
		return nil, nil, "", fmt.Errorf("template boot: %w", err)
	}
	// What the image says it runs (/etc/kantel/ready), else the desktop, browser and Docker. Not SSH: the image has
	// no host keys, so sshd starts only once a sandbox has its identity.
	if _, err := client.WaitExpected(bootCtx, "desktop", "browser", "docker"); err != nil {
		m.log.Warn("template services not all ready; snapshotting anyway", "template", b.name, "error", err)
	}
	t.step("services", &start)
	if b.prepare != nil {
		if err := b.prepare(ctx, client, link); err != nil {
			return nil, nil, "", err
		}
		t.step("prepare", &start)
	}
	_ = client.Sync(ctx)
	client.Close()
	if err := machine.Pause(ctx); err != nil {
		return nil, nil, "", err
	}
	if err := machine.Snapshot(ctx, filepath.Join(building, "state"), filepath.Join(building, "mem")); err != nil {
		return nil, nil, "", err
	}
	t.step("snapshot", &start)
	machine.Kill()
	<-machine.Done()
	_ = os.Remove(filepath.Join(building, buildSlotFile))
	if err := os.Rename(filepath.Join(vm, fc.DiskFile), filepath.Join(building, fc.DiskFile)); err != nil {
		return nil, nil, "", err
	}
	_ = os.RemoveAll(vm)
	// Its record of its base moves with it: not while a prune walks the references.
	unhold = m.holdBases()
	err = os.Rename(building, b.dir)
	unhold()
	if err != nil {
		return nil, nil, "", err
	}
	return t, caps, rootfs, nil
}

// buildSlotFile, in a snapshot boot's building directory, is the network slot its machine's link has.
const buildSlotFile = "slot"

// reapInterruptedBuilds ends the snapshot boots (size templates' and template builds') a previous run of the host left
// running in their building directories, when it stopped without ending them (a crash, or an update's exit): each
// Firecracker is killed and gone before New returns, its link is removed, and its building directory with it, so
// none of their memory, disk or network slots is in use, unaccounted, once the tier takes work. Their builds failed
// with the run; a retry builds again. Finished snapshots and running sandboxes (adopted already) are left as they are.
// The helper containers of root filesystems being made go the same way (rootfsBuilder.reap).
func (m *Manager) reapInterruptedBuilds() {
	adopted := m.adoptedSlots()
	var dirs []string
	for _, parent := range []string{"templates", templateSnapshotsDir} {
		found, _ := filepath.Glob(filepath.Join(m.cfg.Root, parent, "*.building"))
		dirs = append(dirs, found...)
	}
	for _, dir := range dirs {
		fc.KillLeftover(filepath.Join(dir, "vm"))
		raw, err := os.ReadFile(filepath.Join(dir, buildSlotFile))
		slot, convErr := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err == nil && convErr == nil {
			m.removeLeftoverLink(slot, adopted)
		}
		if err := os.RemoveAll(dir); err != nil {
			m.log.Warn("interrupted build's directory", "dir", dir, "error", err)
			continue
		}
		m.log.Info("ended a snapshot boot the host's previous run left", "dir", dir)
	}
	if m.tpl != nil {
		m.tpl.rootfs.reap()
	}
}

// reapInterruptedCreates ends the creates a previous run of the host left unfinished when it stopped (a crash, or an
// update's exit) while their machine started or ran its template's setup, which can take many minutes: each sandbox
// recorded as starting (startMachine records it before its machine starts) has its Firecracker killed and gone, its
// link removed, and its directory with them, before New returns, so none of its memory, disk or network slot is in
// use, unaccounted, once the tier takes work. It isn't adopted as a sandbox, since its setup may have run only in
// part: its create failed with the run, as one that fails does, so the host doesn't have it and a retry of the create
// (the control plane's, from the sandbox's saved recipe) makes it again under the same ID.
func (m *Manager) reapInterruptedCreates() {
	adopted := m.adoptedSlots()
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "sandboxes"))
	for _, e := range entries {
		dir := filepath.Join(m.cfg.Root, "sandboxes", e.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			continue
		}
		var started meta
		if err := json.Unmarshal(raw, &started); err != nil || started.State != proto.StateStarting {
			continue
		}
		fc.KillLeftover(filepath.Join(dir, "vm"))
		m.removeLeftoverLink(started.Slot, adopted)
		if err := os.RemoveAll(dir); err != nil {
			m.log.Warn("interrupted create's directory", "dir", dir, "error", err)
			continue
		}
		m.log.Info("ended a create the host's previous run left unfinished", "sandbox", started.ID)
	}
}

// adoptedSlots are the network slots of the sandboxes adopt found running.
func (m *Manager) adoptedSlots() map[int]bool {
	adopted := map[int]bool{}
	for _, s := range m.sandboxes {
		if s.link != nil {
			adopted[s.link.Slot] = true
		}
	}
	return adopted
}

// removeLeftoverLink removes the link a machine a previous run of the host left had in slot, unless a sandbox adopted
// running has that slot (a record of it gone stale).
func (m *Manager) removeLeftoverLink(slot int, adopted map[int]bool) {
	if slot > 0 && !adopted[slot] && m.cfg.Network != nil {
		m.cfg.Network.Remove(m.cfg.Network.LinkFor(slot, network.EgressNone))
	}
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

func (m *Manager) get(id string) (*sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sandboxes[id]
	if !ok {
		return nil, notFound(id)
	}
	return s, nil
}

// register adds a new sandbox of machine size, once admitted: from then on Usage counts it.
func (m *Manager) register(s *sandbox, size proto.Size) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sandboxes[s.meta.ID]; ok {
		return conflict("sandbox %s already exists on this host", s.meta.ID)
	}
	if err := m.admit(size, "sandbox"); err != nil {
		return err
	}
	m.sandboxes[s.meta.ID] = s
	return nil
}

// admit refuses (ErrCapacity) a machine of size that the budget hasn't room for beside what the tier holds
// (heldLocked). Called with m.mu held: what it admits is registered or held before the lock goes, so two never share
// the same room.
func (m *Manager) admit(size proto.Size, what string) error {
	if m.cfg.Budget == nil {
		return nil
	}
	memory, disk := m.cfg.Budget()
	used, held := m.heldLocked()
	if memory-used < int64(size.MemoryMiB) || disk-held < int64(size.DiskGiB) {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf("this host hasn't %d MiB and %d GiB free for a %s now", size.MemoryMiB, size.DiskGiB, what)}
	}
	return nil
}

// holdBuild admits a template build of machine size and holds its memory and disk, by its snapshot ID, until release.
// One of a snapshot already building (its control plane gave up waiting, and tries again) waits for that one: its
// next try takes the result kept.
func (m *Manager) holdBuild(id string, size proto.Size) (release func(), err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.builds[id]; ok {
		return nil, &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf("template snapshot %s is building already", id)}
	}
	if err := m.admit(size, "template build"); err != nil {
		return nil, err
	}
	if m.builds == nil {
		m.builds = map[string]proto.Size{}
	}
	m.builds[id] = size
	return func() {
		m.mu.Lock()
		delete(m.builds, id)
		m.mu.Unlock()
	}, nil
}

// heldLocked is what the tier's machines hold against its budget: the memory of the sandboxes starting, resuming or
// running and of the template builds; and the disk of the work under way, whose files are still being written: the
// creates starting, the resumes and the builds. Called with m.mu held.
func (m *Manager) heldLocked() (memoryMiB, diskGiB int64) {
	memoryMiB = m.sandboxMemoryLocked()
	for _, s := range m.sandboxes {
		if s.meta.State != proto.StateStarting {
			continue
		}
		if size, err := m.size(s.meta.Size); err == nil {
			diskGiB += int64(size.DiskGiB)
		}
	}
	for _, resume := range m.resuming {
		diskGiB += int64(resume.DiskGiB)
	}
	for _, build := range m.builds {
		memoryMiB += int64(build.MemoryMiB)
		diskGiB += int64(build.DiskGiB)
	}
	for _, build := range m.ownBuilds {
		memoryMiB += int64(build.MemoryMiB)
		diskGiB += int64(build.DiskGiB)
	}
	return memoryMiB, diskGiB
}

// holdResume admits a stopped sandbox of machine size to start again (Resume, a start or a resume) and holds its
// memory, and the room its disk may still grow into, until release: from then on a create or a build can't take the
// room the sandbox left when it stopped. Called with s.mu held.
func (m *Manager) holdResume(s *sandbox, size proto.Size) (release func(), err error) {
	id := s.meta.ID
	need := size
	// Its disk is on the host already, and the free disk the budget reports leaves out what it uses.
	need.DiskGiB = max(0, size.DiskGiB-int(diskUsage(filepath.Join(s.vmDir(), fc.DiskFile))>>30))
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.admit(need, "sandbox to start"); err != nil {
		return nil, err
	}
	if m.resuming == nil {
		m.resuming = map[string]proto.Size{}
	}
	m.resuming[id] = need
	return func() {
		m.mu.Lock()
		delete(m.resuming, id)
		m.mu.Unlock()
	}, nil
}

// TemplateBuilds are the template builds admitted and not yet ended (their snapshot IDs), and the memory and disk
// their machines hold.
func (m *Manager) TemplateBuilds() (ids []string, memoryMiB, diskGiB int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, size := range m.builds {
		ids = append(ids, id)
		memoryMiB += int64(size.MemoryMiB)
		diskGiB += int64(size.DiskGiB)
	}
	for _, size := range m.ownBuilds {
		memoryMiB += int64(size.MemoryMiB)
		diskGiB += int64(size.DiskGiB)
	}
	slices.Sort(ids)
	return ids, memoryMiB, diskGiB
}

// holdOwnBuild admits one of the tier's own background template builds, of shape sh, and holds the memory and disk its
// machine boots with until release, which its builder calls once the machine has exited (buildTemplate waits for it):
// a create, a resume or another build can't take that room meanwhile. A shared template's hotplug range takes no
// memory until a sandbox restored from it is given some.
func (m *Manager) holdOwnBuild(sh shape) (release func(), err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.admit(sh.Size, "template build"); err != nil {
		return nil, err
	}
	if m.ownBuilds == nil {
		m.ownBuilds = map[int]proto.Size{}
	}
	m.ownBuildSeq++
	id := m.ownBuildSeq
	m.ownBuilds[id] = sh.Size
	return func() {
		m.mu.Lock()
		delete(m.ownBuilds, id)
		m.mu.Unlock()
	}, nil
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

// sandboxOrigin is where a new sandbox's machine comes from: the root filesystem it reads,
// the snapshot it restores (state and memory; none: it boots) with the disk it copies (none: a new empty one), and the
// setup it runs once it has its identity (a template's, booted fresh).
type sandboxOrigin struct {
	rootfs, state, mem, disk string
	setup                    string
	source                   string
	timings                  timings
	// templateSnapshot is the template snapshot it restores, if any; release gives back its share of the snapshot's
	// lock once the files are copied and loaded.
	templateSnapshot string
	release          func()
	// unhold releases the base lock, held to read (holdBases) from reading where rootfs comes from until it is linked
	// (startMachine), so a prune finds the base in one or the other; nil when it isn't held.
	unhold func()
	// guest is what a template's image has (of a pulled base or the host's image), as its agent reported it at the
	// build, kept with the template snapshot or the sandbox snapshot restored; askGuest: not known yet (a template
	// booted fresh, or the host's image booted as a custom shape, which has no size template to have asked), so the new
	// machine's agent is asked once it is up.
	guest    *proto.GuestCapabilities
	askGuest bool
	// reshape is the shared template's shape when it restores one (shared.go): the sandbox is grown from it, its
	// memory plugged and its disk grown, to its own size.
	reshape *shape
}

// startOf is a new sandbox's origin as a machine of size: p.From, a snapshot; p.Template, a template's snapshot or its
// image booted fresh; else, with shared templates on, its vCPU count's shared template (or, while that is made or for a
// shape it can't make, the host's image booted on a new disk); else the size's template, or for a custom shape (which
// has none) the host's image booted on a new disk. Its rootfs is the images the snapshot or template it starts from is over, so its memory matches its disk; it is
// read with the base lock held (origin.unhold), which startMachine releases once it has linked it.
func (m *Manager) startOf(ctx context.Context, p proto.CreateParams, size proto.Size) (sandboxOrigin, error) {
	if p.From != "" {
		unhold := m.holdBases()
		snap, err := m.readSnapshot(p.From)
		if err != nil {
			unhold()
			return sandboxOrigin{}, err
		}
		if snap.Size != size.Name && snap.Memory {
			unhold()
			return sandboxOrigin{}, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("snapshot %s is of a %s sandbox; a sandbox made from it is that size too", p.From, snap.Size)}
		}
		sdir := m.snapshotDir(p.From)
		origin := sandboxOrigin{rootfs: m.snapshotRootfs(snap), disk: filepath.Join(sdir, fc.DiskFile), source: "snapshot", guest: snap.Guest, unhold: unhold}
		if snap.Memory {
			origin.state, origin.mem = filepath.Join(sdir, "state"), filepath.Join(sdir, "mem")
		}
		return origin, nil
	}
	if p.Template != nil {
		return m.templateOrigin(ctx, *p.Template, size)
	}
	sh, fits, ready := m.sharedPlan(size)
	if ready {
		// Until it is restored (release, once started): a background rebuild swaps the template in between creates.
		unuse := m.useTemplate(sh.Name)
		tpl, tt, err := m.template(ctx, sh)
		if err != nil {
			unuse()
			return sandboxOrigin{}, err
		}
		unhold := m.holdBases()
		return sandboxOrigin{rootfs: m.sizeTemplateRootfs(tpl), state: filepath.Join(tpl, "state"), mem: filepath.Join(tpl, "mem"), disk: filepath.Join(tpl, fc.DiskFile), source: "snapshot", timings: tt, release: unuse, unhold: unhold, reshape: &sh}, nil
	}
	if isCustom(size.Name) || fits || m.sharedOn() {
		// No template: a fresh disk, then a cold boot (and, when it fits, its shared template is being made), on the
		// current images as they resolve now (the version itself with PinBase, so a later update doesn't move it:
		// pinRootfs). No template asked the image what it has, so this boot does, as a template's would.
		return sandboxOrigin{rootfs: m.cfg.Rootfs, source: "boot", askGuest: true, unhold: m.holdBases()}, nil
	}
	// Until it is restored (release, once started): a background rebuild swaps the template in between creates.
	unuse := m.useTemplate(size.Name)
	tpl, tt, err := m.template(ctx, shape{Size: size})
	if err != nil {
		unuse()
		return sandboxOrigin{}, err
	}
	unhold := m.holdBases()
	origin := sandboxOrigin{rootfs: m.sizeTemplateRootfs(tpl), state: filepath.Join(tpl, "state"), mem: filepath.Join(tpl, "mem"), disk: filepath.Join(tpl, fc.DiskFile), source: "snapshot", timings: tt, release: unuse, unhold: unhold}
	if tt != nil {
		origin.source = "boot"
	}
	return origin, nil
}

// Create makes a sandbox by restoring a template (or p.From, a snapshot; or p.Template, a template's). With shared
// templates on, any shape (a named size, or a custom one: p.VCPUs, p.MemoryMiB and p.DiskGiB with no p.Size) restores
// its vCPU count's template, and cold-boots while that is being made. With them off, a named size restores its own
// template and a custom shape cold-boots unless it is made from a snapshot or from a template snapshot built as that
// shape.
func (m *Manager) Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if !validID(p.SandboxID) {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID"}
	}
	size, err := m.createSize(p)
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
	if err := m.register(s, size); err != nil {
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
	origin, err := m.startSandbox(ctx, p, size, func(origin sandboxOrigin) error {
		return m.startMachine(ctx, s, origin, size, p.Egress, t)
	})
	if err != nil {
		return fail(err)
	}
	for k, v := range origin.timings {
		t["template."+k] = v
	}
	source, setup := origin.source, origin.setup
	if origin.state == "" {
		source = "boot"
	}
	start = time.Now()
	if origin.askGuest {
		// Asked where a build asks it, before the setup: a restore of the template's snapshot reports the same.
		caps, err := m.guestReport(ctx, s.guest, p.SandboxID)
		if err != nil {
			return fail(fmt.Errorf("boot: %w", err))
		}
		m.keepAskedGuest(s, p.Template != nil, origin, caps)
		t.step("capabilities", &start)
	}
	if err := m.cfg.Network.SetEgress(s.link, egressMode(p.Egress)); err != nil {
		return fail(err)
	}
	m.attach(s, s.link.Slot)
	t.step("attach", &start)
	var reshaped chan reshapeResult
	if reshape := origin.reshape; reshape != nil {
		// Beside the identity: the memory is Firecracker's and the guest kernel's to plug, the identity the agent's.
		reshaped = make(chan reshapeResult, 1)
		machine := s.machine
		go func() { reshaped <- m.reshape(ctx, machine, size, *reshape) }()
	}
	steps, err := s.guest.SetIdentitySteps(ctx, m.identity(s, true))
	for k, v := range steps {
		t["identity."+k] = v
	}
	if err != nil {
		if reshaped != nil {
			<-reshaped
		}
		return fail(fmt.Errorf("identity: %w", err))
	}
	t.step("identity", &start)
	if reshaped != nil {
		r := <-reshaped
		for k, v := range r.timings {
			t["reshape."+k] = v
		}
		if r.err != nil {
			return fail(fmt.Errorf("memory: %w", r.err))
		}
		t.step("reshape", &start)
		if size.DiskGiB > origin.reshape.DiskGiB {
			s.meta.GrowDisk = true
		}
	} else if p.From != "" {
		// The snapshot's may be from before its sandbox's disk was grown (or of another size, made without memory).
		s.meta.GrowDisk = true
	}
	if setup != "" {
		if err := runSetup(ctx, s.guest, setup, s.meta.Env); err != nil {
			return fail(err)
		}
		t.step("setup", &start)
	}
	s.meta.State = proto.StateRunning
	s.meta.Slot = s.link.Slot
	s.meta.Pid = s.machine.Pid()
	if err := m.writeMeta(s); err != nil {
		return fail(err)
	}
	if s.meta.GrowDisk {
		// Once this answers (it holds the sandbox's lock until then): growing ext4 online takes a while, and
		// nothing fills the template's disk (gigabytes) in that time.
		go m.growDisk(s, size.DiskGiB)
	}
	m.watch(s, s.machine)
	t.step("finish", &start)
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info := m.info(s)
	info.Timings, info.Source = t, source
	m.emit(s)
	m.log.Debug("create", "sandbox", s.meta.ID, "size", size.Name, "source", source, "timings", t)
	return info, nil
}

// createSize is the size a create asks for: a named one (p.Size), or a custom shape.
func (m *Manager) createSize(p proto.CreateParams) (proto.Size, error) {
	sizeName := p.Size
	if sizeName == "" && (p.VCPUs != 0 || p.MemoryMiB != 0 || p.DiskGiB != 0) {
		if p.VCPUs <= 0 || p.MemoryMiB <= 0 || p.DiskGiB <= 0 {
			return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: "a custom size needs vcpus, memoryMiB and diskGiB"}
		}
		sizeName = CustomSizeName(p.VCPUs, p.MemoryMiB, p.DiskGiB)
	}
	return m.size(sizeName)
}

// sharedPlan is sharedFor when shared templates are on; nothing fits when they're off.
func (m *Manager) sharedPlan(size proto.Size) (sh shape, fits, ready bool) {
	if !m.sharedOn() {
		return shape{}, false, false
	}
	return m.sharedFor(size)
}

// keepAskedGuest keeps what a new sandbox's agent answered when its origin had no report (askGuest). A sandbox made
// from a template keeps it as its own, the host's image's included (the default base before a digest is published),
// as a restore of the template's snapshot has it, whether or not the host's image has a report for its version yet. A
// custom shape's boot of the host's image had no size template to ask what the image has, so it answers for the image
// version it booted on (noteBootGuest): every sandbox of that version shares the report.
func (m *Manager) keepAskedGuest(s *sandbox, fromTemplate bool, origin sandboxOrigin, caps *proto.GuestCapabilities) {
	if fromTemplate || m.pulledRootfs(origin.rootfs) {
		s.meta.Guest = caps
		return
	}
	if caps != nil {
		m.noteBootGuest(baseOf(s.vmDir()), caps)
	}
}

// recordImage records in s's meta the image origin starts it from: its root filesystem when that is a template's
// pulled base (pulledRootfs), not the host's image, and the report origin has (a template's, whatever its root
// filesystem; none for the host's image's other sandboxes, which share their image version's, guestOf).
func (m *Manager) recordImage(s *sandbox, origin sandboxOrigin) {
	s.meta.Rootfs, s.meta.Guest = "", origin.guest
	if m.pulledRootfs(origin.rootfs) {
		s.meta.Rootfs = origin.rootfs
	}
}

// startSandbox starts a new sandbox's machine with start from its origin (startOf). A template snapshot that won't
// restore (its files gone or broken, or Firecracker refusing them) is a cache miss: once start has cleaned up, the
// template is booted fresh and runs its setup. A sandbox's own snapshot (p.From) that won't restore is an error.
func (m *Manager) startSandbox(ctx context.Context, p proto.CreateParams, size proto.Size, start func(sandboxOrigin) error) (sandboxOrigin, error) {
	origin, err := m.startOf(ctx, p, size)
	if err != nil {
		return sandboxOrigin{}, err
	}
	err = start(origin)
	if origin.release != nil {
		origin.release()
		origin.release = nil
	}
	if err == nil || origin.templateSnapshot == "" || ctx.Err() != nil {
		return origin, err
	}
	m.log.Warn("template snapshot didn't restore; booting the template fresh", "snapshot", origin.templateSnapshot, "error", err)
	fresh := *p.Template
	fresh.Snapshot = ""
	origin, err = m.templateOrigin(ctx, fresh, size)
	if err != nil {
		return sandboxOrigin{}, err
	}
	return origin, start(origin)
}

// startMachine starts s's machine from origin in s's vm directory: the root filesystem linked, the disk copied (or a
// new one), a network link, its record (meta.json, starting), and the snapshot restored (or the machine booted). On
// failure it leaves no machine, link or vm directory behind; the record goes with s's directory (Create's fail).
func (m *Manager) startMachine(ctx context.Context, s *sandbox, origin sandboxOrigin, size proto.Size, e *proto.Egress, t timings) (err error) {
	vm := s.vmDir()
	defer func() {
		if err == nil {
			return
		}
		if s.machine != nil {
			s.machine.Kill()
			s.machine, s.guest = nil, nil
		}
		if s.link != nil {
			m.cfg.Network.Remove(*s.link)
			s.link = nil
		}
		_ = os.RemoveAll(vm)
	}()
	// The root filesystem is linked under the base lock its origin was read with (released whatever happens), the host's
	// image as the version it resolves to now (pinRootfs).
	err = func() error {
		if origin.unhold != nil {
			defer origin.unhold()
		}
		if err := os.MkdirAll(vm, 0o700); err != nil {
			return err
		}
		origin.rootfs = m.pinRootfs(origin.rootfs)
		m.recordImage(s, origin)
		return m.linkRootfs(vm, origin.rootfs)
	}()
	if err != nil {
		return err
	}
	if origin.reshape != nil {
		// The disk, the network and the Firecracker process side by side: none needs another. Its record (meta.json,
		// starting, with its slot) is written once the link is made, before the snapshot is loaded.
		machine, client, link, err := m.restoreParallel(ctx, vm, origin.disk, origin.state, origin.mem, egressMode(e), t, func(link network.Link) error {
			s.meta.Slot = link.Slot
			return m.writeMeta(s)
		})
		s.link = link
		if err != nil {
			return err
		}
		s.machine, s.guest = machine, client
		return nil
	}
	start := time.Now()
	if origin.disk == "" {
		err = newDisk(filepath.Join(vm, fc.DiskFile), size.DiskGiB)
	} else {
		err = copySparse(origin.disk, filepath.Join(vm, fc.DiskFile))
	}
	if err != nil {
		return err
	}
	t.step("disk", &start)
	link, err := m.cfg.Network.Add(egressMode(e))
	if err != nil {
		return err
	}
	s.link = &link
	t.step("network", &start)
	// On disk, starting, with its slot, before its machine starts: a host that restarts before the create ends (a
	// template's setup can run for many minutes) finds the machine and its link and ends them (reapInterruptedCreates).
	s.meta.Slot = link.Slot
	if err := m.writeMeta(s); err != nil {
		return err
	}
	if origin.state == "" {
		if err := m.boot(ctx, s, size); err != nil {
			return err
		}
		t.step("boot", &start)
		return nil
	}
	machine, client, err := m.restore(ctx, vm, origin.state, origin.mem, link)
	if err != nil {
		return err
	}
	s.machine, s.guest = machine, client
	t.step("restore", &start)
	return nil
}

// boot cold-boots s from its own disk (Start, or a snapshot with no memory), on the kernel of the version its root
// filesystem is (kernelFor): the one it was made on, or a rebase moved it to.
func (m *Manager) boot(ctx context.Context, s *sandbox, size proto.Size) error {
	vm := s.vmDir()
	kernel := m.kernelFor(vmRootfs(vm))
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return err
	}
	s.meta.CID = m.cid()
	if err := machine.Boot(ctx, m.bootConfig(shape{Size: size}, kernel, s.link.Tap, s.link.MAC, s.meta.CID)); err != nil {
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
		// A rebase is a cold boot on the target images: a machine running on others (one a gateway lost track of) isn't
		// that, so it is refused rather than answered as done. One already on them is that boot, retried.
		if coldBoot && p.Rebase {
			target := p.RebaseTo
			if target == "" {
				target = images.VersionOf(m.baseRootfs())
			}
			if have := baseOf(s.vmDir()); have != target {
				return proto.SandboxInfo{}, conflict("sandbox %s is running on images %q, not %q: stop it before restarting it on them", s.meta.ID, have, target)
			}
		}
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
	// A rebase onto a version this host's images aren't on, or of a sandbox on a template's own base image, is refused
	// before anything changes (rebase checks again as it relinks).
	if coldBoot && p.Rebase {
		if err := m.rebaseable(s); err != nil {
			return proto.SandboxInfo{}, err
		}
		if err := m.rebaseTarget(p.RebaseTo); err != nil {
			return proto.SandboxInfo{}, err
		}
	}
	// Admitted against the budget like a create, and held until it runs (counted then as running) or has failed.
	release, err := m.holdResume(s, size)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	defer release()
	if p.Egress != nil {
		s.meta.Egress = p.Egress
		s.unsaved = true
	}
	if coldBoot && p.Rebase {
		if err := m.rebase(s, p.RebaseTo); err != nil {
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
		if coldBoot && p.Rebase {
			if err := m.rebasedGuest(ctx, s.guest, baseOf(vm), size); err != nil {
				s.machine.Kill()
				m.cfg.Network.Remove(link)
				s.machine, s.link = nil, nil
				return proto.SandboxInfo{}, fmt.Errorf("boot: %w", err)
			}
			t.step("capabilities", &start)
		}
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
	if s.meta.GrowDisk {
		// Stopped (or snapshotted) before its disk was grown: grown now, as a create would.
		go m.growDisk(s, size.DiskGiB)
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
	// Rootfs is the root filesystem its disk is a layer over (base.go: a host image version's, or a template's pulled
	// base's); empty in snapshots from before it was kept.
	Rootfs string `json:"rootfs,omitempty"`
	// Guest is what its sandbox's template image has (meta's), which a sandbox made from it reports too.
	Guest *proto.GuestCapabilities `json:"guest,omitempty"`
}

func (m *Manager) snapshotDir(id string) string {
	return filepath.Join(m.cfg.Root, "snapshots", id)
}

func (m *Manager) writeSnapshotMeta(s *sandbox, snap *proto.SnapshotInfo) error {
	// The sandbox's base is now the snapshot's too: recorded under the base lock.
	defer m.holdBases()()
	rootfs, base := rootfsOf(s.vmDir())
	snap.Base = base
	raw, _ := json.MarshalIndent(snapshotMeta{SnapshotInfo: *snap, Size: s.meta.Size, Rootfs: rootfs, Guest: s.meta.Guest}, "", "  ")
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

// pruneAuto keeps the newest AutoSnapshots automatic snapshots of a sandbox, and memory only on the newest one. It
// rewrites snapshot metadata, which names each snapshot's base, so it holds the base lock to read (a prune's walk never
// reads one half written) and replaces each meta.json by a rename rather than truncating it.
func (m *Manager) pruneAuto(sandboxID string) {
	defer m.holdBases()()
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
			_ = fsutil.WriteFileDurably(filepath.Join(dir, "meta.json"), raw, 0o600)
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

// ReadFileStream opens a running sandbox's file to be streamed whole (sandbox.files.open): its bytes, which the caller
// closes, and its size. A missing file is not_found, as ReadFile's is.
func (m *Manager) ReadFileStream(ctx context.Context, p proto.FileParams) (io.ReadCloser, int64, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return nil, 0, err
	}
	body, size, _, err := client.ReadFileStream(ctx, p.Path)
	if guest.IsNotFound(err) {
		return nil, 0, &proto.Error{Code: proto.ErrNotFound, Message: err.Error()}
	}
	return body, size, err
}

// WriteFileStream writes what r gives to a running sandbox's file, which the guest moves into place only once r has
// ended (io.EOF); a read error from r, or a cancelled ctx, leaves the file as it was. It answers the size written.
func (m *Manager) WriteFileStream(ctx context.Context, p proto.FileParams, r io.Reader) (int64, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return 0, err
	}
	return client.WriteFileStream(ctx, p.Path, r, p.Mode)
}

// ExtractArchive has a running sandbox's guest agent extract the tar at p.Archive into p.Target with its own code
// (sandbox.files.extract), never the sandbox's tar or shell. An archive it refuses is invalid; a guest image from
// before it, unsupported.
func (m *Manager) ExtractArchive(ctx context.Context, p proto.FileExtractParams) error {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return err
	}
	err = client.ExtractArchive(ctx, p.Archive, p.Target)
	switch {
	case err == nil:
		return nil
	case guest.IsRefused(err):
		return &proto.Error{Code: proto.ErrInvalid, Message: guest.RefusalMessage(err)}
	case guest.IsUnknownRoute(err):
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this sandbox's image predates archive extraction; make it from a newer image"}
	}
	return err
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

// Close stops the tier taking work. Sandboxes keep running.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed.Store(true)
	m.mu.Unlock()
	if m.bgStop != nil {
		m.bgStop()
	}
	// Ending their context kills their VMs (buildTemplate's deferred Kill): a moment, unless one is stuck.
	settled := make(chan struct{})
	go func() {
		m.builders.Wait()
		close(settled)
	}()
	select {
	case <-settled:
	case <-time.After(20 * time.Second):
		m.log.Warn("a background template build hasn't stopped; the next start ends its VM")
	}
}

// startBuilder counts a background template build in, with the context it runs under, unless the tier is closing.
// Call it with mu held; the build calls m.builders.Done when it ends.
func (m *Manager) startBuilder() (context.Context, bool) {
	if m.closed.Load() {
		return nil, false
	}
	m.builders.Add(1)
	if m.bg == nil {
		return context.Background(), true // a Manager made without New (tests)
	}
	return m.bg, true
}

// Usage is the memory the tier's running sandboxes were given, and how many run and are stopped.
func (m *Manager) Usage() (memoryMiB int64, running int, stopped int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sandboxes {
		switch s.meta.State {
		case proto.StateRunning, proto.StateStarting:
			running++
		case proto.StateStopped:
			stopped++
		}
	}
	return m.sandboxMemoryLocked(), running, stopped
}

// sandboxMemoryLocked is the memory of the sandboxes starting, resuming or running. Called with m.mu held.
func (m *Manager) sandboxMemoryLocked() (memoryMiB int64) {
	for _, resume := range m.resuming {
		memoryMiB += int64(resume.MemoryMiB)
	}
	for _, s := range m.sandboxes {
		if s.meta.State != proto.StateRunning && s.meta.State != proto.StateStarting {
			continue
		}
		if size, err := m.size(s.meta.Size); err == nil {
			memoryMiB += int64(size.MemoryMiB)
		}
	}
	return memoryMiB
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
