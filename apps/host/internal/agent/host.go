// Package agent is kantel-host's daemon: the tiers behind one sandbox interface, the egress proxy, and the
// connection to the control plane.
package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Tier is what each sandbox tier offers the host.
type Tier interface {
	Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error)
	Stop(ctx context.Context, p proto.StopParams) (proto.SnapshotInfo, error)
	Resume(ctx context.Context, p proto.ResumeParams, coldBoot bool) (proto.SandboxInfo, error)
	Fork(ctx context.Context, p proto.ForkParams) (proto.SandboxInfo, error)
	Delete(ctx context.Context, id string) error
	Get(id string) (proto.SandboxInfo, error)
	List() []proto.SandboxInfo
	Exec(ctx context.Context, p proto.ExecParams, onOutput func(stdout, stderr string)) (proto.ExecResult, error)
	// ReadFile answers the file (or with p.Length, at most that many bytes from p.Offset), its mode and its whole size.
	ReadFile(ctx context.Context, p proto.FileParams) ([]byte, uint32, int64, error)
	WriteFile(ctx context.Context, p proto.FileParams, data []byte) error
	DeleteFile(ctx context.Context, p proto.FileParams) error
	ListFiles(ctx context.Context, p proto.FileParams) ([]proto.FileEntry, error)
	DialPort(ctx context.Context, id string, port int) (net.Conn, error)
	Snapshots(sandboxID string) []proto.SnapshotInfo
	SaveSnapshot(ctx context.Context, p proto.SnapshotParams) (proto.SnapshotInfo, error)
	DeleteSnapshot(id string) error
	HasSnapshot(id string) bool
	SnapshotFiles(id, path string) ([]proto.FileEntry, error)
	SnapshotRead(id, path string) ([]byte, error)
	ResetTemplates()
	SetEgress(id string, e *proto.Egress) error
	Usage() (memoryMiB int64, running int, stopped int)
	Close()
}

// Host is the daemon's core: the tiers and the egress proxy, without the control plane connection.
type Host struct {
	cfg     Config
	version string
	log     *slog.Logger
	tiers   map[string]Tier
	order   []string
	net     *network.Manager
	proxy   *egress.Proxy
	facts   proto.Facts
	// secrets holds sandboxes' protected values, in memory only, fetched from Kantel (secrets.fetch) on first use.
	secrets *protect.Store
	// cas are the sandboxes' interception CAs (keys in Root/egress-ca/<sandbox>, never in a guest).
	cas *egress.CAStore
	// egressLog batches the proxy's records to Kantel.
	egressLog *egressBatcher
	// lifecycle is one CA-changing lifecycle call at a time per sandbox.
	lifecycle sandboxLocks
	// gate binds a gateway call's E2E check to the sandbox it reaches (e2e.go).
	gate e2eGate
	// plain are the gateway's plaintext calls and streams in flight, ended if their space turns E2E on (e2e.go).
	plain        plainCalls
	plainRecheck time.Duration
	// e2eRevalidate is how often an open E2E session looks at the chain again (default every 3s).
	e2eRevalidate time.Duration
	// e2e is the host's E2E keys and the chains of the spaces it joined (Root/e2e; e2e.go).
	e2e *e2e.Store
	// commands is the history of commands devices ran in E2E sessions (history.go).
	commands *commandLog
	// floors are the latest egress revisions the host has taken (by sandbox ID), a null egress's too, so a stale update
	// or boot arriving late is ignored; kept on disk too (floorDir), across restarts.
	floorMu sync.Mutex
	floors  map[string]int64
	// durable is what of floors is on disk, so a retry of the same revision writes a floor an earlier write failed to.
	durable map[string]int64
	// patching is versioned host images, with Config.ImagePatching (images.go).
	patching imagePatching

	mu sync.Mutex
	// bySlot is each running microVM's egress, by its network slot.
	bySlot map[int]egress.Rules
	// events go to the control plane while connected.
	events func(proto.Event)
	// link makes calls to the control plane while connected.
	link *caller
	// usageAcks says the link's welcome had UsageAcks: usage ticks wait for Kantel's usage.ack (usage.go).
	usageAcks bool
	// usage samples the host and its sandboxes while RunUsage runs (usage.go).
	usage *usageSampler
}

