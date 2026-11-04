package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const (
	binPath  = "/usr/local/bin/kantel-host"
	unitPath = "/etc/systemd/system/kantel-host.service"
	// FirecrackerVersion is the Firecracker release the host runs (its snapshot format is tied to the version).
	FirecrackerVersion = "v1.17.0"
)

// The service: VMs are in their own process groups and KillMode=process leaves them running across a restart or an
// update; the next run adopts them.
const unit = `[Unit]
Description=Kantel host: runs Kantel sandboxes (microVMs and isolates)
Documentation=https://kantel.dev/docs/hosts
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/kantel-host run
Restart=always
RestartSec=2
KillMode=process
LimitNOFILE=1048576
TasksMax=infinity

[Install]
WantedBy=multi-user.target
`

type labelFlag map[string]string

func (l labelFlag) String() string { return fmt.Sprint(map[string]string(l)) }
func (l labelFlag) Set(v string) error {
	for _, kv := range strings.Split(v, ",") {
		k, val, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return fmt.Errorf("label %q: want key=value", kv)
		}
		l[k] = val
	}
	return nil
}

func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	controlPlane := fs.String("url", os.Getenv("KANTEL_URL"), "Kantel's URL")
	token := fs.String("token", os.Getenv("KANTEL_HOST_TOKEN"), "a kth_ registration token from Kantel's Hosts page")
	name := fs.String("name", "", "the host's name in Kantel (default: its hostname)")
	labels := labelFlag{}
	fs.Var(labels, "label", "a label, key=value (repeatable, or comma-separated)")
	images := fs.String("images", "", "where to get the kernel and images: a URL or a directory (default: Kantel's)")
	root := fs.String("root", agent.DefaultRoot, "where sandboxes live")
	configPath := fs.String("config", defaultConfigPath, "config file")
	tiers := fs.String("tiers", "", "tiers to run: microvm,isolate (default: what the machine can)")
	isolateRuntime := fs.String("isolate-runtime", "", `"native" runs isolates with workerd on the host itself (no KVM; trusted code only)`)
	proxyDataPath := fs.Bool("proxy-data-path", false, "turn on the egress data path (experimental): sandboxes' traffic goes through the control plane's proxy settings")
	injectGuestAgent := fs.Bool("inject-guest-agent", false, "boot microVMs through Kantel's initramfs, which puts the guest agent into any Linux image (experimental)")
	noStart := fs.Bool("no-start", false, "install and register, but don't start the service")
	_ = fs.Parse(args)
	if os.Geteuid() != 0 {
		return errors.New("install needs root: run it with sudo (sudo kantel-host install …)")
	}
	if *controlPlane == "" {
		return errors.New("--url is required: Kantel's URL, such as https://kantel.example.com")
	}
	*controlPlane = strings.TrimRight(*controlPlane, "/")
	cfg, _ := agent.LoadConfig(*configPath)
	if cfg.Credential != "" && cfg.ControlPlane == *controlPlane && *token == "" {
		fmt.Println("Already registered with", cfg.ControlPlane, "as", cfg.HostID, "; updating the install.")
	} else if *token == "" {
		return errors.New("--token is required: make one on Kantel's Hosts page (a kth_ token)")
	}
	cfg.ControlPlane = *controlPlane
	// The installer's own files go back to where it puts them, under the new root; an operator's own sandbox image or
	// guest agent (a custom image, see docs/sandboxes/custom-images) is kept, and fetchImages leaves it alone. Which
	// is which is decided here alone (keptFiles).
	image, agentBin, keep, err := keptFiles(cfg, *root)
	if err != nil {
		return err
	}
	cfg.Root = *root
	if *name != "" {
		cfg.Name = *name
	}
	if len(labels) > 0 {
		cfg.Labels = labels
	}
	if *tiers != "" {
		cfg.Tiers = strings.Split(*tiers, ",")
	}
	if *isolateRuntime != "" {
		cfg.IsolateRuntime = *isolateRuntime
	}
	if *proxyDataPath {
		cfg.ProxyDataPath = true
	}
	if *injectGuestAgent {
		cfg.InjectGuestAgent = true
	}
	cfg.Kernel, cfg.SandboxImage, cfg.IsolateImage, cfg.Firecracker, cfg.Workerd, cfg.IsolateBundle, cfg.GuestAgent = "", image, "", "", "", "", agentBin
	cfg.Defaults()

	step("Checking this machine")
	kvm, kvmDetail := hostinfo.KVM()
	nested, nestedDetail := hostinfo.Nested()
	fmt.Printf("  kvm: %v (%s)\n  nested virtualisation: %v (%s)\n", kvm, kvmDetail, nested, nestedDetail)
	if !kvm && cfg.IsolateRuntime != "native" {
		return errors.New("no usable /dev/kvm, so no microVMs and no isolate VMs: fix that (see `kantel-host doctor`), or install with --isolate-runtime native --tiers isolate to run isolates only, with workerd on this machine itself (trusted code only)")
	}

	step("Installing kantel-host " + version)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return err
	}
	if self != binPath {
		if err := copyFile(self, binPath, 0o755); err != nil {
			return err
		}
	}

	step("Fetching Firecracker and the sandbox images")
	source := *images
	if source == "" {
		source = cfg.ControlPlane + "/v1/hosts/images"
	}
	if err := fetchImages(cfg, source, kvm, keep); err != nil {
		return err
	}

	if *token != "" {
		step("Registering with " + cfg.ControlPlane)
		hostID, credential, err := register(cfg, *token)
		if err != nil {
			return err
		}
		cfg.HostID, cfg.Credential = hostID, credential
		fmt.Println("  registered as", hostID)
	}
	if err := cfg.Save(*configPath); err != nil {
		return err
	}

	step("Starting the service")
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		// A container, WSL without systemd, or another init: the install is done, the supervising is theirs.
		fmt.Println("  no systemd on this machine: run `kantel-host run` under your own supervisor (as root, restarted when it exits)")
		return nil
	}
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return err
	}
	if out, err := runOutput("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %v: %s", err, out)
	}
	if *noStart {
		fmt.Println("  installed; start it with: sudo systemctl enable --now kantel-host")
		return nil
	}
	if out, err := runOutput("systemctl", "enable", "--now", "kantel-host"); err != nil {
		return fmt.Errorf("systemctl enable --now kantel-host: %v: %s", err, out)
	}
	if out, err := runOutput("systemctl", "restart", "kantel-host"); err != nil {
		return fmt.Errorf("systemctl restart kantel-host: %v: %s", err, out)
	}
	fmt.Println("\nDone. This host is on Kantel's Hosts page; `kantel-host status` and `journalctl -u kantel-host` show it here.")
	return nil
}

