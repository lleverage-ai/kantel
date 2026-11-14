package kantel

import (
	"encoding/json"
	"testing"
)

// Moving a stopped sandbox to another host: kantel move, with --to, --drop-memory and --no-wait, and how a sandbox
// that is moving reads.

func TestMoveSendsWhatWasAsked(t *testing.T) {
	moved := func(call) any {
		return sandbox(map[string]any{"type": "microvm", "hostId": "hst_b", "hostName": "box-b"})
	}
	r := run(t, []string{"move", "sbx_test1", "--to", "hst_b"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/move": moved}})
	eq(t, "exit", r.Code, 0)
	got, _ := json.Marshal(r.Calls[0].Body)
	eq(t, "body", string(got), `{"hostId":"hst_b","wait":true}`)
	if r.Calls[0].Key == "" {
		t.Error("no Idempotency-Key on move")
	}
	contains(t, "out", r.Stdout, "Moved sbx_test1 (brisk-otter) to box-b")

	moving := func(call) any {
		return sandbox(map[string]any{"type": "microvm", "state": "moving", "move": map[string]any{"phase": "copying", "keepMemory": false, "startedAt": 1}})
	}
	r = run(t, []string{"move", "sbx_test1", "--drop-memory", "--no-wait"},
		opts{routes: routes{"POST /v1/sandboxes/sbx_test1/move": moving}})
	eq(t, "exit", r.Code, 0)
	got, _ = json.Marshal(r.Calls[0].Body)
	eq(t, "no-wait body", string(got), `{"keepMemory":false,"wait":false}`)
	contains(t, "out", r.Stdout, "sbx_test1 moving (copying)")

	r = run(t, []string{"move", "sbx_test1", "--wait", "--no-wait"}, opts{})
	eq(t, "refused", r.Code, 2)
	eq(t, "calls", len(r.Calls), 0)
}

// A move that kept its memory says so; one that restarted says why; a dry run lists each host's way and pause.
func TestMoveSaysWhatBecameOfItsMemory(t *testing.T) {
	kept := func(call) any {
		return sandbox(map[string]any{"type": "microvm", "hostId": "hst_b", "hostName": "box-b", "moved": map[string]any{"at": 1, "keptMemory": true}})
	}
	r := run(t, []string{"move", "sbx_test1"}, opts{routes: routes{"POST /v1/sandboxes/sbx_test1/move": kept}})
	eq(t, "exit", r.Code, 0)
	contains(t, "kept", r.Stdout, "Its memory moved with it")

	restarted := func(call) any {
		return sandbox(map[string]any{"type": "microvm", "hostId": "hst_b", "moved": map[string]any{"at": 1, "keptMemory": false, "restartReason": "Host box-b has another CPU than box-a"}})
	}
	r = run(t, []string{"move", "sbx_test1"}, opts{routes: routes{"POST /v1/sandboxes/sbx_test1/move": restarted}})
	contains(t, "restarted", r.Stdout, "Its memory couldn't move: Host box-b has another CPU than box-a.")

	plan := func(call) any {
		return map[string]any{"targets": []any{
			map[string]any{"hostId": "hst_b", "keepsMemory": true, "pauseMs": 4300, "memoryBytes": 536870912, "bytesPerSecond": 125000000, "rateMeasured": false},
			map[string]any{"hostId": "hst_c", "keepsMemory": false, "restartReason": "Host box-c has another CPU than box-a"},
		}}
	}
	r = run(t, []string{"move", "sbx_test1", "--dry-run"}, opts{routes: routes{"GET /v1/sandboxes/sbx_test1/move": plan}})
	eq(t, "exit", r.Code, 0)
	eq(t, "dry-run calls", len(r.Calls), 1)
	contains(t, "keeps", r.Stdout, "keeps memory")
	contains(t, "pause", r.Stdout, "about 4s (rate assumed)")
	contains(t, "restarts", r.Stdout, "restarts: Host box-c has another CPU than box-a")
}
