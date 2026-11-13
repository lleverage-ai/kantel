package mesh

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/curve25519"
)

// Key is a WireGuard (Curve25519) key, private or public.
type Key [32]byte

// String is the key as WireGuard writes it, in base64: how it goes in Facts.Mesh and comes in a MeshPeer.
func (k Key) String() string { return base64.StdEncoding.EncodeToString(k[:]) }

// hex is the key as wireguard-go's configuration protocol takes it.
func (k Key) hex() string { return hex.EncodeToString(k[:]) }

// Public is a private key's public key.
func (k Key) Public() Key {
	var pub Key
	curve25519.ScalarBaseMult((*[32]byte)(&pub), (*[32]byte)(&k))
	return pub
}

// ParseKey reads a base64 key.
func ParseKey(s string) (Key, error) {
	var k Key
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != len(k) {
		return k, fmt.Errorf("not a WireGuard key: %q", s)
	}
	copy(k[:], b)
	return k, nil
}

// newPrivateKey is a random Curve25519 private key, clamped as WireGuard's are.
func newPrivateKey() (Key, error) {
	var k Key
	if _, err := rand.Read(k[:]); err != nil {
		return k, err
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	return k, nil
}

// keyFile is where the host's private key is kept, under its root.
const keyFile = "private.key"

// LoadKey reads the host's private key from dir, making it (mode 0600, dir 0700) the first time: the same key on every
// start, so peers and the control plane keep knowing the host by it. It is never sent anywhere.
func LoadKey(dir string) (Key, error) {
	path := filepath.Join(dir, keyFile)
	raw, err := os.ReadFile(path)
	if err == nil {
		return ParseKey(string(raw))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Key{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Key{}, err
	}
	k, err := newPrivateKey()
	if err != nil {
		return Key{}, err
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, []byte(k.String()+"\n"), 0o600); err != nil {
		return Key{}, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return Key{}, err
	}
	return k, nil
}
