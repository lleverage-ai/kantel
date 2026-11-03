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
	"runtime"
	"strings"
	"sync"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
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
	ReadFile(ctx context.Context, p proto.FileParams) ([]byte, uint32, error)
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
	SetPools(want map[string]int)
	Warm() map[string]int
	ResetTemplates()
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

	mu sync.Mutex
	// bySlot is each running microVM's egress, by its network slot.
	bySlot map[int]egress.Rules
	// events go to the control plane while connected.
	events func(proto.Event)
	pools  map[string]int
}

// New starts the tiers the host can run.
func New(cfg Config, version string, log *slog.Logger) (*Host, error) {
	h := &Host{cfg: cfg, version: version, log: log, tiers: map[string]Tier{}, bySlot: map[int]egress.Rules{}, pools: map[string]int{}}
	if err := os.MkdirAll(cfg.Root, 0o700); err != nil {
		return nil, err
	}
	h.proxy = egress.New(log.With("part", "egress"))
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
		mv, err := microvm.New(microvm.Config{
			SpoolDir: spoolDir, SpoolMaxMiB: spoolMax,
			Root: cfg.Root + "/microvm", Firecracker: cfg.Firecracker, Kernel: cfg.Kernel, Rootfs: cfg.SandboxImage,
			Sizes: sizes, Network: netm, ProxyPort: cfg.ProxyPort, DNS: cfg.DNS, Log: log,
			Events: h.sandboxEvent,
			Attach: h.attachSlot,
			Detach: h.detachSlot,
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
		iso, err := isolate.New(isolate.Config{
			Root: cfg.Root + "/isolate", Runtime: cfg.IsolateRuntime, Firecracker: cfg.Firecracker, Kernel: cfg.Kernel,
			Rootfs: cfg.IsolateImage, Workerd: cfg.Workerd, Bundle: cfg.IsolateBundle, Egress: h.proxy,
			Rules: h.egressRules, Log: log, Events: h.sandboxEvent,
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
	h.facts = h.makeFacts()
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
	return proto.Facts{
		Version: h.version, Protocol: proto.ProtocolVersion, OS: runtime.GOOS, Arch: hostinfo.Arch(), Kernel: hostinfo.Kernel(),
		Hostname: name, CPUs: runtime.NumCPU(), MemoryMiB: max(0, total-reserve), DiskGiB: hostinfo.FreeDiskGiB(h.cfg.Root),
		KVM: kvm, Nested: nested && kvm, Tiers: h.Tiers(), Sizes: sizes, Labels: h.cfg.Labels, Egress: h.cfg.Egress,
	}
}

// Facts are what the host tells the control plane it is.
func (h *Host) Facts() proto.Facts { return h.facts }

// Capacity is what is free now.
func (h *Host) Capacity() proto.Capacity {
	c := proto.Capacity{Warm: map[string]int{}, Load1: hostinfo.Load1(), FreeDiskGiB: hostinfo.FreeDiskGiB(h.cfg.Root)}
	var used int64
	for _, t := range h.tiers {
		mem, running, stopped := t.Usage()
		used += mem
		c.Running += running
		c.Stopped += stopped
	}
	c.Warm = h.Warm()
	budget := int64(float64(h.facts.MemoryMiB) * h.cfg.OvercommitMemory)
	c.FreeMemoryMiB = max(0, budget-used)
	return c
}

// SetPools sets the warm pools, as "<tier>/<pool>": n ("microvm/default": 2 is two warm default-size microVMs;
// "isolate/default": 1 one spare isolate runtime). A tier gets its own pools without the prefix.
func (h *Host) SetPools(want map[string]int) {
	h.mu.Lock()
	h.pools = want
	h.mu.Unlock()
	for name, t := range h.tiers {
		mine := map[string]int{}
		for key, n := range want {
			if tier, pool, ok := strings.Cut(key, "/"); ok && tier == name {
				mine[pool] = n
			}
		}
		t.SetPools(mine)
	}
}

// Warm is every tier's ready pool, as "<tier>/<pool>": n.
func (h *Host) Warm() map[string]int {
	out := map[string]int{}
	for name, t := range h.tiers {
		for k, v := range t.Warm() {
			out[name+"/"+k] = v
		}
	}
	return out
}

// ResetTemplates drops a tier's templates and pools (a benchmark's cold start).
func (h *Host) ResetTemplates(tier string) {
	if t, ok := h.tiers[tier]; ok {
		t.ResetTemplates()
	}
}

func (h *Host) Close() {
	for _, t := range h.tiers {
		t.Close()
	}
	h.proxy.Close()
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
	if !h.cfg.ProxyDataPath {
		return r
	}
	r.Upstream, r.Token, r.AttributionKey = e.Upstream, e.Token, e.AttributionKey
	return r
}

func (h *Host) attachSlot(slot int, sandboxID, owner string, e *proto.Egress) {
	r := h.egressRules(sandboxID, owner, e)
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

// tierOf finds the tier holding a sandbox.
func (h *Host) tierOf(id string) (Tier, error) {
	for _, name := range h.order {
		t := h.tiers[name]
		if _, err := t.Get(id); err == nil {
			return t, nil
		}
	}
	return nil, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no sandbox %s on this host", id)}
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
		return t.Create(ctx, p)
	case proto.MethodStop:
		p, err := decode[proto.StopParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return t.Stop(ctx, p)
	case proto.MethodResume, proto.MethodStart:
		p, err := decode[proto.ResumeParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return t.Resume(ctx, p, method == proto.MethodStart)
	case proto.MethodFork:
		p, err := decode[proto.ForkParams](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		return t.Fork(ctx, p)
	case proto.MethodDelete:
		p, err := decode[proto.SandboxRef](params)
		if err != nil {
			return nil, err
		}
		t, err := h.tierOf(p.SandboxID)
		if err != nil {
			return nil, err
		}
		if err := t.Delete(ctx, p.SandboxID); err != nil {
			return nil, err
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
		data, mode, err := t.ReadFile(ctx, p)
		if err != nil {
			return nil, err
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(data), "mode": mode, "size": len(data)}, nil
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
		data, err := t.SnapshotRead(p.SnapshotID, p.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(data), "size": len(data)}, nil
	case proto.MethodHostPools:
		var want map[string]int
		if err := json.Unmarshal(params, &want); err != nil {
			return nil, invalid("bad pools")
		}
		h.SetPools(want)
		return map[string]bool{"ok": true}, nil
	}
	return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "unknown method " + method}
}

// List is every sandbox on the host.
func (h *Host) List() []proto.SandboxInfo {
	var out []proto.SandboxInfo
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
