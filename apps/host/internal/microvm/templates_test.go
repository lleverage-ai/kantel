package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeDocker is the template pipeline's runner without Docker: it records each command, answers what Docker would,
// and makes the helper container's rootfs.ext4.
type fakeDocker struct {
	calls [][]string
	// fail fails the first command starting with it, with output.
	fail string
	// missing: there is no docker CLI.
	missing bool
}

func (f *fakeDocker) run(_ context.Context, name string, args ...string) ([]byte, error) {
	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)
	if f.missing {
		return nil, fmt.Errorf("docker %s: %w", args[0], &exec.Error{Name: "docker", Err: exec.ErrNotFound})
	}
	if f.fail != "" && strings.HasPrefix(strings.Join(call, " "), f.fail) {
		return []byte("Error response from daemon: manifest unknown"), errors.New("docker pull: exit status 1: Error response from daemon: manifest unknown")
	}
	switch {
	case args[0] == "version":
		return []byte("27.3.1\n"), nil
	case len(args) >= 2 && args[0] == "image" && args[1] == "inspect":
		return []byte("sha256:feed\n"), nil
	case args[0] == "create":
		return []byte("c0ffee\n"), nil
	case args[0] == "run":
		for i, arg := range args {
			if arg == "-v" {
				work := strings.TrimSuffix(args[i+1], ":/work")
				return nil, os.WriteFile(filepath.Join(work, "rootfs.ext4"), []byte("ext4"), 0o600)
			}
		}
	}
	return nil, nil
}

// neverBuilt fails if any command was a `docker build`: a template's image is only ever pulled.
func (f *fakeDocker) neverBuilt(t *testing.T) {
	t.Helper()
	for _, call := range f.calls {
		if len(call) > 1 && call[0] == "docker" && (call[1] == "build" || call[1] == "buildx") {
			t.Fatalf("ran a docker build: %v", call)
		}
	}
}

// dockerVersion is the builder's check that Docker answers, its first command.
var dockerVersion = []string{"docker", "version", "--format", "{{.Server.Version}}"}

// testRegistry is the operator's registry the tests' bases are pulled from (Config.TemplateRegistry).
const testRegistry = "ghcr.io/lleverage-ai"

// testDigest and otherDigest are base image digests.
var (
	testDigest  = "sha256:" + strings.Repeat("ab", 32)
	otherDigest = "sha256:" + strings.Repeat("cd", 32)
)

func testBuilder(t *testing.T) (*rootfsBuilder, *fakeDocker) {
	docker := &fakeDocker{}
	b := newRootfsBuilder(filepath.Join(t.TempDir(), "images", "templates"), docker.run, testRegistry)
	b.arch = "amd64"
	return b, docker
}

// A base with a digest is pulled by that digest from the operator's registry, and made into a root filesystem as
// guest/rootfs.sh makes one: nothing is built.
func TestRootfsPullsTheBaseByDigestFromTheTemplateRegistry(t *testing.T) {
	b, docker := testBuilder(t)
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	path, digest, err := b.rootfs(context.Background(), img)
	if err != nil {
		t.Fatal(err)
	}
	key := img.key()
	work := filepath.Join(b.dir, key+".building")
	ref := "ghcr.io/lleverage-ai/kantel/sandbox@" + testDigest
	helper := "kantel-rootfs-" + key
	want := [][]string{
		dockerVersion,
		{"docker", "pull", "--platform", "linux/amd64", ref},
		{"docker", "image", "inspect", "--format", "{{.Id}}", ref},
		{"docker", "create", "--platform", "linux/amd64", ref, "/bin/true"},
		{"docker", "export", "-o", filepath.Join(work, "rootfs.tar"), "c0ffee"},
		// The helper is named, so one left by an earlier run, or by this one cancelled, is ended.
		{"docker", "rm", "-f", helper},
		{"docker", "run", "--rm", "--name", helper, "-v", work + ":/work", rootfsHelperImage, "sh", "-euc", rootfsScript},
		{"docker", "rm", "-f", helper},
		{"docker", "rm", "-f", "c0ffee"},
	}
	if !reflect.DeepEqual(docker.calls, want) {
		t.Fatalf("commands:\n%v\nwant:\n%v", docker.calls, want)
	}
	docker.neverBuilt(t)
	if path != filepath.Join(b.dir, key+".ext4") || digest != "sha256:feed" {
		t.Fatalf("got %s %s", path, digest)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatalf("the work directory stayed: %v", err)
	}
	// Cached: the second of the same base runs nothing, and answers the image ID it recorded.
	docker.calls = nil
	again, digest, err := b.rootfs(context.Background(), img)
	if err != nil || again != path || digest != "sha256:feed" || len(docker.calls) != 0 {
		t.Fatalf("a cached base: %s %s %v %v", again, digest, err, docker.calls)
	}
	// A name that reads as a registry is still a path in the operator's.
	docker.calls = nil
	if _, _, err := b.rootfs(context.Background(), templateImage{BaseImage: "registry.example.com/agent", BaseDigest: testDigest}); err != nil {
		t.Fatal(err)
	}
	if pull := []string{"docker", "pull", "--platform", "linux/amd64", "ghcr.io/lleverage-ai/registry.example.com/agent@" + testDigest}; !reflect.DeepEqual(docker.calls[0], pull) {
		t.Fatalf("pull %v", docker.calls)
	}
	// A registry configured with a trailing slash names the same reference.
	docker = &fakeDocker{}
	slashed := newRootfsBuilder(filepath.Join(t.TempDir(), "images", "templates"), docker.run, testRegistry+"/")
	slashed.arch = "amd64"
	if _, _, err := slashed.rootfs(context.Background(), img); err != nil || !reflect.DeepEqual(docker.calls[1], want[1]) {
		t.Fatalf("pull %v %v", docker.calls, err)
	}
}

func TestRootfsPullFailureIsTheTemplatesWithItsOutput(t *testing.T) {
	b, docker := testBuilder(t)
	docker.fail = "docker pull"
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	_, _, err := b.rootfs(context.Background(), img)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrInvalid || !strings.Contains(pe.Message, "manifest unknown") {
		t.Fatalf("got %v", err)
	}
	if _, ok := os.Stat(b.path(img.key())); ok == nil {
		t.Fatal("a failed pull left a root filesystem")
	}
	docker.neverBuilt(t)
}

// A host with no templateRegistry can't pull a base, and says so before any docker command.
func TestRootfsRefusesAPulledBaseWithoutATemplateRegistry(t *testing.T) {
	docker := &fakeDocker{}
	b := newRootfsBuilder(filepath.Join(t.TempDir(), "images", "templates"), docker.run, "")
	_, _, err := b.rootfs(context.Background(), templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest})
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported || !strings.Contains(pe.Message, "templateRegistry") {
		t.Fatalf("got %v", err)
	}
	if len(docker.calls) != 0 {
		t.Fatalf("ran %v", docker.calls)
	}
}

// A base's name is a repository path and its digest a sha256 one, or nothing is pulled: the account names no registry,
// tag or other reference through them.
func TestTemplateBaseRefusesBadNamesAndDigests(t *testing.T) {
	bad := []templateImage{}
	for _, name := range []string{
		"", "localhost:5000/agent", "[::1]/agent", "kantel/sandbox:stable", "kantel/sandbox@" + testDigest,
		"Kantel/Sandbox", "/kantel/sandbox", "kantel//sandbox", "kantel/sandbox/", "../sandbox", "kantel/-sandbox", "kantel sandbox",
	} {
		bad = append(bad, templateImage{BaseImage: name, BaseDigest: testDigest})
	}
	for _, digest := range []string{
		"sha256:abc", "sha256:" + strings.Repeat("AB", 32), "sha512:" + strings.Repeat("ab", 64), "latest", strings.Repeat("ab", 32),
		testDigest + "\n", "sha256:" + strings.Repeat("ab", 32) + "0",
	} {
		bad = append(bad, templateImage{BaseImage: "kantel/sandbox", BaseDigest: digest})
	}
	for _, img := range bad {
		b, docker := testBuilder(t)
		_, _, err := b.rootfs(context.Background(), img)
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
			t.Fatalf("%+v: got %v", img, err)
		}
		if len(docker.calls) != 0 {
			t.Fatalf("%+v: ran %v", img, docker.calls)
		}
	}
	for _, img := range []templateImage{
		{BaseImage: "kantel/sandbox", BaseDigest: testDigest},
		{BaseImage: "sandbox", BaseDigest: testDigest},
		{BaseImage: "acme.tools/agent_base-2/v1.0", BaseDigest: testDigest},
		// No digest: the host's own image, whatever the name.
		{BaseImage: "kantel/sandbox"},
		{},
	} {
		if err := img.validate(); err != nil {
			t.Fatalf("%+v: %v", img, err)
		}
	}
}

