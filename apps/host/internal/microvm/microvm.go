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
//	                                          bundle<n>.erofs (its bundle drives: an empty file, or a link to a bundle's
//	                                          image in the host's bundle cache; bundles.go), sticky<n>.ext4 (its
//	                                          sticky drives: an empty file, or its clone of a sticky disk; sticky.go)
//	sticky/<disk>/<version>.img               the sticky disk versions the host holds (sticky.go)
//	snapshots/<id>/{meta.json,disk.ext4,...}  automatic and saved snapshots, with links to the bundle images attached
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
	"io/fs"
	"log/slog"
	"maps"
	"net"
	"net/http"
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

	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
	"github.com/lleverage-ai/kantel/apps/host/internal/mounts"
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
	// DefaultMaxDiskGiB is the most disk a create may ask for unless the operator sets MaxDiskGiB.
	DefaultMaxDiskGiB = 1024
)

// DiskLimits are the disk a create may ask for a custom shape: minGiB and maxGiB where set, else at least the
// smallest named size's (the disk the shared templates are made with, so a smaller one would cold-boot) and at most
// DefaultMaxDiskGiB, both within 1 to 4096 GiB and the least never above the most.
func DiskLimits(sizes []proto.Size, minGiB, maxGiB int) proto.DiskLimits {
	if minGiB <= 0 {
		for _, s := range sizes {
			if s.DiskGiB > 0 && (minGiB <= 0 || s.DiskGiB < minGiB) {
				minGiB = s.DiskGiB
			}
		}
	}
	if maxGiB <= 0 {
		maxGiB = DefaultMaxDiskGiB
	}
	maxGiB = min(max(maxGiB, 1), maxCustomDiskGiB)
	minGiB = min(max(minGiB, 1), maxGiB)
	return proto.DiskLimits{MinGiB: minGiB, MaxGiB: maxGiB}
}

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
	// KeepForkSnapshots keeps a live fork's snapshot (its disk copied into the fork) rather than giving the fork its
	// disk and deleting it (Fork).
	KeepForkSnapshots bool
	Log               *slog.Logger
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
	// MinDiskGiB and MaxDiskGiB bound the disk a create may ask for a custom shape (DiskLimits says their defaults).
	// A sandbox made before keeps its disk whatever they say.
	MinDiskGiB int
	MaxDiskGiB int
	// TemplateRegistry is the operator's registry templates' Kantel base images are pulled from by digest, such as
	// ghcr.io/lleverage-ai (rootfs.go). Empty: templates are made only from Rootfs, the host's own image.
	TemplateRegistry string
	// TemplateBuilder switches on templates' custom images, built in a build microVM (builder.go); nil: off. It
	// needs Initrd too, which boots an image that isn't Kantel's with the guest agent put in.
	TemplateBuilder *TemplateBuilderConfig
	// Budget is what the tier may use now: the host's memory budget less what its other tiers use, and its free disk.
	// Each create, start or resume and template build is admitted against it (admit), beside what the tier holds. It is
	// called with the tier's lock held, so it mustn't call the tier. Nil admits everything.
	Budget func() (memoryMiB, diskGiB int64)
	// AdmitMemory, when set (memory over-commit on, experimental), admits each create, start or resume and template
	// build's memory instead of Budget's memory: vm beside held, what the tier holds now (heldVMsLocked). Called with
	// the tier's lock held, so it mustn't call the tier.
	AdmitMemory func(vm memplan.VM, held []memplan.VM) error
	// FreePageReporting boots every microVM's balloon with free page reporting: the guest hands the pages it frees
	// back to the host, so a VM's resident memory falls after a peak. In the templates' fingerprint.
	FreePageReporting bool
	// CPU is the host's CPU fingerprint, which snapshots record (fingerprint.go); nil reads it (hostinfo.CPU) once,
	// when first asked.
	CPU *proto.CPUFingerprint
	// ExitCause, when set, says why a VM exited that the host didn't end itself ("": not known), such as the kernel's
	// out-of-memory killer at the host's memory limit: the error its exit is reported with. Called with the sandbox's
	// lock held, so it mustn't call the tier.
	ExitCause func() string
	// Mounts serves sandboxes' read-only bucket mounts; nil refuses a create with mounts.
	Mounts *mounts.Manager
	// Bundles is the host's cache of bundle images, for bundle mounts (bundles.go); nil, or BundleDrives 0, refuses
	// them. BundleDrives is how many every microVM has. FetchBundle opens a bundle's tar from the control plane for a
	// sandbox that mounts it. BundleWait is how long a call waits for an image being built (default DefaultBundleWait).
	Bundles      *bundles.Cache
	BundleDrives int
	FetchBundle  func(ctx context.Context, sandboxID, digest string) (io.ReadCloser, error)
	BundleWait   time.Duration
	// MountEvents receives a sandbox whose mounts changed status after its call answered.
	MountEvents func(proto.SandboxInfo)
	// FetchSticky, when set, fetches a sticky disk version from the host's peers in the background: a create attaching
	// a version the host doesn't hold starts on the host's newest, and asks for that one for the next.
	FetchSticky func(diskID, version string)
	// Discard boots every microVM with discard on its writable disk (fc.BootConfig.Discard), for a Firecracker that
	// can (fc.DiscardSupported): blocks the guest frees, and those a trim before a save frees (trimDisk), are holes in
	// disk.ext4 again, so a snapshot's copy doesn't keep deleted files' bytes. It is in the templates' fingerprint.
	Discard bool
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
	// HealthAt is the sandbox's healthAt as last written (FeatureExitStamps): its last machine's last health stamp, so a
	// stopped sandbox's exit keeps naming the machine that ended across restarts of the host, and the next machine's
	// stamps start above it.
	HealthAt int64 `json:"healthAt,omitempty"`
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
	// Mounts are the sandbox's read-only mounts as created, bundles and buckets in one list (no credentials: the host
	// resolves those). MountStatus is how each bundle mount is doing; a bucket mount's is its mounts.Sandbox's.
	Mounts      []proto.Mount       `json:"mounts,omitempty"`
	MountStatus []proto.MountStatus `json:"mountStatus,omitempty"`
	// MountsAt is when MountStatus was last set (SandboxInfo.MountsAt).
	MountsAt int64 `json:"mountsAt,omitempty"`
	// BundleDrives is how many bundle drives its VM has (fixed by the template or snapshot it came from), and
	// BundleSlots the digest of the bundle attached to each ("" none).
	BundleDrives int      `json:"bundleDrives,omitempty"`
	BundleSlots  []string `json:"bundleSlots,omitempty"`
	// StickyDrives is how many sticky drives its VM has (StickyDrives, or none for a VM made before them), and
	// StickyDisks the sticky disks attached to it (sticky.go).
	StickyDrives int          `json:"stickyDrives,omitempty"`
	StickyDisks  []stickyDisk `json:"stickyDisks,omitempty"`
	// Runtime is the portable runtime fingerprint of the machine it runs (fingerprint.go), as it was when it booted,
	// or restored: its snapshots record it. Empty when it can't be told, such as a machine started before it was kept.
	Runtime string `json:"runtime,omitempty"`
}

type sandbox struct {
	mu      sync.Mutex
	meta    meta
	dir     string
	machine *fc.Machine
	guest   *guest.Client
	link    *network.Link
	// starting is the runtime of the machine a create or start is starting (fingerprint.go), taken as it launches:
	// meta.Runtime once it runs, and never if its start fails, so a stopped sandbox's memory keeps its own.
	starting string
	// unsaved: meta differs from meta.json (a write failed). A call that would otherwise change nothing, a retried
	// start, writes it before it answers.
	unsaved bool
	// adoptedMounts: the host adopted the sandbox running, with mounts its guest still holds, whose status the host
	// hasn't confirmed with the guest since (ReconcileMounts).
	adoptedMounts atomic.Bool
	// reserved are the bundle images the sandbox waits for, each reserved in the cache from its first wait until its
	// drive links it or the sandbox gives it up (bundles.go: reserveBundles, releaseBundles).
	reserved map[string]func()
	// mountsSeen is what the sandbox last reported of its mounts' states (mountStatus), whose change moves MountsAt on.
	mountsSeen string
	// unresponsive is why its guest agent is taken not to answer (health.go: watchHealth), while it runs; "" while it
	// answers.
	unresponsive string
	// healthAt is when unresponsive was last set (Unix ms), from its machine's start on: SandboxInfo.HealthAt, which
	// orders its reports.
	healthAt int64
	// probe stands in for its guest agent's health in a test (nil: its guest).
	probe healthClient
	// killedFor is why the host itself ended the VM killed (memory.go: KillForMemory), the error that machine's exit is
	// reported with; "" when it didn't.
	killedFor string
	killed    *fc.Machine
	// reclaiming is a Reclaim under way (memory.go), which a stop or snapshot ends first.
	reclaiming *reclaim
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
	// statfs measures the file system a stop's snapshot goes on (roomForSnapshot): syscall.Statfs when nil, tests
	// replace it.
	statfs func(path string, st *syscall.Statfs_t) error
	// snapshotRoom guards snapshotReserved: the bytes snapshots and sticky disks' full copies have been let copy and
	// haven't finished copying, which the file system's free space doesn't show yet (reserveRoom).
	snapshotRoom     sync.Mutex
	snapshotReserved int64
	spool            *spool
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
	// autoMu is held while automatic snapshots are removed (pruneAuto, a sandbox's delete) and while one is kept as a
	// saved snapshot (KeepSnapshot), so a keep never links a snapshot half removed. Taken after bases, never before.
	autoMu sync.Mutex
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
	// stickyMu guards the sticky disk versions the host holds (sticky.go): read while one is cloned, written while one
	// is added or removed.
	stickyMu sync.RWMutex
	// stickyCommits are the versions being committed now, by "<disk>/<version>" (reserveStickyVersion). Guarded by
	// stickyMu.
	stickyCommits map[string]bool
	// stickyMaps are the sticky disk versions' block maps being made now, by "<disk>/<version>" (startStickyMap), and
	// stickyDigests each map's digest as last read (stickyMapDigest). Guarded by stickyMapMu.
	stickyMapMu   sync.Mutex
	stickyMaps    map[string]*stickyMapJob
	stickyDigests map[string]stickyDigest
	// stickyAnswering are the versions published whose commit isn't answered yet, by "<disk>/<version>", each until
	// when it is kept from a prune at most (pinStickyAnswer). Guarded by stickyMu.
	stickyAnswering map[string]time.Time
	// holdMaps (tests), when set, holds every block map started meanwhile once its files are open.
	holdMaps *mapHold
	// fingerprints is the CPU and the runtime's files, as fingerprint.go reads them.
	fingerprints fingerprints
}

// guestFile, in a template, is its agent's capability report. The manager's root keeps each image's too (guestPath),
// from a template or a custom shape's boot (which has no template), so a host that restarts still has them, and a
// sandbox on an older version still has its own once its template has been rebuilt.
const (
	guestFile = "guest.json"
	guestsDir = "guests"
)

// bootConfig is a cold boot of a shape on kernel (kernelFor: its root filesystem's version's), with drives bundle
// drives and sticky sticky drives after them: through Kantel's initramfs when the host injects the agent, with its hotpluggable memory when it has some
// (a shared template).
func (m *Manager) bootConfig(sh shape, kernel, tap, mac string, cid uint32, drives, sticky int) fc.BootConfig {
	cfg := fc.BootConfig{
		VCPUs: sh.VCPUs, MemoryMiB: sh.MemoryMiB, Kernel: kernel, BootArgs: bootArgs, TapDevice: tap, MAC: mac, GuestCID: cid,
		HotplugMiB: sh.HotplugMiB, BalloonStatsSeconds: balloonStatsSeconds, Drives: append(bundleDrives(drives), stickyDrives(sticky)...),
		Discard: m.cfg.Discard, FreePageReporting: m.cfg.FreePageReporting,
	}
	if m.cfg.Initrd != "" {
		cfg.Initrd, cfg.BootArgs = m.cfg.Initrd, guestinit.BootArgs
	}
	cfg.BootArgs += browserSurfaceBootArg + psiBootArg
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
	if !canReflink(filepath.Join(cfg.Root, "snapshots")) {
		m.log.Warn("the host's file system has no reflinks, so each sandbox made or forked from a snapshot copies its whole disk; XFS or btrfs clones it at once", "root", cfg.Root)
	}
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
	// Before anything reads them: disk copies the previous run left with no record (a crash, or a full disk).
	m.reapUnpublished()
	if err := m.adopt(); err != nil {
		return nil, err
	}
	// After adopt, which takes the running sandboxes' network slots: a build's or an unfinished create's is freed only if
	// no sandbox has it.
	m.reapInterruptedBuilds()
	m.reapInterruptedCreates()
	// After adopt: a fork it found running has its disk already, and keeps the memory it has mapped.
	m.reapTransientSnapshots()
	m.adoptMappedMemory()
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
	m.spool.adopt(spoolLinks(cfg.Root))
	// Block maps of the sticky disk versions committed before them.
	m.mapOldSticky(m.bg)
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
	s.meta.HealthAt = s.healthAt
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
	info.Mounts, info.MountsAt = m.mountStatus(s)
	if s.meta.State == proto.StateRunning && s.unresponsive != "" {
		info.Health, info.HealthReason = proto.HealthUnresponsive, s.unresponsive
	}
	// Its machine's last health stamp, from its start on, kept once it stops: with the error of an exit the host didn't
	// cause by a call, it names the machine that ended, so Kantel never takes a late report of it for a later run's.
	info.HealthAt = s.healthAt
	info.StickyDisks = stickyStatus(s.meta.StickyDisks)
	return info
}

