// Package e2e is the host's half of Kantel Connect's end-to-end encryption: its keys, the space chain it verifies,
// and the Noise IK sessions people's devices open to it through the gateway's relay. The TypeScript half is
// packages/e2e; both pass the vectors in packages/e2e/vectors.
//
// A host that holds a space's chain with its mode `on` or `strict` serves that space's sandbox content (commands,
// files, ports) only inside sessions from the chain's devices, and refuses it in plaintext calls from the gateway.
package e2e

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
)

// KeyBytes is the size of every public key and seed.
const KeyBytes = 32

var b64 = base64.RawURLEncoding.Strict()

var base64urlChars = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)

// B64 is base64url without padding, as the chain writes keys, signatures and hashes.
func B64(b []byte) string { return b64.EncodeToString(b) }

// FromB64 decodes base64url without padding, and only the one encoding of its bytes.
func FromB64(s string) ([]byte, error) {
	if !base64urlChars.MatchString(s) || len(s)%4 == 1 {
		return nil, errors.New("not base64url")
	}
	out, err := b64.DecodeString(s)
	if err != nil || B64(out) != s {
		return nil, errors.New("not base64url")
	}
	return out, nil
}

// Identity is what a host (or, in tests, a device) holds: an Ed25519 key that signs and an X25519 key sessions open
// with, both from 32-byte seeds.
type Identity struct {
	Sign   ed25519.PrivateKey
	Static *ecdh.PrivateKey
}

// Seeds are an identity's secret halves, as stored.
type Seeds struct {
	Sign string `json:"sign"`
	DH   string `json:"dh"`
}

func NewSeeds() Seeds {
	a, b := make([]byte, KeyBytes), make([]byte, KeyBytes)
	_, _ = rand.Read(a)
	_, _ = rand.Read(b)
	return Seeds{Sign: B64(a), DH: B64(b)}
}

func IdentityFromSeeds(s Seeds) (*Identity, error) {
	sign, err := FromB64(s.Sign)
	if err != nil || len(sign) != KeyBytes {
		return nil, errors.New("the signing seed isn't 32 bytes of base64url")
	}
	dh, err := FromB64(s.DH)
	if err != nil || len(dh) != KeyBytes {
		return nil, errors.New("the Noise seed isn't 32 bytes of base64url")
	}
	static, err := ecdh.X25519().NewPrivateKey(dh)
	if err != nil {
		return nil, err
	}
	return &Identity{Sign: ed25519.NewKeyFromSeed(sign), Static: static}, nil
}

// SignPublic is the raw Ed25519 public key.
func (i *Identity) SignPublic() []byte { return []byte(i.Sign.Public().(ed25519.PublicKey)) }

// DHPublic is the raw X25519 public key.
func (i *Identity) DHPublic() []byte { return i.Static.PublicKey().Bytes() }

// KeyID is the ID a key pair goes by: the prefix (`kd` for a device, `kh` for a host), then the first 16 bytes of the
// SHA-256 of its Ed25519 public key, in hex.
func KeyID(prefix string, signPublic []byte) string {
	sum := sha256.Sum256(signPublic)
	return prefix + "_" + hex.EncodeToString(sum[:16])
}

// Fingerprint is what people compare by reading it out: five groups of four hex digits.
func Fingerprint(publicKeys ...[]byte) string {
	h := sha256.New()
	h.Write([]byte("kantel-fingerprint/1"))
	for _, k := range publicKeys {
		h.Write(k)
	}
	d := hex.EncodeToString(h.Sum(nil)[:10])
	return d[0:4] + "-" + d[4:8] + "-" + d[8:12] + "-" + d[12:16] + "-" + d[16:20]
}

// verify reports whether sig is pub's Ed25519 signature over msg; a key or signature of the wrong size is simply not.
func verify(pub, msg, sig []byte) bool {
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}
