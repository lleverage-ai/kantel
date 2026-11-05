package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
)

var update = flag.Bool("update", false, "rewrite testdata/install-plan.txt")

// fakeMachine is a machine install works on under a temporary directory: KVM without nesting, systemd, a release of
// images in a directory, Firecracker's release served from memory, and a control plane that registers whoever asks.
type fakeMachine struct {
	dir                  string
	in                   *installer
	registered           []string
	systemctl            []string
	out                  bytes.Buffer
	firecrackerArchive   []byte
	firecrackerArchiveSH string
}

func firecrackerArch() string {
	if runtime.GOARCH == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

func newFakeMachine(t *testing.T) *fakeMachine {
	t.Helper()
	m := &fakeMachine{dir: t.TempDir()}
	arch := archName()
	images := filepath.Join(m.dir, "images")
	write := func(path string, data []byte, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]ImageFile{}
	for _, name := range []string{"vmlinux-" + arch, "sandbox-" + arch + ".ext4", "isolate-" + arch + ".ext4", "kantel-guest-" + arch} {
		data := []byte("release " + strings.ReplaceAll(name, arch, "arch")) // the same digests on every machine
		sum := sha256.Sum256(data)
		write(filepath.Join(images, name), data, 0o644)
		files[name] = ImageFile{Path: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data))}
	}
	manifest, _ := json.Marshal(ImageManifest{Version: "host-images-test", Files: files})
	write(filepath.Join(images, "manifest.json"), manifest, 0o644)
	write(filepath.Join(m.dir, "download", "kantel-host"), []byte("kantel-host"), 0o755)

	// Firecracker's release: a tgz whose binary says its version, so a second run finds it up to date.
	var tgz bytes.Buffer
	gz := gzip.NewWriter(&tgz)
	tw := tar.NewWriter(gz)
	fa := firecrackerArch()
	body := []byte("#!/bin/sh\necho Firecracker " + FirecrackerVersion + "\n")
	_ = tw.WriteHeader(&tar.Header{Name: fmt.Sprintf("release-%s-%s/firecracker-%s-%s", FirecrackerVersion, fa, FirecrackerVersion, fa), Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	_ = gz.Close()
	m.firecrackerArchive = tgz.Bytes()
	sum := sha256.Sum256(m.firecrackerArchive)
	m.firecrackerArchiveSH = hex.EncodeToString(sum[:])

	m.in = &installer{
		binPath:    filepath.Join(m.dir, "usr", "local", "bin", "kantel-host"),
		unitPath:   filepath.Join(m.dir, "etc", "systemd", "system", "kantel-host.service"),
		euid:       func() int { return 0 },
		executable: func() (string, error) { return filepath.Join(m.dir, "download", "kantel-host"), nil },
		kvm:        func() (bool, string) { return true, "/dev/kvm opens read-write" },
		nested:     func() (bool, string) { return false, "no kvm_intel or kvm_amd module loaded" },
		systemd:    func() bool { return true },
		systemctl: func(args ...string) (string, error) {
			m.systemctl = append(m.systemctl, strings.Join(args, " "))
			return "", nil
		},
		get: func(u string) (io.ReadCloser, error) {
			name := fmt.Sprintf("firecracker-%s-%s.tgz", FirecrackerVersion, fa)
			switch {
			case strings.HasSuffix(u, "/"+name+".sha256.txt"):
				return io.NopCloser(strings.NewReader(m.firecrackerArchiveSH + "  " + name + "\n")), nil
			case strings.HasSuffix(u, "/"+name):
				return io.NopCloser(bytes.NewReader(m.firecrackerArchive)), nil
			}
			return nil, fmt.Errorf("GET %s: 404", u)
		},
		register: func(cfg agent.Config, token string) (string, string, error) {
			m.registered = append(m.registered, token)
			return "host_1", "khc_secret", nil
		},
		hostname: func() (string, error) { return "builder-1", nil },
		out:      &m.out,
	}
	return m
}

func (m *fakeMachine) options(token string) installOptions {
	return installOptions{
		controlPlane: "https://kantel.example.com/", token: token, images: filepath.Join(m.dir, "images"),
		root: filepath.Join(m.dir, "var", "lib", "kantel-host"), configPath: filepath.Join(m.dir, "etc", "kantel-host", "config.json"),
		labels: map[string]string{"zone": "ams", "gpu": "none"},
	}
}

// tree is every file and directory under dir, with each file's contents' digest.
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			out[p] = "dir"
			return nil
		}
		raw, err := os.ReadFile(p)
		sum := sha256.Sum256(raw)
		out[p] = hex.EncodeToString(sum[:])
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// normal makes output the same on every machine: the temporary directory and the architecture by name.
func (m *fakeMachine) normal(s string) string {
	return strings.NewReplacer(m.dir, "$TMP", archName(), "$ARCH", firecrackerArch(), "$FCARCH", m.firecrackerArchiveSH, "$FCSHA").Replace(s)
}