func step(s string) { fmt.Println("==> " + s) }

func runOutput(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// ImageManifest is <images>/manifest.json: the files a host needs, by name, for this architecture (package images,
// which the daemon's image updates share).
type ImageManifest = images.Manifest

type ImageFile = images.File

func archName() string { return images.Arch() }

// open reads a file from a URL or a directory.
func open(base, rel string) (io.ReadCloser, error) {
	return images.Open(context.Background(), base, rel)
}

// fetch writes one file, checking its digest; a file already there with the right digest is kept.
func fetch(base string, f ImageFile, dst string, mode os.FileMode) error {
	return images.Fetch(context.Background(), base, f, dst, mode)
}

// fileSHA256 hashes a file as it is on disk.
func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// custom is a configured image path when it isn't the installer's own (images/<name> under root), else "".
func custom(root, configured, name string) string {
	if root == "" {
		root = agent.DefaultRoot
	}
	if configured == "" || filepath.Clean(configured) == filepath.Join(root, "images", name) {
		return ""
	}
	return configured
}

// kept is which of the operator's own files install keeps (custom): fetchImages fetches none of them.
type kept struct{ image, agent bool }

// keptFiles is the operator's own sandbox image and guest agent in loaded (settings read with their root), which an
// install to newRoot keeps. Who owns a file is where it is: the installer owns <root>/images/sandbox.ext4 and
// <root>/images/kantel-guest, and nothing else. So an operator's file can't be kept at one of those under newRoot,
// where the next run would take it for the installer's: that's an error, not a guess.
func keptFiles(loaded agent.Config, newRoot string) (image, agentBin string, keep kept, err error) {
	image, agentBin = custom(loaded.Root, loaded.SandboxImage, "sandbox.ext4"), custom(loaded.Root, loaded.GuestAgent, "kantel-guest")
	for _, own := range []struct{ path, name, setting string }{{image, "sandbox.ext4", "sandboxImage"}, {agentBin, "kantel-guest", "guestAgent"}} {
		if own.path != "" && custom(newRoot, own.path, own.name) == "" {
			return "", "", kept{}, fmt.Errorf("%s %s is the installer's own path for its %s under --root %s: move your file elsewhere (any other name will do) and set %s to it", own.setting, own.path, own.name, newRoot, own.setting)
		}
	}
	return image, agentBin, kept{image: image != "", agent: agentBin != ""}, nil
}

func fetchImages(cfg agent.Config, source string, kvm bool, keep kept) error {
	arch := archName()
	// An operator's own sandbox image or guest agent: theirs to keep, not a release's to replace.
	mine := func(own bool, dst, setting string) (bool, error) {
		if !own {
			return false, nil
		}
		if _, err := os.Stat(dst); err != nil {
			return true, fmt.Errorf("the configured %s: %w", setting, err)
		}
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
		return fetch(source, f, dst, mode)
	}
	if kvm {
		if err := fetchFirecracker(cfg.Firecracker); err != nil {
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
			r, err := open(source, f.Path)
			if err != nil {
				return err
			}
			defer r.Close()
			if err := untar(r, cfg.IsolateBundle); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkArch says, before anything is downloaded, when the images are for other architectures only: one release holds
// each architecture's kernel and sandbox image side by side (vmlinux-<arch>, sandbox-<arch>.ext4), and a host takes
// its own.
func checkArch(manifest ImageManifest, arch string) error {
	var missing []string
	for _, name := range []string{"vmlinux-" + arch, "sandbox-" + arch + ".ext4"} {
		if _, ok := manifest.Files[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	var others []string
	for _, other := range []string{"amd64", "arm64"} {
		if _, ok := manifest.Files["sandbox-"+other+".ext4"]; ok && other != arch {
			others = append(others, other)
		}
	}
	if len(others) > 0 {
		return fmt.Errorf("no %s images (%s), only %s: use a release with %s images, or --images with your own build (ARCHES=%s apps/host/guest/release.sh)",
			arch, strings.Join(missing, ", "), strings.Join(others, ", "), arch, arch)
	}
	return fmt.Errorf("the images manifest has no %s", strings.Join(missing, " or "))
}

// fetchFirecracker gets Firecracker's release from GitHub and checks it against the release's SHA256SUMS.
func fetchFirecracker(dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	return images.FetchFirecracker(ctx, dst, FirecrackerVersion)
}

func untar(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.Clean("/"+h.Name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(h.Mode)&0o755)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		}
	}
}

// register trades a kth_ token for the host's ID and credential.
func register(cfg agent.Config, token string) (string, string, error) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	facts := proto.Facts{Version: version, Protocol: proto.ProtocolVersion, OS: runtime.GOOS, Arch: hostinfo.Arch(), Kernel: hostinfo.Kernel(), CPUs: runtime.NumCPU(), MemoryMiB: hostinfo.MemoryMiB()}
	if h, err := agent.New(cfg, version, log); err == nil {
		facts = h.Facts()
		h.Close()
	}
	name := cfg.Name
	if name == "" {
		name, _ = os.Hostname()
	}
	req := map[string]any{"token": token, "name": name, "facts": facts}
	if len(cfg.Labels) > 0 {
		req["labels"] = cfg.Labels // a nil map would be null, which Kantel refuses
	}
	body, _ := json.Marshal(req)
	res, err := http.Post(cfg.ControlPlane+"/v1/hosts/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 && res.StatusCode != 201 {
		var e struct {
			Error   any    `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := e.Message
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return "", "", fmt.Errorf("registering: %s: %s", res.Status, msg)
	}
	var out struct {
		HostID     string `json:"hostId"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Credential == "" {
		return "", "", fmt.Errorf("registering: unexpected answer %s", strings.TrimSpace(string(raw)))
	}
	return out.HostID, out.Credential, nil
}

// selfUpdater replaces the binary and exits; systemd starts the new one, which adopts the running VMs.
func selfUpdater(log *slog.Logger) agent.Updater {
	return func(ctx context.Context, p proto.UpdateParams) error {
		u := strings.NewReplacer("{version}", p.Version, "{os}", runtime.GOOS, "{arch}", archName()).Replace(p.URL)
		want := p.SHA256
		// A binary from one of Kantel's GitHub Releases is checked against the release's SHA256SUMS.
		if i := strings.LastIndex(u, "/"); want == "" && strings.HasPrefix(u, releaseRepo+"/") && i > 0 {
			sum, err := releaseSum(ctx, u[:i], u[i+1:])
			if err != nil {
				return err
			}
			want = sum
		}
		if err := downloadBinary(ctx, u, want); err != nil {
			return err
		}
		log.Info("updated; restarting", "version", p.Version)
		go func() {
			time.Sleep(500 * time.Millisecond)
			os.Exit(0)
		}()
		return nil
	}
}

// releaseRepo is where Kantel's releases are: each carries kantel-host-linux-{amd64,arm64} and SHA256SUMS.
const releaseRepo = "https://github.com/lleverage-ai/kantel/releases"

// releaseBase is the download URL of a release's files: "latest" or a version such as 0.2.0.
func releaseBase(version string) string {
	if version == "" || version == "latest" {
		return releaseRepo + "/latest/download"
	}
	return releaseRepo + "/download/v" + strings.TrimPrefix(version, "v")
}

// releaseSum reads asset's SHA-256 from the release's SHA256SUMS.
func releaseSum(ctx context.Context, base, asset string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/SHA256SUMS", nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("GET %s/SHA256SUMS: %s", base, res.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if sum := parseSums(string(raw))[asset]; sum != "" {
		return sum, nil
	}
	return "", fmt.Errorf("%s/SHA256SUMS has no line for %s", base, asset)
}

// parseSums reads sha256sum's output: "<hex>  <name>" a line ("*<name>" in binary mode).
func parseSums(text string) map[string]string {
	sums := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && len(fields[0]) == 64 {
			sums[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
		}
	}
	return sums
}

func downloadBinary(ctx context.Context, u, want string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("GET %s: %s", u, res.Status)
	}
	var reader io.Reader = res.Body
	if strings.HasSuffix(u, ".gz") {
		gz, err := gzip.NewReader(res.Body)
		if err != nil {
			return err
		}
		reader = gz
	}
	raw, err := io.ReadAll(io.LimitReader(reader, 256<<20))
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	if want != "" && hex.EncodeToString(sum[:]) != want {
		return errors.New("the update's digest doesn't match")
	}
	tmp := binPath + ".new"
	if err := os.WriteFile(tmp, raw, 0o755); err != nil {
		return err
	}
	if out, err := exec.Command(tmp, "version").Output(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("the new binary doesn't run: %v", err)
	} else {
		fmt.Fprintf(os.Stderr, "new binary: %s", out)
	}
	return os.Rename(tmp, binPath)
}

func updateCmd(args []string) error {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	_ = fs.String("config", defaultConfigPath, "config file (unused: kept so older scripts still parse)")
	from := fs.String("url", "", "the binary's URL (default: Kantel's GitHub Release for --version, checked against its SHA256SUMS)")
	ver := fs.String("version", "latest", "the release, such as 0.2.0, or latest")
	_ = fs.Parse(args)
	if os.Geteuid() != 0 {
		return errors.New("update needs root")
	}
	ctx := context.Background()
	u, want := *from, ""
	if u == "" {
		base := releaseBase(*ver)
		asset := "kantel-host-linux-" + archName()
		sum, err := releaseSum(ctx, base, asset)
		if err != nil {
			return err
		}
		u, want = base+"/"+asset, sum
	}
	if err := downloadBinary(ctx, u, want); err != nil {
		return err
	}
	if out, err := runOutput("systemctl", "restart", "kantel-host"); err != nil {
		return fmt.Errorf("systemctl restart: %v: %s", err, out)
	}
	fmt.Println("updated and restarted")
	return nil
}

func uninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "config file")
	purge := fs.Bool("purge", false, "also delete sandboxes, snapshots and images")
	_ = fs.Parse(args)
	if os.Geteuid() != 0 {
		return errors.New("uninstall needs root")
	}
	cfg, _ := agent.LoadConfig(*configPath)
	_, _ = runOutput("systemctl", "disable", "--now", "kantel-host")
	// The VMs outlive the service (KillMode=process): stop them too.
	_, _ = runOutput("pkill", "-f", filepath.Join(cfg.Root, "bin", "firecracker"))
	_ = os.Remove(unitPath)
	_, _ = runOutput("systemctl", "daemon-reload")
	if *purge {
		if err := os.RemoveAll(cfg.Root); err != nil {
			return err
		}
		_ = os.Remove(*configPath)
		_ = os.Remove(binPath)
	}
	fmt.Println("uninstalled")
	return nil
}
