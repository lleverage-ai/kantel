package agent

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// e2eTier holds sandboxes with owners and runs commands by echoing them.
type e2eTier struct {
	Tier
	mu     sync.Mutex
	owners map[string]string
	execs  []proto.ExecParams
}

func (f *e2eTier) Get(id string) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	owner, ok := f.owners[id]
	if !ok {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning, Owner: owner}, nil
}

func (f *e2eTier) List() []proto.SandboxInfo {
	out := []proto.SandboxInfo{}
	for id := range f.owners {
		info, _ := f.Get(id)
		out = append(out, info)
	}
	return out
}

func (f *e2eTier) Snapshots(sandboxID string) []proto.SnapshotInfo {
	if sandboxID == "sbx_one" {
		return []proto.SnapshotInfo{{ID: "snap_one", SandboxID: "sbx_one"}}
	}
	return nil
}

func (f *e2eTier) Exec(_ context.Context, p proto.ExecParams, _ func(string, string)) (proto.ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execs = append(f.execs, p)
	return proto.ExecResult{ExitCode: 0, Stdout: "ran: " + p.Command + "\n"}, nil
}

type sessionVector struct {
	Space        string      `json:"space"`
	HostID       string      `json:"hostId"`
	HostStatic   string      `json:"hostStatic"`
	DeviceStatic string      `json:"deviceStatic"`
	Entries      []e2e.Entry `json:"entries"`
}

// e2eHost is a host that joined the vectors' space (acc_org) as host_one, with sbx_one in that space and sbx_other in
// another.
func e2eHost(t *testing.T) (*Host, *e2eTier, sessionVector) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "e2e", "vectors", "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v sessionVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	tier := &e2eTier{owners: map[string]string{"sbx_one": v.Space, "sbx_other": "acc_plain"}}
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.cfg.HostID = v.HostID
	dir := filepath.Join(h.cfg.Root, "e2e")
	if h.e2e, err = e2e.OpenStore(dir); err != nil {
		t.Fatal(err)
	}
	write := func(path string, v any) {
		raw, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(dir, path), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("key.json", e2e.Seeds{Sign: e2e.NewSeeds().Sign, DH: v.HostStatic})
	write("spaces/"+v.Space+".json", map[string]any{"genesis": e2e.EntryHash(v.Entries[0]), "entries": v.Entries})
	return h, tier, v
}

func key(t *testing.T, seed string) *ecdh.PrivateKey {
	t.Helper()
	b, err := e2e.FromB64(seed)
	if err != nil {
		t.Fatal(err)
	}
	k, err := ecdh.X25519().NewPrivateKey(b)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// recorder is the relay: it passes the device's bytes on and keeps them, both ways.
type recorder struct {
	net.Conn
	mu   sync.Mutex
	seen bytes.Buffer
}

func (r *recorder) Read(p []byte) (int, error) {
	n, err := r.Conn.Read(p)
	r.mu.Lock()
	r.seen.Write(p[:n])
	r.mu.Unlock()
	return n, err
}

func (r *recorder) Write(p []byte) (int, error) {
	r.mu.Lock()
	r.seen.Write(p)
	r.mu.Unlock()
	return r.Conn.Write(p)
}

func TestTheGatewayCantReachAnE2ESpacesContent(t *testing.T) {
	h, tier, _ := e2eHost(t)
	refused := func(method string, params any) bool {
		raw, _ := json.Marshal(params)
		err := h.gatewayMayCall(method, raw)
		var pe *proto.Error
		return errors.As(err, &pe) && strings.Contains(pe.Message, "end-to-end encrypted")
	}
	for _, m := range []string{proto.MethodExec, proto.MethodFileRead, proto.MethodFileWrite, proto.MethodFileDelete, proto.MethodFileList} {
		if !refused(m, map[string]string{"sandboxId": "sbx_one"}) {
			t.Errorf("%s on an E2E sandbox wasn't refused", m)
		}
		if refused(m, map[string]string{"sandboxId": "sbx_other"}) {
			t.Errorf("%s on a sandbox in a space without E2E was refused", m)
		}
	}
	if !refused(proto.MethodPortOpen, map[string]any{"sandboxId": "sbx_one", "port": 22, "stream": 1}) {
		t.Error("a plaintext port on an E2E sandbox wasn't refused")
	}
	if refused(proto.MethodPortOpen, map[string]any{"sandboxId": "sbx_one", "port": 0, "stream": 1}) {
		t.Error("the E2E target was refused")
	}
	if !refused(proto.MethodSnapshotRead, map[string]any{"snapshotId": "snap_one", "path": "/etc/passwd"}) {
		t.Error("reading an E2E sandbox's snapshot wasn't refused")
	}
	if !refused(proto.MethodSnapshotTree, map[string]any{"snapshotId": "snap_gone", "path": "/"}) {
		t.Error("reading a snapshot of a sandbox that's gone wasn't refused on a host with an E2E space")
	}
	mustRefuse := func(params any) {
		raw, _ := json.Marshal(params)
		if h.gatewayMayCall(proto.MethodCreate, raw) == nil {
			t.Errorf("create %s wasn't refused", raw)
		}
	}
	// Out of the space with an E2E sandbox's disk, where plaintext calls would reach it.
	mustRefuse(map[string]any{"sandboxId": "sbx_copy", "from": "snap_one", "owner": "acc_plain"})
	mustRefuse(map[string]any{"sandboxId": "sbx_copy", "from": "snap_gone", "owner": "acc_plain"})
	if raw, _ := json.Marshal(map[string]any{"sandboxId": "sbx_copy", "from": "snap_one", "owner": "acc_org"}); h.gatewayMayCall(proto.MethodCreate, raw) != nil {
		t.Error("a create from a snapshot in the same space was refused")
	}
	for _, m := range []string{proto.MethodCreate, proto.MethodStop, proto.MethodGet, proto.MethodList} {
		if refused(m, map[string]string{"sandboxId": "sbx_one"}) {
			t.Errorf("lifecycle call %s was refused", m)
		}
	}
	if len(tier.execs) != 0 {
		t.Fatal("something ran")
	}
}

func TestAnE2ESessionRunsAMembersCommandAndTheRelaySeesCiphertext(t *testing.T) {
	h, tier, v := e2eHost(t)
	hostSide, deviceSide := net.Pipe()
	if err := h.serveE2E(context.Background(), hostSide, "sbx_one"); err != nil {
		t.Fatal(err)
	}
	relay := &recorder{Conn: deviceSide}
	_ = relay.SetDeadline(time.Now().Add(10 * time.Second))
	hostKey := key(t, v.HostStatic).PublicKey().Bytes()
	c, err := e2e.OpenClient(relay, key(t, v.DeviceStatic), hostKey, v.Space, v.HostID, "sbx_one", v.Entries)
	if err != nil {
		t.Fatal(err)
	}
	const secret = "cat /home/user/.env | grep OPENAI_API_KEY"
	// The session's sandbox, whatever the params name.
	raw, err := c.Call(proto.MethodExec, map[string]any{"sandboxId": "sbx_other", "command": secret})
	if err != nil {
		t.Fatal(err)
	}
	var res proto.ExecResult
	_ = json.Unmarshal(raw, &res)
	if res.Stdout != "ran: "+secret+"\n" || len(tier.execs) != 1 || tier.execs[0].SandboxID != "sbx_one" {
		t.Fatalf("result %+v, execs %+v", res, tier.execs)
	}
	if _, err := c.Call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_new"}); err == nil {
		t.Fatal("a lifecycle call ran in a session")
	}
	c.Close()
	for _, s := range []string{secret, "OPENAI_API_KEY", "ran: ", "sbx_one", "sandbox.exec"} {
		if bytes.Contains(relay.seen.Bytes(), []byte(s)) {
			t.Errorf("the relay saw %q", s)
		}
	}
}

