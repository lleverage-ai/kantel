package agent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// templateTier is a tier that builds templates' snapshots: the microVM tier.
type templateTier interface {
	// CanBuildTemplates says whether the tier can build templates' images now (Docker on the host, answering).
	CanBuildTemplates(ctx context.Context) error
	// CanBuildTemplateImages says whether it builds templates' custom images in a build microVM (templateBuilder on,
	// and the guest agent injected). Facts report FeatureTemplateImageBuild while it does.
	CanBuildTemplateImages() error
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
// only onto the same two, so the control plane keys its template snapshots by them. And the host's CPU fingerprint:
// a snapshot's memory restores only onto the same CPU.
func (h *Host) withRuntime(f proto.Facts) proto.Facts {
	if t, ok := h.tiers[microvm.Tier]; ok {
		f.Firecracker = hostinfo.FirecrackerVersion(h.cfg.Firecracker)
		f.GuestKernel = hostinfo.GuestKernel(h.cfg.Kernel)
		if mv, ok := t.(*microvm.Manager); ok {
			f.CPU = mv.CPU()
		}
	}
	return f
}

// runtimes are the microVM tier's runtime fingerprints (Facts.Runtimes), for the host image versions it has now: an
// update adds one, and a prune takes one away. None without the tier.
func (h *Host) runtimes() []proto.HostRuntime {
	mv, ok := h.tiers[microvm.Tier].(*microvm.Manager)
	if !ok {
		return nil
	}
	var versions []string
	if h.cfg.ImagePatching {
		versions = imageStore(h.cfg).SandboxImages()
	}
	return mv.Runtimes(versions)
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

// TemplateBuilderConfig is the host's templateBuilder setting.
type TemplateBuilderConfig struct {
	// Registries are host patterns a custom image's build may reach besides the template's grants: the registries an
	// operator allows (`registry-1.docker.io`, `auth.docker.io`, `ghcr.io`) and the hosts their blobs redirect to
	// (`production.cloudflare.docker.com`, `pkg-containers.githubusercontent.com`). Every connection still goes through
	// the egress proxy, which refuses any address that isn't public.
	Registries []string `json:"registries,omitempty"`
}

// templateBuilder is the microVM tier's builder setting: nil while it is off.
func templateBuilder(c *TemplateBuilderConfig) *microvm.TemplateBuilderConfig {
	if c == nil {
		return nil
	}
	registries := []string{}
	for _, r := range c.Registries {
		if r = strings.TrimSpace(r); r != "" {
			registries = append(registries, r)
		}
	}
	return &microvm.TemplateBuilderConfig{Registries: registries}
}

// canBuildTemplateImages says whether the host builds templates' custom images in a build microVM now.
func (h *Host) canBuildTemplateImages() error {
	t, err := h.templateTier()
	if err != nil {
		return err
	}
	return t.CanBuildTemplateImages()
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
		// A custom image is built in a build microVM, which runs its own Docker: the host's isn't needed, or used.
		if p.Image != nil {
			if err := t.CanBuildTemplateImages(); err != nil {
				return nil, err
			}
		} else if err := t.CanBuildTemplates(ctx); err != nil {
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
