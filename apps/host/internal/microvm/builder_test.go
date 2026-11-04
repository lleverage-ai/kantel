package microvm

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

var testDockerfile = &proto.TemplateImage{Kind: proto.TemplateImageDockerfile, Dockerfile: "ARG KANTEL_BASE\nFROM $KANTEL_BASE\nRUN apt-get install -y ripgrep\n", Scope: "tpl_1@1#0"}

// fakeBuilder stands for the build microVM: it records each job and leaves an output drive in its directory.
type fakeBuilder struct {
	jobs   []builderJob
	digest string
	fail   error
}

func (f *fakeBuilder) run(_ context.Context, job builderJob) (builderOutput, error) {
	f.jobs = append(f.jobs, job)
	if f.fail != nil {
		return builderOutput{}, f.fail
	}
	if err := os.MkdirAll(job.dir, 0o700); err != nil {
		return builderOutput{}, err
	}
	out := filepath.Join(job.dir, builderOutputDrive)
	return builderOutput{rootfs: out, imageDigest: f.digest}, os.WriteFile(out, []byte("ext4 made in the microVM"), 0o600)
}

// builderManager is testManager with the template builder on, the guest agent injected and the build microVM faked.
func builderManager(t *testing.T) (*Manager, *fakeDocker, *fakeBuilder) {
	t.Helper()
	m, docker := testManager(t)
	m.cfg.Initrd = filepath.Join(t.TempDir(), "initramfs")
	m.cfg.TemplateBuilder = &TemplateBuilderConfig{Registries: []string{"registry-1.docker.io", "*.docker.io"}}
	netm, err := network.New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	m.cfg.Network = netm
	b := &fakeBuilder{digest: "sha256:" + strings.Repeat("ab", 32)}
	m.tpl.runBuilder = b.run
	return m, docker, b
}

// A custom image is built in the build microVM, never by the host's Docker: no host command runs, the microVM's way
// out is the egress proxy under the template's grants with every other host refused, and the root filesystem it made
// is kept under its key for the snapshot's boot.
func TestACustomImageIsBuiltInABuildMicroVMNeverOnTheHost(t *testing.T) {
	m, docker, b := builderManager(t)
	grants := []proto.Grant{{Action: "allow", Host: "archive.ubuntu.com", Rule: "allow archive.ubuntu.com"}}
	p := proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20, Owner: "acc_1",
		Egress: &proto.Egress{Mode: "open", Allow: []string{"pypi.org"}, Grants: grants}}
	// The snapshot's boot needs Firecracker, which the tests haven't: the build fails there, after the image is made.
	if _, err := m.BuildTemplate(context.Background(), p); err == nil {
		t.Fatal("a build with no Firecracker succeeded")
	}
	if len(docker.calls) != 0 {
		t.Fatalf("the host ran %v for a custom image", docker.calls)
	}
	if len(b.jobs) != 1 {
		t.Fatalf("build microVM jobs %d", len(b.jobs))
	}
	job := b.jobs[0]
	if job.id != "tsn_1" || job.owner != "acc_1" || job.image != testDockerfile || job.baseRef != "" {
		t.Fatalf("job %+v", job)
	}
	e := job.egress
	if e.Mode != network.EgressProxy || !e.DefaultDeny {
		t.Fatalf("the build microVM's egress is %q (default deny %v), not the proxy refusing what no rule allows", e.Mode, e.DefaultDeny)
	}
	if !reflect.DeepEqual(e.Allow, []string{"pypi.org", "registry-1.docker.io", "*.docker.io"}) || !reflect.DeepEqual(e.Grants, grants) {
		t.Fatalf("the build microVM's rules %+v", e)
	}
	if p.Egress.Mode != "open" || len(p.Egress.Allow) != 1 {
		t.Fatalf("the template's egress was changed: %+v", p.Egress)
	}
	key := customImageKey("acc_1", testDockerfile, templateImage{BaseImage: "kantel/sandbox"})
	path, rec, ok := m.tpl.rootfs.cached(key)
	if !ok || rec.ImageDigest != b.digest || !strings.HasPrefix(rec.BuiltFrom, "dockerfile sha256:") {
		t.Fatalf("the image's root filesystem %s %+v %v", path, rec, ok)
	}
	if !m.pulledRootfs(path) {
		t.Fatalf("%s isn't kept as a template's own root filesystem", path)
	}
	// Built once a scope: a retry of the build (its snapshot's boot failed) boots what it made.
	_, _ = m.BuildTemplate(context.Background(), p)
	if len(b.jobs) != 1 {
		t.Fatalf("the image was built again: %d jobs", len(b.jobs))
	}
}

