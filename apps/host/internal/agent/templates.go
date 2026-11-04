package agent

import (
	"context"
	"encoding/json"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// templateTier is a tier that builds templates' snapshots: the microVM tier.
type templateTier interface {
	// CanBuildTemplates says whether the tier can build templates' images now (Docker on the host, answering).
	CanBuildTemplates(ctx context.Context) error
	// TemplateBuildMachine is the machine a build boots; ErrInvalid for one beyond the tier's custom shapes' limits.
	TemplateBuildMachine(p proto.TemplateBuildParams) (proto.Size, error)
	// BuildTemplate builds one, admitted against the host's budget (ErrCapacity without room) and counted in
	// TemplateBuilds until it returns.
	BuildTemplate(ctx context.Context, p proto.TemplateBuildParams) (proto.TemplateBuildResult, error)
	DeleteTemplate(id string) error
	// TemplateBuilds are the builds admitted and not yet ended (snapshot IDs), and the memory and disk they hold.
	TemplateBuilds() (ids []string, memoryMiB, diskGiB int64)
}

// withRuntime adds the microVM tier's Firecracker and guest kernel to the host's facts: a template snapshot restores
// only onto the same two, so the control plane keys its template snapshots by them.
func (h *Host) withRuntime(f proto.Facts) proto.Facts {
	if _, ok := h.tiers[microvm.Tier]; ok {
		f.Firecracker = hostinfo.FirecrackerVersion(h.cfg.Firecracker)
		f.GuestKernel = hostinfo.GuestKernel(h.cfg.Kernel)
	}
	return f
}

// canBuildTemplates says whether the host can build templates now: it runs the microVM tier and that can build their
// images. Facts report FeatureTemplateBuild while it can, and template.build is refused while it can't.
func (h *Host) canBuildTemplates(ctx context.Context) error {
	t, err := h.templateTier()
	if err != nil {
		return err
	}
	return t.CanBuildTemplates(ctx)
}

func (h *Host) templateTier() (templateTier, error) {
	t, ok := h.tiers[microvm.Tier].(templateTier)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't run microVMs, which templates make"}
	}
	return t, nil
}

// templateCall runs template.build and template.delete. The tier admits a build against the host's budget, beside its
// sandboxes and other builds, before its machine starts, and holds its memory and disk until BuildTemplate has
// returned, when its machine has gone, however it ended. Capacity counts it all that while, and names it (Builds), so
// every control plane's placement sees it, and the one that holds room for it stops when a report names it.
func (h *Host) templateCall(ctx context.Context, method string, params json.RawMessage) (any, error) {
	t, err := h.templateTier()
	if err != nil {
		return nil, err
	}
	switch method {
	case proto.MethodTemplateBuild:
		p, err := decode[proto.TemplateBuildParams](params)
		if err != nil {
			return nil, err
		}
		if err := t.CanBuildTemplates(ctx); err != nil {
			return nil, err
		}
		if _, err := t.TemplateBuildMachine(p); err != nil {
			return nil, err
		}
		// The build is a sandbox to the egress proxy, named after its snapshot, until its setup is done: the CA a grant
		// that intercepts needs is its own, and goes with it.
		h.requireProtected(p.SnapshotID, p.Egress)
		e, fresh, err := h.prepareEgress(microvm.Tier, p.SnapshotID, p.Egress)
		if err != nil {
			return nil, err
		}
		if fresh {
			defer func() { _ = h.cas.Forget(p.SnapshotID) }()
		}
		p.Egress = e
		return t.BuildTemplate(ctx, p)
	case proto.MethodTemplateDelete:
		p, err := decode[proto.TemplateDeleteParams](params)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, t.DeleteTemplate(p.SnapshotID)
	}
	return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "unknown method " + method}
}