func TestRootfsKeyIsTheBaseImageAndItsDigest(t *testing.T) {
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	sum := sha256.Sum256([]byte("kantel-base\x00kantel/sandbox@" + testDigest))
	if img.key() != hex.EncodeToString(sum[:]) {
		t.Fatalf("key %s", img.key())
	}
	keys := map[string]string{}
	for name, other := range map[string]templateImage{
		"base":         img,
		"other digest": {BaseImage: "kantel/sandbox", BaseDigest: otherDigest},
		"other image":  {BaseImage: "kantel/desktop", BaseDigest: testDigest},
	} {
		key := other.key()
		if !validKey(key) {
			t.Fatalf("%s: key %q isn't one", name, key)
		}
		if was, ok := keys[key]; ok {
			t.Fatalf("%s and %s share a key", name, was)
		}
		keys[key] = name
	}
	for _, bad := range []string{"", "../x", strings.Repeat("g", 64), strings.Repeat("a", 63)} {
		if validKey(bad) {
			t.Fatalf("validKey(%q)", bad)
		}
	}
}

// testManager is a Manager of the files a create reads before it starts a VM, with its per-size template already made.
func testManager(t *testing.T) (*Manager, *fakeDocker) {
	root := t.TempDir()
	images := t.TempDir()
	for _, name := range []string{"firecracker", "vmlinux", "sandbox.ext4"} {
		if err := os.WriteFile(filepath.Join(images, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	docker := &fakeDocker{}
	m := &Manager{
		cfg: Config{Root: root, Firecracker: filepath.Join(images, "firecracker"), Kernel: filepath.Join(images, "vmlinux"), Rootfs: filepath.Join(images, "sandbox.ext4"), Sizes: DefaultSizes},
		log: slog.New(slog.DiscardHandler), templates: map[string]*sync.Mutex{}, tpl: newTemplateCache(root, docker.run, testRegistry),
	}
	m.tpl.rootfs.arch = "amd64"
	for _, size := range DefaultSizes {
		m.templates[size.Name] = &sync.Mutex{}
		dir := filepath.Join(root, "templates", size.Name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(dir, "images"), []byte(m.templateFingerprint(shape{Size: size})), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "ready"), []byte("{}"), 0o600)
	}
	return m, docker
}

// keepTestTemplateSnapshot makes a template snapshot as a build leaves it, of img's root filesystem: one in
// images/templates, or the host's own image for a base with no digest.
func keepTestTemplateSnapshot(t *testing.T, m *Manager, id string, img templateImage) templateSnapshotMeta {
	t.Helper()
	rootfs, _, err := m.templateRootfs(context.Background(), img)
	if err != nil {
		t.Fatal(err)
	}
	dir := m.templateSnapshotDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"state", "mem", fc.DiskFile} {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600)
	}
	// Built as the `default` size's machine, which the tests' creates get.
	size := DefaultSizes[1]
	builtFrom := templateBuiltFrom{Image: templateImageKind, BaseImage: img.BaseImage, BaseDigest: img.BaseDigest}
	if img.BaseDigest != "" {
		builtFrom.RootfsKey = img.key()
	}
	kept := templateSnapshotMeta{SnapshotID: id, KeyHash: "k1", Rootfs: rootfs, Runtime: m.runtimeFingerprint(rootfs), BuiltFrom: builtFrom, VCPUs: size.VCPUs, MemoryMiB: size.MemoryMiB, DiskGiB: size.DiskGiB}
	if err := keepTemplateSnapshot(dir, &kept); err != nil {
		t.Fatal(err)
	}
	return kept
}

var testTemplateImage = templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}

// settled is origin with the locks it holds given back (its share of a template's, and the base lock), to compare.
func settled(origin sandboxOrigin) sandboxOrigin {
	for _, give := range []func(){origin.release, origin.unhold} {
		if give != nil {
			give()
		}
	}
	origin.release, origin.unhold = nil, nil
	return origin
}

func TestTemplateSnapshotsLiveApartFromSandboxSnapshots(t *testing.T) {
	m, _ := testManager(t)
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	dir := m.templateSnapshotDir("tsn_1")
	if dir != filepath.Join(m.cfg.Root, "template-snapshots", "tsn_1") {
		t.Fatalf("template snapshot in %s", dir)
	}
	for _, name := range []string{"state", "mem", fc.DiskFile, "meta.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if target, err := os.Readlink(filepath.Join(dir, "rootfs")); err != nil || target != kept.Rootfs {
		t.Fatalf("rootfs link %q %v", target, err)
	}
	read, err := m.readTemplateSnapshot("tsn_1")
	if err != nil || read.KeyHash != "k1" || read.SizeBytes <= 0 || read.result().Ref != "tsn_1" {
		t.Fatalf("read %+v %v", read, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "snapshots")); len(entries) != 0 {
		t.Fatalf("a template snapshot wrote under snapshots/: %v", entries)
	}
	// A sandbox's snapshot of the same ID is another thing: deleting the template snapshot leaves it, and the root
	// filesystem sandboxes made from the template read.
	user := m.snapshotDir("tsn_1")
	if err := os.MkdirAll(user, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteTemplate("tsn_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("still there: %v", err)
	}
	if _, err := os.Stat(user); err != nil {
		t.Fatalf("the sandbox snapshot went too: %v", err)
	}
	if _, err := os.Stat(kept.Rootfs); err != nil {
		t.Fatalf("the root filesystem went too: %v", err)
	}
	if err := m.DeleteTemplate("tsn_1"); err != nil {
		t.Fatalf("deleting one that's gone: %v", err)
	}
	for _, bad := range []string{"../snapshots/tsn_1", "..", "", "a/b"} {
		if m.DeleteTemplate(bad) == nil {
			t.Fatalf("DeleteTemplate(%q) took it", bad)
		}
		if _, err := m.readTemplateSnapshot(bad); err == nil {
			t.Fatalf("readTemplateSnapshot(%q) took it", bad)
		}
	}
	if _, err := os.Stat(user); err != nil {
		t.Fatalf("a bad ID reached snapshots/: %v", err)
	}
}

func TestCreateWithoutTemplateRestoresTheSizesTemplate(t *testing.T) {
	m, docker := testManager(t)
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1"}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	tpl := filepath.Join(m.cfg.Root, "templates", "default")
	want := sandboxOrigin{rootfs: m.cfg.Rootfs, state: filepath.Join(tpl, "state"), mem: filepath.Join(tpl, "mem"), disk: filepath.Join(tpl, fc.DiskFile), source: "snapshot"}
	if origin = settled(origin); !reflect.DeepEqual(origin, want) {
		t.Fatalf("origin %+v, want %+v", origin, want)
	}
	if len(docker.calls) != 0 {
		t.Fatalf("ran %v", docker.calls)
	}
}

func TestCreateFromATemplateSnapshotRestoresIt(t *testing.T) {
	m, _ := testManager(t)
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "touch /x", Snapshot: "tsn_1"}
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	dir := m.templateSnapshotDir("tsn_1")
	if origin.release == nil {
		t.Fatal("the restore holds no share of the snapshot's lock")
	}
	want := sandboxOrigin{rootfs: kept.Rootfs, state: filepath.Join(dir, "state"), mem: filepath.Join(dir, "mem"), disk: filepath.Join(dir, fc.DiskFile), source: "snapshot", templateSnapshot: "tsn_1"}
	if origin = settled(origin); !reflect.DeepEqual(origin, want) {
		t.Fatalf("origin %+v, want %+v", origin, want)
	}
	// A bad snapshot ID never reaches the disk.
	bad := boot
	bad.Snapshot = "../snapshots/x"
	if _, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &bad}, DefaultSizes[1]); err == nil {
		t.Fatal("a bad template snapshot ID was taken")
	}
}

