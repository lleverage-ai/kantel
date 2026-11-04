package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
)

// An install is a list of steps, each a list of actions. planInstall makes the list, reading the machine but changing
// nothing; `install --dry-run` prints it and `install` prints and does it, action by action. Both come from the one
// list, so what a dry run shows is what an install does.

// action is one thing install does: a line to show, and the change itself (nil for a check, a note or a file kept as
// it is).
type action struct {
	// verb is the kind of change: check, note, keep, get, copy, mkdir, write, unpack, post or run.
	verb string
	what string
	do   func() error
}

func (a action) String() string { return fmt.Sprintf("  %-6s %s", a.verb, a.what) }

type installStep struct {
	title   string
	actions []action
}

type installPlan struct {
	steps []installStep
	// after is what install leaves to the service, and what it doesn't touch at all, for the dry run's summary.
	after []string
	// done is the last line of a real install.
	done string
	// usesToken: the plan registers, which uses the join token up.
	usesToken bool
}

// installOptions are install's flags.
type installOptions struct {
	controlPlane, token, name, images, root, configPath, tiers, isolateRuntime string
	labels                                                                     map[string]string
	proxyDataPath, injectGuestAgent, noStart, dryRun                           bool
}

// installer is the machine install works on: this one, or a test's.
type installer struct {
	binPath, unitPath string
	euid              func() int
	executable        func() (string, error)
	kvm, nested       func() (bool, string)
	systemd           func() bool
	systemctl         func(args ...string) (string, error)
	// get fetches a URL (Firecracker's release); the images go through open.
	get      func(url string) (io.ReadCloser, error)
	register func(cfg agent.Config, token string) (hostID, credential string, err error)
	hostname func() (string, error)
	// out is where install prints.
	out io.Writer
}

func thisMachine() *installer {
	return &installer{
		binPath:  binPath,
		unitPath: unitPath,
		euid:     os.Geteuid,
		executable: func() (string, error) {
			self, err := os.Executable()
			if err != nil {
				return "", err
			}
			return filepath.EvalSymlinks(self)
		},
		kvm:    hostinfo.KVM,
		nested: hostinfo.Nested,
		systemd: func() bool {
			_, err := os.Stat("/run/systemd/system")
			return err == nil
		},
		systemctl: func(args ...string) (string, error) { return runOutput("systemctl", args...) },
		get:       httpGet,
		register:  register,
		hostname:  os.Hostname,
		out:       os.Stdout,
	}
}

// planner builds a plan, step by step.
type planner struct {
	in   *installer
	plan installPlan
	// dirs are the directories the plan already makes or found there.
	dirs map[string]bool
}

func (p *planner) step(title string) {
	p.plan.steps = append(p.plan.steps, installStep{title: title})
}

func (p *planner) add(verb, what string, do func() error) {
	last := &p.plan.steps[len(p.plan.steps)-1]
	last.actions = append(last.actions, action{verb: verb, what: what, do: do})
}

