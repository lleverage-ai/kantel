package e2e

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The vectors are packages/e2e/vectors: noise-ik.json is Cacophony's test vector for Noise_IK_25519_AESGCM_SHA256.
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
