package signing

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
	"time"

	// SHA-256 is the OpenPGP signatures' hash, which go-crypto looks up among the registered ones.
	_ "crypto/sha256"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"golang.org/x/crypto/ssh"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Key formats, as Kantel names them.
const (
	FormatGPG = "gpg"
	FormatSSH = "ssh"
)

// SSHSIG's namespace and hash for Git's signatures (OpenSSH's PROTOCOL.sshsig): the host signs in the "git" namespace
// only, so a signature it makes is never one another program takes for its own.
const (
	sshNamespace = "git"
	sshHash      = "sha512"
	sshMagic     = "SSHSIG"
)

// OpenPGP's hash algorithm ID for SHA-256 (RFC 4880, 9.4), as gpg's status lines give it.
const hashSHA256 = 8

// Key is a sandbox's signing key, parsed and unlocked in the host's memory: it is never written anywhere.
type Key struct {
	Format      string
	KeyID       string
	Fingerprint string
	// AllowedEmails are the committer and tagger emails the key signs for, lower-cased.
	AllowedEmails map[string]bool

	entity    *openpgp.Entity
	sshSigner ssh.Signer
}

// Signature is one signature the host made, with what gpg's status lines say of it.
type Signature struct {
	// Text is the armoured signature: an OpenPGP detached signature, or an SSHSIG.
	Text string
	// PKAlgo and HashAlgo are the OpenPGP algorithm IDs (0 for SSH); Timestamp is when it was made, in Unix seconds.
	PKAlgo    uint8
	HashAlgo  uint8
	Timestamp int64
	// Fingerprint is the key that signed: its OpenPGP fingerprint in upper-case hex, or its SSH SHA256 fingerprint.
	Fingerprint string
}

// ParseKey parses and unlocks k's private key. Its errors never quote the key or its passphrase.
func ParseKey(k proto.SigningKey, now time.Time) (*Key, error) {
	out := &Key{Format: k.Format, KeyID: k.KeyID, Fingerprint: k.Fingerprint, AllowedEmails: map[string]bool{}}
	for _, e := range k.AllowedEmails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out.AllowedEmails[e] = true
		}
	}
	if k.PrivateKey == "" {
		return nil, errors.New("the signing key has no private key")
	}
	var err error
	switch k.Format {
	case FormatGPG:
		out.entity, err = parseOpenPGP([]byte(k.PrivateKey), []byte(k.Passphrase), now)
	case FormatSSH:
		out.sshSigner, err = parseSSH([]byte(k.PrivateKey), []byte(k.Passphrase))
	default:
		return nil, fmt.Errorf("the signing key's format %q is neither gpg nor ssh", k.Format)
	}
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Allows says whether the key signs for email (case-insensitively).
func (k *Key) Allows(email string) bool {
	return k.AllowedEmails[strings.ToLower(email)]
}

// Sign signs payload as of now.
func (k *Key) Sign(payload []byte, now time.Time) (Signature, error) {
	switch {
	case k.entity != nil:
		return signOpenPGP(k.entity, payload, now)
	case k.sshSigner != nil:
		return signSSH(k.sshSigner, payload, now)
	}
	return Signature{}, errors.New("the signing key isn't loaded")
}

// --- OpenPGP --------------------------------------------------------------------------------------------------------

// parseOpenPGP reads an armoured (or binary) secret keyring and unlocks the first key in it that can sign now.
func parseOpenPGP(raw, passphrase []byte, now time.Time) (*openpgp.Entity, error) {
	entities, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(raw))
	if err != nil {
		if entities, err = openpgp.ReadKeyRing(bytes.NewReader(raw)); err != nil {
			return nil, errors.New("the OpenPGP key isn't a key: it doesn't parse")
		}
	}
	if len(entities) == 0 {
		return nil, errors.New("the OpenPGP key holds no key")
	}
	var lastErr error
	for _, e := range entities {
		if err := unlockOpenPGP(e, passphrase); err != nil {
			lastErr = err
			continue
		}
		sk, ok := e.SigningKey(now)
		if !ok {
			lastErr = errors.New("the OpenPGP key has no signing key that is valid now (expired, revoked, or none may sign)")
			continue
		}
		if sk.PrivateKey == nil || sk.PrivateKey.Dummy() {
			lastErr = errors.New("the OpenPGP key's signing key has no private part")
			continue
		}
		return e, nil
	}
	return nil, lastErr
}