// mkdir makes dir and each directory above it that isn't there yet, once in the plan, outermost first.
func (p *planner) mkdir(dir string) {
	var missing []string
	for d := filepath.Clean(dir); !p.dirs[d]; d = filepath.Dir(d) {
		p.dirs[d] = true
		if _, err := os.Stat(d); err == nil {
			break
		}
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	for i := len(missing) - 1; i >= 0; i-- {
		d := missing[i]
		p.add("mkdir", d, func() error { return os.MkdirAll(d, 0o755) })
	}
}

// planInstall checks the options and reads the machine, and says everything install would do, without changing a
// thing: no file is written, nothing is downloaded but the images manifest and Firecracker's digest, and the token
// isn't used.
func (in *installer) planInstall(o installOptions) (*installPlan, error) {
	if in.euid() != 0 {
		if o.dryRun {
			return nil, errors.New("install --dry-run needs root too, to see this machine as install would (it changes nothing): run it with sudo")
		}
		return nil, errors.New("install needs root: run it with sudo (sudo kantel-host install …)")
	}
	if o.controlPlane == "" {
		return nil, errors.New("--url is required: Kantel's URL, such as https://kantel.example.com")
	}
	controlPlane := strings.TrimRight(o.controlPlane, "/")
	loaded, _ := agent.LoadConfig(o.configPath)
	cfg := &loaded
	p := &planner{in: in, dirs: map[string]bool{}}

	token, resumed := o.token, ""
	registered := cfg.Credential != "" && cfg.ControlPlane == controlPlane
	switch {
	case registered && token == "":
		resumed = fmt.Sprintf("already registered with %s as %s: updating the install, keeping the registration", cfg.ControlPlane, cfg.HostID)
	case registered && cfg.TokenSHA256 != "" && cfg.TokenSHA256 == tokenSHA256(token):
		// The same join command again, after an install that registered and then stopped: carry on from there.
		resumed = fmt.Sprintf("already registered with %s as %s with this token: carrying on with the install, without using the token again", cfg.ControlPlane, cfg.HostID)
		token = ""
	case token == "":
		return nil, errors.New("--token is required: make one on Kantel's Hosts page (a kth_ token)")
	}

	cfg.ControlPlane = controlPlane
	// The installer's own files go back to where it puts them, under the new root; an operator's own sandbox image or
	// guest agent (a custom image, see docs/sandboxes/custom-images) is kept, and the images step leaves it alone.
	// Which is which is decided here alone (keptFiles).
	image, agentBin, keep, err := keptFiles(*cfg, o.root)
	if err != nil {
		return nil, err
	}
	cfg.Root = o.root
	if o.name != "" {
		cfg.Name = o.name
	}
	if len(o.labels) > 0 {
		cfg.Labels = o.labels
	}
	if o.tiers != "" {
		cfg.Tiers = strings.Split(o.tiers, ",")
	}
	if o.isolateRuntime != "" {
		cfg.IsolateRuntime = o.isolateRuntime
	}
	if o.proxyDataPath {
		cfg.ProxyDataPath = true
	}
	if o.injectGuestAgent {
		cfg.InjectGuestAgent = true
	}
	cfg.Kernel, cfg.SandboxImage, cfg.IsolateImage, cfg.Firecracker, cfg.Workerd, cfg.IsolateBundle, cfg.GuestAgent = "", image, "", "", "", "", agentBin
	cfg.Defaults()

	p.step("Check this machine")
	if resumed != "" {
		p.add("note", resumed, nil)
	}
	kvm, kvmDetail := in.kvm()
	_, nestedDetail := in.nested()
	p.add("check", "kvm: "+kvmDetail, nil)
	p.add("check", "nested virtualisation: "+nestedDetail, nil)
	if !kvm && cfg.IsolateRuntime != "native" {
		return nil, errors.New("no usable /dev/kvm, so no microVMs and no isolate VMs: fix that (see `kantel-host doctor`), or install with --isolate-runtime native --tiers isolate to run isolates only, with workerd on this machine itself (trusted code only)")
	}

	p.step("Install kantel-host " + version)
	self, err := in.executable()
	if err != nil {
		return nil, err
	}
	if self == in.binPath {
		p.add("keep", in.binPath+" (this binary, already in place)", nil)
	} else {
		p.mkdir(filepath.Dir(in.binPath))
		p.add("copy", fmt.Sprintf("%s to %s (mode 0755)", self, in.binPath), func() error { return copyFile(self, in.binPath, 0o755) })
	}

	p.step("Fetch Firecracker and the sandbox images")
	source := o.images
	if source == "" {
		source = cfg.ControlPlane + "/v1/hosts/images"
	}
	if err := p.images(*cfg, source, kvm, keep); err != nil {
		return nil, err
	}

	if token != "" {
		name := cfg.Name
		if name == "" {
			name, _ = in.hostname()
		}
		p.step("Register with " + cfg.ControlPlane)
		p.add("post", fmt.Sprintf("%s/v1/hosts/register as %q%s, which uses the token up", cfg.ControlPlane, name, labelsText(cfg.Labels)), func() error {
			hostID, credential, err := in.register(*cfg, token)
			if err != nil {
				return err
			}
			cfg.HostID, cfg.Credential, cfg.TokenSHA256 = hostID, credential, tokenSHA256(token)
			fmt.Fprintln(in.out, "  registered as", hostID)
			return nil
		})
		p.plan.usesToken = true
	}
	p.step("Save the settings")
	p.mkdir(filepath.Dir(o.configPath))
	p.add("write", o.configPath+" (mode 0600: the control plane, the host's ID and credential, and its settings)", func() error { return cfg.Save(o.configPath) })

	p.step("Start the service")
	if !in.systemd() {
		// A container, WSL without systemd, or another init: the install is done, the supervising is theirs.
		p.add("note", "no systemd on this machine: run `kantel-host run` under your own supervisor (as root, restarted when it exits)", nil)
	} else {
		p.mkdir(filepath.Dir(in.unitPath))
		p.add("write", in.unitPath+" (the kantel-host systemd unit, mode 0644)", func() error { return os.WriteFile(in.unitPath, []byte(unit), 0o644) })
		p.systemctl("daemon-reload")
		if o.noStart {
			p.add("note", "not started (--no-start): start it with sudo systemctl enable --now kantel-host", nil)
		} else {
			p.systemctl("enable", "--now", "kantel-host")
			p.systemctl("restart", "kantel-host")
			p.plan.done = "Done. This host is on Kantel's Hosts page; `kantel-host status` and `journalctl -u kantel-host` show it here."
		}
	}

	p.plan.after = append(p.plan.after,
		"Each file it gets is written as <name>.part and renamed when its digest matches; an image's digest is kept beside it in <name>.sha256-source, so running install again keeps what's already there.",
		"Install itself adds no users or groups (kantel-host runs as root), and changes no sysctl settings and no firewall rules.",
		"Once it runs, the service keeps sandboxes, snapshots and templates under "+cfg.Root+", and memory snapshots in RAM at "+cfg.SpoolDir+" first.")
	if kvm {
		p.plan.after = append(p.plan.after,
			"For microVMs it adds iptables chains KANTEL-INPUT and KANTEL-FORWARD, jumped to from INPUT, FORWARD and (on a host with Docker) DOCKER-USER, ip6tables rules that drop its devices' traffic, and a TAP device (kt0, kt1, …) in "+cfg.Subnet+" for each microVM, with IPv6 off on it. Its egress proxy takes port "+fmt.Sprint(cfg.ProxyPort)+" on those devices only.")
	}
	return &p.plan, nil
}

func (p *planner) systemctl(args ...string) {
	p.add("run", "systemctl "+strings.Join(args, " "), func() error {
		if out, err := p.in.systemctl(args...); err != nil {
			return fmt.Errorf("systemctl %s: %v: %s", strings.Join(args, " "), err, out)
		}
		return nil
	})
}

// images plans the images step: Firecracker, the kernel and images for this architecture from source, less any of the
// operator's own files (keep).
func (p *planner) images(cfg agent.Config, source string, kvm bool, keep kept) error {
	arch := archName()
	// An operator's own sandbox image or guest agent: theirs to keep, not a release's to replace.
	mine := func(own bool, dst, setting string) (bool, error) {
		if !own {
			return false, nil
		}
		if _, err := os.Stat(dst); err != nil {
			return true, fmt.Errorf("the configured %s: %w", setting, err)
		}
		p.add("keep", dst+" (your own "+setting+")", nil)
		return true, nil
	}
	in, err := open(source, "manifest.json")
	if err != nil {
		return fmt.Errorf("images manifest at %s: %w", source, err)
	}
	var manifest ImageManifest
	err = json.NewDecoder(in).Decode(&manifest)
	in.Close()
	if err != nil {
		return fmt.Errorf("images manifest: %w", err)
	}
	p.add("check", fmt.Sprintf("images %s from %s", orNone(manifest.Version), location(source, "manifest.json")), nil)
	if kvm {
		if err := checkArch(manifest, arch); err != nil {
			return fmt.Errorf("images at %s: %w", source, err)
		}
	}
	get := func(name, dst string, mode os.FileMode, required bool) error {
		f, ok := manifest.Files[name]
		if !ok {
			if required {
				return fmt.Errorf("the images manifest has no %s", name)
			}
			return nil
		}
		p.file(source, f, dst, mode)
		return nil
	}
	if kvm {
		if err := p.firecracker(cfg.Firecracker); err != nil {
			return err
		}
		if err := get("vmlinux-"+arch, cfg.Kernel, 0o644, true); err != nil {
			return err
		}
		if own, err := mine(keep.image, cfg.SandboxImage, "sandboxImage"); err != nil {
			return err
		} else if !own {
			if err := get("sandbox-"+arch+".ext4", cfg.SandboxImage, 0o644, true); err != nil {
				return err
			}
		}
		if err := get("isolate-"+arch+".ext4", cfg.IsolateImage, 0o644, false); err != nil {
			return err
		}
		// The static agent the initramfs is made from (injectGuestAgent); required only when that's on.
		if own, err := mine(keep.agent, cfg.GuestAgent, "guestAgent"); err != nil {
			return err
		} else if !own {
			if err := get("kantel-guest-"+arch, cfg.GuestAgent, 0o755, cfg.InjectGuestAgent); err != nil {
				return err
			}
		}
	}
	if cfg.IsolateRuntime == "native" {
		if err := get("workerd-"+arch, cfg.Workerd, 0o755, true); err != nil {
			return err
		}
		if f, ok := manifest.Files["isolate-bundle.tar.gz"]; ok {
			// Fetched (and checked) beside the directory, then unpacked into it.
			archive := cfg.IsolateBundle + ".tar.gz"
			f.Gzip = false
			p.file(source, f, archive, 0o644)
			p.mkdir(cfg.IsolateBundle)
			p.add("unpack", archive+" into "+cfg.IsolateBundle, func() error {
				r, err := os.Open(archive)
				if err != nil {
					return err
				}
				defer r.Close()
				return untar(r, cfg.IsolateBundle)
			})
		}
	}
	return nil
}

// file plans one file from the images: kept when it's there with the manifest's digest, else fetched and checked.
func (p *planner) file(base string, f ImageFile, dst string, mode os.FileMode) {
	if f.SHA256 != "" && upToDate(dst, f.SHA256) {
		p.add("keep", fmt.Sprintf("%s (sha256 %s, already there)", dst, f.SHA256), nil)
		return
	}
	p.mkdir(filepath.Dir(dst))
	digest := "sha256 " + f.SHA256
	if f.SHA256 == "" {
		digest = "no sha256 in the manifest, so not checked"
	}
	gz := ""
	if f.Gzip {
		gz = ", unpacked as it downloads"
	}
	p.add("get", fmt.Sprintf("%s to %s (%s%s, mode %04o)", location(base, f.Path), dst, digest, gz, mode), func() error { return fetch(base, f, dst, mode) })
}

// firecracker plans Firecracker from its GitHub release, checked against the release's digest, unless the one there
// is this version already.
func (p *planner) firecracker(dst string) error {
	if out, err := exec.Command(dst, "--version").Output(); err == nil && strings.Contains(string(out), strings.TrimPrefix(FirecrackerVersion, "v")) {
		p.add("keep", fmt.Sprintf("%s (Firecracker %s, already there)", dst, FirecrackerVersion), nil)
		return nil
	}
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}
	base := "https://github.com/firecracker-microvm/firecracker/releases/download/" + FirecrackerVersion + "/"
	name := fmt.Sprintf("firecracker-%s-%s.tgz", FirecrackerVersion, arch)
	sums, err := p.in.get(base + name + ".sha256.txt")
	if err != nil {
		return err
	}
	sumText, err := io.ReadAll(sums)
	sums.Close()
	if err != nil {
		return err
	}
	fields := strings.Fields(string(sumText))
	if len(fields) == 0 || len(fields[0]) != 64 {
		return fmt.Errorf("%s.sha256.txt has no SHA-256", name)
	}
	want := strings.ToLower(fields[0])
	member := fmt.Sprintf("release-%s-%s/firecracker-%s-%s", FirecrackerVersion, arch, FirecrackerVersion, arch)
	p.mkdir(filepath.Dir(dst))
	p.add("get", fmt.Sprintf("%s (sha256 %s, from %s.sha256.txt), its %s to %s (mode 0755)", base+name, want, name, filepath.Base(member), dst), func() error {
		return installFirecracker(p.in.get, base+name, want, member, dst)
	})
	return nil
}