// A Dockerfile's KANTEL_BASE is a pulled Kantel base fetched in the microVM, by digest from the operator's registry,
// which the microVM's rules allow; the host pulls nothing.
func TestADockerfileOnAPinnedBaseFetchesItInTheMicroVM(t *testing.T) {
	m, docker, b := builderManager(t)
	m.cfg.TemplateRegistry = testRegistry
	_, _ = m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", BaseDigest: testDigest, Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20})
	if len(docker.calls) != 0 {
		t.Fatalf("the host ran %v", docker.calls)
	}
	if len(b.jobs) != 1 || b.jobs[0].baseRef != testRegistry+"/kantel/sandbox@"+testDigest {
		t.Fatalf("jobs %+v", b.jobs)
	}
	if !slices.Contains(b.jobs[0].egress.Allow, "ghcr.io") {
		t.Fatalf("the microVM may not reach the operator's registry: %v", b.jobs[0].egress.Allow)
	}
}

// A build that failed in the microVM is the template's, and leaves nothing behind.
func TestACustomImageBuildFailureIsTheTemplates(t *testing.T) {
	m, docker, b := builderManager(t)
	b.fail = &proto.Error{Code: proto.ErrInvalid, Message: "the template's image build exited with 1: pull access denied"}
	_, err := m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", Image: &proto.TemplateImage{Kind: proto.TemplateImageRef, Ref: "python:3.13-slim", Scope: "tpl_1@1#0"}, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20})
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrInvalid || !strings.Contains(pe.Message, "pull access denied") {
		t.Fatalf("build %v", err)
	}
	if len(docker.calls) != 0 {
		t.Fatalf("the host ran %v", docker.calls)
	}
	left, _ := filepath.Glob(filepath.Join(m.cfg.Root, "images", "templates", "*"))
	if len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if ids, _, _ := m.TemplateBuilds(); len(ids) != 0 {
		t.Fatalf("builds held %v", ids)
	}
}

// A host whose builder is off, or which doesn't inject the guest agent, refuses custom images before anything runs.
func TestAHostWithoutTheBuilderRefusesCustomImages(t *testing.T) {
	for name, change := range map[string]func(*Manager){
		"builder off":        func(m *Manager) { m.cfg.TemplateBuilder = nil },
		"no injected agent":  func(m *Manager) { m.cfg.Initrd = "" },
		"builder and initrd": func(m *Manager) { m.cfg.TemplateBuilder, m.cfg.Initrd = nil, "" },
	} {
		t.Run(name, func(t *testing.T) {
			m, docker, b := builderManager(t)
			change(m)
			_, err := m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20})
			var pe *proto.Error
			if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
				t.Fatalf("build %v", err)
			}
			if len(b.jobs) != 0 || len(docker.calls) != 0 {
				t.Fatalf("ran %v %v", b.jobs, docker.calls)
			}
			if _, err := m.templateOrigin(context.Background(), proto.TemplateBoot{BaseImage: "kantel/sandbox", Image: testDockerfile}, DefaultSizes[1]); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
				t.Fatalf("boot %v", err)
			}
		})
	}
}

// A create from a custom image boots the root filesystem a build here made, and never builds one: without it, it fails
// (the control plane sends it only to hosts holding one).
func TestACreateFromACustomImageBootsOnlyWhatABuildMade(t *testing.T) {
	m, _, b := builderManager(t)
	_, _ = m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20, Owner: "acc_1"})
	key := customImageKey("acc_1", testDockerfile, templateImage{BaseImage: "kantel/sandbox"})
	origin, err := m.templateOrigin(context.Background(), proto.TemplateBoot{BaseImage: "kantel/sandbox", Image: testDockerfile, RootfsKey: key, Setup: "true"}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	origin = settled(origin)
	if origin.rootfs != m.tpl.rootfs.path(key) || origin.setup != "true" || origin.source != "boot" {
		t.Fatalf("origin %+v", origin)
	}
	var pe *proto.Error
	for _, missing := range []string{"", strings.Repeat("0", 64), "../../etc"} {
		if _, err := m.templateOrigin(context.Background(), proto.TemplateBoot{BaseImage: "kantel/sandbox", Image: testDockerfile, RootfsKey: missing}, DefaultSizes[1]); !errors.As(err, &pe) || pe.Code != proto.ErrNotFound {
			t.Fatalf("boot of %q: %v", missing, err)
		}
	}
	if len(b.jobs) != 1 {
		t.Fatalf("a create built an image: %d jobs", len(b.jobs))
	}
}

