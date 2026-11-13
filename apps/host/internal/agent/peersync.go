package agent

// Peer sync (docs/design/disk-store.md, "2c. Peer sync"): while the host is in its pool's mesh, it serves the disk
// versions it holds to the pool's other hosts, on its mesh address, to those with a grant from the control plane.

import (
	"io/fs"
	"net/netip"
	"os"

	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// startPeerSync readies the peer sync server, with the mesh: it listens once a welcome brings the mesh up.
func (h *Host) startPeerSync() {
	if h.mesh == nil {
		return
	}
	h.peers = &disksync.Server{
		Source: peerSource{h},
		Self:   h.selfID,
		Key: func() string {
			if k := h.grantKey.Load(); k != nil {
				return *k
			}
			return ""
		},
		PeerAt: h.mesh.PeerAt,
		Log:    h.log.With("part", "peer-sync"),
	}
}

// selfID is the host's ID: the last welcome's, else its settings'.
func (h *Host) selfID() string {
	if id := h.welcomeID.Load(); id != nil && *id != "" {
		return *id
	}
	return h.cfg.HostID
}

// followPeerSync takes a welcome's grant key and host ID, and has the peer sync server listen on the mesh address while
// the mesh is up, and stop while it is down. A welcome without a key keeps the last one: the control plane's key
// doesn't change, and a welcome goes without it when the key couldn't be read just then.
func (h *Host) followPeerSync(w *proto.Welcome) {
	if key := w.GrantKey; key != "" {
		h.grantKey.Store(&key)
	}
	if id := w.HostID; id != "" {
		h.welcomeID.Store(&id)
	}
	if h.peers == nil {
		return
	}
	addr, up := h.mesh.Address()
	if !up {
		addr = netip.Addr{}
	}
	if err := h.peers.Serve(addr); err != nil {
		h.log.Error("the peer sync server couldn't listen", "error", err)
	}
}

// StickyServer is a tier whose sticky disk versions the host serves to its peers: the microVM tier.
type StickyServer interface {
	// OpenStickyVersion opens a version the host holds, and its map, for a peer to fetch (fs.ErrNotExist: not held).
	OpenStickyVersion(diskID, version string, withMap bool) (*os.File, []byte, error)
}

var _ StickyServer = (*microvm.Manager)(nil)

// peerSource is the versions the host holds, for its peers: sticky disks' on the microVM tier.
type peerSource struct{ h *Host }

func (s peerSource) Open(kind, objectID, version string, withMap bool) (*os.File, []byte, error) {
	sticky, ok := s.h.tiers[microvm.Tier].(StickyServer)
	if kind != "sticky" || !ok {
		return nil, nil, fs.ErrNotExist
	}
	return sticky.OpenStickyVersion(objectID, version, withMap)
}