func TestCreateFromATemplateBootsFreshWithoutASnapshotItCanRestore(t *testing.T) {
	m, docker := testManager(t)
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	docker.calls = nil
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "touch /x"}
	// No snapshot named, one discarded meanwhile, and one made with another Firecracker or kernel: each boots the
	// template's root filesystem (made already) and runs its setup.
	stale := kept
	stale.SnapshotID, stale.Runtime = "tsn_old", "another runtime"
	staleDir := m.templateSnapshotDir("tsn_old")
	_ = os.MkdirAll(staleDir, 0o700)
	raw, _ := json.Marshal(stale)
	_ = os.WriteFile(filepath.Join(staleDir, "meta.json"), raw, 0o600)
	for _, snapshot := range []string{"", "tsn_gone", "tsn_old"} {
		named := boot
		named.Snapshot = snapshot
		origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &named}, DefaultSizes[1])
		if err != nil {
			t.Fatal(err)
		}
		if origin.rootfs != kept.Rootfs || origin.state != "" || origin.disk != "" || origin.setup != "touch /x" || origin.source != "boot" {
			t.Fatalf("snapshot %q: origin %+v", snapshot, origin)
		}
	}
	if len(docker.calls) != 0 {
		t.Fatalf("a made root filesystem was made again: %v", docker.calls)
	}
	// One not made yet is pulled and made first.
	boot.BaseDigest = otherDigest
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	pull := []string{"docker", "pull", "--platform", "linux/amd64", testRegistry + "/kantel/sandbox@" + otherDigest}
	// Docker answered the first pull a moment ago (dockerCheckTTL), so this pull is the first command.
	if len(docker.calls) == 0 || !reflect.DeepEqual(docker.calls[0], pull) || origin.rootfs == kept.Rootfs || !origin.askGuest {
		t.Fatalf("origin %+v after %v", origin, docker.calls)
	}
	docker.neverBuilt(t)
}

func TestBuildTemplateRefusesBadParamsBeforeWriting(t *testing.T) {
	m, docker := testManager(t)
	for _, p := range []proto.TemplateBuildParams{
		{SnapshotID: "../snapshots/x", BaseImage: "kantel/sandbox", BaseDigest: testDigest, VCPUs: 1, MemoryMiB: 1024},
		{SnapshotID: "tsn_1", BaseImage: "localhost:5000/agent", BaseDigest: testDigest, VCPUs: 1, MemoryMiB: 1024},
		{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", BaseDigest: "sha256:abc", VCPUs: 1, MemoryMiB: 1024},
		{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", BaseDigest: testDigest},
	} {
		if _, err := m.BuildTemplate(context.Background(), p); err == nil {
			t.Fatalf("%+v was taken", p)
		}
	}
	if _, err := os.Stat(filepath.Join(m.cfg.Root, "template-snapshots")); !os.IsNotExist(err) || len(docker.calls) != 0 {
		t.Fatalf("wrote or ran before refusing: %v %v", err, docker.calls)
	}
}

func TestBuildTemplateAnswersAFinishedBuildAgain(t *testing.T) {
	m, docker := testManager(t)
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	docker.calls = nil
	got, err := m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", BaseDigest: testDigest, VCPUs: 4, MemoryMiB: 2048, DiskGiB: 20, KeyHash: "k1"})
	if err != nil || got.Ref != "tsn_1" || got.SizeBytes != kept.SizeBytes || len(docker.calls) != 0 {
		t.Fatalf("got %+v %v after %v", got, err, docker.calls)
	}
}

// A build's machine is the named size with exactly the vCPUs, memory and disk asked, else that custom shape within the
// host's limits; one beyond them is refused before anything runs.
func TestTemplateBuildMachineIsTheSizeOrCustomShapeAsked(t *testing.T) {
	m, docker := testManager(t)
	for _, c := range []struct {
		p    proto.TemplateBuildParams
		want proto.Size
	}{
		{proto.TemplateBuildParams{VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10}, DefaultSizes[0]},
		{proto.TemplateBuildParams{VCPUs: 4, MemoryMiB: 8192, DiskGiB: 50}, DefaultSizes[2]},
		{proto.TemplateBuildParams{VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20}, proto.Size{Name: CustomSizeName(2, 4096, 20), VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20}},
		{proto.TemplateBuildParams{VCPUs: 1, MemoryMiB: 1024, DiskGiB: 7}, proto.Size{Name: CustomSizeName(1, 1024, 7), VCPUs: 1, MemoryMiB: 1024, DiskGiB: 7}},
	} {
		if got, err := m.TemplateBuildMachine(c.p); err != nil || got != c.want {
			t.Fatalf("%+v: %+v %v, want %+v", c.p, got, err, c.want)
		}
	}
	for _, p := range []proto.TemplateBuildParams{
		{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", VCPUs: 2, MemoryMiB: 2048},
		{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", VCPUs: 2, MemoryMiB: 1 << 30, DiskGiB: 20},
		{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", VCPUs: 1000, MemoryMiB: 1024, DiskGiB: 20},
	} {
		var pe *proto.Error
		if _, err := m.BuildTemplate(context.Background(), p); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
			t.Fatalf("%+v: got %v", p, err)
		}
	}
	if len(docker.calls) != 0 {
		t.Fatalf("ran %v for a machine too big", docker.calls)
	}
}

// A sandbox made from a template is the machine its create asks for, a named size or a custom shape; it restores a
// template snapshot only when the snapshot was built with that machine's vCPUs and memory, and else boots fresh.
func TestCreateFromATemplateRestoresOnlyIntoTheMachineItWasBuiltAs(t *testing.T) {
	m, _ := testManager(t)
	keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "touch /x", Snapshot: "tsn_1"}
	// Built as the `default` size (4 vCPUs, 2048 MiB): a `large` create boots fresh.
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Size: "large", Template: &boot}, DefaultSizes[2])
	if err != nil {
		t.Fatal(err)
	}
	if origin.source != "boot" || origin.state != "" || origin.release != nil || origin.setup != "touch /x" {
		t.Fatalf("origin %+v", origin)
	}
	// So does a custom shape of other vCPUs and memory.
	custom, err := m.size(CustomSizeName(2, 4096, 20))
	if err != nil {
		t.Fatal(err)
	}
	if origin, err = m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &boot}, custom); err != nil || origin.release != nil || origin.source != "boot" {
		t.Fatalf("origin %+v %v", origin, err)
	}
	// The vCPUs and memory it was built with, named or custom: restored.
	for _, size := range []proto.Size{DefaultSizes[1], {Name: CustomSizeName(4, 2048, 30), VCPUs: 4, MemoryMiB: 2048, DiskGiB: 30}} {
		origin, err = m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_3", Template: &boot}, size)
		if err != nil {
			t.Fatal(err)
		}
		if origin.templateSnapshot != "tsn_1" || origin.release == nil {
			t.Fatalf("%s: origin %+v", size.Name, origin)
		}
		origin.release()
	}
}

func TestSetupFailureCarriesTheEndOfItsOutput(t *testing.T) {
	if err := setupFailure(guest.ExecResult{ExitCode: 0, Stdout: "ok"}); err != nil {
		t.Fatal(err)
	}
	err := setupFailure(guest.ExecResult{ExitCode: 3, Stdout: strings.Repeat("x", 5000), Stderr: "E: Unable to locate package nope"})
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrInvalid || !strings.Contains(pe.Message, "exited with 3") ||
		!strings.HasSuffix(pe.Message, "E: Unable to locate package nope") || len(pe.Message) > 2100 {
		t.Fatalf("got %v", err)
	}
	if err := setupFailure(guest.ExecResult{TimedOut: true}); err == nil || !strings.Contains(err.Error(), "took longer") {
		t.Fatalf("a timeout: %v", err)
	}
}

// A host without a working Docker can't pull templates' bases, and says so; a root filesystem already made is still
// answered.
func TestRootfsPullNeedsDocker(t *testing.T) {
	b, docker := testBuilder(t)
	built, _, err := b.rootfs(context.Background(), testTemplateImage)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		set  func(*fakeDocker)
		want string
	}{
		{"not installed", func(d *fakeDocker) { d.missing = true }, "isn't installed"},
		{"daemon down", func(d *fakeDocker) { d.fail = "docker version" }, "doesn't answer"},
	} {
		b.docker = dockerCheck{}
		*docker = fakeDocker{}
		c.set(docker)
		_, _, err := b.rootfs(context.Background(), templateImage{BaseImage: "kantel/sandbox", BaseDigest: otherDigest})
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported || !strings.Contains(pe.Message, c.want) {
			t.Fatalf("%s: got %v", c.name, err)
		}
		if !reflect.DeepEqual(docker.calls, [][]string{dockerVersion}) {
			t.Fatalf("%s: ran %v", c.name, docker.calls)
		}
		// The answer is kept: asking again runs nothing.
		docker.calls = nil
		if err := b.ready(context.Background()); err == nil || len(docker.calls) != 0 {
			t.Fatalf("%s: asked again: %v %v", c.name, err, docker.calls)
		}
		if path, _, err := b.rootfs(context.Background(), testTemplateImage); err != nil || path != built || len(docker.calls) != 0 {
			t.Fatalf("%s: a made root filesystem: %s %v %v", c.name, path, err, docker.calls)
		}
	}
}

