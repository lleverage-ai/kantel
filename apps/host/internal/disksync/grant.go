// Package disksync moves disk versions between the hosts of a pool over its mesh (docs/design/disk-store.md, "2c. Peer
// sync"): a server that serves the versions this host holds to the peers the control plane lets fetch them, with a
// grant it signed.
package disksync

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Grant is the control plane's word that host To may fetch Version of an object from the hosts in From, until Exp
// (milliseconds since the epoch). It is signed with the control plane's grant key (Welcome.GrantKey), as
// packages/compute/src/grants.ts makes it.
type Grant struct {
	Kind      string   `json:"kind"`
	ObjectID  string   `json:"objectId"`
	Version   string   `json:"version"`
	AccountID string   `json:"accountId"`
	From      []string `json:"from"`
	To        string   `json:"to"`
	Exp       int64    `json:"exp"`
}

// ErrBadGrant is the error of a grant that isn't one the key signed, or isn't valid now.
var ErrBadGrant = errors.New("not a valid grant")

// decode reads base64url, with or without its padding.
func decode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// VerifyGrant is the grant token carries, when publicKey (32 raw bytes in base64url) signed it and it is still valid at
// now. A token is "<payload>.<signature>": the grant's JSON in base64url, and Ed25519 over the payload's text.
func VerifyGrant(publicKey, token string, now time.Time) (Grant, error) {
	key, err := decode(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return Grant{}, errors.New("no grant key")
	}
	payload, signature, ok := strings.Cut(token, ".")
	if !ok || strings.Contains(signature, ".") {
		return Grant{}, ErrBadGrant
	}
	sig, err := decode(signature)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(key), []byte(payload), sig) {
		return Grant{}, ErrBadGrant
	}
	raw, err := decode(payload)
	if err != nil {
		return Grant{}, ErrBadGrant
	}
	var g Grant
	if err := json.Unmarshal(raw, &g); err != nil || g.Kind == "" || g.ObjectID == "" || g.Version == "" || g.To == "" {
		return Grant{}, ErrBadGrant
	}
	if g.Exp <= now.UnixMilli() {
		return Grant{}, fmt.Errorf("%w: it expired", ErrBadGrant)
	}
	return g, nil
}

// Allows says why the grant doesn't let asker fetch version of an object from holder, or nil when it does.
func (g Grant) Allows(kind, objectID, version, holder, asker string) error {
	switch {
	case g.Kind != kind || g.ObjectID != objectID || g.Version != version:
		return errors.New("the grant is for another version")
	case !slices.Contains(g.From, holder):
		return errors.New("the grant doesn't name this host as a holder")
	case asker == "" || g.To != asker:
		return errors.New("the grant is for another host")
	}
	return nil
}
