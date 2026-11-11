package kantel

// The MCP server: its JSON-RPC handshake, its tools and their arguments, and Kantel's errors as tool results
// (packages/cli/test/mcp.test.ts).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

func mcpSandbox(fields map[string]any) map[string]any {
	s := map[string]any{
		"id": "sbx_mcp1", "accountId": "acc_1", "name": "calm-heron", "subdomain": "calm-heron", "type": "isolate",
		"state": "running", "visibility": "private", "grants": []any{},
		"capabilities": map[string]any{"exec": true, "files": true, "ssh": false, "desktop": false, "browser": false,
			"ports": true, "docker": false, "kvm": false, "pause": false},
		"labels": map[string]any{}, "autoStopMinutes": 60, "createdBy": map[string]any{"kind": "api_key", "id": "key_1"},
		"createdAt": 0, "cost": map[string]any{"currency": "USD", "total": 0, "ratePerHour": 0},
		"usage": map[string]any{"runningSeconds": 0, "cpuSeconds": 0, "recentCpu": []any{}, "recentMemory": []any{}},
	}
	for k, v := range fields {
		s[k] = v
	}
	return s
}

func mcpCommandJSON(fields map[string]any) map[string]any {
	c := map[string]any{"id": "cmd_1", "sandboxId": "sbx_mcp1", "command": "echo hi", "state": "exited", "exitCode": 0,
		"stdout": "hi\n", "stderr": "", "truncated": false, "startedAt": 0, "durationMs": 12}
	for k, v := range fields {
		if v == nil {
			delete(c, k)
			continue
		}
		c[k] = v
	}
	return c
}

func runningCommand(fields map[string]any) map[string]any {
	base := map[string]any{"id": "cmd_long", "command": "make", "state": "running", "stdout": "", "exitCode": nil}
	for k, v := range fields {
		base[k] = v
	}
	return mcpCommandJSON(base)
}

func conflict(details map[string]any, message string) reply {
	return reply{Status: 409, Body: map[string]any{"error": map[string]any{"code": "conflict", "message": message, "details": details}}}
}

// mcpRoutes is a fake Kantel for the server; pollsUntilDone is how many polls cmd_long runs for.
func mcpRoutes(pollsUntilDone *atomic.Int64) routes {
	full := mcpSandbox(map[string]any{"id": "sbx_full", "state": "error",
		"reason": "No host can take a microVM of size default (full)", "placementReason": "insufficient_capacity"})
	return routes{
		"POST /v1/sandboxes": func(call) any { return mcpSandbox(nil) },
		"POST /v1/sandboxes/sbx_mcp1/commands": func(c call) any {
			if c.Body["detached"] == true {
				return runningCommand(nil)
			}
			return mcpCommandJSON(nil)
		},
		"POST /v1/sandboxes/sbx_slow/commands": func(call) any {
			time.Sleep(120 * time.Millisecond)
			return mcpCommandJSON(nil)
		},
		// Slow, like a request that can't be aborted.
		"POST /v1/sandboxes/sbx_slow/browser": func(call) any {
			time.Sleep(300 * time.Millisecond)
			return map[string]any{"url": "https://view.test", "cdpUrl": "wss://cdp.test", "embedUrl": "", "surface": "browser",
				"expiresAt": 0, "viewOnly": false}
		},
		"GET /v1/sandboxes/sbx_mcp1/commands/cmd_long": func(call) any {
			if pollsUntilDone.Add(-1) > 0 {
				return runningCommand(nil)
			}
			return runningCommand(map[string]any{"state": "exited", "exitCode": 0, "stdout": "built\n"})
		},
		"GET /v1/sandboxes/sbx_mcp1/commands": func(call) any {
			return map[string]any{"items": []any{runningCommand(map[string]any{"stdout": "lots"}), mcpCommandJSON(nil)}}
		},
		"GET /v1/sandboxes/sbx_many/commands": func(c call) any {
			if url.Values(c.Query).Get("cursor") == "c2" {
				return map[string]any{"items": []any{mcpCommandJSON(map[string]any{"id": "cmd_old"})}}
			}
			return map[string]any{"items": []any{mcpCommandJSON(map[string]any{"id": "cmd_new"})}, "nextCursor": "c2"}
		},
		"DELETE /v1/sandboxes/sbx_mcp1/commands/cmd_long": func(call) any {
			return runningCommand(map[string]any{"state": "killed", "exitCode": 137})
		},
		"GET /v1/sandboxes/sbx_gone": func(call) any { return kantelError(404, "not_found", "No such sandbox") },
		"POST /v1/sandboxes/sbx_held/commands": func(call) any {
			return conflict(map[string]any{"idempotencyKey": "held"},
				"A call with this Idempotency-Key didn't finish, so whether it took effect is unknown")
		},
		"POST /v1/sandboxes/sbx_stopped/commands": func(call) any {
			return conflict(map[string]any{"code": "sandbox_stopped", "sandboxId": "sbx_stopped", "state": "stopped",
				"stopReason": "auto-stop", "hint": "Resume it with kantel resume sbx_stopped or POST /v1/sandboxes/sbx_stopped/resume, then try again"},
				"The sandbox is stopped (auto-stop); resume it first")
		},
		"POST /v1/sandboxes/sbx_away/resume": func(call) any {
			return reply{Status: 503, Body: map[string]any{"error": map[string]any{"code": "unavailable",
				"message": "No host can run a microvm sandbox now", "details": map[string]any{"reason": "host_unavailable"}}}}
		},
		"GET /v1/sandboxes/sbx_full":         func(call) any { return full },
		"POST /v1/sandboxes/sbx_full/resume": func(call) any { return full },
		"POST /v1/sandboxes/sbx_starting/commands": func(call) any {
			return conflict(map[string]any{"code": "sandbox_starting", "sandboxId": "sbx_starting", "state": "starting",
				"hint": "It is still starting: send the call again in a moment"},
				"The sandbox is still starting after 60 seconds; send the call again")
		},
	}
}

