package e2e

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"math"
)

// Noise_IK_25519_AESGCM_SHA256 (revision 34 of the Noise spec), as packages/e2e/src/noise.ts does it:
//
//	<- s
//	...
//	-> e, es, s, ss
//	<- e, ee, se
const NoiseProtocol = "Noise_IK_25519_AESGCM_SHA256"

const (
	// NoiseMaxMessage is the largest Noise message.
	NoiseMaxMessage = 65535
	noiseTag        = 16
	// NoiseMaxPlaintext is the most one transport message carries.
	NoiseMaxPlaintext = NoiseMaxMessage - noiseTag
)

// CipherState is one direction's key and counter.
type CipherState struct {
	aead cipher.AEAD
	n    uint64
}

func (c *CipherState) init(key []byte) {
	c.n = 0
	if key == nil {
		c.aead = nil
		return
	}
	block, _ := aes.NewCipher(key)
	c.aead, _ = cipher.NewGCM(block)
}

func (c *CipherState) nonce() []byte {
	out := make([]byte, 12)
	binary.BigEndian.PutUint64(out[4:], c.n)
	return out
}

var errSpent = errors.New("this Noise key is spent")

// Encrypt seals plaintext with ad.
func (c *CipherState) Encrypt(ad, plaintext []byte) ([]byte, error) {
	if c.aead == nil {
		return append([]byte{}, plaintext...), nil
	}
	if c.n == math.MaxUint64 {
		return nil, errSpent
	}
	out := c.aead.Seal(nil, c.nonce(), plaintext, ad)
	c.n++
	return out, nil
}