// unlockOpenPGP decrypts e's primary key and subkeys where they are encrypted.
func unlockOpenPGP(e *openpgp.Entity, passphrase []byte) error {
	if e.PrivateKey == nil {
		return errors.New("the OpenPGP key is a public key: it has no private key")
	}
	var locked []*packet.PrivateKey
	if !e.PrivateKey.Dummy() && e.PrivateKey.Encrypted {
		locked = append(locked, e.PrivateKey)
	}
	for _, sub := range e.Subkeys {
		if sub.PrivateKey != nil && !sub.PrivateKey.Dummy() && sub.PrivateKey.Encrypted {
			locked = append(locked, sub.PrivateKey)
		}
	}
	if len(locked) == 0 {
		return nil
	}
	if len(passphrase) == 0 {
		return errors.New("the OpenPGP key is encrypted and has no passphrase")
	}
	for _, pk := range locked {
		if err := pk.Decrypt(passphrase); err != nil {
			return errors.New("the OpenPGP key's passphrase doesn't unlock it")
		}
	}
	return nil
}

func signOpenPGP(e *openpgp.Entity, payload []byte, now time.Time) (Signature, error) {
	// OpenPGP signatures carry whole seconds: the status line's timestamp is the signature's own.
	now = now.Truncate(time.Second)
	sk, ok := e.SigningKey(now)
	if !ok {
		return Signature{}, errors.New("the OpenPGP key has no signing key that is valid now")
	}
	config := &packet.Config{DefaultHash: crypto.SHA256, Time: func() time.Time { return now }, SigningKeyId: sk.PublicKey.KeyId}
	var b strings.Builder
	if err := openpgp.ArmoredDetachSign(&b, e, bytes.NewReader(payload), config); err != nil {
		return Signature{}, fmt.Errorf("OpenPGP signing failed: %w", err)
	}
	text := b.String()
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return Signature{
		Text: text, PKAlgo: uint8(sk.PublicKey.PubKeyAlgo), HashAlgo: hashSHA256, Timestamp: now.Unix(),
		Fingerprint: strings.ToUpper(hex.EncodeToString(sk.PublicKey.Fingerprint)),
	}, nil
}

// --- OpenSSH --------------------------------------------------------------------------------------------------------

// parseSSH reads an OpenSSH (or PEM) private key, unlocked with passphrase if it is encrypted; a passphrase given for
// a key that has none is not needed.
func parseSSH(raw, passphrase []byte) (ssh.Signer, error) {
	key, err := ssh.ParseRawPrivateKey(raw)
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		if len(passphrase) == 0 {
			return nil, errors.New("the SSH key is encrypted and has no passphrase")
		}
		if key, err = ssh.ParseRawPrivateKeyWithPassphrase(raw, passphrase); err != nil {
			return nil, errors.New("the SSH key's passphrase doesn't unlock it")
		}
	} else if err != nil {
		return nil, errors.New("the SSH key isn't a private key: it doesn't parse")
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		return nil, fmt.Errorf("the SSH key can't sign: %w", err)
	}
	return signer, nil
}

// signSSH makes an armoured SSHSIG (PROTOCOL.sshsig) of payload in the "git" namespace, as `ssh-keygen -Y sign -n git`
// does.
func signSSH(signer ssh.Signer, payload []byte, now time.Time) (Signature, error) {
	digest := sha512.Sum512(payload)
	var signed []byte
	signed = append(signed, sshMagic...)
	signed = appendSSHString(signed, []byte(sshNamespace))
	signed = appendSSHString(signed, nil) // reserved
	signed = appendSSHString(signed, []byte(sshHash))
	signed = appendSSHString(signed, digest[:])
	pub := signer.PublicKey()
	var sig *ssh.Signature
	var err error
	if pub.Type() == ssh.KeyAlgoRSA {
		// OpenSSH refuses SHA-1 RSA signatures (ssh-rsa): an RSA key signs with rsa-sha2-512.
		as, ok := signer.(ssh.AlgorithmSigner)
		if !ok {
			return Signature{}, errors.New("the SSH RSA key can't sign with rsa-sha2-512")
		}
		sig, err = as.SignWithAlgorithm(rand.Reader, signed, ssh.KeyAlgoRSASHA512)
	} else {
		sig, err = signer.Sign(rand.Reader, signed)
	}
	if err != nil {
		return Signature{}, fmt.Errorf("SSH signing failed: %w", err)
	}
	var blob []byte
	blob = append(blob, sshMagic...)
	blob = binary.BigEndian.AppendUint32(blob, 1)
	blob = appendSSHString(blob, pub.Marshal())
	blob = appendSSHString(blob, []byte(sshNamespace))
	blob = appendSSHString(blob, nil)
	blob = appendSSHString(blob, []byte(sshHash))
	blob = appendSSHString(blob, ssh.Marshal(sig))
	text := pem.EncodeToMemory(&pem.Block{Type: "SSH SIGNATURE", Bytes: blob})
	return Signature{Text: string(text), Timestamp: now.Unix(), Fingerprint: ssh.FingerprintSHA256(pub)}, nil
}

func appendSSHString(b, s []byte) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s)))
	return append(b, s...)
}