type mcpFixture struct {
	server *mcpServer
	fake   *fake
	polls  *atomic.Int64
}

func newMCPFixture(t *testing.T, poll time.Duration) *mcpFixture {
	polls := &atomic.Int64{}
	f := newFake(t, mcpRoutes(polls))
	client := &api.Client{BaseURL: f.server.URL + "/v1", Token: "ksk_agent", HTTP: f.server.Client(),
		Sleep: func(context.Context, time.Duration) error { return nil }}
	s := newMCPServer(client, "1.2.3", "", nil)
	s.progressEvery, s.pollEvery = 20*time.Millisecond, poll
	return &mcpFixture{server: s, fake: f, polls: polls}
}

// message is v as the server gets it from a line of JSON.
func message(t *testing.T, v any) any {
	t.Helper()
	m, err := decodeJSON([]byte(jsonText(v)))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func request(id any, method string, params any) map[string]any {
	r := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		r["params"] = params
	}
	return r
}

func toolCall(id any, name string, args map[string]any) map[string]any {
	return request(id, "tools/call", map[string]any{"name": name, "arguments": args})
}

// generic is an answer as its JSON says it.
func generic(v any) map[string]any {
	if v == nil {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(jsonText(v)), &out)
	return out
}

func (f *mcpFixture) handle(t *testing.T, v any, notify func(any)) any {
	return f.server.handle(context.Background(), message(t, v), notify)
}

type callResult struct {
	text       string
	structured map[string]any
	isError    bool
}

func resultOf(t *testing.T, answer any) callResult {
	t.Helper()
	m := generic(answer)
	result, ok := m["result"].(map[string]any)
	if !ok || m["jsonrpc"] != "2.0" {
		t.Fatalf("not a result: %s", jsonText(answer))
	}
	var r callResult
	if content, ok := result["content"].([]any); ok && len(content) > 0 {
		r.text, _ = content[0].(map[string]any)["text"].(string)
	}
	r.structured, _ = result["structuredContent"].(map[string]any)
	r.isError, _ = result["isError"].(bool)
	return r
}

// jsonAt is a value inside parsed JSON, by keys and indexes.
func jsonAt(v any, keys ...any) any {
	for _, k := range keys {
		switch key := k.(type) {
		case string:
			m, _ := v.(map[string]any)
			v = m[key]
		case int:
			a, _ := v.([]any)
			if key >= len(a) {
				return nil
			}
			v = a[key]
		}
	}
	return v
}