// Decrypt opens ciphertext; the counter moves on only when it is authentic.
func (c *CipherState) Decrypt(ad, ciphertext []byte) ([]byte, error) {
	if c.aead == nil {
		return append([]byte{}, ciphertext...), nil
	}
	if c.n == math.MaxUint64 {
		return nil, errSpent
	}
	out, err := c.aead.Open(nil, c.nonce(), ciphertext, ad)
	if err != nil {
		return nil, errors.New("a Noise message failed to decrypt")
	}
	c.n++
	return out, nil
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

func hkdf2(ck, input []byte) ([]byte, []byte) {
	temp := hmacSHA256(ck, input)
	one := hmacSHA256(temp, []byte{1})
	two := hmacSHA256(temp, append(append([]byte{}, one...), 2))
	return one, two
}

type symmetric struct {
	cipher CipherState
	ck, h  []byte
}

func (s *symmetric) initialize() {
	name := []byte(NoiseProtocol)
	if len(name) <= sha256.Size {
		s.h = make([]byte, sha256.Size)
		copy(s.h, name)
	} else {
		sum := sha256.Sum256(name)
		s.h = sum[:]
	}
	s.ck = append([]byte{}, s.h...)
	s.cipher.init(nil)
}

func (s *symmetric) mixKey(input []byte) {
	ck, key := hkdf2(s.ck, input)
	s.ck = ck
	s.cipher.init(key)
}

func (s *symmetric) mixHash(data []byte) {
	h := sha256.New()
	h.Write(s.h)
	h.Write(data)
	s.h = h.Sum(nil)
}

func (s *symmetric) encryptAndHash(p []byte) ([]byte, error) {
	c, err := s.cipher.Encrypt(s.h, p)
	if err != nil {
		return nil, err
	}
	s.mixHash(c)
	return c, nil
}

func (s *symmetric) decryptAndHash(c []byte) ([]byte, error) {
	p, err := s.cipher.Decrypt(s.h, c)
	if err != nil {
		return nil, err
	}
	s.mixHash(c)
	return p, nil
}

func (s *symmetric) split() (*CipherState, *CipherState) {
	one, two := hkdf2(s.ck, nil)
	a, b := &CipherState{}, &CipherState{}
	a.init(one)
	b.init(two)
	return a, b
}

// Transport is what a finished handshake gives a side.
type Transport struct {
	Send, Receive *CipherState
	HandshakeHash []byte
	RemoteStatic  []byte
}

func dh(priv *ecdh.PrivateKey, pub []byte) ([]byte, error) {
	p, err := ecdh.X25519().NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	shared, err := priv.ECDH(p)
	if err != nil {
		return nil, errors.New("a low-order X25519 key")
	}
	if subtle.ConstantTimeCompare(shared, make([]byte, KeyBytes)) == 1 {
		return nil, errors.New("a low-order X25519 key")
	}
	return shared, nil
}

func newEphemeral(given *ecdh.PrivateKey) (*ecdh.PrivateKey, error) {
	if given != nil {
		return given, nil
	}
	return ecdh.X25519().GenerateKey(rand.Reader)
}

// Responder is the host's side of the handshake.
type Responder struct {
	Prologue  []byte
	Static    *ecdh.PrivateKey
	Ephemeral *ecdh.PrivateKey // for test vectors only

	s      symmetric
	re, rs []byte
	step   int
}

// ReadMessage1 reads `-> e, es, s, ss`: the device's static key and payload.
func (r *Responder) ReadMessage1(msg []byte) (remoteStatic, payload []byte, err error) {
	if r.step != 0 {
		return nil, nil, errors.New("out of order")
	}
	r.step = 1
	if len(msg) < 2*KeyBytes+2*noiseTag {
		return nil, nil, errors.New("the first handshake message is short")
	}
	r.s.initialize()
	r.s.mixHash(r.Prologue)
	r.s.mixHash(r.Static.PublicKey().Bytes())
	r.re = append([]byte{}, msg[:KeyBytes]...)
	r.s.mixHash(r.re)
	shared, err := dh(r.Static, r.re)
	if err != nil {
		return nil, nil, err
	}
	r.s.mixKey(shared)
	rs, err := r.s.decryptAndHash(msg[KeyBytes : 2*KeyBytes+noiseTag])
	if err != nil {
		return nil, nil, err
	}
	r.rs = rs
	if shared, err = dh(r.Static, rs); err != nil {
		return nil, nil, err
	}
	r.s.mixKey(shared)
	payload, err = r.s.decryptAndHash(msg[2*KeyBytes+noiseTag:])
	if err != nil {
		return nil, nil, err
	}
	return rs, payload, nil
}

// WriteMessage2 writes `<- e, ee, se` with payload, and gives the transport.
func (r *Responder) WriteMessage2(payload []byte) ([]byte, *Transport, error) {
	if r.step != 1 {
		return nil, nil, errors.New("out of order")
	}
	r.step = 2
	e, err := newEphemeral(r.Ephemeral)
	if err != nil {
		return nil, nil, err
	}
	pub := e.PublicKey().Bytes()
	r.s.mixHash(pub)
	for _, remote := range [][]byte{r.re, r.rs} {
		shared, err := dh(e, remote)
		if err != nil {
			return nil, nil, err
		}
		r.s.mixKey(shared)
	}
	body, err := r.s.encryptAndHash(payload)
	if err != nil {
		return nil, nil, err
	}
	msg := append(pub, body...)
	if len(msg) > NoiseMaxMessage {
		return nil, nil, errors.New("the second handshake message is too big")
	}
	receive, send := r.s.split()
	return msg, &Transport{Send: send, Receive: receive, HandshakeHash: r.s.h, RemoteStatic: r.rs}, nil
}

// Initiator is the device's side, for tests (devices run the TypeScript one).
type Initiator struct {
	Prologue     []byte
	Static       *ecdh.PrivateKey
	RemoteStatic []byte
	Ephemeral    *ecdh.PrivateKey

	s    symmetric
	e    *ecdh.PrivateKey
	step int
}

func (i *Initiator) WriteMessage1(payload []byte) ([]byte, error) {
	if i.step != 0 {
		return nil, errors.New("out of order")
	}
	i.step = 1
	i.s.initialize()
	i.s.mixHash(i.Prologue)
	i.s.mixHash(i.RemoteStatic)
	e, err := newEphemeral(i.Ephemeral)
	if err != nil {
		return nil, err
	}
	i.e = e
	i.s.mixHash(e.PublicKey().Bytes())
	shared, err := dh(e, i.RemoteStatic)
	if err != nil {
		return nil, err
	}
	i.s.mixKey(shared)
	s, err := i.s.encryptAndHash(i.Static.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	if shared, err = dh(i.Static, i.RemoteStatic); err != nil {
		return nil, err
	}
	i.s.mixKey(shared)
	body, err := i.s.encryptAndHash(payload)
	if err != nil {
		return nil, err
	}
	return append(append(e.PublicKey().Bytes(), s...), body...), nil
}

func (i *Initiator) ReadMessage2(msg []byte) ([]byte, *Transport, error) {
	if i.step != 1 {
		return nil, nil, errors.New("out of order")
	}
	i.step = 2
	if len(msg) < KeyBytes+noiseTag {
		return nil, nil, errors.New("the second handshake message is short")
	}
	re := msg[:KeyBytes]
	i.s.mixHash(re)
	for _, priv := range []*ecdh.PrivateKey{i.e, i.Static} {
		shared, err := dh(priv, re)
		if err != nil {
			return nil, nil, err
		}
		i.s.mixKey(shared)
	}
	payload, err := i.s.decryptAndHash(msg[KeyBytes:])
	if err != nil {
		return nil, nil, err
	}
	send, receive := i.s.split()
	return payload, &Transport{Send: send, Receive: receive, HandshakeHash: i.s.h, RemoteStatic: i.RemoteStatic}, nil
}
