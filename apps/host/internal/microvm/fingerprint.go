package microvm

import (
	"fmt"
	"path/filepath"
	"sync"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A snapshot's memory restores only onto the CPU and runtime it was made on. runtimeFingerprint says that for this
// host, by the files' paths, sizes, times and inodes; another host can't compare those. So each snapshot also records
// its host's CPU fingerprint (hostinfo.CPU) and its runtime as any host can say it (portableRuntime), and the host
// reports both for itself in its facts (Runtimes): a snapshot's memory can go to a host whose CPU fingerprint is the
// same and whose runtimes include the snapshot's.

// fingerprints is what the tier has read of the CPU, and of the runtime's files by their local fingerprint
// (fc.Fingerprint), so a file is read again only once it changes.
type fingerprints struct {
	cpuOnce sync.Once
	cpu     *proto.CPUFingerprint
	mu      sync.Mutex
	files   map[string]fileIdentity
}

type fileIdentity struct {
	local, id string
}

// CPU is the host's CPU fingerprint: Config.CPU, else read once. nil when it can't be read.
func (m *Manager) CPU() *proto.CPUFingerprint {
	m.fingerprints.cpuOnce.Do(func() {
		m.fingerprints.cpu = m.cfg.CPU
		if m.fingerprints.cpu == nil {
			m.fingerprints.cpu = hostinfo.CPU()
		}
	})
	if m.fingerprints.cpu == nil {
		return nil
	}
	cpu := *m.fingerprints.cpu
	return &cpu
}

// identify is read(path), kept while the file's local fingerprint stays the same.
func (m *Manager) identify(path string, read func(string) string) string {
	local := fc.Fingerprint(path)
	f := &m.fingerprints
	f.mu.Lock()
	known, ok := f.files[path]
	f.mu.Unlock()
	if ok && known.local == local {
		return known.id
	}
	id := read(path)
	f.mu.Lock()
	if f.files == nil {
		f.files = map[string]fileIdentity{}
	}
	f.files[path] = fileIdentity{local: local, id: id}
	f.mu.Unlock()
	return id
}

// runtimeImage is what portableRuntime says of rootfs: for a host image version's file, the version, and with it
// `@sha256:` and a prefix of the digest it was downloaded with where that was recorded (a version made of an older
// install's plain files is "initial" on every host); for a host image that isn't versioned (Config.Rootfs, a plain
// file), `sha256:` and the prefix; "" for a template's own root filesystem (images/templates/<key>.ext4), which, as in
// runtimeFingerprint, is no part of the runtime (it is keyed by its image already). ok is false when rootfs can't be
// told: a host image that isn't versioned and has no recorded digest.
func (m *Manager) runtimeImage(rootfs string) (image string, ok bool) {
	if rootfs != "" && rootfs == m.cfg.Rootfs {
		// The default path, which with versioned images is a link to the current version's file.
		if target, err := filepath.EvalSymlinks(rootfs); err == nil && images.VersionOf(target) != "" {
			rootfs = target
		}
	}
	digest := func() string {
		sum, err := images.RecordedSHA256(rootfs)
		if err != nil || len(sum) < 16 {
			return ""
		}
		return "sha256:" + sum[:16]
	}
	if v := images.VersionOf(rootfs); v != "" {
		if d := digest(); d != "" {
			return v + "@" + d, true
		}
		return v, true
	}
	if m.pulledRootfs(rootfs) {
		return "", true
	}
	if rootfs != "" && rootfs == m.cfg.Rootfs {
		if d := digest(); d != "" {
			return d, true
		}
	}
	return "", false
}

// portableRuntime is runtimeFingerprint as any host can compare it: the Firecracker version
// (hostinfo.FirecrackerVersion), the guest kernel booted over rootfs (hostinfo.GuestKernel of kernelFor), the host
// image (runtimeImage), the sticky drives and free page reporting, such as
// `firecracker=v1.17.0;kernel=6.1.102+0123456789ab;image=host-images-20261103@sha256:0123456789abcdef;sticky=4;free-page-reporting`.
// Empty when any of them can't be told: such a snapshot's memory goes to no other host.
func (m *Manager) portableRuntime(rootfs string) string {
	image, ok := m.runtimeImage(rootfs)
	if !ok {
		return ""
	}
	firecracker := m.identify(m.cfg.Firecracker, hostinfo.FirecrackerVersion)
	kernel := m.identify(m.kernelFor(rootfs), hostinfo.GuestKernel)
	if firecracker == "" || kernel == "" {
		return ""
	}
	fp := "firecracker=" + firecracker + ";kernel=" + kernel
	if image != "" {
		fp += ";image=" + image
	}
	fp += fmt.Sprintf(";sticky=%d", StickyDrives)
	if m.cfg.FreePageReporting {
		fp += ";free-page-reporting"
	}
	return fp
}

// Runtimes are the runtime fingerprints the tier restores snapshots with (proto.Facts.Runtimes): one for each host
// image version's root filesystem in versions (images.Store.SandboxImages), one for Config.Rootfs, and one for
// templates' own root filesystems (Image ""). One that can't be told, or that another has already, is left out.
func (m *Manager) Runtimes(versions []string) []proto.HostRuntime {
	var out []proto.HostRuntime
	seen := map[string]bool{}
	add := func(rootfs string) {
		image, ok := m.runtimeImage(rootfs)
		if !ok {
			return
		}
		runtime := m.portableRuntime(rootfs)
		if runtime == "" || seen[runtime] {
			return
		}
		seen[runtime] = true
		if v := images.VersionOf(rootfs); v != "" {
			image = v
		} else if !m.pulledRootfs(rootfs) {
			if target, err := filepath.EvalSymlinks(rootfs); err == nil && images.VersionOf(target) != "" {
				image = images.VersionOf(target)
			}
		}
		out = append(out, proto.HostRuntime{Image: image, Runtime: runtime})
	}
	for _, rootfs := range versions {
		add(rootfs)
	}
	add(m.cfg.Rootfs)
	add(filepath.Join(m.cfg.Root, "images", "templates", "template.ext4"))
	return out
}
