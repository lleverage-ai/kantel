package agent

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// processTier lists processes as a microVM's guest agent would, recording the limit each call asked for.
type processTier struct {
	*streamTier
	asked chan proto.ProcessesParams
	err   error
}

func (f processTier) ListProcesses(_ context.Context, p proto.ProcessesParams) (proto.ProcessList, error) {
	f.asked <- p
	if f.err != nil {
		return proto.ProcessList{}, f.err
	}
	return proto.ProcessList{
		Processes: []proto.Process{{PID: 812, Command: "yes", CPUPercent: 99.5, MemoryBytes: 1 << 20}},
		Total:     41, SampleMs: 500,
	}, nil
}

// sandbox.processes reaches a tier that lists processes, its limit defaulted and capped; it's unsupported on a tier that
// doesn't (an isolate's) and passes on the tier's own unsupported (an older guest agent's); the host reports processes
// only with such a tier.
func TestProcessesAreListedFromTheTier(t *testing.T) {
	ctx := context.Background()
	tier := processTier{newStreamTier(nil), make(chan proto.ProcessesParams, 4), nil}
	h := streamHost(t, tier)
	if !slices.Contains(h.makeFacts().Features, proto.FeatureProcesses) {
		t.Error("a host with a tier that lists processes didn't report processes")
	}
	if slices.Contains(streamHost(t, newStreamTier(nil)).makeFacts().Features, proto.FeatureProcesses) {
		t.Error("a host with no tier that lists processes reported processes")
	}
	call := func(h *Host, p proto.ProcessesParams) (any, error) {
		raw, _ := json.Marshal(p)
		return h.Call(ctx, proto.MethodProcesses, raw, nil)
	}

	got, err := call(h, proto.ProcessesParams{SandboxID: "sbx_one"})
	if err != nil {
		t.Fatal(err)
	}
	if asked := <-tier.asked; asked.SandboxID != "sbx_one" || asked.Limit != proto.DefaultProcesses {
		t.Fatalf("asked %+v", asked)
	}
	raw, _ := json.Marshal(got)
	var list proto.ProcessList
	if err := json.Unmarshal(raw, &list); err != nil || len(list.Processes) != 1 || list.Processes[0].Command != "yes" ||
		list.Total != 41 {
		t.Fatalf("answered %s", raw)
	}
	if want := `{"processes":[{"pid":812,"command":"yes","cpuPercent":99.5,"memoryBytes":1048576}],"total":41,"sampleMs":500}`; string(raw) != want {
		t.Fatalf("on the wire %s", raw)
	}
	if _, err := call(h, proto.ProcessesParams{SandboxID: "sbx_one", Limit: 1000}); err != nil {
		t.Fatal(err)
	}
	if asked := <-tier.asked; asked.Limit != proto.MaxProcesses {
		t.Fatalf("a limit of 1000 asked %d", asked.Limit)
	}

	var pe *proto.Error
	if _, err := call(h, proto.ProcessesParams{SandboxID: "sbx_one", Limit: -1}); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
		t.Fatalf("a negative limit: %v", err)
	}
	if _, err := call(h, proto.ProcessesParams{SandboxID: "sbx_gone"}); !errors.As(err, &pe) || pe.Code != proto.ErrNotFound {
		t.Fatalf("a sandbox the host hasn't: %v", err)
	}
	if _, err := call(streamHost(t, newStreamTier(nil)), proto.ProcessesParams{SandboxID: "sbx_one"}); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("a tier that doesn't list processes: %v", err)
	}
	old := processTier{newStreamTier(nil), make(chan proto.ProcessesParams, 1), &proto.Error{Code: proto.ErrUnsupported, Message: "older guest agent"}}
	if _, err := call(streamHost(t, old), proto.ProcessesParams{SandboxID: "sbx_one"}); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("an older guest agent: %v", err)
	}
}
