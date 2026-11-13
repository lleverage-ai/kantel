package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/netip"
	"slices"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeMesh records what the host asks of its mesh.
type fakeMesh struct {
	applied []*proto.WelcomeMesh
	peers   [][]proto.MeshPeer
	up      bool
}

func (f *fakeMesh) Facts() *proto.MeshFacts {
	return &proto.MeshFacts{PublicKey: "pub", ListenPort: 51820, Endpoints: []string{"192.0.2.1:51820"}}
}

func (f *fakeMesh) Apply(w *proto.WelcomeMesh) error {
	f.applied = append(f.applied, w)
	f.up = w != nil
	return nil
}

func (f *fakeMesh) SetPeers(peers []proto.MeshPeer) { f.peers = append(f.peers, peers) }

func (f *fakeMesh) Health() *proto.MeshHealth {
	if !f.up {
		return nil
	}
	return &proto.MeshHealth{Address: "fd4b::1", Peers: []proto.MeshPeerHealth{{HostID: "host_b", Path: proto.MeshPathDirect, RTTMs: 0.4}}}
}

func (f *fakeMesh) Prefix() (netip.Prefix, bool) {
	return netip.MustParsePrefix("fd4b::/48"), f.up
}

func (f *fakeMesh) Close() {}

// A host with the mesh says so in its hello, follows each welcome's mesh (down without one), takes mesh.peers, reports
// its peers' health while up, and keeps sandboxes' proxy off the mesh's prefix; one without says and does none of it.
func TestHostMesh(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	without := &Host{tiers: map[string]Tier{}, log: log}
	if f := without.makeFacts(); slices.Contains(f.Features, proto.FeatureMesh) || without.Facts().Mesh != nil {
		t.Fatal("a host without the mesh reports it")
	}
	without.applyWelcome(context.Background(), &proto.Welcome{Mesh: &proto.WelcomeMesh{Address: "fd4b::1", Prefix: "fd4b::/48"}}, nil)
	(&session{host: without}).text(context.Background(), proto.Message{Type: "mesh.peers"}, nil)
	if without.meshDenied() != nil {
		t.Fatal("a mesh prefix denied without a mesh")
	}

	m := &fakeMesh{}
	h := &Host{tiers: map[string]Tier{}, log: log, mesh: m}
	h.facts = h.makeFacts()
	f := h.Facts()
	if !slices.Contains(f.Features, proto.FeatureMesh) || f.Mesh == nil || f.Mesh.PublicKey != "pub" {
		t.Fatalf("facts: %v %+v", f.Features, f.Mesh)
	}
	raw, _ := json.Marshal(proto.Hello{Facts: f})
	var hello struct {
		Facts struct {
			Mesh map[string]any `json:"mesh"`
		} `json:"facts"`
	}
	if json.Unmarshal(raw, &hello) != nil || hello.Facts.Mesh["publicKey"] != "pub" || hello.Facts.Mesh["listenPort"] != float64(51820) {
		t.Fatalf("hello: %s", raw)
	}
	if h.Capacity().Mesh != nil || h.meshDenied() != nil {
		t.Fatal("health or a denied prefix before the mesh is up")
	}

	var welcome proto.Message
	if err := json.Unmarshal([]byte(`{"type":"welcome","welcome":{"hostId":"host_a","heartbeatSeconds":15,"mesh":{"address":"fd4b::1","prefix":"fd4b::/48","peers":[{"hostId":"host_b","publicKey":"k","address":"fd4b::2","endpoints":["192.0.2.2:51820"]}]}}}`), &welcome); err != nil {
		t.Fatal(err)
	}
	h.applyWelcome(context.Background(), welcome.Welcome, nil)
	if len(m.applied) != 1 || m.applied[0] == nil || m.applied[0].Peers[0].HostID != "host_b" || m.applied[0].Peers[0].Endpoints[0] != "192.0.2.2:51820" {
		t.Fatalf("applied: %+v", m.applied)
	}
	if c := h.Capacity(); c.Mesh == nil || c.Mesh.Peers[0].HostID != "host_b" {
		t.Fatalf("capacity: %+v", c.Mesh)
	}
	if d := h.meshDenied(); len(d) != 1 || d[0].String() != "fd4b::/48" {
		t.Fatalf("denied: %v", d)
	}

	var peers proto.Message
	if err := json.Unmarshal([]byte(`{"type":"mesh.peers","peers":[{"hostId":"host_c","publicKey":"c","address":"fd4b::3","endpoints":[]}]}`), &peers); err != nil {
		t.Fatal(err)
	}
	s := &session{host: h}
	s.text(context.Background(), peers, nil)
	s.text(context.Background(), proto.Message{Type: "mesh.peers"}, nil)
	if len(m.peers) != 2 || m.peers[0][0].HostID != "host_c" || len(m.peers[1]) != 0 {
		t.Fatalf("mesh.peers: %+v", m.peers)
	}

	// A welcome without a mesh (the pool's sync turned off, or a control plane without the mesh) takes it down.
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a"}, nil)
	if len(m.applied) != 2 || m.applied[1] != nil || h.Capacity().Mesh != nil {
		t.Fatalf("applied: %+v", m.applied)
	}
}
