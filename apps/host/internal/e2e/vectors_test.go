package e2e

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The vectors are packages/e2e/vectors, made by the TypeScript (packages/e2e/test/vectors.ts): the Go host must agree
// with the devices on every verdict.
func readVector(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "e2e", "vectors", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func x25519(t *testing.T, seed []byte) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().NewPrivateKey(seed)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestNoiseMatchesCacophony(t *testing.T) {
	var file struct {
		Vector struct {
			Prologue      string `json:"init_prologue"`
			InitStatic    string `json:"init_static"`
			InitEphemeral string `json:"init_ephemeral"`
			RemoteStatic  string `json:"init_remote_static"`
			RespStatic    string `json:"resp_static"`
			RespEphemeral string `json:"resp_ephemeral"`
			HandshakeHash string `json:"handshake_hash"`
			Messages      []struct {
				Payload    string `json:"payload"`
				Ciphertext string `json:"ciphertext"`
			} `json:"messages"`
		} `json:"vector"`
	}
	readVector(t, "noise-ik.json", &file)
	v := file.Vector
	in := &Initiator{Prologue: unhex(t, v.Prologue), Static: x25519(t, unhex(t, v.InitStatic)), RemoteStatic: unhex(t, v.RemoteStatic), Ephemeral: x25519(t, unhex(t, v.InitEphemeral))}
	re := &Responder{Prologue: unhex(t, v.Prologue), Static: x25519(t, unhex(t, v.RespStatic)), Ephemeral: x25519(t, unhex(t, v.RespEphemeral))}
	m1, err := in.WriteMessage1(unhex(t, v.Messages[0].Payload))
	if err != nil || hex.EncodeToString(m1) != v.Messages[0].Ciphertext {
		t.Fatalf("message 1: %x, %v", m1, err)
	}
	rs, p1, err := re.ReadMessage1(m1)
	if err != nil || hex.EncodeToString(p1) != v.Messages[0].Payload || !bytes.Equal(rs, in.Static.PublicKey().Bytes()) {
		t.Fatalf("reading message 1: %v", err)
	}
	m2, rt, err := re.WriteMessage2(unhex(t, v.Messages[1].Payload))
	if err != nil || hex.EncodeToString(m2) != v.Messages[1].Ciphertext {
		t.Fatalf("message 2: %x, %v", m2, err)
	}
	p2, it, err := in.ReadMessage2(m2)
	if err != nil || hex.EncodeToString(p2) != v.Messages[1].Payload || hex.EncodeToString(it.HandshakeHash) != v.HandshakeHash {
		t.Fatalf("reading message 2: %v", err)
	}
	for i, m := range v.Messages[2:] {
		from, to := it.Send, rt.Receive
		if i%2 == 1 {
			from, to = rt.Send, it.Receive
		}
		sealed, _ := from.Encrypt(nil, unhex(t, m.Payload))
		if hex.EncodeToString(sealed) != m.Ciphertext {
			t.Fatalf("transport %d: %x", i, sealed)
		}
		if plain, err := to.Decrypt(nil, sealed); err != nil || hex.EncodeToString(plain) != m.Payload {
			t.Fatalf("transport %d back: %v", i, err)
		}
	}
	// The relay, holding its own key and not the host's, can't read the first message.
	impostor := &Responder{Prologue: unhex(t, v.Prologue), Static: x25519(t, unhex(t, v.InitEphemeral))}
	if _, _, err := impostor.ReadMessage1(m1); err == nil {
		t.Fatal("an impostor read the first message")
	}
}

type stateSummary struct {
	Space   string            `json:"space"`
	Genesis string            `json:"genesis"`
	Head    string            `json:"head"`
	Seq     int               `json:"seq"`
	Mode    string            `json:"mode"`
	OnSince string            `json:"onSince"`
	Members map[string]string `json:"members"`
	Devices []string          `json:"devices"`
	Hosts   []string          `json:"hosts"`
	Allowed map[string]bool   `json:"allowed"`
}

func summarise(s *State) stateSummary {
	out := stateSummary{Space: s.Space, Genesis: s.Genesis, Head: s.Head, Seq: s.Seq, Mode: s.Mode, OnSince: s.OnSince, Members: s.Members, Devices: []string{}, Hosts: []string{}, Allowed: map[string]bool{}}
	for id := range s.Devices {
		out.Devices = append(out.Devices, id)
		out.Allowed[id] = s.Allowed(id) == ""
	}
	for id := range s.Hosts {
		out.Hosts = append(out.Hosts, id)
	}
	slices.Sort(out.Devices)
	slices.Sort(out.Hosts)
	return out
}

func TestChainVectors(t *testing.T) {
	var file struct {
		Cases []struct {
			Name    string  `json:"name"`
			Entries []Entry `json:"entries"`
			Pin     string  `json:"pin"`
			Extend  *struct {
				Known []Entry `json:"known"`
				From  int     `json:"from"`
			} `json:"extend"`
			OK    bool          `json:"ok"`
			Seq   *int          `json:"seq"`
			State *stateSummary `json:"state"`
		} `json:"cases"`
	}
	readVector(t, "chain.json", &file)
	if len(file.Cases) < 10 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var state *State
			var err error
			if c.Extend == nil {
				state, err = VerifyChain(c.Entries, c.Pin)
			} else {
				var known *State
				if known, err = VerifyChain(c.Extend.Known, c.Pin); err != nil {
					t.Fatalf("the known chain: %v", err)
				}
				state, err = ExtendChain(known, c.Entries, c.Extend.From)
			}
			if !c.OK {
				var ce *ChainError
				if err == nil || !errors.As(err, &ce) {
					t.Fatalf("verified; the TypeScript refuses entry %d", *c.Seq)
				}
				if ce.Seq != *c.Seq {
					t.Fatalf("refused entry %d (%v); the TypeScript refuses entry %d", ce.Seq, err, *c.Seq)
				}
				return
			}
			if err != nil {
				t.Fatalf("refused: %v", err)
			}
			got, _ := json.Marshal(summarise(state))
			want, _ := json.Marshal(c.State)
			if !bytes.Equal(got, want) {
				t.Fatalf("state\n got %s\nwant %s", got, want)
			}
		})
	}
}