func TestAnE2ESessionRefusesADeviceTheGatewayAdded(t *testing.T) {
	h, tier, v := e2eHost(t)
	hostSide, deviceSide := net.Pipe()
	if err := h.serveE2E(context.Background(), hostSide, "sbx_one"); err != nil {
		t.Fatal(err)
	}
	_ = deviceSide.SetDeadline(time.Now().Add(10 * time.Second))
	rogue, _ := e2e.IdentityFromSeeds(e2e.NewSeeds())
	hostKey := key(t, v.HostStatic).PublicKey().Bytes()
	_, err := e2e.OpenClient(deviceSide, rogue.Static, hostKey, v.Space, v.HostID, "sbx_one", v.Entries)
	if err == nil || !strings.Contains(err.Error(), "isn't in the space's chain") {
		t.Fatalf("opened: %v", err)
	}
	if len(tier.execs) != 0 {
		t.Fatal("something ran")
	}
}

// The gateway's chain with a device.add it signed with its own key, handed to the host in a session: the host refuses
// the entry, keeps its chain as it was, and runs nothing.
func TestAnE2ESessionRefusesAKeyTheGatewayInjectsIntoTheChain(t *testing.T) {
	h, tier, v := e2eHost(t)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "e2e", "vectors", "chain.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name    string      `json:"name"`
			Entries []e2e.Entry `json:"entries"`
		} `json:"cases"`
	}
	_ = json.Unmarshal(raw, &file)
	var forged []e2e.Entry
	for _, c := range file.Cases {
		if strings.HasPrefix(c.Name, "the gateway adds a device of its own") {
			forged = c.Entries
		}
	}
	if len(forged) != len(v.Entries)+1 {
		t.Fatalf("no forged case (%d entries)", len(forged))
	}
	before := h.e2e.Space(v.Space).State().Seq
	hostSide, deviceSide := net.Pipe()
	if err := h.serveE2E(context.Background(), hostSide, "sbx_one"); err != nil {
		t.Fatal(err)
	}
	_ = deviceSide.SetDeadline(time.Now().Add(10 * time.Second))
	rogue, _ := e2e.IdentityFromSeeds(e2e.NewSeeds())
	hostKey := key(t, v.HostStatic).PublicKey().Bytes()
	_, err = e2e.OpenClient(deviceSide, rogue.Static, hostKey, v.Space, v.HostID, "sbx_one", forged)
	if err == nil || !strings.Contains(err.Error(), "isn't a device in the chain") {
		t.Fatalf("opened: %v", err)
	}
	if after := h.e2e.Space(v.Space).State().Seq; after != before || len(tier.execs) != 0 {
		t.Fatalf("the chain moved to %d, or something ran", after)
	}
}

func TestAnE2ESessionIsForTheSandboxItWasRelayedFor(t *testing.T) {
	h, _, v := e2eHost(t)
	hostSide, deviceSide := net.Pipe()
	if err := h.serveE2E(context.Background(), hostSide, "sbx_one"); err != nil {
		t.Fatal(err)
	}
	_ = deviceSide.SetDeadline(time.Now().Add(10 * time.Second))
	hostKey := key(t, v.HostStatic).PublicKey().Bytes()
	_, err := e2e.OpenClient(deviceSide, key(t, v.DeviceStatic), hostKey, v.Space, v.HostID, "sbx_other", v.Entries)
	if err == nil || !strings.Contains(err.Error(), "another sandbox") {
		t.Fatalf("opened: %v", err)
	}
	if err := h.serveE2E(context.Background(), hostSide, "sbx_other"); err == nil {
		t.Fatal("served an E2E session for a space the host hasn't joined")
	}
}