func TestMCPInitialize(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	answer := generic(f.handle(t, request(1, "initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "test", "version": "0"}}), nil))
	eq(t, "id", answer["id"], any(float64(1)))
	eq(t, "protocol", jsonAt(answer, "result", "protocolVersion"), any("2025-03-26"))
	if jsonAt(answer, "result", "capabilities", "tools") == nil {
		t.Error("no tools capability")
	}
	eq(t, "name", jsonAt(answer, "result", "serverInfo", "name"), any("kantel"))
	eq(t, "version", jsonAt(answer, "result", "serverInfo", "version"), any("1.2.3"))
	contains(t, "instructions", jsonAt(answer, "result", "instructions").(string), "sandbox_create")
	unknown := generic(f.handle(t, request(2, "initialize", map[string]any{"protocolVersion": "1999-01-01"}), nil))
	eq(t, "newest", jsonAt(unknown, "result", "protocolVersion"), any(protocolVersions[0]))
}

func TestMCPNotificationsAndUnknownMethods(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	if a := f.handle(t, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, nil); a != nil {
		t.Errorf("a notification got %s", jsonText(a))
	}
	eq(t, "unknown", jsonAt(generic(f.handle(t, request(3, "resources/list", nil), nil)), "error", "code"), any(float64(-32601)))
	eq(t, "ping", jsonText(f.handle(t, request(4, "ping", nil), nil)), `{"jsonrpc":"2.0","id":4,"result":{}}`)
	// A response from the client gets nothing.
	if a := f.handle(t, map[string]any{"jsonrpc": "2.0", "id": 9, "result": map[string]any{}}, nil); a != nil {
		t.Errorf("a response got %s", jsonText(a))
	}
	eq(t, "not jsonrpc 2.0", jsonAt(generic(f.handle(t, map[string]any{"id": 5, "method": "ping"}, nil)), "error", "code"), any(float64(-32600)))
}

func TestMCPListsItsTools(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	tools, _ := jsonAt(generic(f.handle(t, request(5, "tools/list", nil), nil)), "result", "tools").([]any)
	var names, destructive []string
	for _, tool := range tools {
		names = append(names, jsonAt(tool, "name").(string))
		eq(t, "schema", jsonAt(tool, "inputSchema", "type"), any("object"))
		if jsonAt(tool, "annotations", "destructiveHint") == true {
			destructive = append(destructive, jsonAt(tool, "name").(string))
		}
	}
	want := []string{"sandbox_create", "sandbox_list", "sandbox_get", "sandbox_stop", "sandbox_resume", "sandbox_fork",
		"sandbox_delete", "sandbox_exec", "command_get", "command_list", "command_kill", "file_read", "file_write", "file_list",
		"port_expose", "snapshot_save", "snapshot_list", "browser_open", "desktop_open"}
	eq(t, "tools", strings.Join(names, " "), strings.Join(want, " "))
	eq(t, "destructive", strings.Join(destructive, " "), "sandbox_delete file_write")
	// Properties keep their order.
	listed := jsonText(f.handle(t, request(6, "tools/list", nil), nil))
	eq(t, "order", strings.Index(listed, `"type":{`) < strings.Index(listed, `"size":{`), true)
}

func TestMCPCreatesASandboxAndRunsACommand(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	// An agent has to choose a type: the API's default, an isolate, is rarely what one that left it out wants. A null
	// from is no snapshot either.
	untyped := resultOf(t, f.handle(t, toolCall(4, "sandbox_create", map[string]any{"labels": map[string]any{"task": "T-1"}}), nil))
	eq(t, "untyped isError", untyped.isError, true)
	contains(t, "untyped text", untyped.text, "type is required")
	nullFrom := resultOf(t, f.handle(t, toolCall(5, "sandbox_create", map[string]any{"from": nil}), nil))
	eq(t, "null from isError", nullFrom.isError, true)
	eq(t, "no calls", len(f.fake.Calls()), 0)
	created := resultOf(t, f.handle(t, toolCall(6, "sandbox_create", map[string]any{"type": "microvm", "labels": map[string]any{"task": "T-1"}}), nil))
	eq(t, "isError", created.isError, false)
	eq(t, "id", created.structured["id"], any("sbx_mcp1"))
	eq(t, "state", created.structured["state"], any("running"))
	contains(t, "lead", created.text, "Sandbox sbx_mcp1 (calm-heron) is running.")
	calls := f.fake.Calls()
	eq(t, "path", calls[0].Method+" "+calls[0].Path, "POST /v1/sandboxes")
	eq(t, "body", string(calls[0].Raw), `{"labels":{"task":"T-1"},"type":"microvm","wait":true}`)
	eq(t, "auth", calls[0].Auth, "Bearer ksk_agent")
	ran := resultOf(t, f.handle(t, toolCall(7, "sandbox_exec", map[string]any{"sandboxId": "sbx_mcp1", "command": "echo hi"}), nil))
	eq(t, "isError", ran.isError, false)
	eq(t, "exit code", ran.structured["exitCode"], any(float64(0)))
	eq(t, "stdout", ran.structured["stdout"], any("hi\n"))
	eq(t, "state", ran.structured["state"], any("exited"))
	contains(t, "text", ran.text, "exited with code 0")
	calls = f.fake.Calls()
	eq(t, "exec", calls[1].Path, "/v1/sandboxes/sbx_mcp1/commands")
	eq(t, "exec body", string(calls[1].Raw), `{"command":"echo hi"}`)
	// One made from a snapshot takes the snapshot's type, so it needs none.
	fromSnapshot := resultOf(t, f.handle(t, toolCall(8, "sandbox_create", map[string]any{"from": "base"}), nil))
	eq(t, "from isError", fromSnapshot.isError, false)
	eq(t, "from body", string(f.fake.Calls()[2].Raw), `{"from":"base","wait":true}`)
}

func TestMCPSendsANewIdempotencyKeyForEachExec(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	for i := 1; i <= 2; i++ {
		f.handle(t, toolCall(i, "sandbox_exec", map[string]any{"sandboxId": "sbx_mcp1", "command": "ls"}), nil)
	}
	calls := f.fake.Calls()
	uuid := regexp.MustCompile(`^[0-9a-f-]{36}$`)
	if len(calls) != 2 || !uuid.MatchString(calls[0].Key) || !uuid.MatchString(calls[1].Key) || calls[0].Key == calls[1].Key {
		t.Errorf("keys: %+v", calls)
	}
}

func TestMCPHeldKeySaysToCheckFirst(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	held := resultOf(t, f.handle(t, toolCall(11, "sandbox_exec", map[string]any{"sandboxId": "sbx_held", "command": "make"}), nil))
	eq(t, "isError", held.isError, true)
	contains(t, "text", held.text, "may have taken effect")
	if strings.Contains(held.text, "sandbox_resume") {
		t.Error("says to resume")
	}
}

func TestMCPKantelErrorsAreToolResults(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	missing := resultOf(t, f.handle(t, toolCall(8, "sandbox_get", map[string]any{"sandboxId": "sbx_gone"}), nil))
	eq(t, "isError", missing.isError, true)
	contains(t, "text", missing.text, "not_found: No such sandbox")
	stopped := resultOf(t, f.handle(t, toolCall(9, "sandbox_exec", map[string]any{"sandboxId": "sbx_stopped", "command": "ls"}), nil))
	eq(t, "isError", stopped.isError, true)
	contains(t, "text", stopped.text, "sandbox_resume")
	eq(t, "code", jsonAt(stopped.structured, "error", "code"), any("conflict"))
	eq(t, "details code", jsonAt(stopped.structured, "error", "details", "code"), any("sandbox_stopped"))
	eq(t, "details state", jsonAt(stopped.structured, "error", "details", "state"), any("stopped"))
	eq(t, "stop reason", jsonAt(stopped.structured, "error", "details", "stopReason"), any("auto-stop"))
	starting := resultOf(t, f.handle(t, toolCall(12, "sandbox_exec", map[string]any{"sandboxId": "sbx_starting", "command": "ls"}), nil))
	eq(t, "isError", starting.isError, true)
	contains(t, "text", starting.text, "call the tool again in a moment")
	if strings.Contains(starting.text, "sandbox_resume") {
		t.Error("says to resume a starting sandbox")
	}
}

func TestMCPNamesWhyASandboxCantBePlaced(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	away := resultOf(t, f.handle(t, toolCall(20, "sandbox_resume", map[string]any{"sandboxId": "sbx_away"}), nil))
	eq(t, "isError", away.isError, true)
	contains(t, "text", away.text, "unavailable (host_unavailable): No host can run a microvm sandbox now")
	contains(t, "hint", away.text, "Try again later")
	eq(t, "reason", jsonAt(away.structured, "error", "reason"), any("host_unavailable"))
	full := resultOf(t, f.handle(t, toolCall(21, "sandbox_resume", map[string]any{"sandboxId": "sbx_full"}), nil))
	eq(t, "isError", full.isError, false)
	contains(t, "text", full.text, "Sandbox sbx_full is error (insufficient_capacity): No host can take a microVM of size default (full)")
	contains(t, "hint", full.text, "The hosts are full now")
	got := resultOf(t, f.handle(t, toolCall(22, "sandbox_get", map[string]any{"sandboxId": "sbx_full"}), nil))
	contains(t, "text", got.text, "Sandbox sbx_full is error (insufficient_capacity)")
	contains(t, "hint", got.text, "The hosts are full now")
	eq(t, "id", got.structured["id"], any("sbx_full"))
	eq(t, "placement", got.structured["placementReason"], any("insufficient_capacity"))
}

func TestMCPRefusesBadArguments(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	missing := resultOf(t, f.handle(t, toolCall(10, "sandbox_exec", map[string]any{}), nil))
	eq(t, "isError", missing.isError, true)
	contains(t, "text", missing.text, "sandboxId is required")
	extra := resultOf(t, f.handle(t, toolCall(11, "sandbox_get", map[string]any{"sandboxId": "x", "nope": 1}), nil))
	eq(t, "extra", extra.isError, true)
	wrongType := resultOf(t, f.handle(t, toolCall(12, "sandbox_create", map[string]any{"type": "vm"}), nil))
	eq(t, "wrong type", wrongType.isError, true)
	fraction := resultOf(t, f.handle(t, toolCall(14, "sandbox_fork", map[string]any{"sandboxId": "x", "count": 1.5}), nil))
	contains(t, "fraction", fraction.text, "count must be a whole number")
	tooMany := resultOf(t, f.handle(t, toolCall(15, "sandbox_fork", map[string]any{"sandboxId": "x", "count": 51}), nil))
	contains(t, "maximum", tooMany.text, "count must be at most 50")
	notObject := resultOf(t, f.handle(t, request(16, "tools/call", map[string]any{"name": "sandbox_list", "arguments": []any{}}), nil))
	contains(t, "not an object", notObject.text, "arguments must be an object")
	eq(t, "calls", len(f.fake.Calls()), 0)
	eq(t, "unknown tool", jsonAt(generic(f.handle(t, request(13, "tools/call", map[string]any{"name": "no_such_tool"}), nil)), "error", "code"),
		any(float64(-32602)))
}

func TestMCPAnswersABatch(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	answers := f.handle(t, []any{request(14, "ping", nil), map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
		request(15, "ping", nil)}, nil)
	eq(t, "batch", jsonText(answers), `[{"jsonrpc":"2.0","id":14,"result":{}},{"jsonrpc":"2.0","id":15,"result":{}}]`)
	eq(t, "empty", jsonAt(generic(f.handle(t, []any{}, nil)), "error", "code"), any(float64(-32600)))
}

type notes struct {
	mu   sync.Mutex
	list []map[string]any
}

func (n *notes) add(v any) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.list = append(n.list, generic(v))
}

func (n *notes) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.list)
}

