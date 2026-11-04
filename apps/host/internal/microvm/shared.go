package microvm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Shared templates (Config.SharedTemplate, on by default): a template snapshot per vCPU count rather than per size,
// each serving every memory and disk a sandbox of that count may ask for, named size or custom shape. Firecracker
// restores a snapshot with the vCPUs and memory it was made with and can add neither vCPUs nor (beyond a virtio-mem
// device it was made with) memory, so:
//
//   - Memory: a template boots with the least memory its count may have and a virtio-mem device holding the rest,
//     unplugged. A restore plugs what the sandbox asks for beyond the boot memory. Unplugged memory is a hole in the
//     memory file, so a template costs the disk of the memory its boot touched only.
//   - Disk: a template's disk is the smallest a named size has (every custom shape's is at least that); a larger one
//     is grown, the file and then the guest's ext4, online, just after the create answers.
//   - vCPUs: one template per count. The named sizes' counts are made in the background when the tier starts. A
//     create of another count cold-boots while its template is made, once, in the background, for the next.

// hotplugBootArgs online plugged memory at once (no udev rule needed), with its memory map on the plugged memory
// itself rather than the boot memory's. Sandboxes are never shrunk, so hot-remove doesn't matter.
const hotplugBootArgs = " memhp_default_state=online memory_hotplug.memmap_on_memory=1"

// sharedPrefix starts a shared template's name (shared-<n>vcpu); no size may be named so.
const sharedPrefix = "shared-"

const (
	// sharedMinMemoryMiB is the least memory a shared template boots with, so the template's services (the desktop,
	// the browser, Docker) start as they would in a small size.
	sharedMinMemoryMiB = 1024
	// sharedMemoryPerVCPU is the least memory a vCPU has, and sharedMaxMemoryPerVCPU the most, as the control plane
	// allows them (packages/compute's MEMORY_MB_PER_VCPU).
	sharedMemoryPerVCPU    = 512
	sharedMaxMemoryPerVCPU = 8192
	// sharedRetry is how long a vCPU count whose template failed waits before another try.
	sharedRetry = 10 * time.Minute
)

// errNoVirtioMem is a guest kernel without virtio-mem: no shared template can grow, so the tier keeps a template per
// named size instead.
var errNoVirtioMem = errors.New("the guest kernel has no virtio-mem driver")

// shape is what a template is made with: a size, and the hotpluggable memory beyond it.
type shape struct {
	proto.Size
	HotplugMiB int
}

// sharedConfig is the shared templates' shape, but for their vCPUs.
type sharedConfig struct {
	maxVCPUs int
	// memoryMiB and maxMemoryMiB, when set, are every count's boot memory and the most it grows to; unset, each
	// count's own (shape).
	memoryMiB    int
	maxMemoryMiB int
	diskGiB      int
	// hostMemoryMiB is the machine's (0: unknown).
	hostMemoryMiB int64
	sizes         []proto.Size
	// first are the vCPU counts made when the tier starts, in order.
	first []int
}

// sharedShape is the shared templates' shape from the config, or nil when they are off. Unset parts default to: as
// many vCPUs as the machine has (at most 32, and at least any named size has), and the smallest disk a named size
// has; a count's memory comes from shape.
func sharedShape(cfg Config, hostMemoryMiB int64, cpus int) *sharedConfig {
	if !cfg.SharedTemplate {
		return nil
	}
	c := &sharedConfig{maxVCPUs: cfg.TemplateVCPUs, memoryMiB: cfg.TemplateMemoryMiB, maxMemoryMiB: cfg.TemplateMaxMemoryMiB, diskGiB: cfg.TemplateDiskGiB, hostMemoryMiB: hostMemoryMiB, sizes: cfg.Sizes}
	if c.maxVCPUs <= 0 {
		c.maxVCPUs = min(maxCustomVCPUs, cpus)
		for _, s := range cfg.Sizes {
			c.maxVCPUs = max(c.maxVCPUs, s.VCPUs)
		}
	}
	if c.diskGiB <= 0 {
		for _, s := range cfg.Sizes {
			if c.diskGiB == 0 || s.DiskGiB < c.diskGiB {
				c.diskGiB = s.DiskGiB
			}
		}
		if c.diskGiB <= 0 {
			c.diskGiB = 10
		}
	}
	// The default size's count first (most sandboxes), then the rest of the named sizes', smallest first.
	seen := map[int]bool{}
	add := func(n int) {
		if n >= 1 && n <= c.maxVCPUs && !seen[n] {
			seen[n] = true
			c.first = append(c.first, n)
		}
	}
	for _, s := range cfg.Sizes {
		if s.Name == "default" {
			add(s.VCPUs)
		}
	}
	rest := []int{}
	for _, s := range cfg.Sizes {
		rest = append(rest, s.VCPUs)
	}
	sort.Ints(rest)
	for _, n := range rest {
		add(n)
	}
	return c
}

