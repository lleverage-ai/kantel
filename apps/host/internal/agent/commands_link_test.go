package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// linkTier is a heldTier the whole link (Run) can report on: no usage, no template builds.
type linkTier struct{ *heldTier }

func (linkTier) Usage() (int64, int, int)                 { return 0, 0, 0 }
func (linkTier) TemplateBuilds() ([]string, int64, int64) { return nil, 0, 0 }

// takeoverHub is a control plane for kantel-host's whole link that plays one script per connection, as the gateway would
// across a newer connection for the host taking over (#703): call sends a call on that connection and answers its
// result, and takeOver closes it as the gateway's hub does when the host's next connection arrives.
type takeoverHub struct {
	mu     sync.Mutex
	conns  int
	script []func(call func(method string, params any) (proto.Message, error), takeOver func())
}

func (u *takeoverHub) serve(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()
	if _, _, err := c.Read(ctx); err != nil { // the hello
		return
	}
	welcome, _ := json.Marshal(proto.Message{Type: "welcome", Welcome: &proto.Welcome{HostID: "host_a", HeartbeatSeconds: 60}})
	if c.Write(ctx, websocket.MessageText, welcome) != nil {
		return
	}
	u.mu.Lock()
	n := u.conns
	u.conns++
	u.mu.Unlock()
	if n >= len(u.script) {
		<-ctx.Done()
		return
	}
	id := 0
	call := func(method string, params any) (proto.Message, error) {
		id++
		raw, _ := json.Marshal(params)
		m, _ := json.Marshal(proto.Message{Type: "call", ID: "c" + strconv.Itoa(id), Method: method, Params: raw})
		if err := c.Write(ctx, websocket.MessageText, m); err != nil {
			return proto.Message{}, err
		}
		for {
			_, frame, err := c.Read(ctx)
			if err != nil {
				return proto.Message{}, err
			}
			var got proto.Message
			if json.Unmarshal(frame, &got) == nil && got.Type == "result" {
				return got, nil
			}
		}
	}
	takeOver := func() { _ = c.Close(4008, "A newer connection for the host took over") }
	u.script[n](call, takeOver)
	<-ctx.Done()
}

// A foreground command with Kantel's ID is running when a newer connection for its host takes over the old one: it
// runs on to its end, and the control plane asks for it on the next connection and gets its result.
func TestAForegroundCommandRunsOnWhenANewerConnectionTakesOver(t *testing.T) {
	tier := linkTier{newHeldTier()}
	ended := make(chan proto.ExecStatus, 1)
	failed := make(chan error, 1)
	hub := &takeoverHub{}
	hub.script = []func(func(string, any) (proto.Message, error), func()){
		func(call func(string, any) (proto.Message, error), takeOver func()) {
			go func() {
				_, _ = call(proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "pnpm install", CommandID: "cmd_fg", TimeoutMs: 600_000})
			}()
			select {
			case <-tier.started:
			case <-time.After(5 * time.Second):
				failed <- context.DeadlineExceeded
				return
			}
			takeOver()
		},
		func(call func(string, any) (proto.Message, error), _ func()) {
			// The new connection: the command is still running, then its end is answered by its ID.
			got, err := call(proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_fg"})
			if err != nil || got.Error != nil {
				failed <- errorOf(err, got)
				return
			}
			var status proto.ExecStatus
			_ = json.Unmarshal(got.Result, &status)
			if status.State != proto.ExecRunning {
				ended <- status
				return
			}
			tier.release <- proto.ExecResult{ExitCode: 0, Stdout: "Done in 42s\n"}
			got, err = call(proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_fg", WaitMs: 5000})
			if err != nil || got.Error != nil {
				failed <- errorOf(err, got)
				return
			}
			_ = json.Unmarshal(got.Result, &status)
			ended <- status
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(hub.serve))
	t.Cleanup(srv.Close)
	h := hostWith(t, tier)
	h.cfg.ControlPlane, h.cfg.Credential, h.cfg.HostID, h.version = srv.URL, "khc_test", "host_a", "test"
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.Run(ctx, nil)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	select {
	case status := <-ended:
		if status.State != proto.ExecEnded || status.Result == nil || status.Result.Stdout != "Done in 42s\n" {
			t.Fatalf("after the takeover: %+v", status)
		}
	case err := <-failed:
		t.Fatalf("after the takeover: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("no answer after the takeover")
	}
}

func errorOf(err error, m proto.Message) error {
	if err != nil {
		return err
	}
	return m.Error
}
