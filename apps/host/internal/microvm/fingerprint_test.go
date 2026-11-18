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
		digest := strings.Repeat(map[string]string{"old": "0a", "new": "0b"}[v], 32)
		if err := os.WriteFile(filepath.Join(imgs, "v", v, "sandbox.ext4.sha256-source"), []byte(digest), 0o644); err != nil {
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
	want := fmt.Sprintf("firecracker=v1.17.0;kernel=6.1.102+%s;image=old@sha256:0a0a0a0a0a0a0a0a;sticky=%d", old[len("firecracker=v1.17.0;kernel=6.1.102+"):][:12], StickyDrives)
	if old != want {
		t.Fatalf("old's runtime = %q, want %q", old, want)
	}
	// The default path is the current version's file.
	if current != one.portableRuntime(versionFile(one, "new")) || !strings.Contains(current, ";kernel=6.1.155+") || !strings.Contains(current, ";image=new@sha256:0b0b0b0b0b0b0b0b;") {
		t.Fatalf("the current image's runtime = %q", current)
	}
	// Free page reporting is a device the snapshot keeps.
	one.cfg.FreePageReporting = true
	if got := one.portableRuntime(versionFile(one, "old")); got != old+";free-page-reporting" {
		t.Fatalf("with free page reporting: %q", got)
	}
}

// A version's recorded digest goes in its image; one without (an older install's files, migrated into "initial" on
// every host) can't be told. A host image that isn't versioned is told by its digest alone, and without one it can't
// be told either; a template's own root filesystem is no part of the runtime, as locally.
func TestPortableRuntimeImages(t *testing.T) {
	m := fingerprintHost(t)
	sum := strings.Repeat("ab", 32)
	if err := os.WriteFile(versionFile(m, "old")+".sha256-source", []byte(sum), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := m.portableRuntime(versionFile(m, "old")); !strings.Contains(got, ";image=old@sha256:abababababababab;") {
		t.Fatalf("a version with a recorded digest: %q", got)
	}
	// Two hosts' "initial" versions, of different images and no digest: neither can be told, so they never match.
	if err := os.Remove(versionFile(m, "old") + ".sha256-source"); err != nil {
		t.Fatal(err)
	}
	if got := m.portableRuntime(versionFile(m, "old")); got != "" {
		t.Fatalf("a version without a recorded digest: %q", got)
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

// A snapshot records the host's CPU and the runtime of the machine it was taken of, as that machine booted or was
// restored (meta.Runtime), not what the host's files say now; a machine from before that was kept records none.
func TestSnapshotsRecordTheirFingerprints(t *testing.T) {
	m := fingerprintHost(t)
	dir := filepath.Join(m.cfg.Root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), versionFile(m, "old"))
	booted := m.portableRuntime(versionFile(m, "old"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped, Runtime: booted}}
	// The host's files change after the machine booted: its snapshots still say what it runs.
	if err := os.WriteFile(filepath.Join(filepath.Dir(m.cfg.Rootfs), "v", "old", "vmlinux"), []byte("Linux version 6.1.200 (x) #1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if m.portableRuntime(versionFile(m, "old")) == booted {
		t.Fatal("the kernel's change didn't show")
	}
	for _, id := range []string{"snp_1", "snp_2"} {
		if err := os.MkdirAll(m.snapshotDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	snap := proto.SnapshotInfo{ID: "snp_1", SandboxID: "sbx_1", Kind: "saved", Memory: true, Tier: Tier}
	if err := m.writeSnapshotMeta(s, &snap); err != nil {
		t.Fatal(err)
	}
	if !testCPU.Same(snap.CPU) || snap.Runtime != booted || booted == "" {
		t.Fatalf("the answer has %+v, %q; want %+v, %q", snap.CPU, snap.Runtime, testCPU, booted)
	}
	kept, err := m.readSnapshot("snp_1")
	if err != nil {
		t.Fatal(err)
	}
	if !testCPU.Same(kept.CPU) || kept.Runtime != booted {
		t.Fatalf("meta.json has %+v, %q", kept.CPU, kept.Runtime)
	}
	raw, _ := json.Marshal(kept.SnapshotInfo)
	if !strings.Contains(string(raw), `"cpu":{"vendor":"AuthenticAMD","family":25,"model":97,"featuresHash":"sha256:0123456789abcdef"}`) {
		t.Fatalf("on the wire: %s", raw)
	}
	s.meta.Runtime = ""
	older := proto.SnapshotInfo{ID: "snp_2", SandboxID: "sbx_1", Kind: "saved", Memory: true, Tier: Tier}
	if err := m.writeSnapshotMeta(s, &older); err != nil {
		t.Fatal(err)
	}
	if older.Runtime != "" {
		t.Fatalf("a machine from before its runtime was kept: %q", older.Runtime)
	}
}

// A machine restored from memory runs the snapshot's kernel and image under the Firecracker just launched, which takes
// its snapshots from then on.
func TestRestoredRuntime(t *testing.T) {
	m := fingerprintHost(t)
	made := "firecracker=v1.16.0;kernel=6.1.102+0123456789ab;image=old;sticky=4"
	if got, want := m.restoredRuntime(made), "firecracker=v1.17.0;kernel=6.1.102+0123456789ab;image=old;sticky=4"; got != want {
		t.Fatalf("restoredRuntime = %q, want %q", got, want)
	}
	for _, unknown := range []string{"", "kernel=6.1.102+0123456789ab", "firecracker=v1.16.0"} {
		if got := m.restoredRuntime(unknown); got != "" {
			t.Fatalf("restoredRuntime(%q) = %q", unknown, got)
		}
	}
	m.cfg.Firecracker = filepath.Join(t.TempDir(), "missing")
	if got := m.restoredRuntime(made); got != "" {
		t.Fatalf("without Firecracker: %q", got)
	}
}

// A size's or shared template keeps the runtime it booted with; one from before it was kept has none.
func TestSizeTemplateRuntime(t *testing.T) {
	dir := t.TempDir()
	if got := sizeTemplateRuntime(dir); got != "" {
		t.Fatalf("an older template's runtime = %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, templateRuntimeFile), []byte("firecracker=v1.17.0;kernel=k;sticky=4"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := sizeTemplateRuntime(dir); got != "firecracker=v1.17.0;kernel=k;sticky=4" {
		t.Fatalf("sizeTemplateRuntime = %q", got)
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

// A sandbox made before the sticky drives boots with none, and its runtime says so: it isn't the host's.
func TestRuntimeWithTheMachinesStickyDrives(t *testing.T) {
	m := fingerprintHost(t)
	rootfs := versionFile(m, "old")
	legacy := m.runtimeWith(rootfs, 0)
	if !strings.HasSuffix(legacy, ";sticky=0") || legacy == m.portableRuntime(rootfs) {
		t.Fatalf("a sandbox without sticky drives: %q, the host's %q", legacy, m.portableRuntime(rootfs))
	}
	for _, r := range m.Runtimes(images.Store{Dir: filepath.Dir(m.cfg.Rootfs)}.SandboxImages()) {
		if r.Runtime == legacy {
			t.Fatalf("the host reports %q", legacy)
		}
	}
}