// A sandbox booted fresh from a template takes its root filesystem as a template build does, under the same checks: a
// bad base name or digest is refused, and a pinned base on a host with no templateRegistry, before any docker command.
func TestCreateFromATemplateBootsFreshUnderTheBuildsChecks(t *testing.T) {
	m, docker := testManager(t)
	for _, c := range []struct {
		boot proto.TemplateBoot
		code string
	}{
		{proto.TemplateBoot{BaseImage: "localhost:5000/agent", BaseDigest: testDigest, Setup: "true"}, proto.ErrInvalid},
		{proto.TemplateBoot{BaseImage: "kantel/sandbox:stable", BaseDigest: testDigest, Setup: "true"}, proto.ErrInvalid},
		{proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: "latest", Setup: "true"}, proto.ErrInvalid},
	} {
		_, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &c.boot}, DefaultSizes[1])
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != c.code || len(docker.calls) != 0 {
			t.Fatalf("%+v: got %v after %v", c.boot, err, docker.calls)
		}
	}
	pinned := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "true"}
	m.tpl.rootfs.registry = ""
	_, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &pinned}, DefaultSizes[1])
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported || len(docker.calls) != 0 {
		t.Fatalf("no templateRegistry: got %v after %v", err, docker.calls)
	}
	m.tpl.rootfs.registry = testRegistry
	if _, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &pinned}, DefaultSizes[1]); err != nil {
		t.Fatal(err)
	}
	if len(docker.calls) < 2 || docker.calls[1][1] != "pull" {
		t.Fatalf("commands %v", docker.calls)
	}
	docker.neverBuilt(t)
}

// A base with no digest (the default base, while its channel has none published) is the host's own image: a fresh boot
// and a build read Config.Rootfs, with no docker command at all, and a fresh boot asks its own agent what it has (the
// host's image may have no shared report yet). Its template snapshot restores only onto that same image, so an update
// of the host's image is a cache miss, and the template boots fresh.
func TestATemplateWithoutADigestIsTheHostsImage(t *testing.T) {
	m, docker := testManager(t)
	img := templateImage{BaseImage: "kantel/sandbox"}
	if rootfs, digest, err := m.templateRootfs(context.Background(), img); err != nil || rootfs != m.cfg.Rootfs || digest != "" {
		t.Fatalf("a build's root filesystem %s %s %v", rootfs, digest, err)
	}
	// Even on a host with no templateRegistry, and whatever the name: the control plane sends no digest only for its
	// default base.
	m.tpl.rootfs.registry = ""
	for _, name := range []string{"kantel/sandbox", "kantel/sandbox:stable", ""} {
		boot := proto.TemplateBoot{BaseImage: name, Setup: "touch /x"}
		origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &boot}, DefaultSizes[1])
		if err != nil {
			t.Fatal(err)
		}
		if origin.rootfs != m.cfg.Rootfs || origin.source != "boot" || origin.state != "" || origin.setup != "touch /x" || !origin.askGuest {
			t.Fatalf("%q: origin %+v", name, origin)
		}
	}
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", img)
	if kept.Rootfs != m.cfg.Rootfs || kept.BuiltFrom.Image != "kantel-base" || kept.BuiltFrom.RootfsKey != "" {
		t.Fatalf("kept %+v", kept)
	}
	if target, err := os.Readlink(filepath.Join(m.templateSnapshotDir("tsn_1"), templateRootfsLink)); err != nil || target != m.cfg.Rootfs {
		t.Fatalf("rootfs link %q %v", target, err)
	}
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", Setup: "touch /x", Snapshot: "tsn_1"}
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	if origin.templateSnapshot != "tsn_1" || origin.rootfs != m.cfg.Rootfs || origin.release == nil {
		t.Fatalf("a restore's origin %+v", origin)
	}
	origin.release()
	if len(docker.calls) != 0 {
		t.Fatalf("ran %v", docker.calls)
	}
	// The host's image updated in place: not the image the snapshot was made over.
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(m.cfg.Rootfs, later, later); err != nil {
		t.Fatal(err)
	}
	origin, err = m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_3", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	if origin.source != "boot" || origin.state != "" || origin.release != nil || origin.rootfs != m.cfg.Rootfs || origin.setup != "touch /x" {
		t.Fatalf("after the host's image changed: origin %+v", origin)
	}
}

// With versioned host images (image patching), a template snapshot of the host's image is on the version its build
// booted (pinRootfs): it records it, a prune keeps it from the build's directory on, and a restore links that version
// after an update has moved current on, while a fresh boot is on the current version. A sandbox on a template's pulled
// base is never rebased onto the host's images.
func TestATemplateSnapshotOfTheHostsImageIsOnItsVersion(t *testing.T) {
	m, _ := testManager(t)
	images := versionedImages(t)
	m.cfg.Rootfs, m.cfg.Kernel, m.cfg.PinBase = filepath.Join(images, "sandbox.ext4"), filepath.Join(images, "vmlinux"), true
	current := func(v string) {
		t.Helper()
		link := filepath.Join(images, "current")
		if err := os.Remove(link); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("v", v), link); err != nil {
			t.Fatal(err)
		}
	}
	old, latest := filepath.Join(images, "v", "old", "sandbox.ext4"), filepath.Join(images, "v", "new", "sandbox.ext4")
	// Built while old was current, as bootSnapshot picks it: the host's image as the version it resolves to.
	current("old")
	built := m.pinRootfs(m.cfg.Rootfs)
	if built != old {
		t.Fatalf("a build boots %s, want %s", built, old)
	}
	dir := m.templateSnapshotDir("tsn_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"state", "mem", fc.DiskFile} {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600)
	}
	size := DefaultSizes[1]
	kept := templateSnapshotMeta{SnapshotID: "tsn_1", KeyHash: "k1", Rootfs: built, Runtime: m.runtimeFingerprint(built), BuiltFrom: templateBuiltFrom{Image: templateImageKind, BaseImage: "kantel/sandbox"}, VCPUs: size.VCPUs, MemoryMiB: size.MemoryMiB, DiskGiB: size.DiskGiB}
	if err := keepTemplateSnapshot(dir, &kept); err != nil {
		t.Fatal(err)
	}
	if kept.Base != "old" {
		t.Fatalf("the snapshot records base %q", kept.Base)
	}
	// A build under way names its version from its directory, by its VM directory's link and its own.
	linkVM(t, filepath.Join(m.cfg.Root, templateSnapshotsDir, "tsn_2.building", "vm"), latest)
	if err := linkTemplateRootfs(filepath.Join(m.cfg.Root, templateSnapshotsDir, "tsn_2.building"), latest); err != nil {
		t.Fatal(err)
	}
	current("new")
	in, err := m.BasesInUse()
	if err != nil || !in["old"] || !in["new"] {
		t.Fatalf("in use %v %v", in, err)
	}
	// The restore is over the version the snapshot was built on, though current has moved on.
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", Setup: "touch /x", Snapshot: "tsn_1"}
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &boot}, size)
	if err != nil {
		t.Fatal(err)
	}
	if origin = settled(origin); origin.templateSnapshot != "tsn_1" || m.pinRootfs(origin.rootfs) != old {
		t.Fatalf("a restore's origin %+v", origin)
	}
	// A fresh boot is on the current version.
	fresh := boot
	fresh.Snapshot = ""
	origin, err = m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &fresh}, size)
	if err != nil {
		t.Fatal(err)
	}
	if origin = settled(origin); origin.source != "boot" || m.pinRootfs(origin.rootfs) != latest {
		t.Fatalf("a fresh boot's origin %+v", origin)
	}
	onHost := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", "sbx_1"), meta: meta{ID: "sbx_1", Size: "default", State: proto.StateStopped}}
	linkVM(t, onHost.vmDir(), old)
	m.recordImage(onHost, sandboxOrigin{rootfs: old})
	if onHost.meta.Rootfs != "" || m.info(onHost).Base != "old" || m.rebaseable(onHost) != nil {
		t.Fatalf("a sandbox of the host's image: %+v, %+v", onHost.meta, m.info(onHost))
	}
	// A sandbox on a pulled base isn't moved onto the host's images.
	pulled := keepTestTemplateSnapshot(t, m, "tsn_3", testTemplateImage)
	other := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", "sbx_3"), meta: meta{ID: "sbx_3", Size: "default", State: proto.StateStopped}}
	linkVM(t, other.vmDir(), pulled.Rootfs)
	m.recordImage(other, sandboxOrigin{rootfs: pulled.Rootfs})
	m.sandboxes = map[string]*sandbox{"sbx_3": other}
	if other.meta.Rootfs != pulled.Rootfs || m.info(other).Base != "" {
		t.Fatalf("a sandbox of a pulled base: %+v", other.meta)
	}
	var pe *proto.Error
	if err := m.CanRebase("sbx_3"); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("CanRebase of a pulled base's sandbox: %v", err)
	}
	if err := m.rebase(other, ""); err == nil || vmRootfs(other.vmDir()) != pulled.Rootfs {
		t.Fatalf("a rebase of a pulled base's sandbox: %v, now on %s", err, vmRootfs(other.vmDir()))
	}
}