func TestMCPReportsProgressWithAToken(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var got notes
	answer := f.handle(t, request(30, "tools/call", map[string]any{"name": "sandbox_exec",
		"arguments": map[string]any{"sandboxId": "sbx_slow", "command": "make"}, "_meta": map[string]any{"progressToken": "tok-1"}}), got.add)
	eq(t, "state", resultOf(t, answer).structured["state"], any("exited"))
	if got.count() < 2 {
		t.Fatalf("progress notes: %d", got.count())
	}
	last := 0.0
	for _, n := range got.list {
		eq(t, "method", n["method"], any("notifications/progress"))
		eq(t, "token", jsonAt(n, "params", "progressToken"), any("tok-1"))
		p := jsonAt(n, "params", "progress").(float64)
		if p <= last {
			t.Errorf("progress %v after %v", p, last)
		}
		last = p
	}
	contains(t, "message", jsonAt(got.list[0], "params", "message").(string), "sandbox_exec")
	sent := got.count()
	time.Sleep(60 * time.Millisecond)
	eq(t, "none after the answer", got.count(), sent)
}

func TestMCPEndsACancelledCallAtOnce(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var got notes
	started := time.Now()
	done := make(chan any)
	go func() {
		done <- f.handle(t, request(40, "tools/call", map[string]any{"name": "browser_open",
			"arguments": map[string]any{"sandboxId": "sbx_slow"}, "_meta": map[string]any{"progressToken": "b"}}), got.add)
	}()
	time.Sleep(50 * time.Millisecond)
	if a := f.handle(t, map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 40}}, nil); a != nil {
		t.Errorf("the cancellation got %s", jsonText(a))
	}
	if a := <-done; a != nil {
		t.Errorf("a cancelled call got %s", jsonText(a))
	}
	if d := time.Since(started); d > 250*time.Millisecond {
		t.Errorf("took %v", d)
	}
	sent := got.count()
	time.Sleep(60 * time.Millisecond)
	eq(t, "no progress after", got.count(), sent)
}

