// Package isolate is the isolate tier: each sandbox is a workerd Dynamic Worker running just-bash (a TypeScript
// shell) over its own files. It starts in milliseconds and runs no native binaries.
//
// workerd "is not a hardened sandbox", so it never runs agent code on the host itself: each account's isolates run
// in that account's own isolate VM, a small Firecracker microVM with workerd and the isolate worker
// (apps/host/isolate) and no network device. With Runtime "native" (for a host without KVM, and only for code you
// trust) workerd runs on the host instead, one process per account.
//
// State lives on the host, not in the VM: a sandbox is a manifest (path → SHA-256) and the account's blobs, which
// the worker reads and writes through the host's store (a vsock port the host serves for that VM's account only).
// A command takes the manifest and returns the next one. So a snapshot or a fork copies a manifest, and stopping a
// sandbox costs nothing.
//
// Fast acquisition: isolate VMs are restored from a template snapshot taken with workerd up and isolates
// pre-loaded; spare VMs wait in a pool for an account's first sandbox, and each VM keeps isolates pre-loaded for its
// account's next ones.
package isolate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Tier is the isolate tier's name.
const Tier = "isolate"

// Vsock ports the host serves for each isolate VM.
const (
	StorePort  = 1025
	EgressPort = 1026
)

// Config is the tier's setup.
type Config struct {
	Root string
	// Runtime is "microvm" (the default) or "native".
	Runtime     string
	Firecracker string
	Kernel      string
	// Rootfs is the isolate VM's image (isolate-<arch>.ext4).
	Rootfs string
	// VM is the isolate VM's shape.
	VCPUs     int
	MemoryMiB int
	// Workerd and Bundle are the native runtime's workerd binary and the isolate worker's directory (config.capnp
	// and dist/).
	Workerd string
	Bundle  string
	// Preload is how many isolates each account's VM keeps loaded for its next sandboxes (default 4).
	Preload int
	// IdleVM is how long an account's VM lives with no running sandbox (default 10 minutes).
	IdleVM        time.Duration
	AutoSnapshots int
	Egress        *egress.Proxy
	// Rules turns a sandbox's egress into the proxy's rules.
	Rules  func(sandboxID, owner string, e *proto.Egress) egress.Rules
	Log    *slog.Logger
	Events func(proto.SandboxInfo)
}

type meta struct {
	ID        string            `json:"id"`
	Owner     string            `json:"owner"`
	State     string            `json:"state"`
	CreatedAt int64             `json:"createdAt"`
	Env       map[string]string `json:"env,omitempty"`
	Egress    *proto.Egress     `json:"egress,omitempty"`
	Error     string            `json:"error,omitempty"`
}