// A custom image's root filesystem is the account's, the build's scope's (its template, version and rebuild) and the
// image's: another account's same Dockerfile, a rebuild, or another Dockerfile builds its own.
func TestACustomImagesKeyIsItsAccountScopeAndImage(t *testing.T) {
	base := templateImage{BaseImage: "kantel/sandbox"}
	key := customImageKey("acc_1", testDockerfile, base)
	changed := func(f func(img *proto.TemplateImage)) *proto.TemplateImage {
		img := *testDockerfile
		f(&img)
		return &img
	}
	for name, other := range map[string]string{
		"account":    customImageKey("acc_2", testDockerfile, base),
		"rebuild":    customImageKey("acc_1", changed(func(i *proto.TemplateImage) { i.Scope = "tpl_1@1#1" }), base),
		"version":    customImageKey("acc_1", changed(func(i *proto.TemplateImage) { i.Scope = "tpl_1@2#0" }), base),
		"dockerfile": customImageKey("acc_1", changed(func(i *proto.TemplateImage) { i.Dockerfile += "RUN true\n" }), base),
		"base":       customImageKey("acc_1", testDockerfile, templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}),
		"kind":       customImageKey("acc_1", &proto.TemplateImage{Kind: proto.TemplateImageRef, Ref: "python:3.13", Scope: "tpl_1@1#0"}, base),
	} {
		if other == key {
			t.Errorf("another %s has the same key", name)
		}
	}
	if !validKey(key) || key != customImageKey("acc_1", testDockerfile, base) {
		t.Fatalf("key %q", key)
	}
	if key == base.key() {
		t.Fatal("a custom image's key is its base's")
	}
}

func TestTemplateImagesAreCheckedBeforeAnythingRuns(t *testing.T) {
	good := []*proto.TemplateImage{
		testDockerfile,
		{Kind: proto.TemplateImageRef, Ref: "python:3.13-slim", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "ghcr.io/acme/ci:1.8", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "registry.example.com:5000/team/app@sha256:" + strings.Repeat("0", 64), Scope: "s"},
	}
	for _, img := range good {
		if err := validateTemplateImage(img); err != nil {
			t.Errorf("%+v: %v", img, err)
		}
	}
	bad := []*proto.TemplateImage{
		{Kind: proto.TemplateImageDockerfile, Dockerfile: " \n", Scope: "s"},
		{Kind: proto.TemplateImageDockerfile, Dockerfile: strings.Repeat("#", maxDockerfileBytes+1), Scope: "s"},
		{Kind: proto.TemplateImageDockerfile, Dockerfile: "FROM x", Ref: "x", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "Python:3", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "python:3 ; rm -rf /", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "-v/:/host", Scope: "s"},
		{Kind: proto.TemplateImageRef, Ref: "python", Scope: "../x y"},
		{Kind: "kantel-base", Scope: "s"},
	}
	for _, img := range bad {
		var pe *proto.Error
		if err := validateTemplateImage(img); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
			t.Errorf("%+v: %v", img, err)
		}
	}
}

func TestTheBuildsDigestIsTheMicroVMsLastResultLine(t *testing.T) {
	id, repo := "sha256:"+strings.Repeat("1", 64), "python@sha256:"+strings.Repeat("2", 64)
	out := "Step 1/2\nKANTEL-RESULT {\"imageId\":\"bogus\"}\nKANTEL-RESULT {\"imageId\":\"" + id + "\",\"repoDigest\":\"" + repo + "\"}\n"
	if d, err := parseBuilderResult(&proto.TemplateImage{Kind: proto.TemplateImageRef}, out); err != nil || d != "sha256:"+strings.Repeat("2", 64) {
		t.Fatalf("an image reference's digest %q %v", d, err)
	}
	if d, err := parseBuilderResult(testDockerfile, out); err != nil || d != id {
		t.Fatalf("a Dockerfile's digest %q %v", d, err)
	}
	for _, bad := range []string{"", "KANTEL-RESULT {\"imageId\":\"sha256:nothex\"}", "KANTEL-RESULT nope"} {
		if _, err := parseBuilderResult(testDockerfile, bad); err == nil {
			t.Errorf("%q answered a digest", bad)
		}
	}
}

