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

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Grant is the control plane's word that host To may fetch Version of an object from the hosts in From, until Exp
// (milliseconds since the epoch). It is signed with the control plane's grant key whose ID is Kid (one of
// Welcome.GrantKeys), as packages/compute/src/grants.ts makes it.
type Grant struct {
	Kind      string   `json:"kind"`
	ObjectID  string   `json:"objectId"`
	Version   string   `json:"version"`
	AccountID string   `json:"accountId"`
	From      []string `json:"from"`
	To        string   `json:"to"`
	Exp       int64    `json:"exp"`
	// Kid is the ID of the key that signed it; empty in a grant from a control plane from before key IDs.
	Kid string `json:"kid,omitempty"`
}

// ErrBadGrant is the error of a grant that isn't one the key signed, or isn't valid now.
var ErrBadGrant = errors.New("not a valid grant")

// decode reads base64url, with or without its padding.
func decode(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// VerifyGrant is the grant token carries, when one of keys (each 32 raw bytes in base64url) signed it and it is still
// valid at now. A token is "<payload>.<signature>": the grant's JSON in base64url, and Ed25519 over the payload's text.
// A grant naming its key (Kid) is checked with the key of that ID, and keys with none (a control plane's from before
// rotation); a key past its Until signs nothing.
func VerifyGrant(keys []proto.GrantKey, token string, now time.Time) (Grant, error) {
	payload, signature, ok := strings.Cut(token, ".")
	if !ok || strings.Contains(signature, ".") {
		return Grant{}, ErrBadGrant
	}
	sig, err := decode(signature)
	if err != nil {
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
	signed, usable := false, false
	for _, k := range keys {
		key, err := decode(k.PublicKey)
		if err != nil || len(key) != ed25519.PublicKeySize || (k.Until != 0 && k.Until <= now.UnixMilli()) {
			continue
		}
		usable = true
		if g.Kid != "" && k.ID != "" && k.ID != g.Kid {
			continue
		}
		if ed25519.Verify(ed25519.PublicKey(key), []byte(payload), sig) {
			signed = true
			break
		}
	}
	if !usable {
		return Grant{}, errors.New("no grant key")
	}
	if !signed {
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