// shape is the shared template for a vCPU count. It boots with the least memory the count may have (512 MiB a vCPU,
// at least 1 GiB, or less where a named size of the count has less) and can grow to the most (8 GiB a vCPU, at most
// the machine's, or more where a named size has more).
func (c *sharedConfig) shape(vcpus int) shape {
	base := c.memoryMiB
	if base <= 0 {
		base = max(sharedMinMemoryMiB, vcpus*sharedMemoryPerVCPU)
		for _, s := range c.sizes {
			if s.VCPUs == vcpus && s.MemoryMiB < base {
				base = max(sharedMemoryPerVCPU, s.MemoryMiB)
			}
		}
	}
	top := c.maxMemoryMiB
	if top <= 0 {
		top = vcpus * sharedMaxMemoryPerVCPU
		if c.hostMemoryMiB > 0 {
			top = min(top, int(c.hostMemoryMiB))
		}
		for _, s := range c.sizes {
			if s.VCPUs == vcpus {
				top = max(top, s.MemoryMiB)
			}
		}
	}
	// Firecracker's hotpluggable total is a whole number of slots, and a device needs one at least.
	hotplug := max(top-base, 0)
	hotplug = max(fc.HotplugSlotMiB, (hotplug+fc.HotplugSlotMiB-1)/fc.HotplugSlotMiB*fc.HotplugSlotMiB)
	return shape{Size: proto.Size{Name: fmt.Sprintf("%s%dvcpu", sharedPrefix, vcpus), VCPUs: vcpus, MemoryMiB: base, DiskGiB: c.diskGiB}, HotplugMiB: hotplug}
}

// fits is the shared template a size restores from, when one can make it.
func (c *sharedConfig) fits(size proto.Size) (shape, bool) {
	if c == nil || size.VCPUs < 1 || size.VCPUs > c.maxVCPUs {
		return shape{}, false
	}
	sh := c.shape(size.VCPUs)
	ok := size.MemoryMiB >= sh.MemoryMiB && size.MemoryMiB <= sh.MemoryMiB+sh.HotplugMiB && size.DiskGiB >= sh.DiskGiB
	return sh, ok
}

// sharedOn says whether the tier uses shared templates: configured, and the guest kernel can grow one.
func (m *Manager) sharedOn() bool {
	return m.shared != nil && !m.sharedOff.Load()
}

// sharedFor is how a new sandbox of the size is made when shared templates are on: from its vCPU count's template
// (ready), or by a cold boot while that template is made in the background (fits but not ready), or by a cold boot
// (doesn't fit).
func (m *Manager) sharedFor(size proto.Size) (sh shape, fits, ready bool) {
	sh, fits = m.shared.fits(size)
	if !fits {
		return sh, false, false
	}
	if m.templateReady(sh) {
		return sh, true, true
	}
	go m.prepareShape(size.VCPUs)
	return sh, true, false
}

// prepareShared makes the shared templates the tier starts with, one after another.
func (m *Manager) prepareShared() {
	for _, n := range m.shared.first {
		if m.closed.Load() || !m.sharedOn() {
			return
		}
		m.prepareShape(n)
	}
}

// prepareShape makes a vCPU count's shared template unless it is made, being made, or failed lately.
func (m *Manager) prepareShape(vcpus int) {
	sh := m.shared.shape(vcpus)
	m.mu.Lock()
	if m.preparing[vcpus] || time.Since(m.sharedFailed[vcpus]) < sharedRetry {
		m.mu.Unlock()
		return
	}
	ctx, ok := m.startBuilder()
	if !ok {
		m.mu.Unlock()
		return
	}
	m.preparing[vcpus] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.preparing, vcpus)
		m.mu.Unlock()
		m.builders.Done()
	}()
	if m.templateReady(sh) {
		m.dropSizeTemplates()
		return
	}
	_, _, err := m.template(ctx, sh)
	if err == nil {
		m.dropSizeTemplates()
		return
	}
	if m.closed.Load() {
		return
	}
	if errors.Is(err, errNoVirtioMem) {
		// Every count would fail alike: a template per named size, as with shared templates off.
		m.log.Warn("shared templates off: a template per size instead", "error", err)
		m.sharedOff.Store(true)
		return
	}
	m.log.Warn("shared template", "vcpus", vcpus, "error", err)
	m.mu.Lock()
	m.sharedFailed[vcpus] = time.Now()
	m.mu.Unlock()
}