// A delete waits for a create restoring the template snapshot to have loaded it; creates meanwhile, and after it,
// boot the template fresh.
func TestDeleteTemplateWaitsForARestoreToLoadIt(t *testing.T) {
	m, _ := testManager(t)
	keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "touch /x", Snapshot: "tsn_1"}
	create := func(id string) sandboxOrigin {
		t.Helper()
		origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: id, Template: &boot}, DefaultSizes[1])
		if err != nil {
			t.Fatal(err)
		}
		return origin
	}
	restoring := create("sbx_1")
	if restoring.templateSnapshot != "tsn_1" || restoring.release == nil {
		t.Fatalf("origin %+v", restoring)
	}
	deleted := make(chan error, 1)
	go func() { deleted <- m.DeleteTemplate("tsn_1") }()
	select {
	case err := <-deleted:
		t.Fatalf("deleted while a create was restoring it: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	for _, file := range []string{restoring.state, restoring.mem, restoring.disk} {
		if _, err := os.Stat(file); err != nil {
			t.Fatalf("a restore's file went: %v", err)
		}
	}
	// Being deleted: a create doesn't wait for it, nor restore it.
	if meanwhile := create("sbx_2"); meanwhile.source != "boot" || meanwhile.release != nil || meanwhile.setup != "touch /x" {
		t.Fatalf("a create meanwhile: %+v", meanwhile)
	}
	restoring.release()
	select {
	case err := <-deleted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the delete didn't finish once the restore had loaded the snapshot")
	}
	if _, err := os.Stat(m.templateSnapshotDir("tsn_1")); !os.IsNotExist(err) {
		t.Fatalf("still there: %v", err)
	}
	if after := create("sbx_3"); after.source != "boot" || after.state != "" || after.setup != "touch /x" {
		t.Fatalf("a create after the delete: %+v", after)
	}
}

// deleteDoesntWait fails unless deleting a template snapshot finishes promptly: no create holds a share of its lock.
func deleteDoesntWait(t *testing.T, m *Manager, id string) {
	t.Helper()
	deleted := make(chan error, 1)
	go func() { deleted <- m.DeleteTemplate(id) }()
	select {
	case err := <-deleted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("deleting %s waited for a create that had given up on it", id)
	}
}

// A template snapshot that is broken on disk, or doesn't restore, is a cache miss: the template boots fresh and runs
// its setup. A sandbox's own snapshot that doesn't restore is still an error.
func TestCreateBootsATemplateFreshWhenItsSnapshotIsBroken(t *testing.T) {
	m, _ := testManager(t)
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Setup: "touch /x"}
	for name, damage := range map[string]func(dir string){
		"meta.json unreadable": func(dir string) { _ = os.WriteFile(filepath.Join(dir, "meta.json"), []byte("{"), 0o600) },
		"mem missing":          func(dir string) { _ = os.Remove(filepath.Join(dir, "mem")) },
		"state missing":        func(dir string) { _ = os.Remove(filepath.Join(dir, "state")) },
		"disk missing":         func(dir string) { _ = os.Remove(filepath.Join(dir, fc.DiskFile)) },
	} {
		keepTestTemplateSnapshot(t, m, "tsn_broken", testTemplateImage)
		damage(m.templateSnapshotDir("tsn_broken"))
		named := boot
		named.Snapshot = "tsn_broken"
		origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &named}, DefaultSizes[1])
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if origin.source != "boot" || origin.rootfs != kept.Rootfs || origin.setup != "touch /x" || origin.release != nil {
			t.Fatalf("%s: origin %+v", name, origin)
		}
		deleteDoesntWait(t, m, "tsn_broken")
	}

	// Whole on disk, but Firecracker won't load it: the attempt is given up and the template booted fresh.
	named := boot
	named.Snapshot = "tsn_1"
	var tried []sandboxOrigin
	origin, err := m.startSandbox(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &named}, DefaultSizes[1], func(o sandboxOrigin) error {
		tried = append(tried, o)
		if o.state != "" {
			return errors.New("firecracker: load snapshot: bad state file")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tried) != 2 || tried[0].templateSnapshot != "tsn_1" || origin.source != "boot" || origin.state != "" || origin.rootfs != kept.Rootfs || origin.setup != "touch /x" {
		t.Fatalf("tried %+v, origin %+v", tried, origin)
	}
	deleteDoesntWait(t, m, "tsn_1")

	// A sandbox's own snapshot: its failure is the create's.
	user := m.snapshotDir("snap_1")
	if err := os.MkdirAll(user, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"state", "mem", fc.DiskFile} {
		_ = os.WriteFile(filepath.Join(user, name), []byte(name), 0o600)
	}
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap_1", Memory: true}, Size: DefaultSizes[1].Name})
	_ = os.WriteFile(filepath.Join(user, "meta.json"), raw, 0o600)
	tries := 0
	_, err = m.startSandbox(context.Background(), proto.CreateParams{SandboxID: "sbx_2", From: "snap_1"}, DefaultSizes[1], func(sandboxOrigin) error {
		tries++
		return errors.New("firecracker: load snapshot: bad state file")
	})
	if err == nil || tries != 1 {
		t.Fatalf("a sandbox snapshot that didn't restore: %v after %d tries", err, tries)
	}
}

