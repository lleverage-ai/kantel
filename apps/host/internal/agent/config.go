package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Config is /etc/kantel-host/config.json. `kantel-host join` writes it; everything but the control plane, the host's
// ID and its credential has a default.
type Config struct {
	// ControlPlane is Kantel's origin, such as https://kantel.example.com. Empty: run with no control plane (bench).
	ControlPlane string `json:"controlPlane"`
	HostID       string `json:"hostId,omitempty"`
	// Credential is the host's khc_ credential. Kept in this file, readable by root only.
	Credential string            `json:"credential,omitempty"`
	Name       string            `json:"name,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`

	// Root holds sandboxes, snapshots and templates (default /var/lib/kantel-host).
	Root string `json:"root,omitempty"`
	// Images: the guest kernel and root filesystems (default Root/images/...).
	Kernel        string `json:"kernel,omitempty"`
	SandboxImage  string `json:"sandboxImage,omitempty"`
	IsolateImage  string `json:"isolateImage,omitempty"`
	Firecracker   string `json:"firecracker,omitempty"`
	Workerd       string `json:"workerd,omitempty"`
	IsolateBundle string `json:"isolateBundle,omitempty"`

	// Tiers to run; default every tier the host can.
	Tiers []string `json:"tiers,omitempty"`
	// IsolateRuntime is "microvm" (default) or "native": workerd on the host itself, for a host without KVM, and
	// only for code you trust (workerd is not a hardened sandbox).
	IsolateRuntime string       `json:"isolateRuntime,omitempty"`
	Sizes          []proto.Size `json:"sizes,omitempty"`
	// ReserveMemoryMiB is kept back for the host itself (default 2048 or a tenth of memory, whichever is more).
	ReserveMemoryMiB int64 `json:"reserveMemoryMiB,omitempty"`
	// OvercommitMemory lets running sandboxes be given more memory than the host has, as a ratio (default 1.5:
	// restored sandboxes share their template's unchanged pages).
	OvercommitMemory float64 `json:"overcommitMemory,omitempty"`
	// Subnet sandboxes' addresses come from (default 10.231.0.0/16).
	Subnet string `json:"subnet,omitempty"`
	// DNS is no longer used: sandboxes have no route to a DNS server (the egress proxy resolves names). Kept so old
	// configs load.
	DNS []string `json:"dns,omitempty"`
	// Egress: the default for sandboxes that don't say ("open" unless set). Every mode goes out through the host's
	// egress proxy only; "open" is the proxy with no rules, "none" not even the proxy.
	Egress string `json:"egress,omitempty"`
	// EgressAllowCIDRs are private ranges the egress proxy may connect to anyway, such as a LAN package mirror
	// ("192.168.10.0/24"). Loopback, the sandbox subnet and the host's own addresses stay refused.
	EgressAllowCIDRs []string `json:"egressAllowCIDRs,omitempty"`
	// ProxyPort is the host's egress proxy, on each sandbox's gateway address (default 3129).
	ProxyPort int `json:"proxyPort,omitempty"`
	// ProxyDataPath is the switch for the egress data path: when false (the default), the control plane's egress
	// settings (upstream, token, allow/deny) are ignored and sandboxes get the host's default egress. Experimental.
	ProxyDataPath bool `json:"proxyDataPath,omitempty"`
	// InjectGuestAgent boots microVMs through Kantel's initramfs, which puts the guest agent (GuestAgent, a static
	// kantel-guest) into the image at boot, so SandboxImage can be any Linux root filesystem: Kantel's, debian, alpine,
	// busybox. Off (the default), the image must ship kantel-init and the agent itself, as Kantel's does. Experimental.
	InjectGuestAgent bool `json:"injectGuestAgent,omitempty"`
	// GuestAgent is the static kantel-guest the initramfs is made from (default Root/images/kantel-guest).
	GuestAgent string `json:"guestAgent,omitempty"`
	// SpoolDir is RAM (tmpfs) memory snapshots go to first, so stop and fork don't wait for the disk (default
	// /dev/shm/kantel-host); SpoolMaxMiB caps it (default an eighth of memory, at most 16 GiB; -1 turns it off).
	SpoolDir    string `json:"spoolDir,omitempty"`
	SpoolMaxMiB int64  `json:"spoolMaxMiB,omitempty"`
	// AutoUpdate lets the control plane move the host to the version it wants (default true).
	AutoUpdate *bool `json:"autoUpdate,omitempty"`
}

const DefaultRoot = "/var/lib/kantel-host"

func LoadConfig(path string) (Config, error) {
	var cfg Config
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return cfg, err
	}
	if err == nil {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("%s: %w", path, err)
		}
	}
	cfg.Defaults()
	return cfg, nil
}

// Defaults fills what isn't set.
func (c *Config) Defaults() {
	if c.Root == "" {
		c.Root = DefaultRoot
	}
	images := filepath.Join(c.Root, "images")
	set := func(p *string, v string) {
		if *p == "" {
			*p = v
		}
	}
	set(&c.Kernel, filepath.Join(images, "vmlinux"))
	set(&c.SandboxImage, filepath.Join(images, "sandbox.ext4"))
	set(&c.IsolateImage, filepath.Join(images, "isolate.ext4"))
	set(&c.GuestAgent, filepath.Join(images, "kantel-guest"))
	set(&c.Firecracker, filepath.Join(c.Root, "bin", "firecracker"))
	set(&c.Workerd, filepath.Join(c.Root, "bin", "workerd"))
	set(&c.IsolateBundle, filepath.Join(c.Root, "isolate"))
	set(&c.IsolateRuntime, "microvm")
	set(&c.Subnet, "10.231.0.0/16")
	set(&c.Egress, "open")
	if len(c.DNS) == 0 {
		c.DNS = []string{"1.1.1.1", "8.8.8.8"}
	}
	if c.ProxyPort == 0 {
		c.ProxyPort = 3129
	}
	set(&c.SpoolDir, "/dev/shm/kantel-host")
	if c.OvercommitMemory == 0 {
		c.OvercommitMemory = 1.5
	}
}

func (c *Config) autoUpdate() bool { return c.AutoUpdate == nil || *c.AutoUpdate }

// Save writes the config, readable by root only (it holds the host's credential).
func (c Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