func verbs(p *installPlan) []string {
	var out []string
	for _, s := range p.steps {
		for _, a := range s.actions {
			out = append(out, a.verb)
		}
	}
	return out
}

// The dry run prints every download with its URL and digest, every directory and file, the unit, the commands and
// the registration, and changes nothing: no file under the machine's directory, no registration, no systemctl.
func TestDryRunPlan(t *testing.T) {
	m := newFakeMachine(t)
	before := tree(t, m.dir)
	o := m.options("kth_secret")
	o.dryRun = true
	plan, err := m.in.planInstall(o)
	if err != nil {
		t.Fatal(err)
	}
	printPlan(&m.out, plan)
	got := m.normal(m.out.String())
	golden := filepath.Join("testdata", "install-plan.txt")
	if *update {
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Errorf("the plan isn't testdata/install-plan.txt (go test -run TestDryRunPlan -update rewrites it):\n%s", got)
	}
	if strings.Contains(m.out.String(), "kth_secret") {
		t.Error("the plan shows the token")
	}
	after := tree(t, m.dir)
	if len(before) != len(after) {
		t.Errorf("the dry run changed the machine: %d paths before, %d after", len(before), len(after))
	}
	for p, sum := range before {
		if after[p] != sum {
			t.Errorf("the dry run changed %s", p)
		}
	}
	if len(m.registered) != 0 || len(m.systemctl) != 0 {
		t.Errorf("the dry run registered %v and ran systemctl %v", m.registered, m.systemctl)
	}
}

// An install does what its plan says, from the same list: each file the plan writes is there, it registers once,
// and it runs the plan's systemctl commands in order. Run again, the same command carries on without the token.
func TestInstallDoesThePlan(t *testing.T) {
	m := newFakeMachine(t)
	o := m.options("kth_secret")
	plan, err := m.in.planInstall(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.in.doPlan(plan); err != nil {
		t.Fatalf("%v\n%s", err, m.out.String())
	}
	cfg, err := agent.LoadConfig(o.configPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{m.in.binPath, m.in.unitPath, o.configPath, cfg.Firecracker, cfg.Kernel, cfg.SandboxImage, cfg.IsolateImage, cfg.GuestAgent} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("not installed: %v", err)
		}
	}
	if info, err := os.Stat(o.configPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("config mode: %v %v", info, err)
	}
	if cfg.HostID != "host_1" || cfg.Credential != "khc_secret" || cfg.TokenSHA256 != tokenSHA256("kth_secret") || cfg.ControlPlane != "https://kantel.example.com" {
		t.Errorf("config: %+v", cfg)
	}
	if raw, _ := os.ReadFile(o.configPath); strings.Contains(string(raw), "kth_secret") {
		t.Error("the config holds the token")
	}
	if strings.Join(m.systemctl, "; ") != "daemon-reload; enable --now kantel-host; restart kantel-host" || len(m.registered) != 1 {
		t.Errorf("systemctl %v, registered %v", m.systemctl, m.registered)
	}
	// What it printed is the plan's lines, as it did them.
	for _, s := range plan.steps {
		for _, a := range s.actions {
			if !strings.Contains(m.out.String(), a.String()) {
				t.Errorf("the install didn't show %q", a)
			}
		}
	}

	// The same join command again (say the service failed to start the first time): it doesn't register again,
	// and everything downloaded is kept.
	again, err := m.in.planInstall(o)
	if err != nil {
		t.Fatal(err)
	}
	if again.usesToken || strings.Contains(strings.Join(verbs(again), " "), "get") || strings.Contains(strings.Join(verbs(again), " "), "mkdir") {
		t.Errorf("a second run with the same token: %v", verbs(again))
	}
	if first := again.steps[0].actions[0]; first.verb != "note" || !strings.Contains(first.what, "without using the token again") {
		t.Errorf("a second run's first line: %s", first)
	}
	if err := m.in.doPlan(again); err != nil || len(m.registered) != 1 {
		t.Errorf("a second run: %v, registered %v", err, m.registered)
	}
	if cfg, _ := agent.LoadConfig(o.configPath); cfg.HostID != "host_1" || cfg.Credential != "khc_secret" {
		t.Errorf("a second run lost the registration: %+v", cfg)
	}

	// No token: an update, keeping the registration. Another token: a new registration.
	if p, err := m.in.planInstall(m.options("")); err != nil || p.usesToken || !strings.Contains(p.steps[0].actions[0].what, "updating the install") {
		t.Errorf("no token: %v %v", p, err)
	}
	if p, err := m.in.planInstall(m.options("kth_other")); err != nil || !p.usesToken {
		t.Errorf("another token: %v %v", p, err)
	}
	// Another control plane, with no token: refused, as before.
	o.controlPlane, o.token = "https://other.example.com", ""
	if _, err := m.in.planInstall(o); err == nil || !strings.Contains(err.Error(), "--token is required") {
		t.Errorf("another control plane: %v", err)
	}
}