// installFirecracker downloads Firecracker's release archive, checks it against want and puts its binary at dst.
func installFirecracker(get func(string) (io.ReadCloser, error), u, want, member, dst string) error {
	body, err := get(u)
	if err != nil {
		return err
	}
	raw, err := io.ReadAll(body)
	body.Close()
	if err != nil {
		return err
	}
	got := sha256.Sum256(raw)
	if hex.EncodeToString(got[:]) != want {
		return fmt.Errorf("%s: digest doesn't match the release's", u)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s has no %s", u, member)
		}
		if err != nil {
			return err
		}
		if h.Name != member {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		out, err := os.OpenFile(dst+".part", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
		fmt.Printf("  firecracker %s\n", FirecrackerVersion)
		return os.Rename(dst+".part", dst)
	}
}

// upToDate: dst is there, and fetch recorded want as its digest when it downloaded it.
func upToDate(dst, want string) bool {
	sum, err := recordedSHA256(dst)
	if err != nil || sum != want {
		return false
	}
	_, err = os.Stat(dst)
	return err == nil
}

// location is where open reads rel from base: a URL or a path.
func location(base, rel string) string {
	if strings.HasPrefix(rel, "https://") || strings.HasPrefix(rel, "http://") {
		return rel
	}
	if strings.HasPrefix(base, "https://") || strings.HasPrefix(base, "http://") {
		if u, err := url.JoinPath(base, rel); err == nil {
			return u
		}
		return strings.TrimRight(base, "/") + "/" + rel
	}
	return filepath.Join(strings.TrimPrefix(base, "file://"), rel)
}

func labelsText(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, len(keys))
	for i, k := range keys {
		pairs[i] = k + "=" + labels[k]
	}
	return " with labels " + strings.Join(pairs, ", ")
}

func tokenSHA256(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// printPlan is `install --dry-run`'s output.
func printPlan(w io.Writer, p *installPlan) {
	for _, s := range p.steps {
		fmt.Fprintln(w, "==> "+s.title)
		for _, a := range s.actions {
			fmt.Fprintln(w, a)
		}
	}
	fmt.Fprintln(w)
	for _, line := range p.after {
		fmt.Fprintln(w, line)
	}
	fmt.Fprintln(w)
	if p.usesToken {
		fmt.Fprintln(w, "Dry run: nothing has been changed, and the token hasn't been used. Run the same command without --dry-run to install.")
	} else {
		fmt.Fprintln(w, "Dry run: nothing has been changed. Run the same command without --dry-run to install.")
	}
}

// doPlan is the install itself: each step's actions, in order, each shown as it's done.
func (in *installer) doPlan(p *installPlan) error {
	for _, s := range p.steps {
		fmt.Fprintln(in.out, "==> "+s.title)
		for _, a := range s.actions {
			fmt.Fprintln(in.out, a)
			if a.do == nil {
				continue
			}
			if err := a.do(); err != nil {
				return err
			}
		}
	}
	if p.done != "" {
		fmt.Fprintln(in.out, "\n"+p.done)
	}
	return nil
}