func TestMCPCancelStopsCommandGetBetweenPolls(t *testing.T) {
	f := newMCPFixture(t, time.Second)
	f.polls.Store(1000)
	started := time.Now()
	done := make(chan any)
	go func() {
		done <- f.handle(t, toolCall(41, "command_get", map[string]any{"sandboxId": "sbx_mcp1", "commandId": "cmd_long", "waitMs": 60000}), nil)
	}()
	// Its first pause between polls is 250 ms: cancel in the middle of it.
	time.Sleep(50 * time.Millisecond)
	f.handle(t, map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 41}}, nil)
	if a := <-done; a != nil {
		t.Errorf("a cancelled call got %s", jsonText(a))
	}
	if d := time.Since(started); d > 200*time.Millisecond {
		t.Errorf("took %v", d)
	}
	time.Sleep(300 * time.Millisecond)
	n := 0
	for _, c := range f.fake.Calls() {
		if strings.HasSuffix(c.Path, "/cmd_long") {
			n++
		}
	}
	eq(t, "polls", n, 1)
}

func TestMCPNoProgressWithoutAToken(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var got notes
	f.handle(t, toolCall(31, "sandbox_exec", map[string]any{"sandboxId": "sbx_slow", "command": "make"}), got.add)
	eq(t, "notes", got.count(), 0)
}

