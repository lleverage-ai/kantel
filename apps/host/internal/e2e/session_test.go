package e2e

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memChain struct {
	mu    sync.Mutex
	state *State
}

func (c *memChain) State() *State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

func (c *memChain) Extend(from int, entries []Entry) (*State, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next, err := ExtendChain(c.state, entries, from)
	if err != nil {
		return nil, err
	}
	c.state = next
	return next, nil
}

type sessionVector struct {
	Space           string   `json:"space"`
	HostID          string   `json:"hostId"`
	HostStatic      string   `json:"hostStatic"`
	HostEphemeral   string   `json:"hostEphemeral"`
	DeviceStatic    string   `json:"deviceStatic"`
	DeviceEphemeral string   `json:"deviceEphemeral"`
	Entries         []Entry  `json:"entries"`
	HostSeq         int      `json:"hostSeq"`
	Device          []string `json:"device"`
	Host            []string `json:"host"`
	HostPlaintexts  []string `json:"hostPlaintexts"`
	DeviceID        string   `json:"deviceId"`
}

func unb64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := FromB64(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The Go host, fed the device's records from a TypeScript session, answers with the same bytes the TypeScript host did.
func TestSessionReplaysTheTypeScriptOne(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	known, err := VerifyChain(v.Entries[:v.HostSeq+1], "")
	if err != nil {
		t.Fatal(err)
	}
	chain := &memChain{state: known}
	host, relay := net.Pipe()
	var gotDevice Device
	var gotParams json.RawMessage
	served := make(chan error, 1)
	go func() {
		served <- Serve(context.Background(), host, ServeOptions{
			Static: x25519(t, unb64(t, v.HostStatic)), HostID: v.HostID, Chain: chain,
			Ephemeral: x25519(t, unb64(t, v.HostEphemeral)),
			RPC: func(_ context.Context, d Device, sandbox, method string, params json.RawMessage, _ func(any)) (any, error) {
				gotDevice, gotParams = d, params
				if sandbox != "sbx_one" || method != "sandbox.exec" {
					t.Errorf("called %s on %s", method, sandbox)
				}
				return json.RawMessage(`{"exitCode":0,"stdout":"hi\n","stderr":"","durationMs":3}`), nil
			},
		})
	}()
	_ = relay.SetDeadline(time.Now().Add(10 * time.Second))
	send := func(i int) {
		if _, err := relay.Write(frame2(unb64(t, v.Device[i]))); err != nil {
			t.Fatal(err)
		}
	}
	expect := func(i int) {
		rec, err := readRecord(relay)
		if err != nil {
			t.Fatal(err)
		}
		if B64(rec) != v.Host[i] {
			t.Fatalf("host record %d differs from the TypeScript host's", i)
		}
	}
	send(0)
	expect(0)
	send(1)
	expect(1)
	send(2)
	expect(2)
	relay.Close()
	<-served
	if gotDevice.ID != v.DeviceID || string(gotParams) != `{"command":"echo hi"}` {
		t.Fatalf("device %s, params %s", gotDevice.ID, gotParams)
	}
	if chain.State().Seq != len(v.Entries)-1 {
		t.Fatalf("the host didn't take the device's newer entries: seq %d", chain.State().Seq)
	}
}

// A device whose key isn't in the chain (one the gateway made) gets a refusal, and nothing runs.
func TestSessionRefusesAKeyNotInTheChain(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, err := VerifyChain(v.Entries, "")
	if err != nil {
		t.Fatal(err)
	}
	ran := false
	host, relay := net.Pipe()
	go Serve(context.Background(), host, ServeOptions{
		Static: x25519(t, unb64(t, v.HostStatic)), HostID: v.HostID, Chain: &memChain{state: state},
		RPC: func(context.Context, Device, string, string, json.RawMessage, func(any)) (any, error) {
			ran = true
			return nil, nil
		},
	})
	_ = relay.SetDeadline(time.Now().Add(10 * time.Second))
	rogue := NewSeeds()
	id, _ := IdentityFromSeeds(rogue)
	in := &Initiator{Prologue: Prologue(v.Space, v.HostID), Static: id.Static, RemoteStatic: x25519(t, unb64(t, v.HostStatic)).PublicKey().Bytes()}
	m1, _ := in.WriteMessage1([]byte(`{"v":1,"sandbox":"sbx_one","op":"rpc"}`))
	relay.Write(frame2(m1))
	m2, _ := readRecord(relay)
	_, tr, err := in.ReadMessage2(m2)
	if err != nil {
		t.Fatal(err)
	}
	s := &secure{conn: relay, t: tr}
	if err := s.send(map[string]string{"type": "open"}); err != nil {
		t.Fatal(err)
	}
	raw, err := s.next()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"refused"`) || !strings.Contains(string(raw), "isn't in the space's chain") {
		t.Fatalf("answer %s", raw)
	}
	if ran {
		t.Fatal("a call ran")
	}
}

// The gateway can't answer as the host: it doesn't hold the host's static key, so the device's first message is
// unreadable to it, and a second message it makes up fails at the device.
func TestSessionAnsweredByTheWrongKeyFails(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, _ := VerifyChain(v.Entries, "")
	impostor, _ := IdentityFromSeeds(NewSeeds())
	host, relay := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- Serve(context.Background(), host, ServeOptions{Static: impostor.Static, HostID: v.HostID, Chain: &memChain{state: state}})
	}()
	_ = relay.SetDeadline(time.Now().Add(10 * time.Second))
	relay.Write(frame2(unb64(t, v.Device[0])))
	if err := <-done; err == nil || !strings.Contains(err.Error(), "handshake") {
		t.Fatalf("served: %v", err)
	}
	if _, err := readRecord(relay); err == nil {
		t.Fatal("the impostor answered")
	}
}

// openSession runs Serve on chain and opens a session as the vector's device, for op ("rpc" or "port").
func openSession(t *testing.T, chain *memChain, o ServeOptions, op string) (*secure, chan error) {
	t.Helper()
	var v sessionVector
	readVector(t, "session.json", &v)
	host, relay := net.Pipe()
	o.Static, o.HostID, o.Chain = x25519(t, unb64(t, v.HostStatic)), v.HostID, chain
	served := make(chan error, 1)
	go func() { served <- Serve(context.Background(), host, o) }()
	_ = relay.SetDeadline(time.Now().Add(10 * time.Second))
	in := &Initiator{Prologue: Prologue(v.Space, v.HostID), Static: x25519(t, unb64(t, v.DeviceStatic)), RemoteStatic: x25519(t, unb64(t, v.HostStatic)).PublicKey().Bytes()}
	hello := `{"v":1,"sandbox":"sbx_one","op":"rpc"}`
	if op == "port" {
		hello = `{"v":1,"sandbox":"sbx_one","op":"port","port":8080}`
	}
	m1, _ := in.WriteMessage1([]byte(hello))
	relay.Write(frame2(m1))
	m2, _ := readRecord(relay)
	_, tr, err := in.ReadMessage2(m2)
	if err != nil {
		t.Fatal(err)
	}
	s := &secure{conn: relay, t: tr}
	if err := s.send(map[string]string{"type": "open"}); err != nil {
		t.Fatal(err)
	}
	if raw, err := s.next(); err != nil || !strings.Contains(string(raw), `"ready"`) {
		t.Fatalf("open: %s %v", raw, err)
	}
	return s, served
}

// removed is state without device id, as a remove-device entry leaves it.
func removed(state *State, id string) *State {
	next := state.clone()
	delete(next.Devices, id)
	return next
}

// A device removed while its session is open gets no further call, and its session ends.
func TestARemovalEndsAnOpenSession(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, err := VerifyChain(v.Entries, "")
	if err != nil {
		t.Fatal(err)
	}
	chain := &memChain{state: state}
	calls := 0
	s, served := openSession(t, chain, ServeOptions{RPC: func(context.Context, Device, string, string, json.RawMessage, func(any)) (any, error) {
		calls++
		return map[string]bool{"ok": true}, nil
	}}, "rpc")
	call := func(id int) string {
		if err := s.send(map[string]any{"id": id, "method": "sandbox.get"}); err != nil {
			return err.Error()
		}
		raw, err := s.next()
		if err != nil {
			return err.Error()
		}
		return string(raw)
	}
	if got := call(1); !strings.Contains(got, `"ok":true`) {
		t.Fatalf("first call: %s", got)
	}
	chain.mu.Lock()
	chain.state = removed(state, v.DeviceID)
	chain.mu.Unlock()
	if got := call(2); !strings.Contains(got, "forbidden") {
		t.Fatalf("a call after the removal: %s", got)
	}
	if err := <-served; err == nil {
		t.Fatal("the session didn't end")
	}
	if calls != 1 {
		t.Fatalf("%d calls ran", calls)
	}
}

// A port session is looked at again while it relays: a removal closes it.
func TestARemovalClosesAnOpenPort(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, _ := VerifyChain(v.Entries, "")
	chain := &memChain{state: state}
	target, app := net.Pipe()
	defer app.Close()
	_, served := openSession(t, chain, ServeOptions{Revalidate: 20 * time.Millisecond, Port: func(context.Context, Device, string, int) (net.Conn, error) {
		return target, nil
	}}, "port")
	select {
	case <-served:
		t.Fatal("the port closed while the device was still let in")
	case <-time.After(100 * time.Millisecond):
	}
	chain.mu.Lock()
	chain.state = removed(state, v.DeviceID)
	chain.mu.Unlock()
	select {
	case err := <-served:
		if err == nil || !strings.Contains(err.Error(), "isn't in the space's chain") {
			t.Fatalf("ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the port stayed open after the removal")
	}
}

// A chain that stops verifying refuses the session rather than panicking.
func TestNoChainRefusesTheSession(t *testing.T) {
	host, relay := net.Pipe()
	defer relay.Close()
	var v sessionVector
	readVector(t, "session.json", &v)
	err := Serve(context.Background(), host, ServeOptions{Static: x25519(t, unb64(t, v.HostStatic)), HostID: v.HostID, Chain: &memChain{}})
	if err == nil {
		t.Fatal("a session was served without a chain")
	}
}

// A removal ends a session while a call runs, with no further request: the call's context is cancelled.
func TestARemovalEndsACallInFlight(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, _ := VerifyChain(v.Entries, "")
	chain := &memChain{state: state}
	started, stopped := make(chan struct{}), make(chan struct{})
	s, served := openSession(t, chain, ServeOptions{Revalidate: 20 * time.Millisecond, RPC: func(ctx context.Context, _ Device, _, _ string, _ json.RawMessage, emit func(any)) (any, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	}}, "rpc")
	if err := s.send(map[string]any{"id": 1, "method": "sandbox.exec"}); err != nil {
		t.Fatal(err)
	}
	<-started
	chain.mu.Lock()
	chain.state = removed(state, v.DeviceID)
	chain.mu.Unlock()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the call ran on after the removal")
	}
	if err := <-served; err == nil || !strings.Contains(err.Error(), "isn't in the space's chain") {
		t.Fatalf("ended with %v", err)
	}
}

// Authorize is asked again as a session runs: when it stops letting the session reach its sandbox (E2E was turned off
// and on, retiring it), an open port closes and a call in flight ends, with no further request.
func TestAnAuthorizeThatNoLongerHoldsEndsPortsAndCalls(t *testing.T) {
	var v sessionVector
	readVector(t, "session.json", &v)
	state, _ := VerifyChain(v.Entries, "")
	chain := &memChain{state: state}
	var retired atomic.Bool
	authorize := func(Device, Hello) string {
		if retired.Load() {
			return "This sandbox was made while E2E was off"
		}
		return ""
	}
	target, app := net.Pipe()
	defer app.Close()
	_, port := openSession(t, chain, ServeOptions{Revalidate: 20 * time.Millisecond, Authorize: authorize, Port: func(context.Context, Device, string, int) (net.Conn, error) {
		return target, nil
	}}, "port")
	started, stopped := make(chan struct{}), make(chan struct{})
	s, call := openSession(t, chain, ServeOptions{Revalidate: 20 * time.Millisecond, Authorize: authorize, RPC: func(ctx context.Context, _ Device, _, _ string, _ json.RawMessage, emit func(any)) (any, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	}}, "rpc")
	if err := s.send(map[string]any{"id": 1, "method": "sandbox.exec"}); err != nil {
		t.Fatal(err)
	}
	<-started
	select {
	case <-port:
		t.Fatal("the port closed while its sandbox was still let in")
	case <-stopped:
		t.Fatal("the call ended while its sandbox was still let in")
	case <-time.After(100 * time.Millisecond):
	}
	retired.Store(true)
	for name, served := range map[string]chan error{"port": port, "call": call} {
		select {
		case err := <-served:
			if err == nil || !strings.Contains(err.Error(), "made while E2E was off") {
				t.Fatalf("%s ended with %v", name, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("the %s ran on after its sandbox was retired", name)
		}
	}
	<-stopped
}