// Creates and template builds are admitted against one budget, under the tier's lock, beside what both hold: a build
// holds its machine's memory and disk until it ends, a create that wouldn't fit beside it is refused before anything
// starts (ErrCapacity), and TemplateBuilds names what it holds, as Capacity reports it.
func TestCreatesAndTemplateBuildsShareTheBudget(t *testing.T) {
	m, _ := testManager(t)
	m.sandboxes = map[string]*sandbox{"sbx_run": {meta: meta{ID: "sbx_run", Size: "default", State: proto.StateRunning}}}
	m.cfg.Budget = func() (int64, int64) { return 8192, 80 }
	refused := func(err error) {
		t.Helper()
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != proto.ErrCapacity {
			t.Fatalf("got %v, want %s", err, proto.ErrCapacity)
		}
	}
	release, err := m.holdBuild("tsn_a", proto.Size{Name: "template", VCPUs: 2, MemoryMiB: 4096, DiskGiB: 50})
	if err != nil {
		t.Fatal(err)
	}
	if ids, memory, disk := m.TemplateBuilds(); !reflect.DeepEqual(ids, []string{"tsn_a"}) || memory != 4096 || disk != 50 {
		t.Fatalf("builds %v %d MiB %d GiB", ids, memory, disk)
	}
	// The same snapshot again while it builds (its control plane gave up waiting) waits for it, however small.
	_, err = m.holdBuild("tsn_a", proto.Size{VCPUs: 1, MemoryMiB: 1})
	refused(err)
	// 2048 MiB are left beside the running sandbox and the build: another build of 4096 isn't, nor one whose disk
	// wouldn't fit beside the first's, nor a create of the large size; nothing of the create is left.
	_, err = m.holdBuild("tsn_b", proto.Size{VCPUs: 2, MemoryMiB: 4096, DiskGiB: 1})
	refused(err)
	_, err = m.holdBuild("tsn_b", proto.Size{VCPUs: 1, MemoryMiB: 1024, DiskGiB: 31})
	refused(err)
	_, err = m.Create(context.Background(), proto.CreateParams{SandboxID: "sbx_big", Size: "large"})
	refused(err)
	if _, err := m.get("sbx_big"); err == nil {
		t.Fatal("a refused create was registered")
	}
	// One that fits is registered, and counted from then on.
	if err := m.register(&sandbox{meta: meta{ID: "sbx_new", Size: "default", State: proto.StateStarting}}, DefaultSizes[1]); err != nil {
		t.Fatal(err)
	}
	if memory, _, _ := m.Usage(); memory != 4096 {
		t.Fatalf("sandboxes use %d MiB", memory)
	}
	refused(m.register(&sandbox{meta: meta{ID: "sbx_more", Size: "small", State: proto.StateStarting}}, DefaultSizes[0]))
	// The build ended: its room is free again.
	release()
	if ids, memory, disk := m.TemplateBuilds(); len(ids) != 0 || memory != 0 || disk != 0 {
		t.Fatalf("builds after release %v %d %d", ids, memory, disk)
	}
	if err := m.register(&sandbox{meta: meta{ID: "sbx_more", Size: "small", State: proto.StateStarting}}, DefaultSizes[0]); err != nil {
		t.Fatal(err)
	}
}