func TestMCPCancelledStopsTheWaitNotTheCommand(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var got notes
	done := make(chan any)
	go func() {
		done <- f.handle(t, request(32, "tools/call", map[string]any{"name": "sandbox_exec",
			"arguments": map[string]any{"sandboxId": "sbx_slow", "command": "make"}, "_meta": map[string]any{"progressToken": 7}}), got.add)
	}()
	time.Sleep(10 * time.Millisecond)
	f.handle(t, map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 32, "reason": "timeout"}}, nil)
	if a := <-done; a != nil {
		t.Errorf("a cancelled call got %s", jsonText(a))
	}
	after := got.count()
	time.Sleep(50 * time.Millisecond)
	eq(t, "no progress after", got.count(), after)
	for _, c := range f.fake.Calls() {
		if c.Method == "DELETE" {
			t.Error("killed the command")
		}
	}
}

func TestMCPDetachedCommand(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	started := resultOf(t, f.handle(t, toolCall(33, "sandbox_exec", map[string]any{"sandboxId": "sbx_mcp1", "command": "make", "detached": true}), nil))
	eq(t, "isError", started.isError, false)
	eq(t, "structured", jsonText(started.structured), `{"commandId":"cmd_long","state":"running"}`)
	contains(t, "text", started.text, "command_get")
	eq(t, "body", string(f.fake.Calls()[0].Raw), `{"command":"make","detached":true}`)
	capped := resultOf(t, f.handle(t, toolCall(34, "sandbox_exec", map[string]any{"sandboxId": "sbx_mcp1", "command": "make", "detached": true, "timeoutMs": 1000}), nil))
	eq(t, "isError", capped.isError, false)
	got := map[string]any{}
	_ = json.Unmarshal(f.fake.Calls()[1].Raw, &got)
	eq(t, "capped body", jsonText(got), `{"command":"make","detached":true,"timeoutMs":1000}`)
	described := map[string]string{}
	for _, d := range toolDefinitions() {
		described[d.Name] = d.Description
	}
	contains(t, "exec", described["sandbox_exec"], "no time limit unless you give it a timeoutMs")
	contains(t, "exec", described["sandbox_exec"], "predates exec-control still ends it after about 2 minutes")
	contains(t, "kill", described["command_kill"], "Kill a running command and the processes it started")
	contains(t, "kill", described["command_kill"], "predates exec-control it is only marked killed")
}

func TestMCPCommandGetWaits(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	f.polls.Store(3)
	done := resultOf(t, f.handle(t, toolCall(35, "command_get", map[string]any{"sandboxId": "sbx_mcp1", "commandId": "cmd_long", "waitMs": 5000}), nil))
	eq(t, "state", done.structured["state"], any("exited"))
	eq(t, "exit", done.structured["exitCode"], any(float64(0)))
	eq(t, "stdout", done.structured["stdout"], any("built\n"))
	n := 0
	for _, c := range f.fake.Calls() {
		if strings.HasSuffix(c.Path, "/cmd_long") {
			n++
		}
	}
	eq(t, "polls", n, 3)
}