// New starts the tiers the host can run.
func New(cfg Config, version string, log *slog.Logger) (*Host, error) {
	h := &Host{cfg: cfg, version: version, log: log, tiers: map[string]Tier{}, bySlot: map[int]egress.Rules{}}
	if err := os.MkdirAll(cfg.Root, 0o700); err != nil {
		return nil, err
	}
	store, err := e2e.OpenStore(filepath.Join(cfg.Root, "e2e"))
	if err != nil {
		return nil, fmt.Errorf("e2e store: %w", err)
	}
	h.e2e = store
	h.commands = newCommandLog(cfg.Root)
	h.proxy = egress.New(log.With("part", "egress"))
	h.secrets = protect.NewStore(h.fetchSecrets)
	h.cas = egress.NewCAStore(filepath.Join(cfg.Root, "egress-ca"))
	h.proxy.Secrets = h.secrets
	h.proxy.CAs = h.cas
	h.egressLog = newEgressBatcher(h.sendEgress, h.connected)
	h.proxy.OnRecord = h.recordEgress
	dest, err := destinations(cfg)
	if err != nil {
		return nil, err
	}
	h.proxy.Destinations = dest
	want := map[string]bool{}
	for _, t := range cfg.Tiers {
		want[t] = true
	}
	all := len(cfg.Tiers) == 0
	kvm, _ := hostinfo.KVM()
	if (all || want[microvm.Tier]) && kvm && fileExists(cfg.Firecracker) && fileExists(cfg.Kernel) && fileExists(cfg.SandboxImage) {
		netm, err := network.New(cfg.Subnet, cfg.ProxyPort, false)
		if err != nil {
			return nil, fmt.Errorf("sandbox network: %w", err)
		}
		h.net = netm
		h.proxy.Resolve = h.resolveAddr
		if err := h.proxy.Listen(fmt.Sprintf("0.0.0.0:%d", cfg.ProxyPort)); err != nil {
			return nil, fmt.Errorf("egress proxy: %w", err)
		}
		sizes := cfg.Sizes
		if len(sizes) == 0 {
			sizes = microvm.DefaultSizes
		}
		spoolMax := cfg.SpoolMaxMiB
		if spoolMax == 0 {
			spoolMax = min(16384, hostinfo.MemoryMiB()/8)
		}
		spoolDir := cfg.SpoolDir
		if spoolMax < 0 {
			spoolDir = ""
		}
		initrd := ""
		if cfg.InjectGuestAgent {
			// Experimental: any Linux image, with the agent put in at boot.
			if initrd, err = guestinit.Build(filepath.Join(cfg.Root, "microvm", "initramfs"), cfg.GuestAgent); err != nil {
				return nil, fmt.Errorf("injectGuestAgent: %w", err)
			}
			log.Info("microVMs boot through Kantel's initramfs (injected guest agent)", "agent", cfg.GuestAgent, "initramfs", initrd)
		}
		mv, err := microvm.New(microvm.Config{
			SpoolDir: spoolDir, SpoolMaxMiB: spoolMax, Initrd: initrd, TemplateRegistry: cfg.TemplateRegistry,
			Root: cfg.Root + "/microvm", Firecracker: cfg.Firecracker, Kernel: cfg.Kernel, Rootfs: cfg.SandboxImage,
			Sizes: sizes, Network: netm, ProxyPort: cfg.ProxyPort, DNS: cfg.DNS, Log: log,
			PinBase: cfg.ImagePatching, BackgroundTemplates: cfg.ImagePatching,
			Events: h.sandboxEvent,
			Attach: h.attachSlot,
			Detach: h.detachSlot,
			// Creates, starts, resumes and template builds are admitted against the host's budget, as Capacity reports it.
			Budget: h.budgetBeside(microvm.Tier),
		})
		if err != nil {
			return nil, err
		}
		h.add(microvm.Tier, mv)
	} else if want[microvm.Tier] {
		log.Warn("microVM tier off: needs /dev/kvm, firecracker, a kernel and the sandbox image", "kvm", kvm, "firecracker", cfg.Firecracker, "kernel", cfg.Kernel, "image", cfg.SandboxImage)
	}
	isolateReady := false
	if cfg.IsolateRuntime == "native" {
		isolateReady = fileExists(cfg.Workerd) && fileExists(cfg.IsolateBundle+"/config.capnp")
	} else {
		isolateReady = kvm && fileExists(cfg.Firecracker) && fileExists(cfg.Kernel) && fileExists(cfg.IsolateImage)
	}
	if (all || want[isolate.Tier]) && isolateReady {
		// A VM runtime's images, held on one version for the daemon's lifetime (isolateImages); native uses none.
		isoKernel, isoRootfs := cfg.Kernel, cfg.IsolateImage
		if cfg.IsolateRuntime != "native" {
			isoKernel, isoRootfs = h.isolateImages(cfg)
		}
		iso, err := isolate.New(isolate.Config{
			Root: cfg.Root + "/isolate", Runtime: cfg.IsolateRuntime, Firecracker: cfg.Firecracker, Kernel: isoKernel,
			Rootfs: isoRootfs, Workerd: cfg.Workerd, Bundle: cfg.IsolateBundle, Egress: h.proxy,
			Rules: h.liveRules, Log: log, Events: h.sandboxEvent,
		})
		if err != nil {
			return nil, err
		}
		h.add(isolate.Tier, iso)
	} else if want[isolate.Tier] {
		log.Warn("isolate tier off: its runtime isn't installed", "runtime", cfg.IsolateRuntime)
	}
	if len(h.tiers) == 0 {
		return nil, errors.New("this host can run no sandbox tier: run `kantel-host doctor`")
	}
	if cfg.ImagePatching {
		h.startImagePatching(kvm)
	}
	h.facts = h.withRuntime(h.makeFacts())
	go h.egressLog.run()
	return h, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (h *Host) add(name string, t Tier) {
	h.tiers[name] = t
	h.order = append(h.order, name)
}

// Tiers are the tiers the host runs.
func (h *Host) Tiers() []string { return append([]string{}, h.order...) }

func (h *Host) makeFacts() proto.Facts {
	kvm, _ := hostinfo.KVM()
	nested, _ := hostinfo.Nested()
	name, _ := os.Hostname()
	if h.cfg.Name != "" {
		name = h.cfg.Name
	}
	sizes := h.cfg.Sizes
	if len(sizes) == 0 {
		sizes = microvm.DefaultSizes
	}
	if _, ok := h.tiers[microvm.Tier]; !ok {
		sizes = nil
	}
	total := hostinfo.MemoryMiB()
	reserve := h.cfg.ReserveMemoryMiB
	if reserve == 0 {
		reserve = max(2048, total/10)
	}
	features := []string{proto.FeatureEgressPolicy, proto.FeatureCustomShapes}
	// File streams are served for a tier's sandboxes only when it streams files (the microVM tier); a call for another's
	// is refused as unsupported.
	for _, name := range h.order {
		if _, ok := h.tiers[name].(FileStreamer); ok {
			features = append(features, proto.FeatureFileStreams)
			break
		}
	}
	for _, name := range h.order {
		if _, ok := h.tiers[name].(ArchiveExtractor); ok {
			features = append(features, proto.FeatureFilesExtract)
			break
		}
	}
	if h.cfg.usageInterval() > 0 {
		features = append(features, proto.FeatureUsage, proto.FeatureUsageAcks)
	}
	if h.cfg.ImagePatching {
		features = append(features, proto.FeatureImagePatching)
	}
	return proto.Facts{
		Version: h.version, Protocol: proto.ProtocolVersion, OS: runtime.GOOS, Arch: hostinfo.Arch(), Kernel: hostinfo.Kernel(),
		Hostname: name, CPUs: runtime.NumCPU(), MemoryMiB: max(0, total-reserve), DiskGiB: hostinfo.FreeDiskGiB(h.cfg.Root),
		KVM: kvm, Nested: nested && kvm, Tiers: h.Tiers(), Sizes: sizes, Labels: h.cfg.Labels, Egress: h.cfg.Egress,
		Features: features,
	}
}

// Facts are what the host tells the control plane it is, with FeatureTemplateBuild while it can build templates.
func (h *Host) Facts() proto.Facts {
	f := h.facts
	if held := h.patching.facts.Load(); held != nil {
		copied := *held
		f.Images = &copied
	}
	if h.canBuildTemplates(context.Background()) == nil {
		f.Features = append(append([]string{}, f.Features...), proto.FeatureTemplateBuild)
	}
	return f
}

// Capacity is what is free now: the memory budget less what its sandboxes and its template builds use, and the free
// disk less what its builds hold; with the builds named, as they are counted.
func (h *Host) Capacity() proto.Capacity {
	c := proto.Capacity{Warm: map[string]int{}, Load1: hostinfo.Load1(), FreeDiskGiB: hostinfo.FreeDiskGiB(h.cfg.Root)}
	var used int64
	for _, t := range h.tiers {
		mem, running, stopped := t.Usage()
		used += mem
		c.Running += running
		c.Stopped += stopped
	}
	if t, err := h.templateTier(); err == nil {
		ids, memoryMiB, diskGiB := t.TemplateBuilds()
		used += memoryMiB
		c.FreeDiskGiB = max(0, c.FreeDiskGiB-diskGiB)
		c.Builds = ids
	}
	c.FreeMemoryMiB = max(0, h.memoryBudgetMiB()-used)
	return c
}

// budgetBeside is what the tier named may use now (microvm.Config.Budget): the memory budget less what the other
// tiers use, and the free disk. It never calls that tier, whose lock is held when it is called.
func (h *Host) budgetBeside(tier string) func() (memoryMiB, diskGiB int64) {
	return func() (int64, int64) {
		memory := h.memoryBudgetMiB()
		for name, t := range h.tiers {
			if name != tier {
				used, _, _ := t.Usage()
				memory -= used
			}
		}
		return memory, hostinfo.FreeDiskGiB(h.cfg.Root)
	}
}

// memoryBudgetMiB is the memory the host gives its sandboxes and template builds: what it has for them, overcommitted.
func (h *Host) memoryBudgetMiB() int64 {
	return int64(float64(h.facts.MemoryMiB) * h.cfg.OvercommitMemory)
}

// ResetTemplates drops a tier's templates (a benchmark's cold start).
func (h *Host) ResetTemplates(tier string) {
	if t, ok := h.tiers[tier]; ok {
		t.ResetTemplates()
	}
}

func (h *Host) Close() {
	h.stopImagePatching()
	for _, t := range h.tiers {
		t.Close()
	}
	h.proxy.Close()
	if h.egressLog != nil {
		h.egressLog.close()
	}
}

func (h *Host) sandboxEvent(info proto.SandboxInfo) {
	h.mu.Lock()
	fn := h.events
	h.mu.Unlock()
	if fn != nil {
		fn(proto.Event{Kind: "sandbox", Sandbox: &info})
	}
}

// --- egress ---------------------------------------------------------------------------------------------------------

// egressRules turns the control plane's egress for a sandbox into the proxy's rules. Allow and deny always apply (a
// restriction is never dropped); with the data path switched off, the sandbox's traffic goes direct rather than
// through the upstream the control plane named.
func (h *Host) egressRules(sandboxID, account string, e *proto.Egress) egress.Rules {
	r := egress.Rules{SandboxID: sandboxID, Account: account, Mode: h.cfg.Egress}
	if e == nil {
		return r
	}
	if e.Mode != "" {
		r.Mode = e.Mode
	}
	r.Allow, r.Deny, r.DefaultDeny = e.Allow, e.Deny, e.DefaultDeny
	// Protected variables and grants apply whatever the data path: a placeholder is worthless unless swapped, and a
	// grant restricts.
	if e.Protected != nil {
		r.Protected = true
		r.Intercept = slices.Clone(e.Protected.Intercept)
	}
	for _, g := range e.Grants {
		r.Grants = append(r.Grants, egress.Grant{Action: g.Action, Host: g.Host, Methods: slices.Clone(g.Methods), Paths: slices.Clone(g.Paths), Rule: g.Rule})
	}
	if !h.cfg.ProxyDataPath {
		return r
	}
	r.Upstream, r.Token, r.AttributionKey, r.Headers = e.Upstream, e.Token, e.AttributionKey, e.Headers
	r.UpstreamCACert = e.CACert
	return r
}

// destinations is where the egress proxy may connect: public addresses, and the private ranges the operator allows;
// never the sandbox subnet.
func destinations(cfg Config) (egress.Destinations, error) {
	var d egress.Destinations
	subnet, err := netip.ParsePrefix(cfg.Subnet)
	if err != nil {
		return d, fmt.Errorf("sandbox subnet: %w", err)
	}
	d.Deny = []netip.Prefix{subnet.Masked()}
	for _, raw := range cfg.EgressAllowCIDRs {
		p, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil {
			return d, fmt.Errorf("egressAllowCIDRs: %w", err)
		}
		d.Allow = append(d.Allow, p.Masked())
	}
	return d, nil
}

// liveRules are the rules a sandbox's traffic is judged by now, with the protected-table version its egress
// advertises required first: whichever way the egress came (sent, kept in meta.json, adopted at a restart, inherited
// by a fork), a table older than it is never used for that traffic.
func (h *Host) liveRules(sandboxID, owner string, e *proto.Egress) egress.Rules {
	h.requireProtected(sandboxID, e)
	return h.egressRules(sandboxID, owner, e)
}

func (h *Host) attachSlot(slot int, sandboxID, owner string, e *proto.Egress) {
	r := h.liveRules(sandboxID, owner, e)
	h.mu.Lock()
	h.bySlot[slot] = r
	h.mu.Unlock()
}

func (h *Host) detachSlot(slot int) {
	h.mu.Lock()
	delete(h.bySlot, slot)
	h.mu.Unlock()
}

func (h *Host) resolveAddr(addr netip.Addr) (egress.Rules, bool) {
	if h.net == nil {
		return egress.Rules{}, false
	}
	slot := h.net.SlotOf(addr)
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.bySlot[slot]
	return r, ok
}

// --- calls ----------------------------------------------------------------------------------------------------------

func invalid(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf(format, args...)}
}

