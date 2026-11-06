package agent

import (
	"context"
	"fmt"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Processes (sandbox.processes): a running sandbox's busiest processes, for the console's metrics dialog, which asks
// every few seconds while it is open.

// ProcessLister is a tier that lists a running sandbox's processes (the microVM tier, from its guest agent). A tier
// without it (isolates, which share their runtime with the account's others) answers the call as unsupported.
type ProcessLister interface {
	ListProcesses(ctx context.Context, p proto.ProcessesParams) (proto.ProcessList, error)
}

// listProcesses answers sandbox.processes from the tier holding the sandbox, its limit made one the guest takes.
func (h *Host) listProcesses(ctx context.Context, p proto.ProcessesParams) (proto.ProcessList, error) {
	t, name, err := h.tierOfNamed(p.SandboxID)
	if err != nil {
		return proto.ProcessList{}, err
	}
	lister, ok := t.(ProcessLister)
	if !ok {
		return proto.ProcessList{}, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't list their processes", name)}
	}
	if p.Limit < 0 {
		return proto.ProcessList{}, invalid("limit can't be negative")
	}
	if p.Limit == 0 {
		p.Limit = proto.DefaultProcesses
	}
	p.Limit = min(p.Limit, proto.MaxProcesses)
	list, err := lister.ListProcesses(ctx, p)
	if err != nil {
		return proto.ProcessList{}, err
	}
	if list.Processes == nil {
		list.Processes = []proto.Process{}
	}
	return list, nil
}

// listsProcesses says whether any of the host's tiers lists processes (FeatureProcesses).
func (h *Host) listsProcesses() bool {
	for _, name := range h.order {
		if _, ok := h.tiers[name].(ProcessLister); ok {
			return true
		}
	}
	return false
}