func TestMCPCommandStillRunning(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	f.polls.Store(1000)
	running := resultOf(t, f.handle(t, toolCall(36, "command_get", map[string]any{"sandboxId": "sbx_mcp1", "commandId": "cmd_long", "waitMs": 30}), nil))
	eq(t, "isError", running.isError, false)
	eq(t, "id", running.structured["commandId"], any("cmd_long"))
	eq(t, "state", running.structured["state"], any("running"))
	for _, want := range []string{"still running", "command_get", "command_kill"} {
		contains(t, "text", running.text, want)
	}
}

func TestMCPPagesThroughCommands(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	first := resultOf(t, f.handle(t, toolCall(42, "command_list", map[string]any{"sandboxId": "sbx_many", "limit": 1}), nil))
	eq(t, "first", jsonAt(first.structured, "items", 0, "commandId"), any("cmd_new"))
	eq(t, "cursor", first.structured["nextCursor"], any("c2"))
	contains(t, "text", first.text, "cursor c2")
	second := resultOf(t, f.handle(t, toolCall(43, "command_list", map[string]any{"sandboxId": "sbx_many", "limit": 1, "cursor": "c2"}), nil))
	eq(t, "second", second.text,
		`{"items":[{"commandId":"cmd_old","command":"echo hi","state":"exited","exitCode":0,"startedAt":0,"durationMs":12}]}`)
	if strings.Contains(second.text, "older commands") {
		t.Error("says there are more")
	}
	calls := f.fake.Calls()
	eq(t, "first query", url.Values(calls[0].Query).Encode(), "limit=1")
	eq(t, "second query", url.Values(calls[1].Query).Encode(), "cursor=c2&limit=1")
}

func TestMCPListsAndKillsCommands(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	listed := resultOf(t, f.handle(t, toolCall(37, "command_list", map[string]any{"sandboxId": "sbx_mcp1"}), nil))
	eq(t, "listed", listed.text, `{"items":[`+
		`{"commandId":"cmd_long","command":"make","state":"running","exitCode":null,"startedAt":0,"durationMs":12},`+
		`{"commandId":"cmd_1","command":"echo hi","state":"exited","exitCode":0,"startedAt":0,"durationMs":12}]}`)
	killed := resultOf(t, f.handle(t, toolCall(38, "command_kill", map[string]any{"sandboxId": "sbx_mcp1", "commandId": "cmd_long"}), nil))
	eq(t, "state", killed.structured["state"], any("killed"))
	contains(t, "text", killed.text, "The command was killed, and the processes it started with it.")
	eq(t, "calls", strings.Join(f.fake.Lines(), ", "), "GET /v1/sandboxes/sbx_mcp1/commands, DELETE /v1/sandboxes/sbx_mcp1/commands/cmd_long")
	eq(t, "default limit", url.Values(f.fake.Calls()[0].Query).Get("limit"), "20")
}

func TestClipOutput(t *testing.T) {
	long := "HEAD" + strings.Repeat("x", 200_000) + "TAIL"
	clipped := clipOutput(long)
	if len(clipped) >= 70_000 || !strings.HasPrefix(clipped, "HEAD") || !strings.HasSuffix(clipped, "TAIL") {
		t.Errorf("clipped to %d", len(clipped))
	}
	contains(t, "note", clipped, "characters cut here")
	eq(t, "short", clipOutput("short"), "short")
	// A command's output cut is said to be truncated.
	r := commandResult(api.Command{ID: "cmd_1", State: "exited", Stdout: long})
	eq(t, "truncated", r.StructuredContent.(commandStructured).Truncated, true)
}

func TestKilledCommandsAnswer(t *testing.T) {
	base := api.Command{ID: "cmd_k", SandboxID: "sbx_mcp1", Command: "./serve", State: "killed", ExitCode: api.Ptr(int64(137)), StartedAt: 1}
	text := func(c api.Command) string { return commandResult(c).Content[0].Text }
	contains(t, "killed", text(base), "The command was killed, and the processes it started with it.")
	old := base
	old.Stderr = "Kantel marked this command killed but couldn't stop it, so it may still be running: upgrade\n"
	contains(t, "old host", text(old), "its host couldn't stop it")
	contains(t, "old host", text(old), "pkill -f")
}

// Serving on stdio.

func stdioLines(messages ...any) string {
	var b strings.Builder
	for _, m := range messages {
		b.WriteString(jsonText(m) + "\n")
	}
	return b.String()
}

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) lines() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.b.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal([]byte(line), &m)
		out = append(out, m)
	}
	return out
}