// Settings that couldn't be saved after registering would lose the host's credential, with the token used up: an
// install that can't save them doesn't register.
func TestNoRegisteringWithoutSavingTheSettings(t *testing.T) {
	m := newFakeMachine(t)
	o := m.options("kth_secret")
	// A file where the settings' directory should be.
	if err := os.MkdirAll(filepath.Join(m.dir, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Dir(o.configPath), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := m.in.planInstall(o)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.in.doPlan(plan); err == nil || !strings.Contains(err.Error(), "not registering") || len(m.registered) != 0 {
		t.Errorf("install: %v, registered %v", err, m.registered)
	}
}

// Go's flags stop at the first operand, so `--no-start false --dry-run` would leave --dry-run unread and install for
// real. install refuses any operand before doing anything; every spelling of the flags it reads still works.
func TestInstallRefusesStrayArguments(t *testing.T) {
	m := newFakeMachine(t)
	o := m.options("")
	base := []string{"--url", "https://kantel.example.com", "--token", "kth_secret", "--images", o.images, "--root", o.root, "--config", o.configPath}
	before := tree(t, m.dir)
	for _, stray := range [][]string{{"--no-start", "false", "--dry-run"}, {"--", "--dry-run"}, {"builder-1", "--dry-run"}} {
		err := runInstall(m.in, append(append([]string{}, base...), stray...), false)
		if err == nil || !strings.Contains(err.Error(), "install takes options only") {
			t.Errorf("%v: %v", stray, err)
		}
	}
	// The token after the stray operand isn't read, and isn't shown either: it's still unused.
	if err := runInstall(m.in, []string{"--no-start", "false", "--dry-run", "--url", "https://kantel.example.com", "--token", "kth_secret"}, false); err == nil || strings.Contains(err.Error(), "kth_secret") {
		t.Errorf("the error shows the token: %v", err)
	}
	after := tree(t, m.dir)
	for p, sum := range before {
		if after[p] != sum {
			t.Errorf("a refused install changed %s", p)
		}
	}
	if len(after) != len(before) || len(m.registered) != 0 || len(m.systemctl) != 0 {
		t.Errorf("a refused install did something: %d paths, registered %v, systemctl %v", len(after)-len(before), m.registered, m.systemctl)
	}

	for _, args := range [][]string{
		append([]string{"--dry-run=1", "--no-start=false"}, base...),
		append(append([]string{"--no-start"}, base...), "--dry-run"),
		append(append([]string{}, base...), "-dry-run=t"),
	} {
		got, err := parseInstall(args)
		if err != nil || !got.dryRun || got.controlPlane != "https://kantel.example.com" || got.token != "kth_secret" {
			t.Errorf("%v: %+v %v", args, got, err)
		}
	}
	// The whole command, as a dry run: the plan, and nothing done.
	if err := runInstall(m.in, append(append([]string{}, base...), "--label", "zone=ams", "--dry-run"), false); err != nil || len(m.registered) != 0 || !strings.Contains(m.out.String(), "Dry run: nothing has been changed") {
		t.Errorf("a dry run: %v, registered %v\n%s", err, m.registered, m.out.String())
	}
}

// `plan` (what install.sh --dry-run runs) is only ever a dry run: even when an option takes "--dry-run" as its value,
// so install's own --dry-run is never set, nothing is changed and the token isn't used.
func TestPlanIsAlwaysADryRun(t *testing.T) {
	m := newFakeMachine(t)
	o := m.options("")
	before := tree(t, m.dir)
	args := []string{"--name", "--dry-run", "--url", "https://kantel.example.com", "--token", "kth_secret", "--images", o.images, "--root", o.root, "--config", o.configPath}
	if err := runInstall(m.in, args, true); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.out.String(), `as "--dry-run"`) || !strings.Contains(m.out.String(), "Dry run: nothing has been changed") {
		t.Errorf("plan didn't print the plan:\n%s", m.out.String())
	}
	after := tree(t, m.dir)
	for p, sum := range before {
		if after[p] != sum {
			t.Errorf("plan changed %s", p)
		}
	}
	if len(after) != len(before) || len(m.registered) != 0 || len(m.systemctl) != 0 {
		t.Errorf("plan did something: %d paths, registered %v, systemctl %v", len(after)-len(before), m.registered, m.systemctl)
	}
}

// With image patching on (#651), the plan says what the service does to the images at start.
func TestDryRunWithImagePatching(t *testing.T) {
	m := newFakeMachine(t)
	o := m.options("kth_secret")
	o.dryRun = true
	if err := (agent.Config{ControlPlane: "https://kantel.example.com", ImagePatching: true}).Save(o.configPath); err != nil {
		t.Fatal(err)
	}
	plan, err := m.in.planInstall(o)
	if err != nil {
		t.Fatal(err)
	}
	if last := plan.after[len(plan.after)-1]; !strings.Contains(last, "With image patching on") || !strings.Contains(last, "fetches cosign") {
		t.Errorf("image patching: %q", last)
	}
}

func TestDryRunNeedsRoot(t *testing.T) {
	m := newFakeMachine(t)
	m.in.euid = func() int { return 1000 }
	o := m.options("kth_secret")
	o.dryRun = true
	if _, err := m.in.planInstall(o); err == nil || !strings.Contains(err.Error(), "--dry-run needs root") {
		t.Errorf("as a user: %v", err)
	}
}

// Without KVM and without --isolate-runtime native, the dry run fails where the install would.
func TestDryRunWithoutKVM(t *testing.T) {
	m := newFakeMachine(t)
	m.in.kvm = func() (bool, string) { return false, "/dev/kvm is missing" }
	o := m.options("kth_secret")
	o.dryRun = true
	if _, err := m.in.planInstall(o); err == nil || !strings.Contains(err.Error(), "no usable /dev/kvm") {
		t.Errorf("without KVM: %v", err)
	}
}

// doctor exits non-zero when a required check fails or couldn't be found out, and not for advice.
func TestDoctorExit(t *testing.T) {
	ok := hostinfo.Check{Name: "kvm", OK: true, State: hostinfo.StateOK, Required: true}
	advice := hostinfo.Check{Name: "memory", State: hostinfo.StateFail}
	unknown := hostinfo.Check{Name: "tun", State: hostinfo.StateUnknown, Required: true}
	failed := hostinfo.Check{Name: "iptables", State: hostinfo.StateFail, Required: true}
	if err := checksPassed([]hostinfo.Check{ok, advice}); err != nil {
		t.Errorf("advice failing: %v", err)
	}
	if err := checksPassed([]hostinfo.Check{ok, unknown}); err == nil || !strings.Contains(err.Error(), "tun (unknown)") {
		t.Errorf("a required check unknown: %v", err)
	}
	if err := checksPassed([]hostinfo.Check{failed, unknown}); err == nil || !strings.Contains(err.Error(), "iptables (fail), tun (unknown)") {
		t.Errorf("required checks failing: %v", err)
	}
	var out bytes.Buffer
	printChecks(&out, []hostinfo.Check{ok, advice, unknown, failed}, false)
	lines := strings.Split(out.String(), "\n")
	var marks []string
	for _, l := range lines[:4] {
		marks = append(marks, strings.Fields(l)[0])
	}
	sort.Strings(marks)
	if strings.Join(marks, " ") != "FAIL ok unknown warn" {
		t.Errorf("marks: %v\n%s", marks, out.String())
	}
}
