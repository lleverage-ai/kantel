package microvm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

var testCPU = proto.CPUFingerprint{Vendor: "AuthenticAMD", Family: 25, Model: 97, FeaturesHash: "sha256:0123456789abcdef"}

// fingerprintHost is a host's microVM files under a directory of its own, as on another machine: a Firecracker that
// says v1.17.0, versioned images old and new (versionedImages) whose kernels carry a version banner and whose
// versions are installed (a manifest each), and the tier's root.
func fingerprintHost(t *testing.T) *Manager {
	t.Helper()
	imgs := versionedImages(t)
	for _, v := range []string{"old", "new"} {
		kernel := fmt.Sprintf("\x7fELF...Linux version 6.1.%d (builder@kantel) #1 SMP ...", map[string]int{"old": 102, "new": 155}[v])
		if err := os.WriteFile(filepath.Join(imgs, "v", v, "vmlinux"), []byte(kernel), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(imgs, "v", v, "manifest.json"), []byte(`{}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	firecracker := filepath.Join(t.TempDir(), "firecracker")
	if err := os.WriteFile(firecracker, []byte("#!/bin/sh\necho 'Firecracker v1.17.0'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cpu := testCPU
	return &Manager{cfg: Config{
		Root: filepath.Join(filepath.Dir(imgs), "microvm"), Firecracker: firecracker,
		Kernel: filepath.Join(imgs, "vmlinux"), Rootfs: filepath.Join(imgs, "sandbox.ext4"), PinBase: true, CPU: &cpu,
	}}
}

func versionFile(m *Manager, version string) string {
	return filepath.Join(filepath.Dir(m.cfg.Rootfs), "v", version, "sandbox.ext4")
}

// Two hosts with the same Firecracker, kernels and images, at other paths and inodes, give the same portable runtime
// for each image version, though their local fingerprints differ; each version's has its own kernel and its name.
func TestPortableRuntimeIsTheSameOnAnotherHost(t *testing.T) {
	one, two := fingerprintHost(t), fingerprintHost(t)
	for _, v := range []string{"old", "new"} {
		a, b := one.portableRuntime(versionFile(one, v)), two.portableRuntime(versionFile(two, v))
		if a == "" || a != b {
			t.Fatalf("version %s: %q on one host, %q on the other", v, a, b)
		}
		if one.runtimeFingerprint(versionFile(one, v)) == two.runtimeFingerprint(versionFile(two, v)) {
			t.Fatal("the local fingerprints match across hosts: the test's hosts aren't apart")
		}
	}
	old, current := one.portableRuntime(versionFile(one, "old")), one.portableRuntime(one.cfg.Rootfs)
	want := fmt.Sprintf("firecracker=v1.17.0;kernel=6.1.102+%s;image=old;sticky=%d", old[len("firecracker=v1.17.0;kernel=6.1.102+"):][:12], StickyDrives)
	if old != want {
		t.Fatalf("old's runtime = %q, want %q", old, want)
	}
	// The default path is the current version's file.
	if current != one.portableRuntime(versionFile(one, "new")) || !strings.Contains(current, ";kernel=6.1.155+") || !strings.Contains(current, ";image=new;") {
		t.Fatalf("the current image's runtime = %q", current)
	}
	// Free page reporting is a device the snapshot keeps.
	one.cfg.FreePageReporting = true
	if got := one.portableRuntime(versionFile(one, "old")); got != old+";free-page-reporting" {
		t.Fatalf("with free page reporting: %q", got)
	}
}

// A version's recorded digest goes in its image, since one made of an older install's files is "initial" anywhere; a
// host image that isn't versioned is told by its digest alone, and without one it can't be told; a template's own
// root filesystem is no part of the runtime, as locally.
func TestPortableRuntimeImages(t *testing.T) {
	m := fingerprintHost(t)
	sum := strings.Repeat("ab", 32)
	if err := os.WriteFile(versionFile(m, "old")+".sha256-source", []byte(sum), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := m.portableRuntime(versionFile(m, "old")); !strings.Contains(got, ";image=old@sha256:abababababababab;") {
		t.Fatalf("a version with a recorded digest: %q", got)
	}
	template := filepath.Join(m.cfg.Root, "images", "templates", "key.ext4")
	if got := m.portableRuntime(template); got == "" || strings.Contains(got, "image=") {
		t.Fatalf("a template's root filesystem: %q", got)
	}
	plain := filepath.Join(t.TempDir(), "sandbox.ext4")
	if err := os.WriteFile(plain, []byte("plain"), 0o644); err != nil {
		t.Fatal(err)
	}
	m.cfg.Rootfs, m.cfg.PinBase = plain, false
	if got := m.portableRuntime(plain); got != "" {
		t.Fatalf("an unversioned image without a digest: %q", got)
	}
	if err := os.WriteFile(plain+".sha256-source", []byte(sum), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := m.portableRuntime(plain); !strings.Contains(got, ";image=sha256:abababababababab;") {
		t.Fatalf("an unversioned image with a digest: %q", got)
	}
	// Some other file (a VM linking nothing): unknown.
	if got := m.portableRuntime(""); got != "" {
		t.Fatalf("no root filesystem: %q", got)
	}
	// Without a Firecracker that answers: unknown.
	m.cfg.Firecracker = filepath.Join(t.TempDir(), "missing")
	if got := m.portableRuntime(template); got != "" {
		t.Fatalf("without Firecracker: %q", got)
	}
}

// The facts' runtimes: one per installed version, the default path's folded into the current version's, and templates'
// own root filesystems'.
func TestRuntimesListEachVersion(t *testing.T) {
	m := fingerprintHost(t)
	store := images.Store{Dir: filepath.Dir(m.cfg.Rootfs)}
	got := m.Runtimes(store.SandboxImages())
	var names []string
	for _, r := range got {
		names = append(names, r.Image)
		if r.Runtime == "" {
			t.Fatalf("an empty runtime: %+v", got)
		}
	}
	if strings.Join(names, ",") != "new,old," {
		t.Fatalf("runtimes for %q, want new, old and templates': %+v", names, got)
	}
	if got[0].Runtime != m.portableRuntime(versionFile(m, "new")) || got[2].Runtime != m.portableRuntime(filepath.Join(m.cfg.Root, "images", "templates", "x.ext4")) {
		t.Fatalf("runtimes %+v", got)
	}
}

// A snapshot records the CPU and the portable runtime it was made on, in its meta and its answer, and a kept copy of it
// the same.
func TestSnapshotsRecordTheirFingerprints(t *testing.T) {
	m := fingerprintHost(t)
	dir := filepath.Join(m.cfg.Root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), versionFile(m, "old"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped}}
	if err := os.MkdirAll(m.snapshotDir("snp_1"), 0o700); err != nil {
		t.Fatal(err)
	}
	snap := proto.SnapshotInfo{ID: "snp_1", SandboxID: "sbx_1", Kind: "saved", Memory: true, Tier: Tier}
	if err := m.writeSnapshotMeta(s, &snap); err != nil {
		t.Fatal(err)
	}
	want := m.portableRuntime(versionFile(m, "old"))
	if !testCPU.Same(snap.CPU) || snap.Runtime != want || want == "" {
		t.Fatalf("the answer has %+v, %q; want %+v, %q", snap.CPU, snap.Runtime, testCPU, want)
	}
	kept, err := m.readSnapshot("snp_1")
	if err != nil {
		t.Fatal(err)
	}
	if !testCPU.Same(kept.CPU) || kept.Runtime != want {
		t.Fatalf("meta.json has %+v, %q", kept.CPU, kept.Runtime)
	}
	raw, _ := json.Marshal(kept.SnapshotInfo)
	if !strings.Contains(string(raw), `"cpu":{"vendor":"AuthenticAMD","family":25,"model":97,"featuresHash":"sha256:0123456789abcdef"}`) {
		t.Fatalf("on the wire: %s", raw)
	}
}

// A template snapshot's answer carries what it was made on, as its meta.json keeps it.
func TestTemplateSnapshotAnswersWhatItWasMadeOn(t *testing.T) {
	cpu := testCPU
	kept := templateSnapshotMeta{SnapshotID: "tsn_1", CPU: &cpu, PortableRuntime: "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;sticky=4"}
	res := kept.result()
	if !testCPU.Same(res.CPU) || res.Runtime != kept.PortableRuntime {
		t.Fatalf("result has %+v, %q", res.CPU, res.Runtime)
	}
	// One made before they were kept says neither.
	if old := (templateSnapshotMeta{SnapshotID: "tsn_0"}).result(); old.CPU != nil || old.Runtime != "" {
		t.Fatalf("an older one's result has %+v, %q", old.CPU, old.Runtime)
	}
}