func TestServeStdioAnswersEachRequest(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var out lockedBuffer
	text := stdioLines(request(1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}),
		map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, request(2, "tools/list", nil))
	// Split across writes, as a pipe may deliver it.
	r, w := io.Pipe()
	go func() {
		_, _ = io.WriteString(w, text[:len(text)/2])
		time.Sleep(5 * time.Millisecond)
		_, _ = io.WriteString(w, text[len(text)/2:])
		_ = w.Close()
	}()
	_ = serveMCP(context.Background(), f.server, r, &out, io.Discard)
	var ids []float64
	for _, m := range out.lines() {
		ids = append(ids, m["id"].(float64))
	}
	if len(ids) != 2 || ids[0]+ids[1] != 3 {
		t.Errorf("answers: %v", ids)
	}
}

func TestServeStdioProgressAndCancellation(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var out lockedBuffer
	call := func(id int) map[string]any {
		return request(id, "tools/call", map[string]any{"name": "sandbox_exec", "arguments": map[string]any{"sandboxId": "sbx_slow", "command": "make"},
			"_meta": map[string]any{"progressToken": "p" + string(rune('0'+id))}})
	}
	r, w := io.Pipe()
	go func() {
		_, _ = io.WriteString(w, stdioLines(call(1), call(2)))
		time.Sleep(30 * time.Millisecond)
		_, _ = io.WriteString(w, stdioLines(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 2}}))
		_ = w.Close()
	}()
	_ = serveMCP(context.Background(), f.server, r, &out, io.Discard)
	var answered []any
	progress := false
	for _, m := range out.lines() {
		if id, ok := m["id"]; ok {
			answered = append(answered, id)
		}
		if m["method"] == "notifications/progress" && jsonAt(m, "params", "progressToken") == "p1" {
			progress = true
		}
	}
	eq(t, "answered", jsonText(answered), "[1]")
	eq(t, "progress", progress, true)
}

func TestServeStdioParseError(t *testing.T) {
	f := newMCPFixture(t, 5*time.Millisecond)
	var out lockedBuffer
	_ = serveMCP(context.Background(), f.server, strings.NewReader("not json\n"), &out, io.Discard)
	lines := out.lines()
	if len(lines) != 1 || lines[0]["id"] != nil || jsonAt(lines[0], "error", "code") != float64(-32700) {
		t.Errorf("answer: %v", lines)
	}
}

func TestKantelMCPRunsOnStdio(t *testing.T) {
	polls := &atomic.Int64{}
	r := run(t, []string{"mcp"}, opts{routes: mcpRoutes(polls), stdin: stdioLines(
		request(1, "initialize", map[string]any{"protocolVersion": "2025-06-18"}),
		request(2, "tools/call", map[string]any{"name": "sandbox_create", "arguments": map[string]any{"type": "isolate"}}),
	)})
	eq(t, "exit", r.Code, 0)
	var answers []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(r.Stdout), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("stdout isn't JSON-RPC: %q", line)
		}
		answers = append(answers, m)
	}
	eq(t, "answers", len(answers), 2)
	for _, a := range answers {
		if a["id"] == float64(2) {
			eq(t, "created", jsonAt(a, "result", "structuredContent", "id"), any("sbx_mcp1"))
		}
	}
	eq(t, "auth", r.Calls[0].Auth, "Bearer ksk_test")
	eq(t, "stderr", r.Stderr, "")

	// With no key it says so on stderr, and still serves.
	r = run(t, []string{"mcp"}, opts{env: map[string]string{"KANTEL_URL": "$FAKE"}, stdin: stdioLines(request(1, "ping", nil))})
	eq(t, "exit", r.Code, 0)
	contains(t, "note", r.Stderr, "no API key is set")
	eq(t, "ping", strings.TrimSpace(r.Stdout), `{"jsonrpc":"2.0","id":1,"result":{}}`)
}

// A cancellation sent straight after its call, in the same read, always finds it: the call gets no answer.
func TestMCPCancellationRightAfterItsCall(t *testing.T) {
	for i := 0; i < 30; i++ {
		f := newMCPFixture(t, 5*time.Millisecond)
		in := jsonText(request(40, "tools/call", map[string]any{"name": "browser_open",
			"arguments": map[string]any{"sandboxId": "sbx_slow"}})) + "\n" +
			jsonText(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 40}}) + "\n"
		var out bytes.Buffer
		if err := serveMCP(context.Background(), f.server, strings.NewReader(in), &out, io.Discard); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), `"id":40`) {
			t.Fatalf("try %d: the cancelled call was answered: %s", i, out.String())
		}
	}
}
