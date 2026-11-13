package agent

import (
	"net/netip"
	"path/filepath"

	"github.com/lleverage-ai/kantel/apps/host/internal/mesh"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// hostMesh is the host's side of its pool's mesh (mesh.Mesh), an interface so tests can stand in for it.
type hostMesh interface {
	Facts() *proto.MeshFacts
	Apply(w *proto.WelcomeMesh) error
	SetPeers(peers []proto.MeshPeer)
	Health() *proto.MeshHealth
	Prefix() (netip.Prefix, bool)
	Address() (netip.Addr, bool)
	PeerAt(addr netip.Addr) (string, bool)
	Close()
}

// startMesh makes the host's mesh key (on its first start) and readies the mesh, unless MeshPort is -1 or the machine
// can't run it; then the host doesn't report FeatureMesh. The device comes up with a welcome's mesh.
func (h *Host) startMesh() {
	if h.cfg.MeshPort < 0 {
		return
	}
	if err := mesh.Available(); err != nil {
		h.log.Warn("no pool mesh on this host", "error", err)
		return
	}
	m, err := mesh.New(mesh.Config{
		Dir: filepath.Join(h.cfg.Root, "mesh"), Port: h.cfg.MeshPort, Endpoints: h.cfg.MeshEndpoints,
		Log: h.log.With("part", "mesh"),
	})
	if err != nil {
		h.log.Warn("no pool mesh on this host", "error", err)
		return
	}
	h.mesh = m
}

// meshDenied is the pool mesh's prefix while the host is in one (egress.Destinations.Denied).
func (h *Host) meshDenied() []netip.Prefix {
	if h.mesh == nil {
		return nil
	}
	if p, ok := h.mesh.Prefix(); ok {
		return []netip.Prefix{p}
	}
	return nil
}