func (h *Host) tier(name string) (Tier, error) {
	if name == "" {
		name = h.order[0]
	}
	t, ok := h.tiers[name]
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("this host doesn't run %s sandboxes", name)}
	}
	return t, nil
}

// tierName is the name of the tier a create asks for.
func (h *Host) tierName(name string) string {
	if name == "" && len(h.order) > 0 {
		return h.order[0]
	}
	return name
}

// tierOf finds the tier holding a sandbox.
func (h *Host) tierOf(id string) (Tier, error) {
	t, _, err := h.tierOfNamed(id)
	return t, err
}

// tierOfNamed finds the tier holding a sandbox, and its name.
func (h *Host) tierOfNamed(id string) (Tier, string, error) {
	for _, name := range h.order {
		t := h.tiers[name]
		if _, err := t.Get(id); err == nil {
			return t, name, nil
		}
	}
	return nil, "", &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no sandbox %s on this host", id)}
}

// streamEncoding is how the tier holding a sandbox writes streamed output: the microVM guest's chunks are base64.
func (h *Host) streamEncoding(id string) StreamEncoding {
	if _, name, err := h.tierOfNamed(id); err == nil && name == microvm.Tier {
		return StreamBase64
	}
	return StreamText
}

func (h *Host) tierOfSnapshot(id string) (Tier, error) {
	for _, name := range h.order {
		if h.tiers[name].HasSnapshot(id) {
			return h.tiers[name], nil
		}
	}
	return nil, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no snapshot %s on this host", id)}
}

