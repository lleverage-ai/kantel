package e2e

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
)

type hostAddPayload struct {
	V     int    `json:"v"`
	Space string `json:"space"`
	Seq   int    `json:"seq"`
	Prev  string `json:"prev"`
	At    int64  `json:"at"`
	By    string `json:"by"`
	Type  string `json:"type"`
	Body  struct {
		Host   ChainHost `json:"host"`
		Ticket Entry     `json:"ticket"`
	} `json:"body"`
}

// SignHostAdd is the host.add a host signs with its join ticket's one-off key, to follow state. The host is hostID
// (its ID on the gateway, which the relay routes by) with identity's keys. The entry is checked against state before
// it is given back, so a ticket for another space, an expired one or a spent one fails here.
func SignHostAdd(state *State, join *JoinTicket, hostID string, identity *Identity, at int64) (Entry, error) {
	t, _, err := parseTicket(join.Ticket)
	if err != nil {
		return Entry{}, err
	}
	seed, err := FromB64(join.Seed)
	if err != nil || len(seed) != KeyBytes {
		return Entry{}, errors.New("the ticket's seed isn't 32 bytes")
	}
	oneOff := ed25519.NewKeyFromSeed(seed)
	if B64(oneOff.Public().(ed25519.PublicKey)) != t.key {
		return Entry{}, errors.New("the seed isn't the ticket's key")
	}
	p := hostAddPayload{V: ChainVersion, Space: state.Space, Seq: state.Seq + 1, Prev: state.Head, At: at, By: "ticket", Type: "host.add"}
	p.Body.Host = ChainHost{ID: hostID, Name: t.name, Sign: B64(identity.SignPublic()), DH: B64(identity.DHPublic())}
	p.Body.Ticket = join.Ticket
	raw, err := json.Marshal(p)
	if err != nil {
		return Entry{}, err
	}
	e := Entry{Payload: B64(raw), Sig: B64(ed25519.Sign(oneOff, signed(entryContext, raw)))}
	if _, err := ExtendChain(state, []Entry{e}, state.Seq+1); err != nil {
		return Entry{}, err
	}
	return e, nil
}