// mountStatus is how each of the sandbox's mounts is doing, in the order it was created with, and when the host set
// that (MountsAt): a bundle mount's from its meta (bundles.go: setMountStatus stamps it), a bucket mount's from its
// mounts.Sandbox, which changes on its own (a listing, the guest's answer). So a sandbox with bucket mounts has its
// stamp moved on here too, whenever what it reports differs from what it last reported: one stamp for the one list,
// always later than the last, so the control plane never drops a bucket mount's change as older than a bundle's.
// Called with s.mu held.
func (m *Manager) mountStatus(s *sandbox) ([]proto.MountStatus, int64) {
	if len(s.meta.Mounts) == 0 {
		return nil, 0
	}
	byPath := map[string]proto.MountStatus{}
	for _, st := range s.meta.MountStatus {
		byPath[st.Path] = st
	}
	buckets := m.mountsOf(s)
	if buckets != nil {
		for _, st := range buckets.Status() {
			byPath[st.Path] = st
		}
	}
	var out []proto.MountStatus
	var seen strings.Builder
	for _, mt := range s.meta.Mounts {
		if st, ok := byPath[mt.Path]; ok {
			out = append(out, st)
			fmt.Fprintf(&seen, "%q %s %q\n", st.Path, st.State, st.Error)
		}
	}
	if buckets != nil && seen.String() != s.mountsSeen {
		s.mountsSeen = seen.String()
		at := time.Now().UnixMilli()
		if at <= s.meta.MountsAt {
			at = s.meta.MountsAt + 1
		}
		s.meta.MountsAt = at
	}
	if len(out) == 0 {
		return nil, 0
	}
	return out, s.meta.MountsAt
}

// bucketMounts are the sandbox's bucket mounts: the part of its one list of mounts the host's mounts.Manager serves.
func bucketMounts(s *sandbox) []proto.Mount {
	var out []proto.Mount
	for _, mt := range s.meta.Mounts {
		if mt.Kind == proto.MountBucket {
			out = append(out, mt)
		}
	}
	return out
}

// mountsOf is the sandbox's bucket mounts on the host (nil when it has none, or is deleted: its mounts were forgotten,
// and aren't made again for its last event).
func (m *Manager) mountsOf(s *sandbox) *mounts.Sandbox {
	if m.cfg.Mounts == nil || s.meta.State == proto.StateDeleted {
		return nil
	}
	buckets := bucketMounts(s)
	if len(buckets) == 0 {
		return nil
	}
	return m.cfg.Mounts.Sandbox(s.meta.ID, buckets)
}

// applyMounts serves a running sandbox's mounts to it and has its guest mount them: listing each prefix that has no
// manifest yet first. A mount that fails says so in its status; the sandbox runs without it. Called with s.mu held.
// fromSnapshot says the guest may hold mounts of its own from a snapshot, which go when it has none.
func (m *Manager) applyMounts(ctx context.Context, s *sandbox, fromSnapshot bool) {
	if m.cfg.Mounts == nil {
		return
	}
	mt := m.mountsOf(s)
	if mt == nil {
		if fromSnapshot {
			// An older guest agent has no mounts to clear: its answer doesn't matter.
			_, _ = s.guest.Mount(ctx, nil)
		}
		return
	}
	if err := mt.Listen(s.vmDir(), fc.VsockSocket); err != nil {
		mt.Applied(nil, err)
		return
	}
	mt.Load(ctx)
	mt.Applied(s.guest.Mount(ctx, mt.GuestSpecs()))
}