// A sandbox of a template's image reports that image's capabilities, never the host's image's (guestOf): from the
// template snapshot it restores, from its own agent when it boots the template fresh, and from its snapshots when a
// fork or a create from one is made. A sandbox of the host's image reports the shared report as before.
func TestATemplatesSandboxReportsItsOwnImagesCapabilities(t *testing.T) {
	m, _ := testManager(t)
	shared := &proto.GuestCapabilities{Arch: "x86_64", Libc: "glibc"}
	m.keepGuest("", shared)
	own := &proto.GuestCapabilities{Arch: "x86_64", Libc: "musl"}
	kept := keepTestTemplateSnapshot(t, m, "tsn_1", testTemplateImage)
	kept.Guest = own
	if err := keepTemplateSnapshot(m.templateSnapshotDir("tsn_1"), &kept); err != nil {
		t.Fatal(err)
	}
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", BaseDigest: testDigest, Snapshot: "tsn_1"}
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	origin.release()
	if origin.guest == nil || origin.guest.Libc != "musl" || origin.askGuest {
		t.Fatalf("a restore's origin %+v", origin)
	}
	fresh := boot
	fresh.Snapshot = ""
	if origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &fresh}, DefaultSizes[1]); err != nil || !origin.askGuest || origin.guest != nil {
		t.Fatalf("a fresh boot's origin %+v %v", origin, err)
	}
	s := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", "sbx_1"), meta: meta{ID: "sbx_1", Size: "default", State: proto.StateRunning, Rootfs: kept.Rootfs, Guest: own}}
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.linkRootfs(s.vmDir(), kept.Rootfs); err != nil {
		t.Fatal(err)
	}
	if got := m.info(s).Guest; got != own {
		t.Fatalf("a template's sandbox reports %+v", got)
	}
	if got := m.info(&sandbox{meta: meta{ID: "sbx_3", Size: "default", State: proto.StateRunning}}).Guest; got != shared {
		t.Fatalf("a sandbox of the host's image reports %+v", got)
	}
	// Its snapshots carry the report to what is made from them, and its meta to a restarted host.
	snap := proto.SnapshotInfo{ID: "snap_1", SandboxID: "sbx_1"}
	if err := os.MkdirAll(m.snapshotDir(snap.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.writeSnapshotMeta(s, &snap); err != nil {
		t.Fatal(err)
	}
	from, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_fork", From: "snap_1"}, DefaultSizes[1])
	if err != nil || from.guest == nil || from.guest.Libc != "musl" || from.rootfs != kept.Rootfs {
		t.Fatalf("a create from its snapshot %+v %v", from, err)
	}
	raw, _ := json.Marshal(s.meta)
	var adopted meta
	if err := json.Unmarshal(raw, &adopted); err != nil || adopted.Guest == nil || adopted.Guest.Libc != "musl" {
		t.Fatalf("meta %s", raw)
	}
}

// A stopped sandbox's start or resume is admitted against the same budget as creates and builds, and holds its memory,
// and the room its disk may still grow into, until it runs: a build that took the room the sandbox left when it
// stopped makes the resume wait (ErrCapacity, nothing changed), and a resume under way keeps that room from creates and
// builds. A create starting holds its disk the same way.
func TestAResumeIsAdmittedAgainstTheBudgetCreatesAndBuildsShare(t *testing.T) {
	m, _ := testManager(t)
	stopped := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", "sbx_stopped"), meta: meta{ID: "sbx_stopped", Size: "default", State: proto.StateStopped}}
	if err := os.MkdirAll(stopped.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stopped.vmDir(), fc.DiskFile), []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	m.sandboxes = map[string]*sandbox{
		"sbx_run":     {meta: meta{ID: "sbx_run", Size: "default", State: proto.StateRunning}},
		"sbx_stopped": stopped,
	}
	m.cfg.Budget = func() (int64, int64) { return 8192, 80 }
	refused := func(err error) {
		t.Helper()
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != proto.ErrCapacity {
			t.Fatalf("got %v, want %s", err, proto.ErrCapacity)
		}
	}
	// A build takes the room the stopped sandbox left: 2048 MiB running, 4096 and 2048 building.
	releaseA, err := m.holdBuild("tsn_a", proto.Size{VCPUs: 2, MemoryMiB: 4096, DiskGiB: 50})
	if err != nil {
		t.Fatal(err)
	}
	releaseB, err := m.holdBuild("tsn_b", proto.Size{VCPUs: 2, MemoryMiB: 2048, DiskGiB: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, coldBoot := range []bool{false, true} {
		_, err = m.Resume(context.Background(), proto.ResumeParams{SandboxID: "sbx_stopped", Egress: &proto.Egress{Mode: "proxy"}}, coldBoot)
		refused(err)
	}
	if stopped.meta.State != proto.StateStopped || stopped.meta.Egress != nil || stopped.link != nil || len(m.resuming) != 0 {
		t.Fatalf("a refused resume changed it: %+v, resuming %v", stopped.meta, m.resuming)
	}
	// One build ended: the resume is admitted, and until it runs its memory and disk are held.
	releaseB()
	release, err := m.holdResume(stopped, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	if memory, _, _ := m.Usage(); memory != 4096 {
		t.Fatalf("sandboxes use %d MiB while one resumes", memory)
	}
	refused(m.register(&sandbox{meta: meta{ID: "sbx_new", Size: "small", State: proto.StateStarting}}, DefaultSizes[0]))
	_, err = m.holdBuild("tsn_c", proto.Size{VCPUs: 1, MemoryMiB: 128, DiskGiB: 1})
	refused(err)
	release()
	if memory, _, _ := m.Usage(); memory != 2048 || len(m.resuming) != 0 {
		t.Fatalf("after the resume: %d MiB, resuming %v", memory, m.resuming)
	}
	// Disk: 50 GiB held by the build and 20 by a create starting leave 10, too few for an 11 GiB build.
	if err := m.register(&sandbox{meta: meta{ID: "sbx_new", Size: "default", State: proto.StateStarting}}, DefaultSizes[1]); err != nil {
		t.Fatal(err)
	}
	_, err = m.holdBuild("tsn_c", proto.Size{VCPUs: 1, MemoryMiB: 128, DiskGiB: 11})
	refused(err)
	releaseA()
	if _, err := m.holdBuild("tsn_c", proto.Size{VCPUs: 1, MemoryMiB: 128, DiskGiB: 11}); err != nil {
		t.Fatal(err)
	}
}

// A template build holds its machine's memory and disk from before its image is pulled until it has returned, and a
// build that fails gives its room back only then.
func TestATemplateBuildHoldsItsRoomThroughItsImagePull(t *testing.T) {
	m, _ := testManager(t)
	m.cfg.Budget = func() (int64, int64) { return 4096, 80 }
	var during []string
	var refusedCreate error
	docker := &fakeDocker{fail: "docker pull"}
	m.tpl = newTemplateCache(m.cfg.Root, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if args[0] == "pull" {
			during, _, _ = m.TemplateBuilds()
			refusedCreate = m.register(&sandbox{meta: meta{ID: "sbx_1", Size: "large", State: proto.StateStarting}}, DefaultSizes[2])
		}
		return docker.run(ctx, name, args...)
	}, testRegistry)
	m.tpl.rootfs.arch = "amd64"
	_, err := m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", BaseDigest: testDigest, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 20})
	if err == nil {
		t.Fatal("a build whose pull failed succeeded")
	}
	if !reflect.DeepEqual(during, []string{"tsn_1"}) {
		t.Fatalf("builds during the pull %v", during)
	}
	var pe *proto.Error
	if !errors.As(refusedCreate, &pe) || pe.Code != proto.ErrCapacity {
		t.Fatalf("a create beside the pulling build: %v", refusedCreate)
	}
	if ids, memory, disk := m.TemplateBuilds(); len(ids) != 0 || memory != 0 || disk != 0 {
		t.Fatalf("builds after it failed %v %d %d", ids, memory, disk)
	}
}

// A template of the host's own image (the default base before a digest is published) reports its own report too, on a
// host whose image has no shared one yet (no ordinary sandbox has booted): from its template snapshot on a restore, from
// its own agent on a fresh boot, and from the sandbox's meta and snapshots after (a resume, a restarted host's adoption,
// a fork). Sandboxes of the host's image not made from a template report the shared one, as before.
func TestATemplateOfTheHostsImageReportsItsOwnCapabilities(t *testing.T) {
	m, _ := testManager(t)
	own := &proto.GuestCapabilities{Arch: "x86_64", Libc: "glibc", Shell: "/bin/own"}
	kept := keepTestTemplateSnapshot(t, m, "tsn_h", templateImage{BaseImage: "kantel/sandbox"})
	kept.Guest = own
	if err := keepTemplateSnapshot(m.templateSnapshotDir("tsn_h"), &kept); err != nil {
		t.Fatal(err)
	}
	// Which report a sandbox has, by its shell.
	shell := func(caps *proto.GuestCapabilities) string {
		if caps == nil {
			return ""
		}
		return caps.Shell
	}
	boot := proto.TemplateBoot{BaseImage: "kantel/sandbox", Snapshot: "tsn_h"}
	origin, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Template: &boot}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	origin.release()
	if origin.rootfs != m.cfg.Rootfs || shell(origin.guest) != "/bin/own" {
		t.Fatalf("a restore's origin %+v", origin)
	}
	restored := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", "sbx_1"), meta: meta{ID: "sbx_1", Size: "default", State: proto.StateRunning}}
	m.recordImage(restored, origin)
	if restored.meta.Rootfs != "" || shell(m.info(restored).Guest) != "/bin/own" {
		t.Fatalf("a restored sandbox records %+v and reports %+v", restored.meta, m.info(restored).Guest)
	}
	// A fresh boot of it asks its agent, and keeps the answer as the sandbox's own, not the host's image's.
	fresh := boot
	fresh.Snapshot = ""
	origin, err = m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_2", Template: &fresh}, DefaultSizes[1])
	if err != nil || !origin.askGuest || origin.guest != nil {
		t.Fatalf("a fresh boot's origin %+v %v", origin, err)
	}
	booted := &sandbox{meta: meta{ID: "sbx_2", Size: "default", State: proto.StateRunning}}
	m.recordImage(booted, origin)
	asked := &proto.GuestCapabilities{Arch: "x86_64", Libc: "glibc", Shell: "/bin/asked"}
	m.keepAskedGuest(booted, true, origin, asked)
	if m.info(booted).Guest != asked || m.guestOf("") != nil {
		t.Fatalf("a fresh boot reports %+v, the host's image %+v", m.info(booted).Guest, m.guestOf(""))
	}
	// The host's image's report, once it has one, is for its other sandboxes: a template's keeps its own.
	shared := &proto.GuestCapabilities{Arch: "x86_64", Libc: "glibc", Shell: "/bin/shared"}
	custom := &sandbox{meta: meta{ID: "sbx_3", Size: CustomSizeName(1, 1024, 4), State: proto.StateRunning}}
	m.recordImage(custom, sandboxOrigin{rootfs: m.cfg.Rootfs, askGuest: true})
	m.keepAskedGuest(custom, false, sandboxOrigin{rootfs: m.cfg.Rootfs, askGuest: true}, shared)
	if custom.meta.Guest != nil || m.info(custom).Guest != shared || shell(m.info(restored).Guest) != "/bin/own" || m.info(booted).Guest != asked {
		t.Fatalf("custom %+v, restored %+v, booted %+v", m.info(custom).Guest, m.info(restored).Guest, m.info(booted).Guest)
	}
	plain, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_4"}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	sized := &sandbox{meta: meta{ID: "sbx_4", Size: "default", State: proto.StateRunning}}
	m.recordImage(sized, plain)
	if sized.meta.Guest != nil || m.info(sized).Guest != shared {
		t.Fatalf("a size template's sandbox reports %+v", m.info(sized).Guest)
	}
	// A fork (a create from its snapshot) has the same report.
	snap := proto.SnapshotInfo{ID: "snap_1", SandboxID: "sbx_1"}
	if err := os.MkdirAll(m.snapshotDir(snap.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.writeSnapshotMeta(restored, &snap); err != nil {
		t.Fatal(err)
	}
	from, err := m.startOf(context.Background(), proto.CreateParams{SandboxID: "sbx_fork", From: "snap_1"}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	fork := &sandbox{meta: meta{ID: "sbx_fork", Size: "default", State: proto.StateRunning}}
	m.recordImage(fork, from)
	if fork.meta.Rootfs != "" || shell(m.info(fork).Guest) != "/bin/own" {
		t.Fatalf("a fork records %+v and reports %+v", fork.meta, m.info(fork).Guest)
	}
	// Stopped, it is adopted by a restarted host with its report, which a resume keeps.
	restored.meta.State = proto.StateStopped
	if err := os.MkdirAll(restored.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.writeMeta(restored); err != nil {
		t.Fatal(err)
	}
	again, err := New(Config{Root: m.cfg.Root, Rootfs: m.cfg.Rootfs, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	adopted, err := again.Get("sbx_1")
	if err != nil || shell(adopted.Guest) != "/bin/own" {
		t.Fatalf("adopted %+v %v", adopted.Guest, err)
	}
}

// startLeftover starts a process working in dir that stands for a Firecracker a previous run of the host left there
// (its PID in dir's firecracker.pid), and reaps it once it exits.
func startLeftover(t *testing.T, dir string) *exec.Cmd {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "60")
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	go func() { _ = cmd.Wait() }()
	if err := os.WriteFile(filepath.Join(dir, fc.PidFile), []byte(fmt.Sprint(cmd.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	return cmd
}

// A host that restarts while a template build (or a size's template boot) runs ends that boot before it takes work:
// its Firecracker has exited, its link is gone and its slot free, and its building directory too, so none of what it
// held is in use unaccounted. Running sandboxes are adopted as before (their processes and links kept, even one whose
// slot a stale building directory names), and finished template snapshots stay. The same with a state directory reached
// through a symlink, where each process's working directory (/proc's resolved path) differs from its path as text.
func TestNewReapsInterruptedSnapshotBoots(t *testing.T) {
	t.Run("state directory", func(t *testing.T) { testNewReapsInterruptedSnapshotBoots(t, t.TempDir()) })
	t.Run("symlinked state directory", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "state")
		if err := os.Symlink(t.TempDir(), root); err != nil {
			t.Fatal(err)
		}
		testNewReapsInterruptedSnapshotBoots(t, root)
	})
}

func testNewReapsInterruptedSnapshotBoots(t *testing.T, root string) {
	building := filepath.Join(root, templateSnapshotsDir, "tsn_x.building")
	build := startLeftover(t, filepath.Join(building, "vm"))
	if err := os.WriteFile(filepath.Join(building, buildSlotFile), []byte("7"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A size's template boot interrupted too, whose slot record names the running sandbox's slot (stale).
	sizeBuilding := filepath.Join(root, "templates", "default.building")
	if err := os.MkdirAll(filepath.Join(sizeBuilding, "vm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sizeBuilding, buildSlotFile), []byte("3"), 0o600); err != nil {
		t.Fatal(err)
	}
	done := filepath.Join(root, templateSnapshotsDir, "tsn_done")
	if err := os.MkdirAll(done, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(done, "meta.json"), []byte(`{"snapshotId":"tsn_done"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sbxDir := filepath.Join(root, "sandboxes", "sbx_1")
	user := startLeftover(t, filepath.Join(sbxDir, "vm"))
	if err := os.WriteFile(filepath.Join(sbxDir, "vm", fc.APISocket), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(meta{ID: "sbx_1", Size: "default", State: proto.StateRunning, Slot: 3, Pid: user.Process.Pid})
	if err := os.WriteFile(filepath.Join(sbxDir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Network: netm, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if !leftoverGone(build.Process.Pid) {
		t.Fatal("the interrupted build's VM still runs")
	}
	for _, dir := range []string{building, sizeBuilding} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("%s stayed: %v", dir, err)
		}
	}
	if !slices.Contains(netm.Commands, "ip link del kt7") || slices.Contains(netm.Commands, "ip link del kt3") {
		t.Fatalf("the build's link (kt7) should be removed, the running sandbox's (kt3) kept: %q", netm.Commands)
	}
	if _, err := os.Stat(filepath.Join(done, "meta.json")); err != nil {
		t.Fatalf("a finished template snapshot went: %v", err)
	}
	if syscall.Kill(user.Process.Pid, 0) != nil {
		t.Fatal("the running sandbox's VM was killed")
	}
	info, err := m.Get("sbx_1")
	if err != nil || info.State != proto.StateRunning {
		t.Fatalf("the running sandbox: %+v %v", info, err)
	}
	// Its slot is still its own: a new link takes another.
	if link, err := netm.Add(network.EgressNone); err != nil || link.Slot == 3 {
		t.Fatalf("a new link %+v %v", link, err)
	}
	if err := m.Delete(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
}

// A create's record is on disk, starting and with its link's slot, before its machine starts (and so before a
// template's setup runs in it): a host that restarted meanwhile would find it. A machine that won't start leaves no
// link behind, and the record left with its directory is ended by the next run like any unfinished create.
func TestStartMachineRecordsTheCreateBeforeItsMachineStarts(t *testing.T) {
	root := t.TempDir()
	// Stands for Firecracker: keeps what the sandbox's record was as it started (its working directory is the VM's), and
	// fails.
	firecracker := filepath.Join(root, "firecracker")
	if err := os.WriteFile(firecracker, []byte("#!/bin/sh\ncp ../meta.json ../launched.json\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	disk := filepath.Join(root, "template-disk.ext4")
	if err := os.WriteFile(disk, []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Network: netm, Firecracker: firecracker, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	dir := filepath.Join(root, "sandboxes", "sbx_1")
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", Size: "default", State: proto.StateStarting}}
	// A template booted fresh: a cold boot, then its setup.
	origin := sandboxOrigin{rootfs: filepath.Join(root, "rootfs.ext4"), disk: disk, setup: "touch /opt/app/marker", source: "boot"}
	if err := m.startMachine(context.Background(), s, origin, DefaultSizes[1], nil, timings{}); err == nil {
		t.Fatal("a machine that exits at its start started")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "launched.json"))
	if err != nil {
		t.Fatalf("no record as the machine started: %v", err)
	}
	var launched meta
	if err := json.Unmarshal(raw, &launched); err != nil {
		t.Fatal(err)
	}
	if launched.ID != "sbx_1" || launched.State != proto.StateStarting || launched.Slot <= 0 {
		t.Fatalf("the record as the machine started: %+v", launched)
	}
	if s.link != nil || !slices.Contains(netm.Commands, fmt.Sprintf("ip link del kt%d", launched.Slot)) {
		t.Fatalf("the failed start's link (kt%d) stayed: %+v %q", launched.Slot, s.link, netm.Commands)
	}
	if _, err := os.Stat(s.vmDir()); !os.IsNotExist(err) {
		t.Fatalf("the failed start's vm directory stayed: %v", err)
	}
	again, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the unfinished create's directory stayed: %v", err)
	}
	if _, err := again.Get("sbx_1"); err == nil {
		t.Fatal("an unfinished create was adopted")
	}
}

// A host that restarts while a create runs (a template's setup, say, its machine up and recorded starting) ends it
// before it takes work: its Firecracker has exited, its link is gone and its slot free, and its directory too. It isn't
// adopted as a sandbox, running or stopped, since its setup may have run only in part: the host hasn't it, and its ID
// is free for the create's retry. Running and stopped sandboxes are adopted as before, a running one's link kept even
// when a stale record of a failed create's start names its slot.
func TestNewReapsInterruptedCreates(t *testing.T) {
	root := t.TempDir()
	writeRecord := func(id string, rec meta) string {
		t.Helper()
		dir := filepath.Join(root, "sandboxes", id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(rec)
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	setupDir := filepath.Join(root, "sandboxes", "sbx_setup")
	setup := startLeftover(t, filepath.Join(setupDir, "vm"))
	writeRecord("sbx_setup", meta{ID: "sbx_setup", Size: "default", State: proto.StateStarting, Slot: 7})
	staleDir := writeRecord("sbx_stale", meta{ID: "sbx_stale", Size: "default", State: proto.StateStarting, Slot: 3})
	runningDir := filepath.Join(root, "sandboxes", "sbx_1")
	user := startLeftover(t, filepath.Join(runningDir, "vm"))
	if err := os.WriteFile(filepath.Join(runningDir, "vm", fc.APISocket), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	writeRecord("sbx_1", meta{ID: "sbx_1", Size: "default", State: proto.StateRunning, Slot: 3, Pid: user.Process.Pid})
	writeRecord("sbx_stopped", meta{ID: "sbx_stopped", Size: "default", State: proto.StateStopped})
	netm, err := network.New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Network: netm, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if !leftoverGone(setup.Process.Pid) {
		t.Fatal("the interrupted create's VM still runs")
	}
	for _, dir := range []string{setupDir, staleDir} {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("%s stayed: %v", dir, err)
		}
	}
	if !slices.Contains(netm.Commands, "ip link del kt7") || slices.Contains(netm.Commands, "ip link del kt3") {
		t.Fatalf("the create's link (kt7) should be removed, the running sandbox's (kt3) kept: %q", netm.Commands)
	}
	for _, id := range []string{"sbx_setup", "sbx_stale"} {
		if info, err := m.Get(id); err == nil {
			t.Fatalf("an unfinished create was adopted: %+v", info)
		}
	}
	if syscall.Kill(user.Process.Pid, 0) != nil {
		t.Fatal("the running sandbox's VM was killed")
	}
	if info, err := m.Get("sbx_1"); err != nil || info.State != proto.StateRunning {
		t.Fatalf("the running sandbox: %+v %v", info, err)
	}
	if info, err := m.Get("sbx_stopped"); err != nil || info.State != proto.StateStopped {
		t.Fatalf("the stopped sandbox: %+v %v", info, err)
	}
	// The host has only its sandboxes, and the create's ID is free for its retry.
	if ids := m.List(); len(ids) != 2 {
		t.Fatalf("the host has %+v", ids)
	}
	if err := m.register(&sandbox{meta: meta{ID: "sbx_setup", Size: "default", State: proto.StateStarting}}, DefaultSizes[1]); err != nil {
		t.Fatalf("a retry of the create: %v", err)
	}
	if err := m.Delete(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
}

// leftoverGone says a process has exited, or is a zombie its parent hasn't reaped yet.
func leftoverGone(pid int) bool {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return true
	}
	fields := strings.Fields(string(raw[strings.LastIndex(string(raw), ")")+1:]))
	return len(fields) > 0 && fields[0] == "Z"
}

// A host that restarts while a root filesystem is being made removes its helper container, which Docker keeps
// running, and its work directory.
func TestRootfsReapEndsAnInterruptedHelper(t *testing.T) {
	b, docker := testBuilder(t)
	key := testTemplateImage.key()
	work := filepath.Join(b.dir, key+".building")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	b.reap()
	if want := [][]string{{"docker", "rm", "-f", "kantel-rootfs-" + key}}; !reflect.DeepEqual(docker.calls, want) {
		t.Fatalf("commands %v", docker.calls)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatalf("the work directory stayed: %v", err)
	}
}