func decode[T any](raw json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, invalid("bad params: %v", err)
	}
	return v, nil
}

// Call runs one control-plane call. onEvent receives a streamed command's output.
func (h *Host) Call(ctx context.Context, method string, params json.RawMessage, onEvent func(proto.Event)) (any, error) {
	switch method {
	case proto.MethodCreate:
		p, err := decode[proto.CreateParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tier(p.Tier)
		if err != nil {
			return nil, err
		}
		if p.Template != nil && h.tierName(p.Tier) != microvm.Tier {
			return nil, invalid("a sandbox made from a template is a microVM")
		}
		defer h.lifecycle.lock(p.SandboxID)()
		if _, err := h.tierOf(p.SandboxID); err == nil {
			// Before any CA is made: a new one would replace the CA the running sandbox of that ID trusts.
			return nil, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s already exists on this host", p.SandboxID)}
		}
		if p.Egress != nil {
			if err := h.orderNew(t, p.SandboxID, p.Egress.Revision); err != nil {
				return nil, err
			}
		}
		h.requireProtected(p.SandboxID, p.Egress)
		e, fresh, err := h.prepareEgress(h.tierName(p.Tier), p.SandboxID, p.Egress)
		if err != nil {
			return nil, err
		}
		p.Egress = e
		info, err := t.Create(ctx, p)
		if err != nil {
			if fresh {
				_ = h.cas.Forget(p.SandboxID)
			}
			return nil, err
		}
		return info, nil
	case proto.MethodStop:
		p, err := decode[proto.StopParams](params)
		if err != nil {
			return nil, err
		}
		// With the other lifecycle calls, so a start or resume's look at whether the sandbox runs holds while it acts.
		defer h.lifecycle.lock(p.SandboxID)()
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		snap, err := t.Stop(ctx, p)
		if err == nil {
			// Its values aren't needed until it runs again; its CA is, as the guest trusts that one.
			h.forgetSecrets(p.SandboxID)
		}
		return snap, err
	case proto.MethodEgress:
		p, err := decode[proto.ResumeParams](params)
		if err != nil {
			return nil, err
		}
		defer h.lifecycle.lock(p.SandboxID)()
		t, name, err := h.tierOfNamed(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, h.setEgress(ctx, t, name, p)
	case proto.MethodSecrets:
		p, err := decode[proto.SecretsParams](params)
		if err != nil {
			return nil, err
		}
		if p.SandboxID == "" {
			return nil, invalid("sandbox.secrets needs sandboxId")
		}
		// The placeholders stay the same, so nothing in the sandbox changes: the next request fetches the new values.
		if h.secrets != nil {
			h.secrets.Invalidate(p.SandboxID)
			h.secrets.Require(p.SandboxID, p.Version)
		}
		return struct{}{}, nil
	case proto.MethodResume, proto.MethodStart:
		p, err := decode[proto.ResumeParams](params)
		if err != nil {
			return nil, err
		}
		defer h.lifecycle.lock(p.SandboxID)()
		t, name, err := h.tierOfNamed(p.SandboxID)
		if err != nil {
			return nil, err
		}
		// A rebase onto images this host hasn't taken is refused before anything changes (the tier checks again as it
		// relinks).
		if method == proto.MethodStart && p.Rebase && p.RebaseTo != "" {
			if err := h.rebaseTarget(p.SandboxID, p.RebaseTo); err != nil {
				return nil, err
			}
		}
		revision := revisionOf(p)
		// A boot with a revision states the sandbox's egress, none being the host's default; one without an egress
		// and without a revision keeps the egress it has, CA certificate included.
		states := p.Egress != nil || revision > 0
		if info, err := t.Get(p.SandboxID); err == nil && info.State == proto.StateRunning {
			// Running already, the tier changes nothing, so neither does the host: not its CA, nor what it holds.
			states = false
		}
		if states {
			ok, err := h.orderEgress(t, p.SandboxID, revision)
			if err != nil {
				return nil, err
			}
			// Stale (read before an egress the host has taken since: a sandbox.egress while it was stopped, a clear):
			// it boots with that one.
			states = ok
		}
		p.Egress = withRevision(p.Egress, revision)
		if !states {
			p.Egress = nil
		} else if p.Egress == nil {
			// The host's default from now: the egress it had goes, as a sandbox.egress clear does, before it boots.
			if h.cas != nil {
				_ = h.cas.Forget(p.SandboxID)
			}
			if err := t.SetEgress(p.SandboxID, nil); err != nil {
				return nil, err
			}
		} else {
			h.requireProtected(p.SandboxID, p.Egress)
			if p.Egress, _, err = h.prepareEgress(name, p.SandboxID, p.Egress); err != nil {
				return nil, err
			}
		}
		return t.Resume(ctx, p, method == proto.MethodStart)
	case proto.MethodFork:
		p, err := decode[proto.ForkParams](params)
		if err != nil {
			return nil, err
		}
		defer h.lifecycle.lock(p.SandboxID, p.NewID)()
		t, name, err := h.tierOfNamed(p.SandboxID)
		if err != nil {
			return nil, err
		}
		if _, err := h.tierOf(p.NewID); err == nil {
			return nil, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s already exists on this host", p.NewID)}
		}
		if p.Egress == nil {
			// Inherited, as the tier would, but resolved here, in every tier, so the fork's CA is made for what it
			// inherits and its revision is ordered like a given one.
			if p.Egress, err = h.inheritedEgress(t, p.SandboxID); err != nil {
				return nil, err
			}
		}
		if p.Egress != nil {
			if err := h.orderNew(t, p.NewID, p.Egress.Revision); err != nil {
				return nil, err
			}
		}
		h.requireProtected(p.NewID, p.Egress)
		// The fork gets its own CA: its parent's would let one sandbox's key be used for another's traffic.
		e, fresh, err := h.prepareEgress(name, p.NewID, p.Egress)
		if err != nil {
			return nil, err
		}
		p.Egress = e
		info, err := t.Fork(ctx, p)
		if err != nil {
			if fresh {
				_ = h.cas.Forget(p.NewID)
			}
			return nil, err
		}
		return info, nil
	case proto.MethodDelete:
		p, err := decode[proto.SandboxRef](params)
		if err != nil {
			return nil, err
		}
		defer h.lifecycle.lock(p.SandboxID)()
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		if err := t.Delete(ctx, p.SandboxID); err != nil {
			return nil, err
		}
		h.forgetSecrets(p.SandboxID)
		if h.cas != nil {
			_ = h.cas.Forget(p.SandboxID)
		}
		h.forgetFloor(p.SandboxID)
		if h.commands != nil {
			h.commands.forget(p.SandboxID)
		}
		return map[string]bool{"ok": true}, nil
	case proto.MethodGet:
		p, err := decode[proto.SandboxRef](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return t.Get(p.SandboxID)
	case proto.MethodList:
		return h.List(), nil
	case proto.MethodExec:
		p, err := decode[proto.ExecParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		var onOutput func(string, string)
		if p.Stream && onEvent != nil {
			onOutput = func(stdout, stderr string) {
				onEvent(proto.Event{Kind: "exec.output", Stdout: stdout, Stderr: stderr})
			}
		}
		return t.Exec(ctx, p, onOutput)
	case proto.MethodFileRead:
		p, err := decode[proto.FileParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		if p.Offset < 0 || p.Length < 0 {
			return nil, invalid("offset and length can't be negative")
		}
		data, mode, size, err := t.ReadFile(ctx, p)
		if err != nil {
			return nil, err
		}
		// fileSize, the whole file's, also tells the control plane this host reads ranges: one from before them answers
		// the whole file whatever it was asked.
		return map[string]any{
			"data": base64.StdEncoding.EncodeToString(data), "mode": mode, "size": len(data), "fileSize": size,
		}, nil
	case proto.MethodFileWrite:
		p, err := decode[proto.FileParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(p.Data)
		if err != nil {
			return nil, invalid("data isn't base64")
		}
		return map[string]bool{"ok": true}, t.WriteFile(ctx, p, data)
	case proto.MethodFileExtract:
		p, err := decode[proto.FileExtractParams](params)
		if err != nil {
			return nil, err
		}
		if !filepath.IsAbs(p.Archive) || !filepath.IsAbs(p.Target) {
			return nil, invalid("sandbox.files.extract needs an absolute archive and target")
		}
		extractor, err := h.archiveExtractor(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, extractor.ExtractArchive(ctx, p)
	case proto.MethodFileDelete:
		p, err := decode[proto.FileParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, t.DeleteFile(ctx, p)
	case proto.MethodFileList:
		p, err := decode[proto.FileParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		entries, err := t.ListFiles(ctx, p)
		return map[string]any{"entries": entries}, err
	case proto.MethodSnapshotList:
		p, err := decode[proto.SnapshotParams](params)
		if err != nil {
			return nil, err
		}
		var out []proto.SnapshotInfo
		for _, name := range h.order {
			out = append(out, h.tiers[name].Snapshots(p.SandboxID)...)
		}
		return map[string]any{"snapshots": out}, nil
	case proto.MethodSnapshotSave:
		p, err := decode[proto.SnapshotParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return t.SaveSnapshot(ctx, p)
	case proto.MethodSnapshotDel:
		p, err := decode[proto.SnapshotParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOfSnapshot(p.SnapshotID)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, t.DeleteSnapshot(p.SnapshotID)
	case proto.MethodSnapshotTree:
		p, err := decode[proto.SnapshotParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOfSnapshot(p.SnapshotID)
		if err != nil {
			return nil, err
		}
		// E2E is judged on the snapshot in the tier this read uses, so a check can't pass on another tier's (e2e.go).
		if space, covered := h.snapshotGuarded(t, p.SnapshotID); covered {
			return nil, e2eRefusal(space)
		}
		entries, err := t.SnapshotFiles(p.SnapshotID, p.Path)
		return map[string]any{"entries": entries}, err
	case proto.MethodSnapshotRead:
		p, err := decode[proto.SnapshotParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOfSnapshot(p.SnapshotID)
		if err != nil {
			return nil, err
		}
		// E2E is judged on the snapshot in the tier this read uses, so a check can't pass on another tier's (e2e.go).
		if space, covered := h.snapshotGuarded(t, p.SnapshotID); covered {
			return nil, e2eRefusal(space)
		}
		data, err := t.SnapshotRead(p.SnapshotID, p.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(data), "size": len(data)}, nil
	case proto.MethodHostImages:
		return h.hostImages(params)
	case proto.MethodTemplateBuild, proto.MethodTemplateDelete:
		return h.templateCall(ctx, method, params)
	}
	return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "unknown method " + method}
}

// List is every sandbox on the host.
func (h *Host) List() []proto.SandboxInfo {
	out := []proto.SandboxInfo{} // [], not null, on a host with none
	for _, name := range h.order {
		out = append(out, h.tiers[name].List()...)
	}
	return out
}

// DialPort opens a stream to a port of a running sandbox.
func (h *Host) DialPort(ctx context.Context, id string, port int) (net.Conn, error) {
	t, err := h.tierOf(id)
	if err != nil {
		return nil, err
	}
	return t.DialPort(ctx, id, port)
}

var _ = exec.Command