// dropSizeTemplates removes the named sizes' templates, once a shared template is ready: with shared templates on no
// sandbox restores one (a shape that doesn't fit cold-boots), and the guest kernel has shown it can grow memory, so
// they are only disk (gigabytes each, after an upgrade from a host that made them). Turning shared templates off
// makes them again on first use. A running sandbox restored from one keeps its mapping of the removed memory file.
func (m *Manager) dropSizeTemplates() {
	m.sizeTemplatesDropped.Do(func() {
		for _, size := range m.cfg.Sizes {
			dir := filepath.Join(m.cfg.Root, "templates", size.Name)
			_ = os.RemoveAll(dir + ".building")
			if _, err := os.Stat(dir); err != nil {
				continue
			}
			lock := m.templateLock(size.Name)
			if lock != nil {
				lock.Lock()
			}
			err := os.RemoveAll(dir)
			if lock != nil {
				lock.Unlock()
			}
			if err != nil {
				m.log.Warn("removing a size's template", "size", size.Name, "error", err)
			} else {
				m.log.Info("removed a size's template: shared templates are on", "size", size.Name)
			}
		}
	})
}

// WaitTemplate makes, or waits for, the template a create of p would restore: its vCPU count's shared template, or
// its named size's. Nothing for a shape that cold-boots.
func (m *Manager) WaitTemplate(ctx context.Context, p proto.CreateParams) error {
	size, err := m.createSize(p)
	if err != nil {
		return err
	}
	if m.sharedOn() {
		sh, fits := m.shared.fits(size)
		for fits && !m.templateReady(sh) && m.sharedOn() {
			// At once when the background is making it already.
			m.prepareShape(size.VCPUs)
			m.mu.Lock()
			failed := m.sharedFailed[size.VCPUs]
			m.mu.Unlock()
			if !failed.IsZero() {
				return fmt.Errorf("the %d-vCPU shared template failed (logged)", size.VCPUs)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
		if m.sharedOn() {
			return nil
		}
	}
	if isCustom(size.Name) {
		return nil
	}
	_, _, err = m.template(ctx, shape{Size: size})
	return err
}

// checkVirtioMem fails a shared template whose guest has no virtio-mem driver: its sandboxes could never be given
// their memory.
func checkVirtioMem(ctx context.Context, client *guest.Client) error {
	if _, err := client.ListFiles(ctx, "/sys/bus/virtio/drivers/virtio_mem"); err != nil {
		if guest.IsNotFound(err) {
			return errNoVirtioMem
		}
		return fmt.Errorf("checking for virtio-mem: %w", err)
	}
	return nil
}

// restoreParallel makes a new sandbox's disk, its network and its Firecracker process side by side, then restores the
// snapshot into it; linked, when set, runs once all three are made and before the snapshot loads. The link is
// returned when it was made, even on an error, for the caller to remove.
func (m *Manager) restoreParallel(ctx context.Context, vm, diskPath, statePath, memPath, egress string, t timings, linked func(network.Link) error) (*fc.Machine, *guest.Client, *network.Link, error) {
	start := time.Now()
	var wg sync.WaitGroup
	var diskErr, netErr, launchErr error
	var link network.Link
	var machine *fc.Machine
	var diskMs, netMs, launchMs float64
	elapsed := func(since time.Time) float64 { return float64(time.Since(since).Microseconds()) / 1000 }
	wg.Add(3)
	go func() {
		defer wg.Done()
		diskErr = copySparse(diskPath, filepath.Join(vm, fc.DiskFile))
		diskMs = elapsed(start)
	}()
	go func() {
		defer wg.Done()
		link, netErr = m.cfg.Network.Add(egress)
		netMs = elapsed(start)
	}()
	go func() {
		defer wg.Done()
		machine, launchErr = fc.Launch(ctx, m.cfg.Firecracker, vm)
		launchMs = elapsed(start)
	}()
	wg.Wait()
	t["prepare.disk"], t["prepare.network"], t["prepare.launch"] = diskMs, netMs, launchMs
	t.step("prepare", &start)
	var made *network.Link
	if netErr == nil {
		made = &link
	}
	if err := errors.Join(diskErr, netErr, launchErr); err != nil {
		if machine != nil {
			machine.Kill()
		}
		return nil, nil, made, err
	}
	if linked != nil {
		if err := linked(link); err != nil {
			machine.Kill()
			return nil, nil, made, err
		}
	}
	if err := machine.Load(ctx, statePath, memPath, link.Tap); err != nil {
		machine.Kill()
		return nil, nil, made, fmt.Errorf("%w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	t.step("load", &start)
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := client.WaitReady(readyCtx); err != nil {
		machine.Kill()
		return nil, nil, made, fmt.Errorf("%w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	t.step("agent", &start)
	return machine, client, made, nil
}

// growDisk makes a running sandbox's disk (meta.GrowDisk) its size's: the file, then (told by Firecracker) the
// guest's ext4, online, once the guest sees the new capacity. Run once a create, resume or adoption has answered, under
// the sandbox's lock so a stop waits for it. Doing it again changes nothing, so the flag is cleared only once it has
// worked: a stop first, a failure or a restart leaves it for the next resume or adoption. A failure leaves the smaller
// disk working and is logged.
func (m *Manager) growDisk(s *sandbox, gib int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.meta.GrowDisk || s.meta.State != proto.StateRunning || s.machine == nil || m.holdGrowth.Load() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	start := time.Now()
	if err := growDisk(ctx, s.machine, s.guest, filepath.Join(s.vmDir(), fc.DiskFile), int64(gib)<<30); err != nil {
		m.log.Warn("growing a sandbox's disk", "sandbox", s.meta.ID, "gib", gib, "error", err)
		return
	}
	s.meta.GrowDisk = false
	if err := m.writeMeta(s); err != nil {
		m.log.Warn("growing a sandbox's disk", "sandbox", s.meta.ID, "error", err)
	}
	m.log.Debug("grew a sandbox's disk", "sandbox", s.meta.ID, "gib", gib, "ms", time.Since(start).Milliseconds())
}

// diskDevice is what growDisk needs of a running VM: to tell its guest the disk changed size.
type diskDevice interface {
	RescanDrive(ctx context.Context, id, path string) error
}

// diskGuest is what growDisk needs of its guest agent.
type diskGuest interface {
	GrowDisk(ctx context.Context, bytes int64) error
	Exec(ctx context.Context, req guest.ExecRequest) (guest.ExecResult, error)
}

// growDisk makes the disk file at path (never smaller) bytes long, tells the guest, and grows its ext4 to fill it once
// it sees that capacity.
func growDisk(ctx context.Context, machine diskDevice, client diskGuest, path string, bytes int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() < bytes {
		if err := os.Truncate(path, bytes); err != nil {
			return err
		}
	} else {
		// Never shrunk: a cold snapshot of a larger size keeps its disk.
		bytes = info.Size()
	}
	// Also when the file was already grown: a VM restored from a snapshot has the capacity it had then.
	if err := machine.RescanDrive(ctx, "disk", fc.DiskFile); err != nil {
		return err
	}
	// The agent waits for the guest to see the capacity before it grows the file system.
	err = client.GrowDisk(ctx, bytes)
	if !guest.IsNotFound(err) {
		return err
	}
	// An agent from before /disk/grow: the image's resize2fs, once the kernel shows the capacity (in 512-byte sectors).
	script := fmt.Sprintf(`i=0; while [ "$(cat /sys/class/block/vdb/size)" -lt %d ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "/dev/vdb never reached %d bytes" >&2; exit 1; }; sleep 0.1; done; exec resize2fs /dev/vdb`, bytes/512, bytes)
	res, err := client.Exec(ctx, guest.ExecRequest{Argv: []string{"sh", "-c", script}, User: "root", TimeoutMs: 50000})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("resize2fs exited %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

type reshapeResult struct {
	timings timings
	err     error
}

// reshape gives a sandbox restored from a shared template the memory it was asked for: plugged, and answered once the
// guest has it all. Its disk is growDisk's.
func (m *Manager) reshape(ctx context.Context, machine *fc.Machine, size proto.Size, sh shape) reshapeResult {
	t := timings{}
	start := time.Now()
	fail := func(err error) reshapeResult { return reshapeResult{timings: t, err: err} }
	extra := size.MemoryMiB - sh.MemoryMiB
	if extra <= 0 {
		return reshapeResult{timings: t}
	}
	plug := (extra + fc.HotplugBlockMiB - 1) / fc.HotplugBlockMiB * fc.HotplugBlockMiB
	if err := machine.PlugMemory(ctx, plug); err != nil {
		return fail(err)
	}
	t.step("plug", &start)
	// The guest plugs its blocks asynchronously; a sandbox is ready when it has the memory it was promised.
	deadline := time.Now().Add(30 * time.Second)
	for {
		st, err := machine.Hotplug(ctx)
		if err != nil {
			return fail(err)
		}
		if st.PluggedMiB >= plug {
			break
		}
		if time.Now().After(deadline) {
			return fail(fmt.Errorf("the guest plugged %d of %d MiB", st.PluggedMiB, plug))
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.step("plugged", &start)
	return reshapeResult{timings: t}
}

// defaultCPUs is the machine's CPUs, a shared template's most vCPUs by default.
func defaultCPUs() int { return runtime.NumCPU() }