// Entry is one path in a manifest (the same shape as images/isolate-host/src/sandbox.ts's ManifestEntry).
type Entry struct {
	Kind   string `json:"kind"`
	SHA    string `json:"sha,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Mode   uint32 `json:"mode,omitempty"`
	Target string `json:"target,omitempty"`
}

// Manifest is a sandbox's files: path (relative to /workspace) → entry.
type Manifest map[string]Entry

type sandbox struct {
	mu   sync.Mutex
	meta meta
	dir  string
	// exec runs one command at a time (each takes the manifest the last one left). Held without mu, so the
	// command's egress can look the sandbox up meanwhile.
	exec sync.Mutex
}

// Manager runs the tier.
type Manager struct {
	cfg       Config
	log       *slog.Logger
	mu        sync.Mutex
	sandboxes map[string]*sandbox
	// runtimes by account, and spare ones not yet given to an account.
	runtimes  map[string]*runtime
	spare     []*runtime
	spareWant int
	filling   bool
	template  sync.Mutex
	closed    atomic.Bool
	stopReap  chan struct{}
}

func New(cfg Config) (*Manager, error) {
	if cfg.Runtime == "" {
		cfg.Runtime = "microvm"
	}
	if cfg.VCPUs == 0 {
		cfg.VCPUs = 2
	}
	if cfg.MemoryMiB == 0 {
		cfg.MemoryMiB = 1024
	}
	if cfg.Preload == 0 {
		cfg.Preload = 4
	}
	if cfg.IdleVM == 0 {
		cfg.IdleVM = 10 * time.Minute
	}
	if cfg.AutoSnapshots == 0 {
		cfg.AutoSnapshots = 5
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	root := cfg.Root
	for _, dir := range []string{"sandboxes", "snapshots", "accounts", "runtimes"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			return nil, err
		}
	}
	entries, _ := os.ReadDir(filepath.Join(root, "runtimes"))
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(root, "runtimes", e.Name()))
	}
	m := &Manager{cfg: cfg, log: cfg.Log.With("tier", Tier), sandboxes: map[string]*sandbox{}, runtimes: map[string]*runtime{}, stopReap: make(chan struct{})}
	sbs, _ := os.ReadDir(filepath.Join(root, "sandboxes"))
	for _, e := range sbs {
		dir := filepath.Join(root, "sandboxes", e.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			continue
		}
		s := &sandbox{dir: dir}
		if json.Unmarshal(raw, &s.meta) != nil {
			continue
		}
		// An isolate keeps nothing in memory, so a sandbox that was running is running again: its next command
		// loads it.
		m.sandboxes[s.meta.ID] = s
	}
	go m.reap()
	return m, nil
}

func notFound(id string) error {
	return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no sandbox %s on this host", id)}
}

func conflict(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf(format, args...)}
}

func unsupported(what string) error {
	return &proto.Error{Code: proto.ErrUnsupported, Message: what + " isn't supported on an isolate"}
}

func validID(id string) bool {
	if id == "" || len(id) > 100 {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func writeJSONFile(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	// Durably: a sandbox's meta.json (its egress, and that egress's revision) is what the host has acknowledged.
	return fsutil.WriteFileDurably(path, raw, 0o600)
}

func readManifest(path string) (Manifest, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, nil
	}
	if err != nil {
		return nil, err
	}
	var m Manifest
	return m, json.Unmarshal(raw, &m)
}

func (m *Manager) info(s *sandbox) proto.SandboxInfo {
	return proto.SandboxInfo{ID: s.meta.ID, Tier: Tier, Size: "isolate", State: s.meta.State, Error: s.meta.Error, CreatedAt: s.meta.CreatedAt}
}

func (m *Manager) emit(s *sandbox) {
	if m.cfg.Events != nil {
		m.cfg.Events(m.info(s))
	}
}

func (m *Manager) get(id string) (*sandbox, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sandboxes[id]
	if !ok {
		return nil, notFound(id)
	}
	return s, nil
}

// Owner is the account a sandbox belongs to (the egress proxy's check on the isolate worker's claims).
func (m *Manager) Owner(id string) (string, bool) {
	s, err := m.get(id)
	if err != nil {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta.Owner, s.meta.State == proto.StateRunning
}

func (m *Manager) blobPath(account, sha string) string {
	return filepath.Join(m.cfg.Root, "accounts", accountDir(account), "blobs", sha[:2], sha)
}

func accountDir(account string) string {
	if account == "" {
		return "_"
	}
	sum := sha256.Sum256([]byte(account))
	return hex.EncodeToString(sum[:12])
}

func (m *Manager) putBlob(account string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	p := m.blobPath(account, sha)
	if _, err := os.Stat(p); err == nil {
		return sha, nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", p, time.Now().UnixNano())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return "", err
	}
	return sha, os.Rename(tmp, p)
}

var digest = func(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

func (m *Manager) readBlob(account, sha string) ([]byte, error) {
	if !digest(sha) {
		return nil, errors.New("not a SHA-256 digest")
	}
	return os.ReadFile(m.blobPath(account, sha))
}

// --- runtimes -------------------------------------------------------------------------------------------------------

// runtime is one account's workerd: an isolate VM, or a native process.
type runtime struct {
	dir     string
	account atomic.Pointer[string]
	client  *http.Client
	machine *fc.Machine
	guest   *guest.Client
	proc    *os.Process
	done    <-chan struct{}
	lns     []net.Listener
	// lastUsed is when the account last had a running sandbox or a call (unix ms).
	lastUsed atomic.Int64
	mu       sync.Mutex
}

func (r *runtime) owner() string {
	if p := r.account.Load(); p != nil {
		return *p
	}
	return ""
}

func (r *runtime) close() {
	if r.machine != nil {
		r.machine.Kill()
	}
	if r.guest != nil {
		r.guest.Close()
	}
	if r.proc != nil {
		_ = r.proc.Kill()
		_, _ = r.proc.Wait()
	}
	for _, l := range r.lns {
		l.Close()
	}
	_ = os.RemoveAll(r.dir)
}

func (r *runtime) alive() bool {
	select {
	case <-r.done:
		return false
	default:
		return true
	}
}

// call POSTs to the isolate worker.
func (r *runtime) call(ctx context.Context, path string, body any, out any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://isolate"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return fmt.Errorf("isolate worker %s: %d %s", path, res.StatusCode, e.Error)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (r *runtime) health(ctx context.Context) (map[string]any, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://isolate/healthz", nil)
	res, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	return out, json.NewDecoder(res.Body).Decode(&out)
}

func (r *runtime) waitWorker(ctx context.Context) error {
	for {
		attempt, cancel := context.WithTimeout(ctx, time.Second)
		_, err := r.health(attempt)
		cancel()
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("isolate worker never answered: %w", err)
		case <-r.done:
			return errors.New("isolate runtime exited")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// serveStore answers the isolate worker's blob reads and writes, for the runtime's account only.
func (m *Manager) serveStore(r *runtime, l net.Listener) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /blobs/{sha}", func(w http.ResponseWriter, req *http.Request) {
		account := r.owner()
		if account == "" {
			http.Error(w, "no account", http.StatusForbidden)
			return
		}
		data, err := m.readBlob(account, req.PathValue("sha"))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write(data)
	})
	mux.HandleFunc("PUT /blobs", func(w http.ResponseWriter, req *http.Request) {
		account := r.owner()
		if account == "" {
			http.Error(w, "no account", http.StatusForbidden)
			return
		}
		data, err := io.ReadAll(io.LimitReader(req.Body, 256<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sha, err := m.putBlob(account, data)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": sha})
	})
	_ = (&http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}).Serve(l)
}

// serveEgress passes the isolate worker's requests to the host's egress proxy. The worker names the sandbox; the
// host believes it only for a running sandbox of this runtime's account.
func (m *Manager) serveEgress(r *runtime, l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		go m.cfg.Egress.ServeConn(conn, func(req *http.Request) (egress.Rules, bool) {
			id := req.Header.Get("Kantel-Isolate-Sandbox")
			s, err := m.get(id)
			if err != nil || m.cfg.Rules == nil {
				return egress.Rules{}, false
			}
			s.mu.Lock()
			owner, state, eg := s.meta.Owner, s.meta.State, s.meta.Egress
			s.mu.Unlock()
			if state != proto.StateRunning || owner != r.owner() {
				return egress.Rules{}, false
			}
			return m.cfg.Rules(id, owner, eg), true
		})
	}
}

func (m *Manager) listen(r *runtime, network, address string) (net.Listener, error) {
	l, err := net.Listen(network, address)
	if err != nil {
		return nil, err
	}
	r.lns = append(r.lns, l)
	return l, nil
}

// start makes a runtime with no account yet.
func (m *Manager) start(ctx context.Context) (*runtime, error) {
	dir, err := os.MkdirTemp(filepath.Join(m.cfg.Root, "runtimes"), "rt-")
	if err != nil {
		return nil, err
	}
	r := &runtime{dir: dir}
	r.lastUsed.Store(time.Now().UnixMilli())
	var startErr error
	if m.cfg.Runtime == "native" {
		startErr = m.startNative(ctx, r)
	} else {
		startErr = m.startVM(ctx, r)
	}
	if startErr != nil {
		r.close()
		return nil, startErr
	}
	return r, nil
}

func (m *Manager) startNative(ctx context.Context, r *runtime) error {
	store, err := m.listen(r, "tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	egressL, err := m.listen(r, "tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	worker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	workerAddr := worker.Addr().String()
	worker.Close()
	go m.serveStore(r, store)
	go m.serveEgress(r, egressL)
	config, err := os.ReadFile(filepath.Join(m.cfg.Bundle, "config.capnp"))
	if err != nil {
		return err
	}
	text := strings.NewReplacer(
		"127.0.0.1:7001", store.Addr().String(),
		"127.0.0.1:7002", egressL.Addr().String(),
		"127.0.0.1:8080", workerAddr,
		`embed "dist/`, `embed "`+filepath.Join(m.cfg.Bundle, "dist")+"/",
	).Replace(string(config))
	if err := os.WriteFile(filepath.Join(r.dir, "config.capnp"), []byte(text), 0o600); err != nil {
		return err
	}
	logFile, err := os.Create(filepath.Join(r.dir, "workerd.log"))
	if err != nil {
		return err
	}
	proc, err := os.StartProcess(m.cfg.Workerd, []string{m.cfg.Workerd, "serve", "config.capnp", "--experimental"}, &os.ProcAttr{Dir: r.dir, Files: []*os.File{nil, logFile, logFile}})
	logFile.Close()
	if err != nil {
		return err
	}
	r.proc = proc
	done := make(chan struct{})
	go func() { _, _ = proc.Wait(); close(done) }()
	r.done = done
	r.client = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", workerAddr)
	}}}
	readyCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return r.waitWorker(readyCtx)
}

const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/usr/sbin/kantel-init quiet loglevel=3 systemd.show_status=false"

// templateDir returns the isolate VM's template snapshot, cold-booting one if there is none: a VM with workerd up
// and Preload isolates loaded, paused and snapshotted.
func (m *Manager) templateDir(ctx context.Context) (string, error) {
	m.template.Lock()
	defer m.template.Unlock()
	dir := filepath.Join(m.cfg.Root, "template")
	fingerprint := fc.Fingerprint(m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs)
	if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
		if made, _ := os.ReadFile(filepath.Join(dir, "images")); string(made) == fingerprint {
			return dir, nil
		}
		m.log.Info("isolate VM template is for other images; rebuilding")
	}
	start := time.Now()
	building := dir + ".building"
	_ = os.RemoveAll(building)
	_ = os.RemoveAll(dir)
	vm := filepath.Join(building, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return "", err
	}
	if err := os.Symlink(m.cfg.Rootfs, filepath.Join(vm, fc.RootfsFile)); err != nil {
		return "", err
	}
	if err := newDisk(filepath.Join(vm, fc.DiskFile), 1); err != nil {
		return "", err
	}
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return "", err
	}
	defer machine.Kill()
	if err := machine.Boot(ctx, fc.BootConfig{VCPUs: m.cfg.VCPUs, MemoryMiB: m.cfg.MemoryMiB, Kernel: m.cfg.Kernel, BootArgs: bootArgs, GuestCID: 3}); err != nil {
		return "", err
	}
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	defer client.Close()
	bootCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if _, err := client.WaitFor(bootCtx, "isolate"); err != nil {
		return "", fmt.Errorf("isolate VM boot: %w", err)
	}
	r := &runtime{guest: client, done: machine.Done()}
	r.client = workerClient(client)
	if err := r.waitWorker(bootCtx); err != nil {
		return "", err
	}
	if err := r.call(bootCtx, "/warm", map[string]int{"size": m.cfg.Preload}, nil); err != nil {
		return "", fmt.Errorf("preload isolates: %w", err)
	}
	_ = client.Sync(ctx)
	client.Close()
	if err := machine.Pause(ctx); err != nil {
		return "", err
	}
	if err := machine.Snapshot(ctx, filepath.Join(building, "state"), filepath.Join(building, "mem")); err != nil {
		return "", err
	}
	machine.Kill()
	if err := os.Rename(filepath.Join(vm, fc.DiskFile), filepath.Join(building, fc.DiskFile)); err != nil {
		return "", err
	}
	_ = os.RemoveAll(vm)
	if err := os.Rename(building, dir); err != nil {
		return "", err
	}
	raw, _ := json.Marshal(map[string]any{"bootMs": time.Since(start).Milliseconds(), "at": time.Now().UnixMilli()})
	_ = os.WriteFile(filepath.Join(dir, "images"), []byte(fingerprint), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "ready"), raw, 0o600)
	m.log.Info("isolate VM template ready", "ms", time.Since(start).Milliseconds())
	return dir, nil
}

func workerClient(client *guest.Client) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext:         func(ctx context.Context, _, _ string) (net.Conn, error) { return client.DialPort(ctx, 8080) },
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
	}}
}

func newDisk(p string, gib int) error {
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	if err := f.Truncate(int64(gib) << 30); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return runCmd("mkfs.ext4", "-q", "-F", "-L", "kantel-disk", p)
}

func (m *Manager) startVM(ctx context.Context, r *runtime) error {
	tpl, err := m.templateDir(ctx)
	if err != nil {
		return err
	}
	vm := filepath.Join(r.dir, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return err
	}
	if err := os.Symlink(m.cfg.Rootfs, filepath.Join(vm, fc.RootfsFile)); err != nil {
		return err
	}
	if err := runCmd("cp", "--sparse=always", filepath.Join(tpl, fc.DiskFile), filepath.Join(vm, fc.DiskFile)); err != nil {
		return err
	}
	// The worker's ways to the host: Firecracker hands a guest's connection to host port N to <uds>_N.
	store, err := m.listen(r, "unix", filepath.Join(vm, fmt.Sprintf("%s_%d", fc.VsockSocket, StorePort)))
	if err != nil {
		return err
	}
	egressL, err := m.listen(r, "unix", filepath.Join(vm, fmt.Sprintf("%s_%d", fc.VsockSocket, EgressPort)))
	if err != nil {
		return err
	}
	go m.serveStore(r, store)
	go m.serveEgress(r, egressL)
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return err
	}
	r.machine, r.done = machine, machine.Done()
	if err := machine.Load(ctx, filepath.Join(tpl, "state"), filepath.Join(tpl, "mem"), ""); err != nil {
		return err
	}
	r.guest = guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	readyCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := r.guest.WaitReady(readyCtx); err != nil {
		return err
	}
	_ = r.guest.SetIdentity(ctx, guest.Identity{Hostname: "kantel-isolate", UnixTimeMs: time.Now().UnixMilli(), Entropy: entropy()})
	r.client = workerClient(r.guest)
	return r.waitWorker(readyCtx)
}

// runtimeFor is the account's runtime: its own, a spare one, or a new one.
func (m *Manager) runtimeFor(ctx context.Context, account string) (*runtime, string, error) {
	m.mu.Lock()
	if r, ok := m.runtimes[account]; ok && r.alive() {
		m.mu.Unlock()
		r.lastUsed.Store(time.Now().UnixMilli())
		return r, "account", nil
	} else if ok {
		delete(m.runtimes, account)
		go r.close()
	}
	var r *runtime
	for len(m.spare) > 0 && r == nil {
		r = m.spare[0]
		m.spare = m.spare[1:]
		if !r.alive() {
			go r.close()
			r = nil
		}
	}
	m.mu.Unlock()
	source := "spare"
	if r == nil {
		var err error
		r, err = m.start(ctx)
		if err != nil {
			return nil, "", err
		}
		source = "new"
	} else {
		go m.fillSpare()
	}
	acct := account
	r.account.Store(&acct)
	r.lastUsed.Store(time.Now().UnixMilli())
	m.mu.Lock()
	if existing, ok := m.runtimes[account]; ok && existing.alive() {
		// Another create for the account won the race: use its runtime, keep this one spare.
		m.spare = append(m.spare, r)
		r.account.Store(nil)
		m.mu.Unlock()
		return existing, "account", nil
	}
	m.runtimes[account] = r
	m.mu.Unlock()
	return r, source, nil
}

// SetPools sets how many spare runtimes to keep ("isolate/default": n).
func (m *Manager) SetPools(want map[string]int) {
	m.mu.Lock()
	m.spareWant = want["default"]
	m.mu.Unlock()
	go m.fillSpare()
}

func (m *Manager) fillSpare() {
	m.mu.Lock()
	if m.filling || m.closed.Load() {
		m.mu.Unlock()
		return
	}
	m.filling = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.filling = false
		m.mu.Unlock()
	}()
	for !m.closed.Load() {
		m.mu.Lock()
		short := len(m.spare) < m.spareWant
		m.mu.Unlock()
		if !short {
			return
		}
		r, err := m.start(context.Background())
		if err != nil {
			m.log.Error("isolate spare runtime failed", "error", err)
			time.Sleep(10 * time.Second)
			continue
		}
		m.mu.Lock()
		m.spare = append(m.spare, r)
		m.mu.Unlock()
	}
}

// Warm is how many spare runtimes are ready.
func (m *Manager) Warm() map[string]int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return map[string]int{"default": len(m.spare)}
}

// ResetTemplates forgets the template snapshot and every runtime (a benchmark's cold start).
func (m *Manager) ResetTemplates() {
	m.mu.Lock()
	rts := m.runtimes
	m.runtimes = map[string]*runtime{}
	spare := m.spare
	m.spare = nil
	m.mu.Unlock()
	for _, r := range rts {
		r.close()
	}
	for _, r := range spare {
		r.close()
	}
	m.template.Lock()
	_ = os.RemoveAll(filepath.Join(m.cfg.Root, "template"))
	m.template.Unlock()
}

// reap ends the runtimes of accounts with no running sandbox for IdleVM.
func (m *Manager) reap() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopReap:
			return
		case <-ticker.C:
		}
		busy := map[string]bool{}
		m.mu.Lock()
		for _, s := range m.sandboxes {
			if s.meta.State == proto.StateRunning {
				busy[s.meta.Owner] = true
			}
		}
		var idle []*runtime
		for account, r := range m.runtimes {
			if !busy[account] && time.Since(time.UnixMilli(r.lastUsed.Load())) > m.cfg.IdleVM {
				idle = append(idle, r)
				delete(m.runtimes, account)
			}
		}
		m.mu.Unlock()
		for _, r := range idle {
			r.close()
		}
	}
}

// --- sandboxes ------------------------------------------------------------------------------------------------------

type timings map[string]float64

func (t timings) step(name string, since *time.Time) {
	now := time.Now()
	t[name] = float64(now.Sub(*since).Microseconds()) / 1000
	*since = now
}

// load makes sure the sandbox's isolate is loaded in its account's runtime.
func (m *Manager) load(ctx context.Context, s *sandbox, t timings) (string, error) {
	start := time.Now()
	r, source, err := m.runtimeFor(ctx, s.meta.Owner)
	if err != nil {
		return "", err
	}
	t.step("runtime", &start)
	var res struct {
		Hit any `json:"hit"`
	}
	if err := r.call(ctx, "/load", map[string]string{"sandboxId": s.meta.ID}, &res); err != nil {
		return "", err
	}
	t.step("isolate", &start)
	if source == "new" {
		return "boot", nil
	}
	if res.Hit == true {
		return "pool", nil
	}
	return "snapshot", nil
}

func (m *Manager) Create(ctx context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	if !validID(p.SandboxID) {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID"}
	}
	t := timings{}
	began := time.Now()
	dir := filepath.Join(m.cfg.Root, "sandboxes", p.SandboxID)
	s := &sandbox{dir: dir, meta: meta{ID: p.SandboxID, Owner: p.Owner, State: proto.StateStarting, CreatedAt: time.Now().UnixMilli(), Env: p.Env, Egress: p.Egress}}
	m.mu.Lock()
	if _, ok := m.sandboxes[p.SandboxID]; ok {
		m.mu.Unlock()
		return proto.SandboxInfo{}, conflict("sandbox %s already exists on this host", p.SandboxID)
	}
	m.sandboxes[p.SandboxID] = s
	m.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	fail := func(err error) (proto.SandboxInfo, error) {
		_ = os.RemoveAll(dir)
		m.mu.Lock()
		delete(m.sandboxes, p.SandboxID)
		m.mu.Unlock()
		return proto.SandboxInfo{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail(err)
	}
	manifest := Manifest{}
	if p.From != "" {
		snap, err := m.readSnapshot(p.From)
		if err != nil {
			return fail(err)
		}
		if snap.Owner != p.Owner {
			return fail(&proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no snapshot %s for this account", p.From)})
		}
		if manifest, err = readManifest(filepath.Join(m.snapshotDir(p.From), "manifest.json")); err != nil {
			return fail(err)
		}
	}
	if err := writeJSONFile(filepath.Join(dir, "manifest.json"), manifest); err != nil {
		return fail(err)
	}
	source, err := m.load(ctx, s, t)
	if err != nil {
		return fail(err)
	}
	s.meta.State = proto.StateRunning
	if err := writeJSONFile(filepath.Join(dir, "meta.json"), s.meta); err != nil {
		return fail(err)
	}
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info := m.info(s)
	info.Timings, info.Source = t, source
	m.emit(s)
	return info, nil
}

func (m *Manager) Stop(ctx context.Context, p proto.StopParams) (proto.SnapshotInfo, error) {
	if p.Memory != nil && *p.Memory {
		return proto.SnapshotInfo{}, unsupported("keeping memory")
	}
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SnapshotInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning {
		return proto.SnapshotInfo{}, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	s.meta.State = proto.StateStopped
	if err := writeJSONFile(filepath.Join(s.dir, "meta.json"), s.meta); err != nil {
		return proto.SnapshotInfo{}, err
	}
	m.emit(s)
	snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Tier: Tier}
	if p.SnapshotID != "" {
		if err := m.saveSnapshot(s, &snap); err != nil {
			return snap, err
		}
		m.pruneAuto(s.meta.ID)
	}
	return snap, nil
}

func (m *Manager) Resume(ctx context.Context, p proto.ResumeParams, _ bool) (proto.SandboxInfo, error) {
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State == proto.StateRunning {
		return m.info(s), nil
	}
	t := timings{}
	began := time.Now()
	if p.Egress != nil {
		s.meta.Egress = p.Egress
	}
	source, err := m.load(ctx, s, t)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.meta.State = proto.StateRunning
	s.meta.Error = ""
	if err := writeJSONFile(filepath.Join(s.dir, "meta.json"), s.meta); err != nil {
		return proto.SandboxInfo{}, err
	}
	t["total"] = float64(time.Since(began).Microseconds()) / 1000
	info := m.info(s)
	info.Timings, info.Source = t, source
	m.emit(s)
	return info, nil
}

func (m *Manager) Fork(ctx context.Context, p proto.ForkParams) (proto.SandboxInfo, error) {
	src, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	began := time.Now()
	src.mu.Lock()
	snapID := p.SnapshotID
	if snapID == "" {
		snapID = "fork-" + p.NewID
	}
	snap := proto.SnapshotInfo{ID: snapID, SandboxID: src.meta.ID, Kind: "auto", CreatedAt: time.Now().UnixMilli(), Tier: Tier}
	err = m.saveSnapshot(src, &snap)
	owner, env := src.meta.Owner, src.meta.Env
	if p.Env != nil {
		// The fork's own: its protected placeholders aren't its source's.
		env = p.Env
	}
	eg := p.Egress
	if eg == nil {
		eg = src.meta.Egress
	}
	src.mu.Unlock()
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	m.pruneAuto(src.meta.ID)
	info, err := m.Create(ctx, proto.CreateParams{SandboxID: p.NewID, Tier: Tier, From: snapID, Env: env, Egress: eg, Owner: owner})
	if err != nil {
		return info, err
	}
	t := timings{"total": float64(time.Since(began).Microseconds()) / 1000}
	for k, v := range info.Timings {
		t["clone."+k] = v
	}
	info.Timings, info.Source = t, "fork"
	return info, nil
}

func (m *Manager) Delete(_ context.Context, id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, snap := range m.snapshotsOf(id) {
		if snap.Kind == "auto" {
			_ = os.RemoveAll(m.snapshotDir(snap.ID))
		}
	}
	if err := os.RemoveAll(s.dir); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.sandboxes, id)
	m.mu.Unlock()
	s.meta.State = proto.StateDeleted
	m.emit(s)
	return nil
}

func (m *Manager) Get(id string) (proto.SandboxInfo, error) {
	s, err := m.get(id)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return m.info(s), nil
}

func (m *Manager) List() []proto.SandboxInfo {
	m.mu.Lock()
	list := make([]*sandbox, 0, len(m.sandboxes))
	for _, s := range m.sandboxes {
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]proto.SandboxInfo, 0, len(list))
	for _, s := range list {
		s.mu.Lock()
		out = append(out, m.info(s))
		s.mu.Unlock()
	}
	return out
}

func (m *Manager) Usage() (memoryMiB int64, running int, stopped int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sandboxes {
		switch s.meta.State {
		case proto.StateRunning:
			running++
		case proto.StateStopped:
			stopped++
		}
	}
	memoryMiB = int64(len(m.runtimes)+len(m.spare)) * int64(m.cfg.MemoryMiB)
	return
}

// Exec runs a command line in the sandbox's shell (just-bash) over its files, and keeps the files it leaves.
func (m *Manager) Exec(ctx context.Context, p proto.ExecParams, onOutput func(stdout, stderr string)) (proto.ExecResult, error) {
	if p.Detached {
		return proto.ExecResult{}, unsupported("a detached command")
	}
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.ExecResult{}, err
	}
	s.exec.Lock()
	defer s.exec.Unlock()
	s.mu.Lock()
	state, owner := s.meta.State, s.meta.Owner
	env := map[string]string{}
	for k, v := range s.meta.Env {
		env[k] = v
	}
	s.mu.Unlock()
	if state != proto.StateRunning {
		return proto.ExecResult{}, conflict("sandbox %s is %s, not running", p.SandboxID, state)
	}
	command := p.Command
	if command == "" && len(p.Argv) > 0 {
		quoted := make([]string, len(p.Argv))
		for i, a := range p.Argv {
			quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		command = strings.Join(quoted, " ")
	}
	if p.Stdin != "" {
		return proto.ExecResult{}, unsupported("stdin")
	}
	manifest, err := readManifest(filepath.Join(s.dir, "manifest.json"))
	if err != nil {
		return proto.ExecResult{}, err
	}
	r, _, err := m.runtimeFor(ctx, owner)
	if err != nil {
		return proto.ExecResult{}, err
	}
	for k, v := range p.Env {
		env[k] = v
	}
	timeout := time.Duration(p.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	started := time.Now()
	var res struct {
		ExitCode int      `json:"exitCode"`
		Stdout   string   `json:"stdout"`
		Stderr   string   `json:"stderr"`
		Manifest Manifest `json:"manifest"`
		Changed  []string `json:"changed"`
	}
	cwd := p.Cwd
	if strings.HasPrefix(cwd, "/workspace") {
		cwd = strings.TrimPrefix(strings.TrimPrefix(cwd, "/workspace"), "/")
	}
	err = r.call(callCtx, "/exec", map[string]any{"sandboxId": p.SandboxID, "command": command, "cwd": cwd, "env": env, "manifest": manifest, "timeoutMs": timeout.Milliseconds()}, &res)
	if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
		return proto.ExecResult{ExitCode: 124, TimedOut: true, DurationMs: time.Since(started).Milliseconds()}, nil
	}
	if err != nil {
		return proto.ExecResult{}, err
	}
	if res.Manifest != nil {
		s.mu.Lock()
		err := writeJSONFile(filepath.Join(s.dir, "manifest.json"), res.Manifest)
		s.mu.Unlock()
		if err != nil {
			return proto.ExecResult{}, err
		}
	}
	if onOutput != nil {
		onOutput(res.Stdout, res.Stderr)
	}
	return proto.ExecResult{ExitCode: res.ExitCode, Stdout: res.Stdout, Stderr: res.Stderr, DurationMs: time.Since(started).Milliseconds()}, nil
}

// --- files ----------------------------------------------------------------------------------------------------------

// relPath turns an absolute or relative path into a manifest key (relative to /workspace), or false if it leaves it.
func relPath(p string) (string, bool) {
	if !strings.HasPrefix(p, "/") {
		p = "/workspace/" + p
	}
	p = path.Clean(p)
	if p == "/workspace" {
		return "", true
	}
	if !strings.HasPrefix(p, "/workspace/") {
		return "", false
	}
	return strings.TrimPrefix(p, "/workspace/"), true
}

func (m *Manager) withManifest(id string, write bool, fn func(s *sandbox, man Manifest) error) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if write {
		// Not between a command's read of the manifest and its write.
		s.exec.Lock()
		defer s.exec.Unlock()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	man, err := readManifest(filepath.Join(s.dir, "manifest.json"))
	if err != nil {
		return err
	}
	if err := fn(s, man); err != nil {
		return err
	}
	if write {
		return writeJSONFile(filepath.Join(s.dir, "manifest.json"), man)
	}
	return nil
}

func badPath(p string) error {
	return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("%s is outside /workspace, an isolate's only files", p)}
}

func (m *Manager) readFrom(account string, man Manifest, p string) ([]byte, uint32, error) {
	key, ok := relPath(p)
	if !ok {
		return nil, 0, badPath(p)
	}
	e, ok := man[key]
	if !ok || e.Kind != "file" {
		return nil, 0, &proto.Error{Code: proto.ErrNotFound, Message: "no file " + p}
	}
	data, err := m.readBlob(account, e.SHA)
	return data, e.Mode, err
}

func (m *Manager) ReadFile(_ context.Context, p proto.FileParams) ([]byte, uint32, int64, error) {
	var data []byte
	var mode uint32
	err := m.withManifest(p.SandboxID, false, func(s *sandbox, man Manifest) error {
		var err error
		data, mode, err = m.readFrom(s.meta.Owner, man, p.Path)
		return err
	})
	if err != nil {
		return nil, 0, 0, err
	}
	size := int64(len(data))
	if p.Length > 0 {
		// An isolate's files are blobs it keeps whole: the range is cut from one.
		start := min(p.Offset, size)
		data = data[start:min(start+p.Length, size)]
	}
	return data, mode, size, nil
}

func (m *Manager) WriteFile(_ context.Context, p proto.FileParams, data []byte) error {
	return m.withManifest(p.SandboxID, true, func(s *sandbox, man Manifest) error {
		key, ok := relPath(p.Path)
		if !ok || key == "" {
			return badPath(p.Path)
		}
		sha, err := m.putBlob(s.meta.Owner, data)
		if err != nil {
			return err
		}
		mode := p.Mode
		if mode == 0 {
			mode = 0o644
		}
		man[key] = Entry{Kind: "file", SHA: sha, Size: int64(len(data)), Mode: mode}
		for dir := path.Dir(key); dir != "." && dir != "/"; dir = path.Dir(dir) {
			if _, ok := man[dir]; !ok {
				man[dir] = Entry{Kind: "dir"}
			}
		}
		return nil
	})
}

func (m *Manager) DeleteFile(_ context.Context, p proto.FileParams) error {
	return m.withManifest(p.SandboxID, true, func(_ *sandbox, man Manifest) error {
		key, ok := relPath(p.Path)
		if !ok || key == "" {
			return badPath(p.Path)
		}
		e, ok := man[key]
		if !ok {
			return &proto.Error{Code: proto.ErrNotFound, Message: "no file " + p.Path}
		}
		if e.Kind == "dir" && !p.Recursive {
			for k := range man {
				if strings.HasPrefix(k, key+"/") {
					return &proto.Error{Code: proto.ErrConflict, Message: p.Path + " is a directory that isn't empty"}
				}
			}
		}
		delete(man, key)
		for k := range man {
			if strings.HasPrefix(k, key+"/") {
				delete(man, k)
			}
		}
		return nil
	})
}

func listManifest(man Manifest, p string) ([]proto.FileEntry, error) {
	key, ok := relPath(p)
	if !ok {
		return nil, badPath(p)
	}
	if key != "" {
		if e, ok := man[key]; !ok || e.Kind != "dir" {
			return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no directory " + p}
		}
	}
	prefix := key
	if prefix != "" {
		prefix += "/"
	}
	out := []proto.FileEntry{}
	for k, e := range man {
		if !strings.HasPrefix(k, prefix) || strings.Contains(k[len(prefix):], "/") || k == key {
			continue
		}
		entry := proto.FileEntry{Name: k[len(prefix):], Path: "/workspace/" + k, Type: e.Kind, Size: e.Size, Mode: e.Mode, Target: e.Target}
		if e.Kind == "symlink" {
			entry.Type = "symlink"
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *Manager) ListFiles(_ context.Context, p proto.FileParams) ([]proto.FileEntry, error) {
	var out []proto.FileEntry
	err := m.withManifest(p.SandboxID, false, func(_ *sandbox, man Manifest) error {
		var err error
		out, err = listManifest(man, p.Path)
		return err
	})
	return out, err
}

func (m *Manager) DialPort(context.Context, string, int) (net.Conn, error) {
	return nil, unsupported("a port")
}

// --- snapshots ------------------------------------------------------------------------------------------------------

type snapshotMeta struct {
	proto.SnapshotInfo
	Owner string `json:"owner"`
}

func (m *Manager) snapshotDir(id string) string { return filepath.Join(m.cfg.Root, "snapshots", id) }

func (m *Manager) readSnapshot(id string) (snapshotMeta, error) {
	if !validID(id) {
		return snapshotMeta{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	raw, err := os.ReadFile(filepath.Join(m.snapshotDir(id), "meta.json"))
	if err != nil {
		return snapshotMeta{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no snapshot %s on this host", id)}
	}
	var out snapshotMeta
	return out, json.Unmarshal(raw, &out)
}

// saveSnapshot copies a sandbox's manifest. Called with s.mu held.
func (m *Manager) saveSnapshot(s *sandbox, snap *proto.SnapshotInfo) error {
	if !validID(snap.ID) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	dir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	man, err := readManifest(filepath.Join(s.dir, "manifest.json"))
	if err != nil {
		return err
	}
	for _, e := range man {
		snap.SizeBytes += e.Size
	}
	if err := writeJSONFile(filepath.Join(dir, "manifest.json"), man); err != nil {
		return err
	}
	return writeJSONFile(filepath.Join(dir, "meta.json"), snapshotMeta{SnapshotInfo: *snap, Owner: s.meta.Owner})
}

func (m *Manager) snapshotsOf(sandboxID string) []snapshotMeta {
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "snapshots"))
	var out []snapshotMeta
	for _, e := range entries {
		snap, err := m.readSnapshot(e.Name())
		if err == nil && (sandboxID == "" || snap.SandboxID == sandboxID) {
			out = append(out, snap)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

func (m *Manager) pruneAuto(sandboxID string) {
	auto := 0
	for _, snap := range m.snapshotsOf(sandboxID) {
		if snap.Kind != "auto" {
			continue
		}
		auto++
		if auto > m.cfg.AutoSnapshots {
			_ = os.RemoveAll(m.snapshotDir(snap.ID))
		}
	}
}

func (m *Manager) Snapshots(sandboxID string) []proto.SnapshotInfo {
	var out []proto.SnapshotInfo
	for _, snap := range m.snapshotsOf(sandboxID) {
		out = append(out, snap.SnapshotInfo)
	}
	return out
}

func (m *Manager) SaveSnapshot(_ context.Context, p proto.SnapshotParams) (proto.SnapshotInfo, error) {
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SnapshotInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := proto.SnapshotInfo{ID: p.SnapshotID, SandboxID: s.meta.ID, Kind: "saved", Name: p.Name, CreatedAt: time.Now().UnixMilli(), Tier: Tier}
	return snap, m.saveSnapshot(s, &snap)
}

func (m *Manager) DeleteSnapshot(id string) error {
	if _, err := m.readSnapshot(id); err != nil {
		return err
	}
	return os.RemoveAll(m.snapshotDir(id))
}

// HasSnapshot says whether a snapshot is this tier's.
func (m *Manager) HasSnapshot(id string) bool {
	_, err := m.readSnapshot(id)
	return err == nil
}

// SnapshotFiles lists a directory of a snapshot, for the console's file browser.
func (m *Manager) SnapshotFiles(id, p string) ([]proto.FileEntry, error) {
	if _, err := m.readSnapshot(id); err != nil {
		return nil, err
	}
	man, err := readManifest(filepath.Join(m.snapshotDir(id), "manifest.json"))
	if err != nil {
		return nil, err
	}
	if p == "" || p == "/" {
		p = "/workspace"
	}
	return listManifest(man, p)
}

// SnapshotRead reads a file of a snapshot.
func (m *Manager) SnapshotRead(id, p string) ([]byte, error) {
	snap, err := m.readSnapshot(id)
	if err != nil {
		return nil, err
	}
	man, err := readManifest(filepath.Join(m.snapshotDir(id), "manifest.json"))
	if err != nil {
		return nil, err
	}
	data, _, err := m.readFrom(snap.Owner, man, p)
	return data, err
}

func (m *Manager) Close() {
	m.closed.Store(true)
	close(m.stopReap)
	m.mu.Lock()
	rts := m.runtimes
	spare := m.spare
	m.runtimes, m.spare = map[string]*runtime{}, nil
	m.mu.Unlock()
	for _, r := range rts {
		r.close()
	}
	for _, r := range spare {
		r.close()
	}
}

// EgressOf answers a sandbox's egress as it keeps it in meta.json.
func (m *Manager) EgressOf(id string) (*proto.Egress, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Egress == nil {
		return nil, nil
	}
	e := *s.meta.Egress
	return &e, nil
}

// SetEgress replaces a sandbox's egress; the worker's next request sees it.
func (m *Manager) SetEgress(id string, e *proto.Egress) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Egress = e
	return writeJSONFile(filepath.Join(s.dir, "meta.json"), s.meta)
}