// RefreshMounts lists a running sandbox's bucket mounts again now (path: just that one) and shows the guest the new
// manifests; a failed mount is tried again.
func (m *Manager) RefreshMounts(ctx context.Context, p proto.MountsRefreshParams) ([]proto.MountStatus, error) {
	// Before anything waits: a Sync's listings begin no earlier than this.
	since := time.Now()
	s, err := m.get(p.SandboxID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Sync {
		return m.syncMounts(ctx, s, p.Path, since)
	}
	mt := m.mountsOf(s)
	if mt == nil {
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("sandbox %s has no mounts", s.meta.ID)}
	}
	if s.meta.State != proto.StateRunning || s.guest == nil {
		return nil, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	if err := mt.Refresh(ctx, p.Path); err != nil {
		var pe *proto.Error
		if errors.As(err, &pe) {
			return nil, err
		}
		// A listing that failed is in the mount's status; the rest still go to the guest.
	}
	mt.Applied(s.guest.Mount(ctx, refreshSpecs(s, mt)))
	m.emitMounts(s)
	return mt.Status(), nil
}

// refreshSpecs are the mounts a refresh shows the guest, which takes them as its whole set: those with a manifest,
// or every one while the host still reconciles an adopted sandbox's (ReconcileMounts), so a mount the guest still
// holds whose listing the restarted host hasn't recovered isn't unmounted by a refresh of another. Called with s.mu
// held.
func refreshSpecs(s *sandbox, mt *mounts.Sandbox) []guest.MountSpec {
	if s.adoptedMounts.Load() {
		return mt.AllGuestSpecs()
	}
	return mt.GuestSpecs()
}

// syncMounts is RefreshMounts with Sync: each bucket mount at path (all of them when empty) listed from since on and
// shown to the guest, which must take it, or an error saying which mount isn't current and why. Called with s.mu
// held.
func (m *Manager) syncMounts(ctx context.Context, s *sandbox, path string, since time.Time) ([]proto.MountStatus, error) {
	if path != "" {
		for _, mount := range s.meta.Mounts {
			if mount.Path == path && mount.Kind == proto.MountBundle {
				return nil, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("the mount at %s is a bundle, which never changes: mount another digest for other files", path)}
			}
		}
	}
	mt := m.mountsOf(s)
	if mt == nil {
		if path != "" {
			return nil, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("sandbox %s has no bucket mount at %s", s.meta.ID, path)}
		}
		// No bucket mounts: nothing can be out of date.
		status, _ := m.mountStatus(s)
		return status, nil
	}
	if s.meta.State != proto.StateRunning || s.guest == nil {
		return nil, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	if err := mt.Sync(ctx, path, since); err != nil {
		// Sync's own refusal (no bucket mount at path) as it is. A listing's error may hold a proto.Error of its own
		// (bucket.fetch's not_found for a source Kantel won't give), which is still a mount that couldn't be listed.
		if pe, ok := err.(*proto.Error); ok {
			return nil, pe
		}
		m.emitMounts(s)
		return nil, &proto.Error{Code: proto.ErrUnavailable, Message: "couldn't list the bucket again: " + err.Error()}
	}
	synced := mt.Versions(path)
	results, err := s.guest.Mount(ctx, refreshSpecs(s, mt))
	mt.Applied(results, err)
	m.emitMounts(s)
	if err := mt.Shown(synced, results, err); err != nil {
		return nil, &proto.Error{Code: proto.ErrUnavailable, Message: err.Error()}
	}
	// An older guest agent doesn't say it had the kernel forget the names that changed: they go after the timeout,
	// waited out once for all of them.
	if !allCurrent(synced, results) {
		select {
		case <-time.After(guest.CacheTimeout):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return mt.Status(), nil
}

// allCurrent says whether the guest said, for every mount synced, that the kernel already forgot its changed names.
func allCurrent(synced map[string]int64, results []guest.MountResult) bool {
	for _, r := range results {
		if _, picked := synced[r.Path]; picked && !r.Current {
			return false
		}
	}
	return true
}

// ReconcileMounts confirms the mounts of sandboxes the host adopted running, once it can resolve their bucket
// sources (it has just connected to Kantel): each prefix is listed, and the guest is shown every mount (so it keeps
// one it holds whose listing failed), its answer setting each one's status. A sandbox some of whose mounts couldn't
// be listed is tried again, less and less often, until ctx ends (the connection went; the next one tries again).
func (m *Manager) ReconcileMounts(ctx context.Context) {
	m.mu.Lock()
	var adopted []*sandbox
	for _, s := range m.sandboxes {
		if s.adoptedMounts.Load() {
			adopted = append(adopted, s)
		}
	}
	m.mu.Unlock()
	for _, s := range adopted {
		go func() {
			wait := 10 * time.Second
			for !m.reconcileMounts(ctx, s) {
				select {
				case <-ctx.Done():
					return
				case <-time.After(wait):
				}
				wait = min(2*wait, 5*time.Minute)
			}
		}()
	}
}

// reconcileMounts is one try of ReconcileMounts for s; done says there is nothing left to try.
func (m *Manager) reconcileMounts(ctx context.Context, s *sandbox) (done bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mt := m.mountsOf(s)
	if !s.adoptedMounts.Load() || mt == nil || s.meta.State != proto.StateRunning || s.guest == nil {
		// Stopped, deleted or applied again since (a stop and resume applies its mounts afresh).
		s.adoptedMounts.Store(false)
		return true
	}
	mt.Load(ctx)
	results, err := s.guest.Mount(ctx, mt.AllGuestSpecs())
	if err != nil {
		m.log.Warn("adopted sandbox's mounts: the guest didn't answer", "sandbox", s.meta.ID, "error", err)
		return ctx.Err() != nil
	}
	mt.Applied(results, nil)
	m.emit(s)
	if !mt.Listed() {
		return false
	}
	s.adoptedMounts.Store(false)
	return true
}

// SupportsMount says which mounts this tier takes on this host: bundles while the host can build their images and its
// microVMs have drives for them, buckets while it has a mounts.Manager.
func (m *Manager) SupportsMount(kind string) bool {
	switch kind {
	case proto.MountBundle:
		return m.cfg.Bundles != nil && m.cfg.BundleDrives > 0
	case proto.MountBucket:
		return m.cfg.Mounts != nil
	}
	return false
}

// validateMounts checks a create's mounts, bundles and buckets in one list, before anything is made: each is of a kind
// this host takes, and the list keeps mounts.Validate's rules (paths, overlaps, how many, each kind's fields).
func (m *Manager) validateMounts(ms []proto.Mount) error {
	for _, mt := range ms {
		if !m.SupportsMount(mt.Kind) {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("this host has no %s mounts", mt.Kind)}
		}
	}
	return mounts.Validate(ms)
}

func (m *Manager) emit(s *sandbox) {
	if m.cfg.Events != nil {
		m.cfg.Events(m.info(s))
	}
}

// emitMounts is emit for a call that changed a sandbox's mount statuses after its boot answered (a refresh): the
// control plane takes those only from a mounts event (sandbox.mounts, MountEvents), which carries the ordering stamp
// m.info sets (MountsAt), so it gets one besides the sandbox's own.
func (m *Manager) emitMounts(s *sandbox) {
	m.emit(s)
	if m.cfg.MountEvents != nil {
		m.cfg.MountEvents(m.info(s))
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
		// Its last machine's stamp: a stopped sandbox's exit keeps it, and a later machine's stamps start above it.
		s.healthAt = s.meta.HealthAt
		if s.meta.State == proto.StateRunning && s.meta.Pid > 0 && processAlive(s.meta.Pid) {
			machine, err := fc.Attach(s.vmDir(), s.meta.Pid)
			if err == nil {
				// Its API asked once, for the log: one that doesn't answer can't be paused, so the VM runs on as it is and its
				// stop ends it cold (its disk kept, its memory lost), as Stop does for any VM that won't pause.
				actx, cancel := context.WithTimeout(context.Background(), adoptAPITimeout)
				if err := machine.Barrier(actx); err != nil {
					m.log.Warn("adopted a running sandbox whose Firecracker API doesn't answer; its stop will be cold", "sandbox", s.meta.ID, "pid", s.meta.Pid, "error", err)
				}
				cancel()
				link := m.cfg.Network.LinkFor(s.meta.Slot, egressMode(s.meta.Egress))
				if err := m.cfg.Network.Adopt(link); err != nil {
					m.log.Warn("adopted sandbox's network rules", "sandbox", s.meta.ID, "error", err)
				}
				s.machine, s.link = machine, &link
				s.guest = guest.NewClient(filepath.Join(s.vmDir(), fc.VsockSocket))
				m.attach(s, link.Slot)
				m.watch(s, machine)
				if mt := m.mountsOf(s); mt != nil {
					// The guest's mounts are still up: serve them again (each lists its prefix when first asked). Their
					// status is pending until ReconcileMounts confirms them with the guest, once the host is connected.
					if err := mt.Listen(s.vmDir(), fc.VsockSocket); err != nil {
						m.log.Warn("adopted sandbox's mounts", "sandbox", s.meta.ID, "error", err)
					}
					s.adoptedMounts.Store(true)
				}
				m.sandboxes[s.meta.ID] = s
				// A bundle still being built when the host stopped: build it again, and attach it then.
				m.finishBundles(s)
				// A commit the previous run had under way may have left a sticky disk frozen.
				m.thawStickyAfterRestart(s)
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
			// Stamped now: after its machine's start, before any later machine's, so Kantel takes the report of this exit
			// (the hello's) only for the run that machine was. One already stopped keeps the stamp its exit had.
			s.healthAt = max(time.Now().UnixMilli(), s.healthAt+1)
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

// watch marks a sandbox stopped (with an error) when its VM exits without being asked to, and watches its guest
// agent's health while it runs (watchHealth).
func (m *Manager) watch(s *sandbox, machine *fc.Machine) {
	// Healthy, as of now: a machine's first health has a time too, so Kantel orders it against what it took of the
	// machine before (an unresponsive report from before a restart of the host, say).
	s.setUnresponsive("")
	// Written before the boot answers with it (FeatureExitStamps): Kantel fences this machine's exit by it, so a restart
	// of the host must never leave the stamp behind it, even if the host's clock has gone back.
	_ = m.writeMeta(s)
	m.watchHealth(s, machine)
	go func() {
		<-machine.Done()
		s.mu.Lock()
		defer s.mu.Unlock()
		killedFor := ""
		if s.killed == machine {
			killedFor, s.killedFor, s.killed = s.killedFor, "", nil
		}
		if s.machine != machine {
			return
		}
		s.machine = nil
		if s.unresponsive != "" {
			s.setUnresponsive("")
		}
		if s.link != nil {
			m.cfg.Network.Remove(*s.link)
			m.detach(s.link.Slot)
			s.link = nil
		}
		if mt := m.mountsOf(s); mt != nil {
			mt.Close()
		}
		s.meta.State = proto.StateStopped
		s.meta.Memory = false
		s.meta.Error = "the VM exited"
		if killedFor != "" {
			s.meta.Error = killedFor
		} else if m.cfg.ExitCause != nil {
			if why := m.cfg.ExitCause(); why != "" {
				s.meta.Error = why
			}
		}
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

// copySparse copies a disk image, keeping holes: a reflink where the file system has them (XFS, btrfs), which shares
// the source's blocks until either file is written and so takes no room yet, else cp's SEEK_DATA/SEEK_HOLE copy
// (ext4 has no reflinks).
func copySparse(src, dst string) error {
	_, err := cloneDisk(src, dst)
	return err
}

// cloneDisk is copySparse, saying how the copy was made: proto.DiskReflink or proto.DiskCopy. The clone is FICLONE
// itself, so a file system without reflinks answers at once and the copy is the only time spent.
func cloneDisk(src, dst string) (string, error) {
	if fsutil.Reflink(src, dst) == nil {
		return proto.DiskReflink, nil
	}
	// The failed reflink may have made dst (empty): the sparse copy starts from none.
	_ = os.Remove(dst)
	out, err := exec.Command("cp", "--sparse=always", src, dst).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("copy %s: %v: %s", filepath.Base(src), err, strings.TrimSpace(string(out)))
	}
	return proto.DiskCopy, nil
}

// canReflink says whether dir's file system clones files (FICLONE), by cloning a file of one block there.
func canReflink(dir string) bool {
	probe, err := os.CreateTemp(dir, ".reflink-probe-")
	if err != nil {
		return false
	}
	src := probe.Name()
	defer os.Remove(src)
	_, err = probe.Write(make([]byte, 4096))
	probe.Close()
	if err != nil {
		return false
	}
	dst := src + ".clone"
	defer os.Remove(dst)
	return fsutil.Reflink(src, dst) == nil
}

// unchanged says whether the file at path looks as it did when before was taken, by its size, inode, and modification
// and change times. Those times come from a coarse clock, so a write in the same tick as before can leave them equal:
// a check beside writeWatch, never instead of it.
func unchanged(path string, before os.FileInfo) bool {
	now, err := os.Stat(path)
	if err != nil {
		return false
	}
	if now.Size() != before.Size() || !now.ModTime().Equal(before.ModTime()) {
		return false
	}
	b, okB := before.Sys().(*syscall.Stat_t)
	n, okN := now.Sys().(*syscall.Stat_t)
	return okB && okN && b.Ctim == n.Ctim && b.Ino == n.Ino
}

// takeFile moves src to dst: a rename (proto.DiskMove), or (another file system) a sparse copy.
func takeFile(src, dst string) (string, error) {
	if err := os.Rename(src, dst); err == nil {
		return proto.DiskMove, nil
	}
	return cloneDisk(src, dst)
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

// balloonStatsSeconds is how often a VM's balloon has its guest's memory figures from the guest's driver, for the usage
// samples (every 5 s by default): so a reading is at most this old.
const balloonStatsSeconds = 1

// templateDevices is the devices' part of a template's fingerprint: a snapshot keeps the devices it was made with, so
// a template from before the reporting balloon is made again, and the sandboxes restored from it report their guest's
// memory.
const templateDevices = " devices=balloon-stats"

// browserSurfaceBootArg tells the guest image this host forwards its agent's browserSurface report, so the image may
// run Chromium on a display of its own (kantel-browser-display, whose units have it as their condition) rather than
// on the desktop. A host from before it boots the same image with Chromium on the desktop, where its browser view (the
// desktop's page) still shows it: that host would drop the report, and the control plane would never open the
// browser's own stream. A snapshot keeps the command line it booted with, so it is in the template's fingerprint too.
const browserSurfaceBootArg = " " + guest.BrowserSurfaceBootArg

// psiBootArg turns on the guest kernel's pressure figures, which Firecracker's guest config builds in but leaves off
// (CONFIG_PSI_DEFAULT_DISABLED): its agent reads /proc/pressure/io for the sandbox's IO pressure (guest.Stats). A
// sandbox restored from a snapshot made before it keeps its kernel's command line, so has no IO pressure until it is
// cold-booted. In the template's fingerprint too.
const psiBootArg = " psi=1"

const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/usr/sbin/kantel-init quiet loglevel=3 systemd.show_status=false"

// Since is a timer for step timings.
type timings map[string]float64

func (t timings) step(name string, since *time.Time) {
	now := time.Now()
	t[name] = float64(now.Sub(*since).Microseconds()) / 1000
	*since = now
}

// msSince is the milliseconds since since, as timings has them.
func msSince(since time.Time) float64 { return float64(time.Since(since).Microseconds()) / 1000 }

// booted notes in ph, when set, its machine booted or its snapshot loaded since *since, and starts the agent's wait.
func booted(ph *proto.StartPhases, since *time.Time) {
	if ph != nil {
		ph.BootMs = msSince(*since)
		*since = time.Now()
	}
}

// answered notes in ph, when set, its guest agent answered since *since.
func answered(ph *proto.StartPhases, since *time.Time) {
	if ph != nil {
		ph.AgentMs = msSince(*since)
		*since = time.Now()
	}
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

// shapeKey is a shape's part of its template's fingerprint: the size's, its bundle and sticky drives (a VM restored
// from it has the drives it was made with, so a template with another number, or one made before sticky drives, is
// rebuilt, not reused while a background rebuild runs), and a shared template's hotpluggable memory and the boot arguments its guest needs to plug it.
func (m *Manager) shapeKey(sh shape) string {
	// The sticky drives before the size, which tests and older keys have at the end of a shape without bundle drives.
	key := fmt.Sprintf(" sticky=%d", StickyDrives) + templateShape(sh.Size)
	if m.cfg.BundleDrives > 0 {
		key += fmt.Sprintf(" bundles=%d", m.cfg.BundleDrives)
	}
	if sh.HotplugMiB > 0 {
		key += fmt.Sprintf(" hotplug=%d args=%q", sh.HotplugMiB, m.bootConfig(sh, "", "", "", 0, 0, 0).BootArgs)
	}
	return key
}

// templateFingerprint is what a shape's template is made with: Firecracker, the kernel, the images, Kernel's
// initramfs when it injects the guest agent (its name has the agent's digest: another agent, or turning injection on
// or off, makes a new template), the devices and the shape. The shape stays last: a template of the same shape on
// other images (or devices) is still used while its replacement builds, with BackgroundTemplates.
func (m *Manager) templateFingerprint(sh shape) string {
	images := []string{m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs}
	if m.cfg.Initrd != "" {
		images = append(images, m.cfg.Initrd)
	}
	devices := templateDevices
	if m.cfg.Discard {
		// A template from before keeps a disk without discard, and so would every sandbox restored from it.
		devices += ",discard"
	}
	if m.cfg.FreePageReporting {
		// The balloon is a device the snapshot keeps: one made without reporting never reports.
		devices += ",free-page-reporting"
	}
	return fc.Fingerprint(images...) + devices + " boot=" + guest.BrowserSurfaceBootArg + psiBootArg + m.shapeKey(sh)
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
		record: func(building, rootfs, runtime string) error {
			// And its runtime as it boots (fingerprint.go), which the sandboxes restored from it run.
			if err := os.WriteFile(filepath.Join(building, templateRuntimeFile), []byte(runtime), 0o600); err != nil {
				return err
			}
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
	// moves with it to dir: a prune finds the base there once the VM directory has gone. runtime is the portable
	// runtime it boots with (fingerprint.go).
	record func(building, rootfs, runtime string) error
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
	// The kernel it boots, and the runtime that makes it (fingerprint.go), which the snapshot keeps.
	kernel := m.bootKernel(rootfs)
	err := m.linkRootfs(vm, rootfs)
	if err == nil && b.record != nil {
		err = b.record(building, rootfs, m.runtimeOf(rootfs, kernel, StickyDrives))
	}
	unhold()
	if err != nil {
		return nil, nil, "", err
	}
	if err := newDisk(filepath.Join(vm, fc.DiskFile), b.size.DiskGiB); err != nil {
		return nil, nil, "", err
	}
	// Every snapshot has the host's bundle drives, empty: a VM restored from it has the devices it was made with.
	if err := emptyDrives(vm, m.cfg.BundleDrives); err != nil {
		return nil, nil, "", err
	}
	// And the sticky drives, empty: a sandbox restored from it attaches its sticky disks to them.
	if err := emptyStickyDrives(vm, StickyDrives); err != nil {
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
	if err := machine.Boot(ctx, m.bootConfig(shape{Size: b.size, HotplugMiB: b.hotplugMiB}, kernel, link.Tap, link.MAC, m.cid(), m.cfg.BundleDrives, StickyDrives)); err != nil {
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
	// How many bundle drives it was made with: a VM restored from it has those (startMachine).
	if err := writeSnapshotDriveCount(building, m.cfg.BundleDrives); err != nil {
		return nil, nil, "", err
	}
	if err := writeSnapshotStickyCount(building, StickyDrives); err != nil {
		return nil, nil, "", err
	}
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
	m.reapInterruptedBuilders(adopted)
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

// reapUnpublished deletes, when the host starts, the sandbox and snapshot directories a previous run began and never
// published: one with no meta.json. A snapshot's meta.json is written last (liveSnapshot, saveSnapshot), and a
// create's first after its disk is copied (startMachine, restoreParallel), so a crash or a full disk in between leaves
// a disk copy that adopt, reapInterruptedCreates and every listing pass over, which nothing would ever delete. One
// whose meta.json is there but doesn't decode is left, with a warning: records are written durably now, but an older
// host's could be torn, and that directory may hold a sandbox's only disk. Only at startup, when no create or snapshot
// is under way, and only directories directly under sandboxes/ and snapshots/: their contents are removed without
// following links (a sandbox's root filesystem and bundle drives, a snapshot's spooled memory), and a sandbox's
// Firecracker, if one was launched, is ended first. Its network link, made before its record, is the one thing left:
// the slot is known only from that record.
func (m *Manager) reapUnpublished() {
	for _, kind := range []string{"sandboxes", "snapshots"} {
		root := filepath.Join(m.cfg.Root, kind)
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			// A link, a file or a name no ID has isn't the host's to remove.
			if !e.IsDir() || !validID(e.Name()) {
				continue
			}
			dir := filepath.Join(root, e.Name())
			raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
			if err == nil {
				// Decoded as adopt and readSnapshot decode it.
				var record any = &meta{}
				if kind == "snapshots" {
					record = &snapshotMeta{}
				}
				if json.Unmarshal(raw, record) != nil {
					m.log.Warn("a record that doesn't decode; leaving its directory for an operator", "dir", dir, "bytes", dirUsage(dir))
				}
				continue
			}
			if !errors.Is(err, os.ErrNotExist) {
				// Unreadable for another reason (an I/O error): it may be whole.
				m.log.Warn("couldn't read a record; leaving its directory", "dir", dir, "error", err)
				continue
			}
			if kind == "sandboxes" {
				fc.KillLeftover(filepath.Join(dir, "vm"))
			}
			size := dirUsage(dir)
			if err := os.RemoveAll(dir); err != nil {
				m.log.Warn("an unpublished directory the host's previous run left", "dir", dir, "error", err)
				continue
			}
			m.log.Info("deleted an unpublished directory the host's previous run left", "dir", dir, "bytes", size)
		}
	}
}

// dirUsage is what the files under dir take on disk, links not followed (a hard-linked file counted in full).
func dirUsage(dir string) int64 {
	var n int64
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n += diskUsage(path)
		}
		return nil
	})
	return n
}

// reapTransientSnapshots deletes the live forks' snapshots (snapshotMeta.Transient) a previous run left: one whose fork
// was made, or failed, before it could delete it, or whose fork was cut short (reapInterruptedCreates) after taking its
// disk. None is restored again.
func (m *Manager) reapTransientSnapshots() {
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "snapshots"))
	for _, e := range entries {
		if snap, err := m.readSnapshot(e.Name()); err == nil && snap.Transient {
			if err := os.RemoveAll(m.snapshotDir(snap.ID)); err != nil {
				m.log.Warn("a live fork's leftover snapshot", "snapshot", snap.ID, "error", err)
				continue
			}
			m.log.Info("deleted a live fork's snapshot the host's previous run left", "snapshot", snap.ID)
		}
	}
}

// keepMapped keeps a running fork's spooled memory file, and the spool's charge for it, until its machine exits: its
// Firecracker maps the file, so the RAM is in use until then whether or not the file is deleted. After a daemon
// restart, adoptMappedMemory finds it again in the machine's mappings.
func (m *Manager) keepMapped(id, spooled string) {
	var machine *fc.Machine
	if s, err := m.get(id); err == nil {
		s.mu.Lock()
		machine = s.machine
		s.mu.Unlock()
	}
	if machine == nil {
		m.spool.cancel(spooled)
		return
	}
	m.releaseOnExit(machine, spooled)
}

// releaseOnExit gives back a fork's spooled memory once its machine has exited, however it ends.
func (m *Manager) releaseOnExit(machine *fc.Machine, spooled string) {
	go func() {
		<-machine.Done()
		m.spool.cancel(spooled)
	}()
}

// spoolLinks are the memory files that may be links to spooled files: the sandboxes' and the snapshots'.
func spoolLinks(root string) []string {
	vmMems, _ := filepath.Glob(filepath.Join(root, "sandboxes", "*", "vm", "mem"))
	snapMems, _ := filepath.Glob(filepath.Join(root, "snapshots", "*", "mem"))
	return append(vmMems, snapMems...)
}

// adoptMappedMemory, after the daemon restarts, deals with the spooled files no sandbox or snapshot links to (those that
// are linked, spool.adopt queues for the disk): one a running machine maps, a live fork's, is counted again until that
// machine exits; any other, such as an interrupted live fork's, is deleted. A fork's mapping is found in its
// Firecracker's /proc maps, so nothing about it needs to have been written down before the restart.
func (m *Manager) adoptMappedMemory() {
	if m.cfg.SpoolDir == "" {
		return
	}
	dir := filepath.Clean(m.cfg.SpoolDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	linked := map[string]bool{}
	for _, link := range spoolLinks(m.cfg.Root) {
		if dest, err := os.Readlink(link); err == nil {
			linked[dest] = true
		}
	}
	mapped := map[string]*fc.Machine{}
	for _, s := range m.sandboxes {
		// Under its lock: adopt's watch clears it when the machine exits.
		s.mu.Lock()
		machine := s.machine
		s.mu.Unlock()
		if machine != nil {
			for _, path := range mappedFiles(machine.Pid(), dir) {
				mapped[path] = machine
			}
		}
	}
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if !strings.HasSuffix(e.Name(), ".mem") || linked[path] {
			continue
		}
		if machine := mapped[path]; machine != nil && m.spool.adoptMapped(path) {
			m.releaseOnExit(machine, path)
			m.log.Info("counting a running fork's spooled memory again", "file", path)
			continue
		}
		// Mapped with the spool now off, it is unlinked: the RAM goes when the machine does.
		if err := os.Remove(path); err == nil {
			m.log.Info("deleted spooled memory nothing uses", "file", path)
		}
	}
}

// mappedFiles are the files under dir that process pid maps (/proc/<pid>/maps).
func mappedFiles(pid int, dir string) []string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/maps", pid))
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		// address perms offset dev inode path, the path last (and possibly with spaces).
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		path := strings.TrimSuffix(strings.Join(fields[5:], " "), " (deleted)")
		if strings.HasPrefix(path, dir+"/") && !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	return out
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
func (m *Manager) restore(ctx context.Context, vmDir, statePath, memPath string, link network.Link, ph *proto.StartPhases) (*fc.Machine, *guest.Client, error) {
	start := time.Now()
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vmDir)
	if err != nil {
		return nil, nil, err
	}
	if err := machine.Load(ctx, statePath, memPath, link.Tap); err != nil {
		machine.Kill()
		return nil, nil, fmt.Errorf("%w (firecracker log: %s)", err, tail(filepath.Join(vmDir, fc.LogFile)))
	}
	booted(ph, &start)
	client := guest.NewClient(filepath.Join(vmDir, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := client.WaitReady(readyCtx); err != nil {
		machine.Kill()
		return nil, nil, err
	}
	answered(ph, &start)
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
	if err := m.admit(size, "sandbox", memplan.VM{ID: s.meta.ID, SizeMiB: int64(size.MemoryMiB)}); err != nil {
		return err
	}
	m.sandboxes[s.meta.ID] = s
	return nil
}

// admit refuses (ErrCapacity) a machine of size that the budget hasn't room for beside what the tier holds
// (heldLocked). Called with m.mu held: what it admits is registered or held before the lock goes, so two never share
// the same room.
//
// With AdmitMemory (memory over-commit on), memory is admitted by what the machine's VMs use (memplan.Plan.Check)
// instead of by what they were given; the disk as before.
func (m *Manager) admit(size proto.Size, what string, vm memplan.VM) error {
	if m.cfg.Budget == nil {
		return nil
	}
	memory, disk := m.cfg.Budget()
	used, held := m.heldLocked()
	if m.cfg.AdmitMemory != nil {
		if disk-held < int64(size.DiskGiB) {
			return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf("this host hasn't %d GiB of disk free for a %s now", size.DiskGiB, what)}
		}
		if err := m.cfg.AdmitMemory(vm, m.heldVMsLocked()); err != nil {
			return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf("no room for a %s of %d MiB: %v", what, size.MemoryMiB, err)}
		}
		return nil
	}
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
	if err := m.admit(size, "template build", memplan.VM{SizeMiB: int64(size.MemoryMiB), Full: true}); err != nil {
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
	if err := m.admit(need, "sandbox to start", memplan.VM{ID: id, SizeMiB: int64(need.MemoryMiB)}); err != nil {
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
	if err := m.admit(sh.Size, "template build", memplan.VM{SizeMiB: int64(sh.Size.MemoryMiB), Full: true}); err != nil {
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
	// templateDiskGiB is that template snapshot's disk, which a sandbox of a bigger one is grown from once it runs.
	templateDiskGiB int
	release         func()
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
	// snapshotDir, bundleDrives and bundleSlots are a sandbox snapshot's bundle drives when it restores one with memory
	// (p.From): the same images on the same drives (bundles.go). A template snapshot's drives are empty, as many as its
	// directory says; a boot has the host's BundleDrives.
	snapshotDir  string
	bundleDrives int
	bundleSlots  []string
	// stickyDir and stickyDisks are a sandbox snapshot's sticky disks (p.From, with its memory or not), whose files are
	// cloned onto the same drives (sticky.go); stickyDrives is how many sticky drives the snapshot's VM has when it
	// restores its memory.
	stickyDir    string
	stickyDisks  []stickyDisk
	stickyDrives int
	// takeDisk moves the snapshot's disk into the new sandbox rather than copying it: a live fork's own snapshot, which
	// nothing else uses and which is deleted once the fork has started (Fork).
	takeDisk bool
	// runtime is the portable runtime the memory it restores was made on (fingerprint.go): the snapshot's or template
	// snapshot's own record, "" when that has none.
	runtime string
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
			return sandboxOrigin{}, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("snapshot %s holds the memory of a %s sandbox, so a sandbox made from it has to be that machine too, not %s (%d vCPU, %d MiB)", p.From, snap.Size, size.Name, size.VCPUs, size.MemoryMiB)}
		}
		sdir := m.snapshotDir(p.From)
		origin := sandboxOrigin{rootfs: m.snapshotRootfs(snap), disk: filepath.Join(sdir, fc.DiskFile), source: "snapshot", guest: snap.Guest, unhold: unhold}
		origin.stickyDir, origin.stickyDisks = sdir, append([]stickyDisk(nil), snap.StickyDisks...)
		if snap.Memory {
			origin.stickyDrives = snap.StickyDrives
			origin.state, origin.mem = filepath.Join(sdir, "state"), filepath.Join(sdir, "mem")
			// Its memory holds the guest's mounts of the bundles on its drives then: the same images, on the same drives.
			origin.snapshotDir, origin.bundleDrives = sdir, snap.BundleDrives
			origin.bundleSlots = append([]string(nil), snap.BundleSlots...)
			origin.runtime = snap.Runtime
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
		return sandboxOrigin{rootfs: m.sizeTemplateRootfs(tpl), state: filepath.Join(tpl, "state"), mem: filepath.Join(tpl, "mem"), disk: filepath.Join(tpl, fc.DiskFile), source: "snapshot", timings: tt, release: unuse, unhold: unhold, reshape: &sh, runtime: sizeTemplateRuntime(tpl)}, nil
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
	origin := sandboxOrigin{rootfs: m.sizeTemplateRootfs(tpl), state: filepath.Join(tpl, "state"), mem: filepath.Join(tpl, "mem"), disk: filepath.Join(tpl, fc.DiskFile), source: "snapshot", timings: tt, release: unuse, unhold: unhold, runtime: sizeTemplateRuntime(tpl)}
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
	return m.create(ctx, p, false)
}

// create is Create; takeDisk (a live fork's) moves p.From's disk into the sandbox instead of copying it, which leaves
// that snapshot without one: the caller deletes it.
func (m *Manager) create(ctx context.Context, p proto.CreateParams, takeDisk bool) (proto.SandboxInfo, error) {
	if !validID(p.SandboxID) {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID"}
	}
	size, err := m.createSize(p)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	if err := m.validateMounts(p.Mounts); err != nil {
		return proto.SandboxInfo{}, err
	}
	if err := validateStickyDisks(p.StickyDisks, p.Mounts); err != nil {
		return proto.SandboxInfo{}, err
	}
	if err := m.validateInheritedSticky(p); err != nil {
		return proto.SandboxInfo{}, err
	}
	t := timings{}
	ph := &proto.StartPhases{}
	start := time.Now()
	began := start
	dir := filepath.Join(m.cfg.Root, "sandboxes", p.SandboxID)
	s := &sandbox{dir: dir, meta: meta{ID: p.SandboxID, Size: size.Name, State: proto.StateStarting, CreatedAt: time.Now().UnixMilli(), Egress: p.Egress, Env: p.Env, SSHKeys: p.SSHAuthorizedKeys, Owner: p.Owner, Mounts: p.Mounts}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := m.register(s, size); err != nil {
		return proto.SandboxInfo{}, err
	}
	// While the VM starts.
	m.prefetchBundles(s)
	fail := func(err error) (proto.SandboxInfo, error) {
		m.releaseBundles(s, nil)
		if s.machine != nil {
			s.machine.Kill()
		}
		if m.cfg.Mounts != nil {
			m.cfg.Mounts.Forget(p.SandboxID)
		}
		if s.link != nil {
			m.cfg.Network.Remove(*s.link)
		}
		_ = os.RemoveAll(dir)
		m.unregister(p.SandboxID)
		return proto.SandboxInfo{}, err
	}
	origin, err := m.startSandbox(ctx, p, size, func(origin sandboxOrigin) error {
		origin.takeDisk = takeDisk && p.From != ""
		// A template snapshot that didn't restore leaves what it got to: the fresh boot's phases replace them.
		*ph = proto.StartPhases{}
		return m.startMachine(ctx, s, origin, size, p.Egress, t, ph)
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
	} else if origin.templateSnapshot != "" && size.DiskGiB > origin.templateDiskGiB {
		// A template's snapshot built with a smaller disk than the one it was asked for (restorableTemplateSnapshot).
		s.meta.GrowDisk = true
	}
	if setup != "" {
		if err := runSetup(ctx, s.guest, setup, s.meta.Env); err != nil {
			return fail(err)
		}
		t.step("setup", &start)
	}
	// Its mounts, from the one list: bundles on their drives, then the bucket mounts. A mount that fails says so in its
	// status; the sandbox runs without it.
	pending := false
	if len(bundleMounts(s)) > 0 || anyAttached(s.meta.BundleSlots) {
		pending = m.attachBundles(ctx, s, m.bundleWait())
		t.step("bundles", &start)
	}
	// Its sticky disks: those its snapshot had, on the same drives, then those it asks for. One that fails says so in
	// its status; the sandbox runs without it.
	if len(p.StickyDisks) > 0 || len(s.meta.StickyDisks) > 0 {
		m.attachSticky(ctx, s, p.StickyDisks)
		m.mountSticky(ctx, s)
		t.step("sticky", &start)
	}
	if len(s.meta.Mounts) > 0 || p.From != "" {
		m.applyMounts(ctx, s, p.From != "")
		t.step("mounts", &start)
	}
	s.meta.State = proto.StateRunning
	s.meta.Slot = s.link.Slot
	s.meta.Pid = s.machine.Pid()
	s.meta.Runtime = s.starting
	if err := m.writeMeta(s); err != nil {
		return fail(err)
	}
	if s.meta.GrowDisk {
		// Once this answers (it holds the sandbox's lock until then): growing ext4 online takes a while, and
		// nothing fills the template's disk (gigabytes) in that time.
		go m.growDisk(s, size.DiskGiB)
	}
	m.watch(s, s.machine)
	if pending {
		m.finishBundles(s)
	}
	t.step("finish", &start)
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	ph.TotalMs = t["total"]
	info := m.info(s)
	info.Timings, info.Source, info.Phases = t, source, ph
	m.emit(s)
	m.log.Debug("create", "sandbox", s.meta.ID, "size", size.Name, "source", source, "timings", t)
	return info, nil
}

// createSize is the size a create asks for: a named one (p.Size), or a custom shape, whose disk must be within the
// host's DiskLimits unless it is a named size's.
func (m *Manager) createSize(p proto.CreateParams) (proto.Size, error) {
	sizeName := p.Size
	if sizeName == "" && (p.VCPUs != 0 || p.MemoryMiB != 0 || p.DiskGiB != 0) {
		if p.VCPUs <= 0 || p.MemoryMiB <= 0 || p.DiskGiB <= 0 {
			return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: "a custom size needs vcpus, memoryMiB and diskGiB"}
		}
		if err := m.checkDisk(p.DiskGiB); err != nil {
			return proto.Size{}, err
		}
		sizeName = CustomSizeName(p.VCPUs, p.MemoryMiB, p.DiskGiB)
	}
	size, err := m.size(sizeName)
	if err != nil || p.From == "" {
		return size, err
	}
	return m.restoreSize(p.From, size), nil
}

// restoreSize is the size a sandbox made from snapshot from is: a snapshot holding memory restores only into the
// machine it was taken of, so a size of that machine's vCPUs and memory is the snapshot's own, under its own name,
// whatever name the control plane gave it (another size of the same numbers, or a custom shape whose disk differs). Any
// other size stays as asked, for startOf to refuse.
func (m *Manager) restoreSize(from string, size proto.Size) proto.Size {
	unhold := m.holdBases()
	snap, err := m.readSnapshot(from)
	unhold()
	if err != nil || !snap.Memory || snap.Size == size.Name {
		return size
	}
	own, err := m.size(snap.Size)
	if err != nil || own.VCPUs != size.VCPUs || own.MemoryMiB != size.MemoryMiB {
		return size
	}
	return own
}

// validateInheritedSticky checks a create's sticky disks with those of the snapshot it is made from (p.From), whose
// clones it inherits on the same drives, and its mounts (validateEffectiveSticky). A snapshot that can't be read is
// startOf's to refuse.
func (m *Manager) validateInheritedSticky(p proto.CreateParams) error {
	if p.From == "" {
		return nil
	}
	unhold := m.holdBases()
	snap, err := m.readSnapshot(p.From)
	unhold()
	if err != nil {
		return nil
	}
	return validateEffectiveSticky(snap.StickyDisks, p.StickyDisks, p.Mounts)
}

// DiskLimits are the disk a create may ask for a custom shape on this host.
func (m *Manager) DiskLimits() proto.DiskLimits {
	return DiskLimits(m.cfg.Sizes, m.cfg.MinDiskGiB, m.cfg.MaxDiskGiB)
}

// checkDisk refuses a custom shape's disk outside the host's DiskLimits, unless a named size has it (a control plane
// from before disks were chosen asks for a named size's disk with a custom vCPU count and memory).
func (m *Manager) checkDisk(diskGiB int) error {
	for _, s := range m.cfg.Sizes {
		if s.DiskGiB == diskGiB {
			return nil
		}
	}
	if l := m.DiskLimits(); diskGiB < l.MinGiB || diskGiB > l.MaxGiB {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("a microVM's disk on this host is %d to %d GiB", l.MinGiB, l.MaxGiB)}
	}
	return nil
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

// makeDrives gives s's new VM its bundle drives, before it boots or restores, and records them in its meta: a restored
// VM has the devices its snapshot was made with. A boot has the host's BundleDrives, empty; a sandbox snapshot's
// restore its drives as they were, its images linked from the snapshot (bundles.go); a template snapshot's as many as
// it was made with, empty.
func (m *Manager) makeDrives(s *sandbox, origin sandboxOrigin) error {
	if err := m.makeStickyDrives(s, origin); err != nil {
		return err
	}
	vm := s.vmDir()
	switch {
	case origin.state == "":
		s.meta.BundleDrives, s.meta.BundleSlots = m.cfg.BundleDrives, nil
	case origin.snapshotDir != "":
		slots, err := snapshotDrives(vm, origin.snapshotDir, origin.bundleDrives, origin.bundleSlots)
		if err != nil {
			return err
		}
		s.meta.BundleDrives, s.meta.BundleSlots = origin.bundleDrives, slots
		return nil
	default:
		s.meta.BundleDrives, s.meta.BundleSlots = snapshotDriveCount(filepath.Dir(origin.state)), nil
	}
	return emptyDrives(vm, s.meta.BundleDrives)
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
func (m *Manager) startMachine(ctx context.Context, s *sandbox, origin sandboxOrigin, size proto.Size, e *proto.Egress, t timings, ph *proto.StartPhases) (err error) {
	vm := s.vmDir()
	// A restore runs the memory's kernel and image under the Firecracker it launches; a boot sets its own (boot).
	s.starting = ""
	if origin.state != "" {
		s.starting = m.restoredRuntime(origin.runtime)
	}
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
		if err := m.linkRootfs(vm, origin.rootfs); err != nil {
			return err
		}
		return m.makeDrives(s, origin)
	}()
	if err != nil {
		return err
	}
	if origin.reshape != nil {
		// The disk, the network and the Firecracker process side by side: none needs another. Its record (meta.json,
		// starting, with its slot) is written once the link is made, before the snapshot is loaded.
		machine, client, link, err := m.restoreParallel(ctx, vm, origin.disk, origin.state, origin.mem, egressMode(e), t, ph, func(link network.Link) error {
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
	switch {
	case origin.disk == "":
		ph.Disk, err = proto.DiskNew, newDisk(filepath.Join(vm, fc.DiskFile), size.DiskGiB)
	case origin.takeDisk:
		ph.Disk, err = takeFile(origin.disk, filepath.Join(vm, fc.DiskFile))
	default:
		ph.Disk, err = cloneDisk(origin.disk, filepath.Join(vm, fc.DiskFile))
	}
	if err != nil {
		return err
	}
	ph.DiskMs = msSince(start)
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
		if err := m.boot(ctx, s, size, ph); err != nil {
			return err
		}
		t.step("boot", &start)
		return nil
	}
	machine, client, err := m.restore(ctx, vm, origin.state, origin.mem, link, ph)
	if err != nil {
		return err
	}
	s.machine, s.guest = machine, client
	t.step("restore", &start)
	return nil
}

// boot cold-boots s from its own disk (Start, or a snapshot with no memory), on the kernel of the version its root
// filesystem is (kernelFor): the one it was made on, or a rebase moved it to. ph, when set, has its boot and its guest
// agent's wait.
func (m *Manager) boot(ctx context.Context, s *sandbox, size proto.Size, ph *proto.StartPhases) error {
	start := time.Now()
	vm := s.vmDir()
	// The kernel it boots, and its runtime as it launches with that kernel and the sticky drives it has (none for a
	// sandbox from before them).
	kernel := m.bootKernel(vmRootfs(vm))
	s.starting = m.runtimeOf(vmRootfs(vm), kernel, s.meta.StickyDrives)
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return err
	}
	s.meta.CID = m.cid()
	// Its bundle drives as they are: the guest mounts what is on them once it's up. A drive whose file is gone is empty.
	for i := 0; i < s.meta.BundleDrives; i++ {
		if _, err := os.Stat(filepath.Join(vm, bundleDriveFile(i))); err != nil {
			if err := os.WriteFile(filepath.Join(vm, bundleDriveFile(i)), nil, 0o600); err != nil {
				machine.Kill()
				return err
			}
			if i < len(s.meta.BundleSlots) {
				s.meta.BundleSlots[i] = ""
			}
		}
	}
	// Its sticky drives as they are: the guest mounts them again once it's up (mountSticky).
	if err := keepStickyFiles(s); err != nil {
		machine.Kill()
		return err
	}
	if err := machine.Boot(ctx, m.bootConfig(shape{Size: size}, kernel, s.link.Tap, s.link.MAC, s.meta.CID, s.meta.BundleDrives, s.meta.StickyDrives)); err != nil {
		machine.Kill()
		return err
	}
	booted(ph, &start)
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, err := client.WaitReady(readyCtx); err != nil {
		machine.Kill()
		return fmt.Errorf("boot: %w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	answered(ph, &start)
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
	keepMemory := p.Memory == nil || *p.Memory
	if s.meta.State == proto.StateStopped && p.SnapshotID != "" {
		// Stopped already (its VM exited or was reset, or an earlier stop the control plane never heard back from): the
		// stop is done, and answers a snapshot of its disk as it is, so a sandbox the control plane has in error can be
		// stopped rather than refused. One paused with its memory and now stopped without it lets that memory go, so its
		// next start boots from its disk, as the stop said.
		if !keepMemory && s.meta.Memory {
			_ = os.Remove(filepath.Join(s.vmDir(), "state"))
			_ = os.Remove(filepath.Join(s.vmDir(), "mem"))
			s.meta.Memory = false
			if err := m.writeMeta(s); err != nil {
				return proto.SnapshotInfo{}, err
			}
		}
		snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Memory: keepMemory && s.meta.Memory, Tier: Tier}
		if err := m.saveSnapshot(s, &snap, true); err != nil {
			return snap, err
		}
		m.pruneAuto(s.meta.ID)
		return snap, nil
	}
	if s.meta.State != proto.StateRunning || s.machine == nil {
		return proto.SnapshotInfo{}, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	vm := s.vmDir()
	t := timings{}
	start := time.Now()
	defer func() { m.log.Debug("stop", "sandbox", s.meta.ID, "timings", t) }()
	if s.unresponsive == "" {
		// Bounded: a guest that doesn't answer is stopped without its sync, as a crash would leave its disk.
		sctx, cancel := context.WithTimeout(ctx, stopSyncTimeout)
		_ = s.guest.Sync(sctx)
		cancel()
	}
	if s.unresponsive != "" {
		s.setUnresponsive("")
	}
	t.step("sync", &start)
	s.guest.Close()
	// Its balloon given back first, so its memory isn't saved inflated.
	s.endReclaimLocked()
	machine := s.machine
	if err := machine.Pause(ctx); err != nil {
		// Its Firecracker doesn't answer (its API socket refused after a reconnect, say): stopped cold, its disk as a
		// crash would leave it and its memory lost, rather than left running with the stop failed.
		m.log.Warn("couldn't pause a sandbox's VM for its stop; stopping it cold", "sandbox", s.meta.ID, "error", err)
		keepMemory = false
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
			_ = os.Remove(filepath.Join(vm, "state.new"))
			_ = os.Remove(beside)
			// Resumed on a context of its own: the call's may be what ended the snapshot. A VM that won't resume isn't left
			// paused and said to run: it is stopped cold, as one that won't pause is.
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopResumeTimeout)
			rerr := machine.Resume(rctx)
			cancel()
			if rerr == nil {
				return proto.SnapshotInfo{}, err
			}
			m.log.Warn("a sandbox's VM won't resume after its stop's snapshot failed; stopping it cold", "sandbox", s.meta.ID, "snapshot", err, "error", rerr)
			keepMemory = false
		} else {
			t.step("snapshot", &start)
		}
	}
	s.machine = nil
	machine.Kill()
	if mt := m.mountsOf(s); mt != nil {
		mt.Close()
	}
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
	// A bundle it was still waiting for is waited for again by its next start, which reserves it again.
	m.releaseBundles(s, nil)
	s.meta.Memory = keepMemory
	s.meta.Pid = 0
	s.meta.Error = ""
	if err := m.writeMeta(s); err != nil {
		return proto.SnapshotInfo{}, err
	}
	m.emit(s)
	snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Memory: keepMemory, Tier: Tier}
	if p.SnapshotID != "" {
		// An error, not a stop answered without its snapshot: the control plane records the snapshot a stop answers
		// as the sandbox's newest. The sandbox is stopped all the same, its disk and memory kept.
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
	if s.meta.State == proto.StateRunning && s.machine != nil && (p.Reset || !m.answers(ctx, s)) {
		// A recovery (Reset), or a start or resume of a machine whose guest agent doesn't answer: running as far as the
		// host knows, but of no use. It is reset, its disk kept and its memory lost, and booted cold from that disk below,
		// rather than answered as running.
		why := "its guest agent doesn't answer"
		if p.Reset {
			why = "a recovery"
		}
		m.reset(s, why)
		coldBoot = true
	}
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
	ph := &proto.StartPhases{}
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
		s.starting = m.restoredRuntime(s.meta.Runtime)
		machine, client, err := m.restore(ctx, vm, filepath.Join(vm, "state"), filepath.Join(vm, "mem"), link, ph)
		if err != nil {
			m.cfg.Network.Remove(link)
			s.link = nil
			return proto.SandboxInfo{}, err
		}
		s.machine, s.guest = machine, client
		t.step("restore", &start)
	} else {
		if err := m.boot(ctx, s, size, ph); err != nil {
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
	pending := false
	if len(bundleMounts(s)) > 0 || anyAttached(s.meta.BundleSlots) {
		// Restored, its mounts are there still; cold-booted, it mounts its drives' bundles anew.
		pending = m.attachBundles(ctx, s, m.bundleWait())
		t.step("bundles", &start)
	}
	if len(s.meta.StickyDisks) > 0 {
		// Restored, they are mounted still; cold-booted (a recovery too), they are mounted anew from the same files.
		m.mountSticky(ctx, s)
		t.step("sticky", &start)
	}
	if len(s.meta.Mounts) > 0 {
		// Restored, its FUSE mounts are still there and reach the host again; cold-booted, it mounts them anew.
		m.applyMounts(ctx, s, false)
		t.step("mounts", &start)
	}
	s.meta.State = proto.StateRunning
	s.meta.Slot = link.Slot
	s.meta.Pid = s.machine.Pid()
	s.meta.Runtime = s.starting
	s.meta.Error = ""
	if err := m.writeMeta(s); err != nil {
		m.releaseBundles(s, nil)
		return proto.SandboxInfo{}, err
	}
	if s.meta.GrowDisk {
		// Stopped (or snapshotted) before its disk was grown: grown now, as a create would.
		go m.growDisk(s, size.DiskGiB)
	}
	m.watch(s, s.machine)
	if pending {
		m.finishBundles(s)
	}
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	ph.TotalMs = t["total"]
	info := m.info(s)
	info.Timings, info.Source, info.Phases = t, source, ph
	m.emit(s)
	return info, nil
}

// Fork makes a new sandbox from the source's current state: a running source is snapshotted live (paused for the
// snapshot only), a stopped one forks from its newest snapshot.
//
// A live fork's snapshot is the fork's alone: the control plane is never told its ID, so nothing restores it again.
// Unless KeepForkSnapshots is set, the fork takes its disk (a rename, not a second copy of a disk that can be tens of
// gigabytes) and the snapshot is deleted once the fork has started, so it neither takes the source's disk space nor
// counts among its automatic snapshots (pruneAuto would drop the memory of the one before it).
func (m *Manager) Fork(ctx context.Context, p proto.ForkParams) (proto.SandboxInfo, error) {
	src, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	t := timings{}
	start := time.Now()
	began := start
	var snapID, spooled string
	var snapshotMs float64
	live := false
	src.mu.Lock()
	switch src.meta.State {
	case proto.StateRunning:
		if p.SnapshotID == "" {
			src.mu.Unlock()
			return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "forking a running sandbox needs snapshotId"}
		}
		snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: src.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Memory: true, Tier: Tier}
		var err error
		snapAt := time.Now()
		if spooled, err = m.liveSnapshot(ctx, src, &snap, t, !m.cfg.KeepForkSnapshots, nil); err != nil {
			src.mu.Unlock()
			return proto.SandboxInfo{}, err
		}
		snapshotMs = msSince(snapAt)
		snapID, live = snap.ID, true
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
	params := proto.CreateParams{SandboxID: p.NewID, Size: src.meta.Size, From: snapID, Env: env, SSHAuthorizedKeys: src.meta.SSHKeys, Egress: p.Egress, Owner: src.meta.Owner, Mounts: src.meta.Mounts}
	if params.Egress == nil {
		params.Egress = src.meta.Egress
	}
	src.mu.Unlock()
	start = time.Now()
	takeDisk := live && !m.cfg.KeepForkSnapshots
	if !takeDisk {
		m.pruneAuto(src.meta.ID)
		t.step("prune", &start)
	}
	info, err := m.create(ctx, params, takeDisk)
	if takeDisk {
		// Started or not, it has no disk now. The fork's machine has the memory file open (and mapped), so it keeps it.
		if derr := m.DeleteSnapshot(snapID); derr != nil {
			m.log.Warn("deleting a live fork's snapshot", "snapshot", snapID, "error", derr)
		}
		// Its memory, in RAM, was never queued for the disk. A fork that started maps it, which keeps the RAM in use until
		// its machine exits, so the spool counts it until then.
		if spooled != "" {
			if err != nil {
				m.spool.cancel(spooled)
			} else {
				m.keepMapped(p.NewID, spooled)
			}
		}
	}
	if err != nil {
		return info, err
	}
	for k, v := range info.Timings {
		t["clone."+k] = v
	}
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info.Timings = t
	if info.Phases != nil {
		// The whole fork: its own create, and before it the source's live snapshot.
		ph := *info.Phases
		ph.SnapshotMs, ph.TotalMs = snapshotMs, t["total"]
		info.Phases = &ph
	}
	info.Source = "fork"
	// At info: the control plane keeps no host timings, so a host's log is where a slow fork can be taken apart.
	m.log.Info("fork", "sandbox", p.NewID, "from", p.SandboxID, "size", src.meta.Size, "timings", t)
	return info, nil
}

// liveSnapshot snapshots a running sandbox (memory and disk) and lets it carry on. Called with s.mu held.
//
// transient is a snapshot deleted once used (a live fork's): memory spooled to RAM isn't queued for the disk, and its
// spool file is returned for the caller to cancel once the snapshot has gone.
//
// reserve, where it isn't nil, reserves the snapshot's room on the disk once the machine is paused and its disk can no
// longer change, before anything is copied (pausedForCopy); refused, the machine is resumed and the refusal answered.
func (m *Manager) liveSnapshot(ctx context.Context, s *sandbox, snap *proto.SnapshotInfo, t timings, transient bool, reserve func() (func(), error)) (spooled string, err error) {
	// Before anything is written: the ID is joined under snapshots/, so one such as ../sandboxes/<id>/vm would put this
	// sandbox's disk into another's.
	if !validID(snap.ID) {
		return "", &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	start := time.Now()
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return "", err
	}
	_ = s.guest.Sync(ctx)
	t.step("sync", &start)
	// Firecracker resets the VM's vsock connections when it snapshots: a kept-alive one would answer the next call
	// with EOF (seen after a live fork). Drop them so the next call dials afresh.
	s.guest.Close()
	resume, release, err := pausedForCopy(func() (func() error, error) { return m.pauseMachine(ctx, s) }, m.diskBarrier(s), reserve)
	if err != nil {
		os.RemoveAll(sdir)
		return "", err
	}
	defer release()
	defer func() {
		// The snapshot is whole either way; a VM that won't resume has been stopped (pauseMachine), not left frozen.
		if rerr := resume(); rerr != nil {
			m.log.Warn("after a live snapshot", "sandbox", s.meta.ID, "err", rerr)
		}
		s.guest.Close()
		t.step("resume", &start)
	}()
	mem := filepath.Join(sdir, "mem")
	memWrite, memDone := m.memFile(s.meta.Size, mem)
	// Memory going to RAM (the spool), the disk is copied beside it, the VM paused for the longer of the two rather than
	// both. (Memory going to the disk, the two would share it, and side by side took as long as one after the other.)
	// Paused, the guest asks for no more I/O, so the disk holds still; but a request it queued just before the pause may
	// still be served while the copy runs, and the memory would then say done what the copy may have missed. So the
	// disk is watched for writes (writeWatch: inotify, not its timestamps, which a write in the same clock tick leaves as
	// they were) from before the copy until after the memory, and its stamp is checked too: any write in between and it
	// is copied again, after the memory, as it is when the memory goes to the disk. A disk that can't be watched is
	// copied after the memory.
	beside := memWrite != mem
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	var watch *writeWatch
	if beside {
		w, err := watchWrites(disk)
		if err != nil {
			m.log.Warn("can't watch the disk for writes; copying it after the memory", "sandbox", s.meta.ID, "err", err)
			beside = false
		} else {
			watch = w
			defer watch.close()
		}
	}
	before, statErr := os.Stat(disk)
	if statErr != nil {
		_ = memDone(false)
		os.RemoveAll(sdir)
		return "", statErr
	}
	captured := time.Now()
	var diskErr error
	var diskMs float64
	diskDone := make(chan struct{})
	copyDisk := func() {
		defer close(diskDone)
		from := time.Now()
		diskErr = copySparse(disk, filepath.Join(sdir, fc.DiskFile))
		if diskErr == nil {
			diskErr = keepDrives(s.vmDir(), sdir, s.meta.BundleSlots)
		}
		diskMs = float64(time.Since(from).Microseconds()) / 1000
	}
	if beside {
		go copyDisk()
	}
	if transient && memWrite != mem {
		spooled = memWrite
		memDone = func(ok bool) error {
			if !ok {
				m.spool.cancel(spooled)
				return nil
			}
			return os.Symlink(spooled, mem)
		}
	}
	memErr := s.machine.Snapshot(ctx, filepath.Join(sdir, "state"), memWrite)
	if memErr == nil {
		memErr = memDone(true)
	} else {
		_ = memDone(false)
	}
	t["snapshot"] = float64(time.Since(captured).Microseconds()) / 1000
	if !beside {
		if memErr == nil {
			copyDisk()
		} else {
			close(diskDone)
		}
	}
	<-diskDone
	t["disk"] = diskMs
	// After a Barrier, so a write still under way as the copy ended is in the watch too (copyQuietDisk).
	if beside && memErr == nil && diskErr == nil && (s.machine.Barrier(ctx) != nil || watch.written() || !unchanged(disk, before)) {
		m.log.Info("disk written during a live snapshot; copying it again", "sandbox", s.meta.ID)
		again := time.Now()
		diskErr = copySparse(disk, filepath.Join(sdir, fc.DiskFile))
		t.step("disk.again", &again)
	}
	if memErr == nil && diskErr == nil && len(s.meta.StickyDisks) > 0 {
		// Still paused: once no write is in flight, its sticky drives are as its memory has them.
		if diskErr = s.machine.Barrier(ctx); diskErr == nil {
			// A save reserved their room with its disk; a live fork reserves nothing for its disk, which its create
			// counts, so each sticky drive's full copy reserves its own.
			diskErr = m.keepSticky(s.vmDir(), sdir, s.meta.StickyDisks, reserve != nil)
		}
		t.step("sticky", &start)
	}
	t.step("capture", &start)
	if err := errors.Join(memErr, diskErr); err != nil {
		os.RemoveAll(sdir)
		m.spool.cancel(spooled)
		return "", err
	}
	snap.SizeBytes = snapshotBytes(sdir)
	// Transient before the fork can take its disk: a host restarting in between must find it is no snapshot to keep.
	if err := m.writeSnapshotMetaAs(s, snap, transient); err != nil {
		os.RemoveAll(sdir)
		m.spool.cancel(spooled)
		return "", err
	}
	return spooled, nil
}

// trimWait bounds the guest's trim before a save: past it the save goes ahead with whatever was trimmed by then.
const trimWait = 20 * time.Second

// trimDisk asks the guest to discard its disk's free blocks (fstrim) before a save, so that with discard on the drive
// (Config.Discard) the bytes of files it deleted are holes in disk.ext4 and the snapshot copies none of them. Best
// effort, within trimWait: a guest agent too old to trim, a disk booted without discard, or a slow or failed trim only
// leaves the snapshot as big as it would have been. Called with s.mu held.
func (m *Manager) trimDisk(ctx context.Context, s *sandbox) {
	m.trimGuestDisk(ctx, s.meta.ID, s.guest)
}

// trimGuestDisk is trimDisk's call to the guest agent, and says whether it trimmed. The agent ships in the sandbox
// image (host-images), not with the host, so for a while a host talks to agents from before POST /disk/trim: their 404
// answers at once and is no trim, quietly, as is a disk booted without discard (501). The guest's trim isn't stopped
// when trimWait ends (the ioctl runs on), so the agent runs one at a time and answers 409 to another meanwhile: a
// trim that hangs costs each later save nothing, and holds nothing they need.
func (m *Manager) trimGuestDisk(ctx context.Context, id string, client *guest.Client) bool {
	ctx, cancel := context.WithTimeout(ctx, trimWait)
	defer cancel()
	start := time.Now()
	trimmed, err := client.TrimDisk(ctx)
	switch status := guest.StatusOf(err); {
	case err == nil:
		m.log.Info("trimmed the disk before a snapshot", "sandbox", id, "bytes", trimmed, "ms", time.Since(start).Milliseconds())
		return true
	case status == http.StatusNotFound, status == http.StatusNotImplemented, status == http.StatusConflict:
		// An agent that can't trim, a disk that can't discard, or a trim still running: nothing to say.
	default:
		m.log.Debug("no trim before the snapshot", "sandbox", id, "err", err)
	}
	return false
}

// diskCopies is how many times liveDiskSnapshot copies a disk that keeps being written while paused before it gives up.
const diskCopies = 4

// liveDiskSnapshot snapshots a running sandbox's disk alone (no memory) and lets it carry on: what a save keeps unless
// it asks for memory. Called with s.mu held.
//
// The copy is crash-consistent: what the disk would hold had the machine lost power at the pause. The guest flushes its
// page cache first (sync), so that is everything written until then, and the VM is paused for the copy, so the guest
// asks for no more I/O. A request it queued just before the pause may still be served during the copy, though, and a
// copy that saw part of it would be torn. So each copy is watched for writes (writeWatch, and the file's stamp beside
// it), and one that saw any is made again: a copy no write overlapped is the disk at one instant. With reflinks
// (copySparse) a copy is a clone, made in an instant.
//
// With no memory kept, what the guest hadn't written back would be lost without a word: a sync that fails fails the
// save, the VM running on as it was.
func (m *Manager) liveDiskSnapshot(ctx context.Context, s *sandbox, snap *proto.SnapshotInfo, reserve func() (func(), error)) error {
	if !validID(snap.ID) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return err
	}
	if err := s.guest.Sync(ctx); err != nil {
		os.RemoveAll(sdir)
		return fmt.Errorf("the sandbox couldn't write its files back to its disk for the snapshot: %w", err)
	}
	resume, release, err := pausedForCopy(func() (func() error, error) { return m.pauseMachine(ctx, s) }, m.diskBarrier(s), reserve)
	if err != nil {
		os.RemoveAll(sdir)
		return err
	}
	defer release()
	barrier := func() error {
		bctx, cancel := context.WithTimeout(context.Background(), resumeWait)
		defer cancel()
		return s.machine.Barrier(bctx)
	}
	err = copyQuietDisk(filepath.Join(s.vmDir(), fc.DiskFile), filepath.Join(sdir, fc.DiskFile), diskCopies, barrier)
	if err == nil {
		// Paused, with no write in flight (copyQuietDisk's last barrier): its sticky drives as they are with its disk.
		err = m.keepSticky(s.vmDir(), sdir, s.meta.StickyDisks, reserve != nil)
	}
	if rerr := resume(); rerr != nil {
		err = errors.Join(err, rerr)
	}
	if err != nil {
		os.RemoveAll(sdir)
		return err
	}
	snap.Memory = false
	snap.SizeBytes = snapshotBytes(sdir)
	if err := m.writeSnapshotMeta(s, snap); err != nil {
		os.RemoveAll(sdir)
		return err
	}
	return nil
}

// diskBarrier waits, bounded by resumeWait, until no write of s's guest is in flight (fc.Machine.Barrier: with the Sync
// io_engine, a round trip to the VM's API answers only once the writes before it are done).
func (m *Manager) diskBarrier(s *sandbox) func() error {
	return func() error {
		bctx, cancel := context.WithTimeout(context.Background(), resumeWait)
		defer cancel()
		return s.machine.Barrier(bctx)
	}
}

// resumeWait bounds each try to resume a VM paused for a snapshot, apart from the call's context: a caller that has
// gone (its connection closed) mustn't leave the VM paused.
const resumeWait = 10 * time.Second

// resumeTries is how many times a paused VM is asked to resume before it is given up on and stopped.
const resumeTries = 3

// pauseMachine pauses s's VM for a snapshot and returns what resumes it, to call once the snapshot is taken. A pause
// whose answer is lost (a dropped connection, a cancelled context) may still have applied, so a failed pause is
// resumed too before its error is returned: resuming a running VM changes nothing. resume tries resumeTries times,
// each within resumeWait whatever ctx says; a VM that still won't resume is killed, so it is stopped (with its disk) as
// an exited VM is, rather than left frozen while it is reported running, and resume says so. Called with s.mu held.
func (m *Manager) pauseMachine(ctx context.Context, s *sandbox) (resume func() error, err error) {
	// Its balloon given back first, so a snapshot doesn't save it inflated.
	s.endReclaimLocked()
	machine := s.machine
	resume = func() error {
		var err error
		for try := range resumeTries {
			if try > 0 {
				time.Sleep(time.Duration(try) * 200 * time.Millisecond)
			}
			rctx, cancel := context.WithTimeout(context.Background(), resumeWait)
			err = machine.Resume(rctx)
			cancel()
			if err == nil {
				return nil
			}
		}
		m.log.Error("couldn't resume a VM paused for a snapshot; stopping it", "sandbox", s.meta.ID, "err", err)
		machine.Kill()
		return fmt.Errorf("sandbox %s couldn't be resumed after its snapshot, so it was stopped: %w", s.meta.ID, err)
	}
	if err := machine.Pause(ctx); err != nil {
		if rerr := resume(); rerr != nil {
			return nil, errors.Join(err, rerr)
		}
		return nil, err
	}
	return resume, nil
}

// watchDisk starts watching a disk for writes (watchWrites); a test stands in a failing one.
var watchDisk = watchWrites

// copyQuietDisk copies disk to dst (copySparse) until a copy has no write to disk overlapping it, at most tries times.
// A disk that can't be watched (inotify's instances used up, say) can't be shown quiet by its stamps alone, which a
// write in the same clock tick leaves as they were: only a reflink, a clone of the file at one instant, is taken of it,
// and on a file system without them the copy fails rather than risk a torn one.
//
// A write raises its IN_MODIFY as it finishes, so one still under way when a copy ends isn't in the watch yet. barrier
// (fc.Machine.Barrier: a round trip through the VMM thread, which makes every disk write) is called after each copy and
// before its watch is read: by its return every write that was under way has finished and is in the watch. A barrier
// that fails counts as a write.
func copyQuietDisk(disk, dst string, tries int, barrier func() error) error {
	for try := 1; ; try++ {
		watch, werr := watchDisk(disk)
		if werr != nil {
			if out, err := exec.Command("cp", "--reflink=always", disk, dst).CombinedOutput(); err != nil {
				_ = os.Remove(dst)
				return fmt.Errorf("can't watch the disk for writes during its copy (%v), and can't clone it (%s): no copy of it can be shown whole", werr, strings.TrimSpace(string(out)))
			}
			return nil
		}
		before, err := os.Stat(disk)
		if err != nil {
			watch.close()
			return err
		}
		err = copySparse(disk, dst)
		settled := barrier() == nil
		quiet := settled && !watch.written() && unchanged(disk, before)
		watch.close()
		if err != nil {
			return err
		}
		if quiet {
			return nil
		}
		if try >= tries {
			_ = os.Remove(dst)
			return fmt.Errorf("the disk was written during each of %d copies while paused", tries)
		}
		_ = os.Remove(dst)
	}
}

type snapshotMeta struct {
	proto.SnapshotInfo
	Size string `json:"size"`
	// Rootfs is the root filesystem its disk is a layer over (base.go: a host image version's, or a template's pulled
	// base's); empty in snapshots from before it was kept.
	Rootfs string `json:"rootfs,omitempty"`
	// Guest is what its sandbox's template image has (meta's), which a sandbox made from it reports too.
	Guest *proto.GuestCapabilities `json:"guest,omitempty"`
	// BundleDrives and BundleSlots are the sandbox's bundle drives when its memory was taken (bundles.go): a sandbox
	// restored from it gets the same, from the links in the snapshot's directory.
	BundleDrives int      `json:"bundleDrives,omitempty"`
	BundleSlots  []string `json:"bundleSlots,omitempty"`
	// StickyDisks are the sandbox's sticky disks, their clones kept in the snapshot's directory on the same drives
	// (sticky.go), memory or not; StickyDrives is how many sticky drives its VM had when its memory was taken.
	StickyDisks  []stickyDisk `json:"stickyDisks,omitempty"`
	StickyDrives int          `json:"stickyDrives,omitempty"`
	// Transient is a live fork's own snapshot (Fork): its disk is moved into the fork and it is deleted once the fork
	// has started. It is in no sandbox's history (snapshotsOf), and one a previous run left is deleted when the host
	// starts (reapTransientSnapshots), since its disk may be gone.
	Transient bool `json:"transient,omitempty"`
}

func (m *Manager) snapshotDir(id string) string {
	return filepath.Join(m.cfg.Root, "snapshots", id)
}

func (m *Manager) writeSnapshotMeta(s *sandbox, snap *proto.SnapshotInfo) error {
	return m.writeSnapshotMetaAs(s, snap, false)
}

// writeSnapshotMetaAs is writeSnapshotMeta, marking the snapshot transient (snapshotMeta.Transient) or not.
func (m *Manager) writeSnapshotMetaAs(s *sandbox, snap *proto.SnapshotInfo, transient bool) error {
	// The sandbox's base is now the snapshot's too: recorded under the base lock.
	defer m.holdBases()()
	rootfs, base := rootfsOf(s.vmDir())
	snap.Base = base
	snap.CPU, snap.Runtime = m.CPU(), s.meta.Runtime
	sm := snapshotMeta{SnapshotInfo: *snap, Size: s.meta.Size, Rootfs: rootfs, Guest: s.meta.Guest, Transient: transient}
	if snap.Memory {
		sm.BundleDrives, sm.BundleSlots = s.meta.BundleDrives, s.meta.BundleSlots
		sm.StickyDrives = s.meta.StickyDrives
	}
	sm.StickyDisks = attachedSticky(s.meta.StickyDisks)
	raw, _ := json.MarshalIndent(sm, "", "  ")
	// Durably, by a rename, so a published snapshot's record is never left half written.
	return fsutil.WriteFileDurably(filepath.Join(m.snapshotDir(snap.ID), "meta.json"), raw, 0o600)
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
// memory file is never written after it is made. A stop's (fromStop) is refused, before anything is copied, when the
// copy could fill the host's disk (roomForSnapshot). Called with s.mu held.
func (m *Manager) saveSnapshot(s *sandbox, snap *proto.SnapshotInfo, fromStop bool) error {
	if !validID(snap.ID) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	vm := s.vmDir()
	release := func() {}
	if fromStop {
		var err error
		if release, err = m.roomForSnapshot(s, filepath.Join(vm, fc.DiskFile)); err != nil {
			return err
		}
	}
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		release()
		return err
	}
	err := copySparse(filepath.Join(vm, fc.DiskFile), filepath.Join(sdir, fc.DiskFile))
	if err == nil {
		err = m.keepSticky(vm, sdir, s.meta.StickyDisks, true)
	}
	// Copied (its blocks now show in the free space) or not: the reservation has done its job either way.
	release()
	if err != nil {
		os.RemoveAll(sdir)
		return err
	}
	if snap.Memory {
		if err := os.Link(filepath.Join(vm, "state"), filepath.Join(sdir, "state")); err != nil {
			snap.Memory = false
		} else if err := m.spool.link(filepath.Join(vm, "mem"), filepath.Join(sdir, "mem")); err != nil {
			snap.Memory = false
		} else if err := keepDrives(vm, sdir, s.meta.BundleSlots); err != nil {
			dropDrives(sdir)
			snap.Memory = false
		}
	}
	snap.SizeBytes = snapshotBytes(sdir)
	if err := m.writeSnapshotMeta(s, snap); err != nil {
		// Unpublished (a full disk, say): the copy is no snapshot, and nothing that lists snapshots would ever find it.
		os.RemoveAll(sdir)
		return err
	}
	return nil
}

// snapshotHeadroom is the free space an automatic snapshot on a stop leaves on the host's disk, beyond its copy of the
// sandbox's disk: room for the other sandboxes' writes meanwhile.
const snapshotHeadroom = 10 << 30

// roomForSnapshot refuses a stop's snapshot when the file system it goes on has less free than the sandbox's disk
// takes (its allocated blocks, which a sparse copy writes again) and snapshotHeadroom, counting the copies other stops
// have been let make and haven't finished: copied, it would fill the disk every sandbox on the host writes to. Let
// through, its copy's size is reserved until release is called, once the copy is done or has failed. A file system
// that can't be measured is let through.
func (m *Manager) roomForSnapshot(s *sandbox, disk string) (release func(), err error) {
	// Its sticky drives are copied with its disk (keepSticky), so their room is reserved with it.
	return m.reserveSnapshotRoom(disk, stickyUsage(s), func(free, size int64) error {
		m.log.Warn("no automatic snapshot on a stop: the host's disk is nearly full", "sandbox", s.meta.ID, "freeBytes", free, "needBytes", size+snapshotHeadroom)
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf("sandbox %s is stopped, with its disk, but no snapshot was taken of it: the host has %d GiB of disk free, and a copy of its disk needs %d GiB and %d GiB to spare", s.meta.ID, max(free, 0)>>30, size>>30, snapshotHeadroom>>30)}
	})
}

// roomToSave is roomForSnapshot for a snapshot taken or saved by hand (SaveSnapshot): its disk's copy, and for a
// running sandbox its memory as well, which reaches the disk even when it goes to RAM first. Refused, it says how
// much is free, and the control plane passes that on (exhausted). A keep (KeepSnapshot) links its source's files and
// takes no room, so it isn't asked.
func (m *Manager) roomToSave(s *sandbox, withMemory bool) (release func(), err error) {
	var memory int64
	if withMemory {
		if size, err := m.size(s.meta.Size); err == nil {
			memory = int64(size.MemoryMiB) << 20
		}
	}
	// Its sticky drives are copied with its disk (keepSticky), so their room is reserved with it.
	return m.reserveSnapshotRoom(filepath.Join(s.vmDir(), fc.DiskFile), memory+stickyUsage(s), func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and a snapshot of this sandbox needs about %s and must leave %s free. Delete snapshots you no longer need, or free space on the host, and try again.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// pausedForCopy pauses a machine (pause), waits until no write of its guest is in flight (barrier, fc.Machine.Barrier),
// and then, its disk still, reserves the copy's room (reserve; nil reserves nothing, and waits for nothing): measured now, it is exact, where a measure taken while it ran could be outgrown by the writes its guest
// flushed before the pause. Refused, the machine is resumed (pause's resume, which stops one that won't) and the
// refusal answered. Otherwise the caller resumes it, and releases the room once the copy is written.
func pausedForCopy(
	pause func() (func() error, error),
	barrier func() error,
	reserve func() (func(), error),
) (resume func() error, release func(), err error) {
	resume, err = pause()
	if err != nil {
		return nil, nil, err
	}
	if reserve == nil {
		return resume, func() {}, nil
	}
	// No guest write still in flight once the barrier answers: the disk measured after it is the disk copied.
	if err := barrier(); err != nil {
		return nil, nil, errors.Join(fmt.Errorf("the sandbox's disk couldn't be settled for the snapshot: %w", err), resume())
	}
	release, err = reserve()
	if err != nil {
		return nil, nil, errors.Join(err, resume())
	}
	return resume, release, nil
}

// gibText is a byte count in GiB, to one decimal place.
func gibText(n int64) string {
	return fmt.Sprintf("%.1f GiB", float64(n)/float64(1<<30))
}

// reserveSnapshotRoom reserves the room a snapshot's copy of disk (its allocated blocks) and extra bytes take, until
// release, when the file system has that and snapshotHeadroom free beside what other copies have reserved; else it
// answers refuse's error, given the free bytes and the size. A file system that can't be measured is let through.
func (m *Manager) reserveSnapshotRoom(disk string, extra int64, refuse func(free, size int64) error) (release func(), err error) {
	return m.reserveRoom(diskUsage(disk)+extra, refuse)
}

// reserveRoom reserves size bytes of the host's disk for a copy until release, when the file system has that and
// snapshotHeadroom free beside what other copies have reserved; else it answers refuse's error, given the free bytes
// and the size. Every copy the host makes of a disk on its own initiative (snapshots, and sticky disks' full copies)
// reserves here, so two never count the same free space. A file system that can't be measured is let through.
func (m *Manager) reserveRoom(size int64, refuse func(free, size int64) error) (release func(), err error) {
	statfs := m.statfs
	if statfs == nil {
		statfs = syscall.Statfs
	}
	m.snapshotRoom.Lock()
	defer m.snapshotRoom.Unlock()
	// Memory still in the RAM spool reaches this disk once it is flushed: counted as taken already. Read before the
	// file system, so a flush that finishes between the two reads is counted twice (in both), never in neither.
	pending := m.spool.pending()
	var st syscall.Statfs_t
	if err := statfs(filepath.Join(m.cfg.Root, "snapshots"), &st); err != nil {
		return func() {}, nil
	}
	free := int64(st.Bavail)*st.Bsize - m.snapshotReserved - pending
	need := size + snapshotHeadroom
	if free < need {
		return nil, refuse(free, size)
	}
	m.snapshotReserved += size
	var once sync.Once
	return func() {
		once.Do(func() {
			m.snapshotRoom.Lock()
			m.snapshotReserved -= size
			m.snapshotRoom.Unlock()
		})
	}, nil
}

func (m *Manager) snapshotsOf(sandboxID string) []snapshotMeta {
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "snapshots"))
	var out []snapshotMeta
	for _, e := range entries {
		snap, err := m.readSnapshot(e.Name())
		if err == nil && !snap.Transient && (sandboxID == "" || snap.SandboxID == sandboxID) {
			out = append(out, snap)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// latestSnapshot is a stopped sandbox's newest automatic snapshot: its state at its last stop. A saved one, which may
// hold an older state (a kept history entry, newer by its CreatedAt), never is.
func (m *Manager) latestSnapshot(sandboxID string) string {
	for _, snap := range m.snapshotsOf(sandboxID) {
		if snap.Kind == "auto" {
			return snap.ID
		}
	}
	return ""
}

// pruneAuto keeps the newest AutoSnapshots automatic snapshots of a sandbox, and memory only on the newest one. It
// rewrites snapshot metadata, which names each snapshot's base, so it holds the base lock to read (a prune's walk never
// reads one half written) and replaces each meta.json by a rename rather than truncating it.
func (m *Manager) pruneAuto(sandboxID string) {
	defer m.holdBases()()
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
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
			// Without its memory it needs no bundle images: a sandbox made from it boots and mounts its own.
			dropDrives(dir)
			snap.BundleDrives, snap.BundleSlots = 0, nil
			// Its sticky disks stay: a sandbox made from its disk gets them too, on a VM of the host's sticky drives.
			snap.StickyDrives = 0
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

// MeasuredSnapshots is Snapshots, each measured as it is on the disk now (measureSnapshots), not as it was made:
// memory spooled to RAM since flushed, a memory file pruned since. With the groups of files several of them share, of
// the snapshots listed, so the control plane can count each of those once, for the snapshot its own records say keeps
// it. For the host's snapshot.list (FeatureSnapshotSizes).
func (m *Manager) MeasuredSnapshots(sandboxID string) ([]proto.SnapshotInfo, []proto.SharedBytes) {
	all := m.snapshotsOf("")
	held, unique, shared := m.measureSnapshots(all)
	listed := map[string]bool{}
	var out []proto.SnapshotInfo
	for _, snap := range all {
		if sandboxID != "" && snap.SandboxID != sandboxID {
			continue
		}
		listed[snap.ID] = true
		info := snap.SnapshotInfo
		info.SizeBytes, info.UniqueBytes = held[snap.ID], unique[snap.ID]
		out = append(out, info)
	}
	var groups []proto.SharedBytes
	for _, group := range shared {
		for _, id := range group.Snapshots {
			if listed[id] {
				groups = append(groups, group)
				break
			}
		}
	}
	return out, groups
}

// measureSnapshots measures snaps' files on the disk now (snapshotFiles): held is all a snapshot's files take, unique
// what of that is in no other of snaps, and shared the rest, by the set of snapshots that hold it: bytes of files linked
// into several, one entry per set of holders (sorted), so the list is bounded by how they share, not by their files.
func (m *Manager) measureSnapshots(snaps []snapshotMeta) (held, unique map[string]int64, shared []proto.SharedBytes) {
	type file struct {
		bytes   int64
		holders []string
	}
	files := map[fileID]*file{}
	held, unique = map[string]int64{}, map[string]int64{}
	for _, snap := range snaps {
		held[snap.ID], unique[snap.ID] = 0, 0
		snapshotFiles(m.snapshotDir(snap.ID), func(id fileID, bytes int64) {
			held[snap.ID] += bytes
			f := files[id]
			if f == nil {
				f = &file{bytes: bytes}
				files[id] = f
			}
			f.holders = append(f.holders, snap.ID)
		})
	}
	groups := map[string]*proto.SharedBytes{}
	for _, f := range files {
		if len(f.holders) == 1 {
			unique[f.holders[0]] += f.bytes
			continue
		}
		sort.Strings(f.holders)
		key := strings.Join(f.holders, ",")
		group := groups[key]
		if group == nil {
			group = &proto.SharedBytes{Snapshots: f.holders}
			groups[key] = group
		}
		group.Bytes += f.bytes
	}
	for _, group := range groups {
		shared = append(shared, *group)
	}
	sort.Slice(shared, func(i, j int) bool {
		return strings.Join(shared[i].Snapshots, ",") < strings.Join(shared[j].Snapshots, ",")
	})
	return held, unique, shared
}

// fileID is a file on the host: its device and inode, the same for every hard link to it.
type fileID struct{ dev, ino uint64 }

// snapshotFiles calls each with every file a snapshot's directory has on the disk now, and the blocks it has allocated
// (a sparse disk's holes take none), each file once. Left out: a memory file still in RAM, a symlink into the spool
// until it is flushed to the disk; and its bundle drives, links to the bundle cache's images, which are the cache's.
func snapshotFiles(dir string, each func(id fileID, bytes int64)) {
	seen := map[fileID]bool{}
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() || strings.HasPrefix(d.Name(), "bundle") {
			return nil
		}
		var st syscall.Stat_t
		if syscall.Lstat(path, &st) != nil {
			return nil
		}
		id := fileID{uint64(st.Dev), st.Ino}
		if seen[id] {
			return nil
		}
		seen[id] = true
		each(id, st.Blocks*512)
		return nil
	})
}

// snapshotBytes is all a snapshot's directory takes on the disk now (snapshotFiles), shared files included.
func snapshotBytes(dir string) int64 {
	var total int64
	snapshotFiles(dir, func(_ fileID, bytes int64) { total += bytes })
	return total
}

// SaveSnapshot keeps a sandbox's current state under a name, until it is deleted: live for a running sandbox
// (memory too), from its newest snapshot for a stopped one.

// SaveSnapshot keeps a sandbox's current state under a name, until it is deleted: live for a running sandbox, from its
// newest snapshot for a stopped one. A running sandbox's save keeps its disk only, unless p.Memory asks for its
// memory too: a memory file is as big as the machine's memory, and ties a sandbox made from the snapshot to the same
// machine size. A stopped one's keeps what its stop kept, memory or not, whatever p.Memory says.
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
		snap.Memory = p.Memory
		// Memory too only when it is asked for: the disk alone otherwise.
		// A cheap refusal first, before the trim; the room is reserved for good once the machine is paused, its disk
		// still (pausedForCopy), since the guest's writes flushed before the pause may grow it.
		early, err := m.roomToSave(s, snap.Memory)
		if err != nil {
			return snap, err
		}
		early()
		m.trimDisk(ctx, s)
		reserve := func() (func(), error) { return m.roomToSave(s, snap.Memory) }
		if !snap.Memory {
			return snap, m.liveDiskSnapshot(ctx, s, &snap, reserve)
		}
		_, err = m.liveSnapshot(ctx, s, &snap, timings{}, false, reserve)
		return snap, err
	case proto.StateStopped:
		// As its stop left it, as a save of a stopped sandbox or a history entry is: memory only matters live. Its memory,
		// if any, is linked, not copied: only its disk takes room.
		release, err := m.roomToSave(s, false)
		if err != nil {
			return snap, err
		}
		defer release()
		snap.Memory = s.meta.Memory
		return snap, m.saveSnapshot(s, &snap, false)
	default:
		return snap, conflict("sandbox %s is %s", s.meta.ID, s.meta.State)
	}
}

// KeepSnapshot makes p.SnapshotID a saved snapshot of what p.From holds (snapshot.keep): the files of p.From linked
// into a directory of its own, so neither pruneAuto nor a sandbox's delete, which only remove automatic snapshots,
// takes them, and deleting either snapshot leaves the other whole. p.From stays as it was (an automatic snapshot stays
// in its sandbox's history). Nothing in a snapshot's directory is written after it is made (a memory file never is, a
// disk is copied out of it), so a link is as good as a copy.
//
// The memory comes along only while p.From still has it all (pruneAuto drops it from all but the newest): the answer
// says whether it did. Held against pruneAuto and a sandbox's delete (autoMu), so p.From isn't half removed meanwhile.
func (m *Manager) KeepSnapshot(_ context.Context, p proto.SnapshotParams) (proto.SnapshotInfo, error) {
	if !validID(p.SnapshotID) {
		return proto.SnapshotInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	// The new snapshot's meta names its source's base: held as any snapshot's save holds it (base.go). Before autoMu,
	// as pruneAuto takes them.
	defer m.holdBases()()
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	src, err := m.readSnapshot(p.From)
	if err != nil {
		return proto.SnapshotInfo{}, err
	}
	if src.Transient {
		// A live fork's own, whose disk the fork takes: it is no snapshot to keep.
		return proto.SnapshotInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no snapshot %s on this host", p.From)}
	}
	sdir := m.snapshotDir(p.SnapshotID)
	if _, err := os.Lstat(sdir); err == nil {
		return proto.SnapshotInfo{}, conflict("snapshot %s already exists on this host", p.SnapshotID)
	}
	if err := os.MkdirAll(sdir, 0o700); err != nil {
		return proto.SnapshotInfo{}, err
	}
	from := m.snapshotDir(p.From)
	if err := os.Link(filepath.Join(from, fc.DiskFile), filepath.Join(sdir, fc.DiskFile)); err != nil {
		os.RemoveAll(sdir)
		return proto.SnapshotInfo{}, err
	}
	// Its sticky disks' clones, which no one writes once in a snapshot, as its disk is.
	if err := linkSticky(from, sdir, src.StickyDisks); err != nil {
		os.RemoveAll(sdir)
		return proto.SnapshotInfo{}, err
	}
	kept := src
	// Its own save time, and its source's state's time (TakenAt).
	kept.SnapshotInfo = proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: src.SandboxID, Kind: "saved", Name: p.Name, CreatedAt: time.Now().UnixMilli(), TakenAt: src.TakenAtOrCreated(), Memory: src.Memory, Base: src.Base, Tier: Tier, CPU: src.CPU, Runtime: src.Runtime}
	if kept.Memory {
		ok := os.Link(filepath.Join(from, "state"), filepath.Join(sdir, "state")) == nil &&
			m.spool.link(filepath.Join(from, "mem"), filepath.Join(sdir, "mem")) == nil
		for i, digest := range src.BundleSlots {
			if ok && digest != "" {
				ok = os.Link(filepath.Join(from, bundleDriveFile(i)), filepath.Join(sdir, bundleDriveFile(i))) == nil
			}
		}
		if !ok {
			// Its disk alone, as pruneAuto leaves an older snapshot: a sandbox made from it boots.
			_ = os.Remove(filepath.Join(sdir, "state"))
			_ = os.Remove(filepath.Join(sdir, "mem"))
			dropDrives(sdir)
			kept.Memory = false
		}
	}
	if !kept.Memory {
		kept.BundleDrives, kept.BundleSlots, kept.StickyDrives = 0, nil, 0
	}
	// Its own files in full: it shares them with its source, but it is the one kept (snapshotSizes counts them for it).
	kept.SizeBytes = snapshotBytes(sdir)
	raw, _ := json.MarshalIndent(kept, "", "  ")
	if err := fsutil.WriteFileDurably(filepath.Join(sdir, "meta.json"), raw, 0o600); err != nil {
		os.RemoveAll(sdir)
		return proto.SnapshotInfo{}, err
	}
	// What of it is its own, and what it shares (with its source, at least): the control plane counts the shared files
	// for one of their holders, as it does from snapshot.list, so the size it records now is the one a refresh gives.
	answer := kept.SnapshotInfo
	held, unique, shared := m.measureSnapshots(m.snapshotsOf(""))
	answer.SizeBytes = held[answer.ID]
	answer.UniqueBytes = unique[answer.ID]
	for _, group := range shared {
		if slices.Contains(group.Snapshots, answer.ID) {
			answer.Shared = append(answer.Shared, group)
		}
	}
	return answer, nil
}

// DeleteSnapshot removes a snapshot.
func (m *Manager) DeleteSnapshot(id string) error {
	if _, err := m.readSnapshot(id); err != nil {
		return err
	}
	defer m.evictBundles()
	// Not while a keep links it (KeepSnapshot).
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	return os.RemoveAll(m.snapshotDir(id))
}

// Delete ends a sandbox and removes its disk and automatic snapshots. Saved snapshots stay, kept ones too
// (KeepSnapshot): their links hold the files.
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
	m.autoMu.Lock()
	for _, snap := range m.snapshotsOf(id) {
		if snap.Kind == "auto" {
			_ = os.RemoveAll(m.snapshotDir(snap.ID))
		}
	}
	m.autoMu.Unlock()
	if m.cfg.Mounts != nil {
		m.cfg.Mounts.Forget(id)
	}
	// A bundle it waited for is no longer its to keep.
	m.releaseBundles(s, nil)
	if err := os.RemoveAll(s.dir); err != nil {
		return err
	}
	// Its bundle images may be in use by no one now.
	m.evictBundles()
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
	req := execRequest(p)
	req.Detached = p.Detached
	if !p.Stream || onOutput == nil {
		res, err := client.Exec(ctx, req)
		return execResultOf(res), err
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

// execResultOf is a guest's command result as the host answers it.
func execResultOf(r guest.ExecResult) proto.ExecResult {
	return proto.ExecResult{ExitCode: r.ExitCode, Stdout: r.Stdout, Stderr: r.Stderr, Truncated: r.Truncated, TimedOut: r.TimedOut, DurationMs: r.DurationMs, Pid: r.Pid}
}

func execRequest(p proto.ExecParams) guest.ExecRequest {
	req := guest.ExecRequest{Command: p.Command, Argv: p.Argv, Cwd: p.Cwd, Env: p.Env, User: p.User, TimeoutMs: p.TimeoutMs, Stdin: p.Stdin, ID: p.CommandID}
	if p.Attribution != "" {
		req.ProxyUser = "sandbox-" + sanitizeUser(p.Attribution)
	}
	return req
}

// StartCommand starts a command with its CommandID in the guest's background, where it outlives the call, the host's
// connection and the host's own restarts, and answers its pid. A guest agent from before is unsupported (the host then
// runs the command itself).
func (m *Manager) StartCommand(ctx context.Context, p proto.ExecParams) (int, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return 0, err
	}
	res, err := client.StartCommand(ctx, execRequest(p))
	switch {
	case err == nil:
		return res.Pid, nil
	case guest.IsUnknownRoute(err):
		return 0, &proto.Error{Code: proto.ErrUnsupported, Message: "this sandbox's guest agent predates detached commands"}
	case guest.IsRefused(err):
		return 0, &proto.Error{Code: proto.ErrInvalid, Message: guest.RefusalMessage(err)}
	case guest.IsConflict(err):
		return 0, &proto.Error{Code: proto.ErrConflict, Message: guest.RefusalMessage(err)}
	}
	return 0, err
}

// CommandStatus is a command the guest keeps by its ID, waiting up to wait for it to end. One the guest doesn't know
// (or a guest from before) is not_found.
func (m *Manager) CommandStatus(ctx context.Context, sandboxID, commandID string, wait time.Duration) (proto.ExecStatus, error) {
	client, err := m.running(sandboxID)
	if err != nil {
		return proto.ExecStatus{}, err
	}
	status, err := client.CommandStatus(ctx, commandID, wait)
	if err != nil {
		if guest.IsUnknownRoute(err) {
			return proto.ExecStatus{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no command %s in sandbox %s", commandID, sandboxID)}
		}
		return proto.ExecStatus{}, err
	}
	out := proto.ExecStatus{CommandID: commandID, State: status.State}
	if status.State == guest.ExecRunning {
		out.Stdout, out.Stderr, out.Truncated = status.Stdout, status.Stderr, status.Truncated
	}
	if status.Result != nil {
		r := execResultOf(*status.Result)
		out.Result = &r
	}
	return out, nil
}

// KillCommand kills a command the guest knows by its ID, and its process group, saying whether it was running. One the
// guest doesn't know, or a guest from before, is not killed.
func (m *Manager) KillCommand(ctx context.Context, sandboxID, commandID string) (bool, error) {
	client, err := m.running(sandboxID)
	if err != nil {
		return false, err
	}
	killed, err := client.KillCommand(ctx, commandID)
	if guest.IsUnknownRoute(err) {
		return false, nil
	}
	return killed, err
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

// ListProcesses answers a running sandbox's busiest processes, from its guest agent (GET /processes). An agent from
// before it could list them (a sandbox booted, or resumed from memory, on an older image) is ErrUnsupported.
func (m *Manager) ListProcesses(ctx context.Context, p proto.ProcessesParams) (proto.ProcessList, error) {
	client, err := m.running(p.SandboxID)
	if err != nil {
		return proto.ProcessList{}, err
	}
	list, err := client.Processes(ctx, p.Limit)
	if guest.IsNotFound(err) {
		return proto.ProcessList{}, &proto.Error{Code: proto.ErrUnsupported, Message: "this sandbox's guest agent is from before it could list its processes"}
	}
	if err != nil {
		return proto.ProcessList{}, err
	}
	out := proto.ProcessList{Processes: make([]proto.Process, len(list.Processes)), Total: list.Total, SampleMs: list.SampleMs}
	for i, proc := range list.Processes {
		out.Processes[i] = proto.Process(proc)
	}
	return out, nil
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

// SetEnv replaces a sandbox's env in meta.json: what its identity carries from its next boot (a start, a resume, a
// restore) and what a fork with none of its own inherits. A running guest's env file is the caller's to rewrite.
func (m *Manager) SetEnv(id string, env map[string]string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Env = nil
	if len(env) > 0 {
		s.meta.Env = maps.Clone(env)
	}
	return m.writeMeta(s)
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
