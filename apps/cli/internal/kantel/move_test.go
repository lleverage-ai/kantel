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