// The build script builds with no build context (the Dockerfile on stdin), gives RUN steps the microVM's network,
// whose only way out is the proxy, and writes the image into the output drive: nothing is mounted from the host.
func TestTheBuildScriptBuildsWithNoContextIntoTheOutputDrive(t *testing.T) {
	for _, want := range []string{"-t kantel-template:build - < /tmp/kantel.Dockerfile", "--network=host", "mount -t ext4 /dev/vdc", `docker export "$c" | tar -x -C "$out"`, "umount"} {
		if !strings.Contains(builderScript, want) {
			t.Errorf("the build script has no %q", want)
		}
	}
	for _, never := range []string{"--privileged", " -v ", "--mount", "docker.sock", "insecure-registr"} {
		if strings.Contains(builderScript, never) {
			t.Errorf("the build script has %q", never)
		}
	}
	env := builderEnv(builderJob{image: testDockerfile, env: map[string]string{"KANTEL_IMAGE_KIND": "image", "A": "1"}})
	if env["KANTEL_IMAGE_KIND"] != proto.TemplateImageDockerfile || env["A"] != "1" || env["KANTEL_DOCKERFILE"] == "" {
		t.Fatalf("env %v", env)
	}
}

// The build microVM boots the host's own image with an empty disk and an empty output drive, both made by the host, on
// a link in the proxy's mode with the build's rules attached; a Firecracker standing in for the real one records its
// VM directory as it starts, and fails, and the link and directory go.
func TestTheBuildMicroVMBootsTheHostsImageOnTheProxyOnly(t *testing.T) {
	root := t.TempDir()
	firecracker := filepath.Join(root, "firecracker")
	if err := os.WriteFile(firecracker, []byte("#!/bin/sh\nls -1 > ../../launched.txt\nreadlink rootfs.ext4 >> ../../launched.txt\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(root, "sandbox.ext4")
	if err := os.WriteFile(image, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	type attached struct {
		slot   int
		id     string
		egress *proto.Egress
	}
	var got []attached
	detached := 0
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Network: netm, Firecracker: firecracker, Rootfs: image, Initrd: filepath.Join(root, "initramfs"),
		TemplateBuilder: &TemplateBuilderConfig{Registries: []string{"ghcr.io"}}, Log: slog.New(slog.DiscardHandler),
		Attach: func(slot int, id, _ string, e *proto.Egress) { got = append(got, attached{slot, id, e}) },
		Detach: func(int) { detached++ }})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	work := filepath.Join(root, "images", "templates", "k.builder")
	egress := m.builderEgress(&proto.Egress{Mode: "open"}, templateImage{})
	_, err = m.bootBuilder(context.Background(), builderJob{dir: work, id: "tsn_1", owner: "acc_1", image: testDockerfile, size: proto.Size{VCPUs: 1, MemoryMiB: 512, DiskGiB: 1}, egress: egress})
	if err == nil {
		t.Fatal("a build microVM whose Firecracker exits built")
	}
	raw, err := os.ReadFile(filepath.Join(root, "images", "templates", "launched.txt"))
	if err != nil {
		t.Fatalf("Firecracker didn't start: %v", err)
	}
	launched := strings.Fields(string(raw))
	for _, want := range []string{"rootfs.ext4", "disk.ext4", builderOutputDrive, image} {
		if !slices.Contains(launched, want) {
			t.Fatalf("the build microVM's directory %v has no %s", launched, want)
		}
	}
	if len(got) != 1 || got[0].id != "tsn_1" || got[0].egress.Mode != network.EgressProxy || !got[0].egress.DefaultDeny || detached != 1 {
		t.Fatalf("attached %+v, detached %d", got, detached)
	}
	if !slices.Contains(netm.Commands, "ip link del kt"+strconv.Itoa(got[0].slot)) {
		t.Fatalf("the link stayed: %q", netm.Commands)
	}
}
