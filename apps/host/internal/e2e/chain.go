package e2e

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"unicode/utf16"
	"unicode/utf8"
)

// The space chain, as packages/e2e/src/chain.ts verifies it (its comment has the rules); both pass
// packages/e2e/vectors/chain.json.

const ChainVersion = 1

const (
	ModeOff    = "off"
	ModeOn     = "on"
	ModeStrict = "strict"

	// ClassWeb is the hosted console's devices: let in with E2E on, kept out (and its entries refused) when strict.
	ClassWeb = "web"
)

var (
	entryContext  = []byte("kantel-chain/1\n")
	ticketContext = []byte("kantel-ticket/1\n")
	idPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$`)
	devicePattern = regexp.MustCompile(`^kd_[0-9a-f]{32}$`)
)

const maxLabel = 100

// Entry is a chain entry as stored and sent.
type Entry struct {
	Payload string `json:"payload"`
	Sig     string `json:"sig"`
}

type Device struct {
	ID    string `json:"id"`
	User  string `json:"user"`
	Sign  string `json:"sign"`
	DH    string `json:"dh"`
	Class string `json:"class"`
	Label string `json:"label"`
}

type ChainHost struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Sign string `json:"sign"`
	DH   string `json:"dh"`
}

// State is what a verified chain says now.
type State struct {
	Space   string
	Genesis string
	Head    string
	Seq     int
	Mode    string
	Members map[string]string
	Devices map[string]Device
	Hosts   map[string]ChainHost
	spent   map[string]bool
	Hashes  []string
	At      int64
}

func (s *State) clone() *State {
	c := *s
	c.Members = maps(s.Members)
	c.Devices = maps(s.Devices)
	c.Hosts = maps(s.Hosts)
	c.spent = maps(s.spent)
	c.Hashes = slices.Clone(s.Hashes)
	return &c
}

func maps[V any](m map[string]V) map[string]V {
	out := make(map[string]V, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ChainError is an entry that doesn't verify, and where.
type ChainError struct {
	Seq     int
	Message string
}

func (e *ChainError) Error() string { return fmt.Sprintf("space chain entry %d: %s", e.Seq, e.Message) }

type object map[string]json.RawMessage

// fields reads raw as a JSON object with exactly required and any of optional.
func fields(raw json.RawMessage, what string, required []string, optional ...string) (object, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return nil, fmt.Errorf("%s is not an object", what)
	}
	var o object
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("%s is not an object", what)
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return nil, fmt.Errorf("%s has no %s", what, k)
		}
	}
	for k := range o {
		if !slices.Contains(required, k) && !slices.Contains(optional, k) {
			return nil, fmt.Errorf("%s has an unknown field %s", what, k)
		}
	}
	return o, nil
}

func str(raw json.RawMessage, what string) (string, error) {
	raw = bytes.TrimSpace(raw)
	var s string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", fmt.Errorf("%s is not a string", what)
	}
	return s, nil
}

func id(raw json.RawMessage, what string) (string, error) {
	s, err := str(raw, what)
	if err != nil {
		return "", err
	}
	if !idPattern.MatchString(s) {
		return "", fmt.Errorf("%s is not a valid ID", what)
	}
	return s, nil
}

// integer is a JSON number that JavaScript reads as a safe, non-negative integer.
func integer(raw json.RawMessage, what string) (int64, error) {
	var f float64
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || !(raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) || json.Unmarshal(raw, &f) != nil {
		return 0, fmt.Errorf("%s is not a whole number", what)
	}
	if f < 0 || f != math.Trunc(f) || f > (1<<53)-1 {
		return 0, fmt.Errorf("%s is not a whole number", what)
	}
	return int64(f), nil
}

func key32(raw json.RawMessage, what string) (string, error) {
	s, err := str(raw, what)
	if err != nil {
		return "", err
	}
	b, err := FromB64(s)
	if err != nil {
		return "", fmt.Errorf("%s is not base64url", what)
	}
	if len(b) != KeyBytes {
		return "", fmt.Errorf("%s is not a 32-byte key", what)
	}
	return s, nil
}

func oneOf(raw json.RawMessage, allowed []string, what string) (string, error) {
	s, err := str(raw, what)
	if err != nil || !slices.Contains(allowed, s) {
		return "", fmt.Errorf("%s is not one of %v", what, allowed)
	}
	return s, nil
}

// jsLength is a string's length as JavaScript counts it, in UTF-16 units.
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// first runs the checks in order and gives the first error.
func first(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func parseDevice(raw json.RawMessage) (Device, error) {
	o, err := fields(raw, "device", []string{"id", "user", "sign", "dh", "class", "label"})
	if err != nil {
		return Device{}, err
	}
	var d Device
	var e [6]error
	d.Label, e[0] = str(o["label"], "device.label")
	if e[0] == nil && jsLength(d.Label) > maxLabel {
		e[0] = errors.New("device.label is too long")
	}
	d.ID, e[1] = str(o["id"], "device.id")
	if e[1] == nil && !devicePattern.MatchString(d.ID) {
		e[1] = errors.New("device.id is not a device ID")
	}
	d.User, e[2] = id(o["user"], "device.user")
	d.Sign, e[3] = key32(o["sign"], "device.sign")
	d.DH, e[4] = key32(o["dh"], "device.dh")
	d.Class, e[5] = oneOf(o["class"], []string{"cli", "web", "machine"}, "device.class")
	return d, first(e[:]...)
}

func parseHost(raw json.RawMessage) (ChainHost, error) {
	o, err := fields(raw, "host", []string{"id", "name", "sign", "dh"})
	if err != nil {
		return ChainHost{}, err
	}
	var h ChainHost
	var e [4]error
	h.Name, e[0] = str(o["name"], "host.name")
	if e[0] == nil && jsLength(h.Name) > maxLabel {
		e[0] = errors.New("host.name is too long")
	}
	h.ID, e[1] = id(o["id"], "host.id")
	h.Sign, e[2] = key32(o["sign"], "host.sign")
	h.DH, e[3] = key32(o["dh"], "host.dh")
	return h, first(e[:]...)
}

func parseBlob(raw json.RawMessage, what string) (Entry, error) {
	o, err := fields(raw, what, []string{"payload", "sig"})
	if err != nil {
		return Entry{}, err
	}
	p, err1 := str(o["payload"], what+".payload")
	s, err2 := str(o["sig"], what+".sig")
	return Entry{Payload: p, Sig: s}, first(err1, err2)
}

func decodeJSON(payload, what string) ([]byte, json.RawMessage, error) {
	b, err := FromB64(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("%s is not base64url", what)
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, nil, fmt.Errorf("%s is not JSON", what)
	}
	return b, json.RawMessage(b), nil
}

type payload struct {
	space string
	seq   int
	prev  *string
	at    int64
	by    string
	typ   string

	mode   string
	device Device
	user   string
	role   string
	target string
	host   ChainHost
	ticket Entry
}

var entryTypes = []string{"genesis", "member.add", "member.remove", "device.add", "device.remove", "host.add", "host.remove", "mode"}

var modes = []string{ModeOff, ModeOn, ModeStrict}

func parseBody(p *payload, raw json.RawMessage) error {
	switch p.typ {
	case "genesis":
		o, err := fields(raw, "body", []string{"mode", "device"})
		if err != nil {
			return err
		}
		var e1, e2 error
		p.mode, e1 = oneOf(o["mode"], modes, "mode")
		p.device, e2 = parseDevice(o["device"])
		return first(e1, e2)
	case "member.add":
		o, err := fields(raw, "body", []string{"user", "role"})
		if err != nil {
			return err
		}
		var e1, e2 error
		p.user, e1 = id(o["user"], "user")
		p.role, e2 = oneOf(o["role"], []string{"admin", "member"}, "role")
		return first(e1, e2)
	case "member.remove":
		o, err := fields(raw, "body", []string{"user"})
		if err != nil {
			return err
		}
		p.user, err = id(o["user"], "user")
		return err
	case "device.add":
		o, err := fields(raw, "body", []string{"device"})
		if err != nil {
			return err
		}
		p.device, err = parseDevice(o["device"])
		return err
	case "device.remove", "host.remove":
		o, err := fields(raw, "body", []string{"id"})
		if err != nil {
			return err
		}
		p.target, err = id(o["id"], "id")
		return err
	case "host.add":
		o, err := fields(raw, "body", []string{"host", "ticket"})
		if err != nil {
			return err
		}
		var e1, e2 error
		p.host, e1 = parseHost(o["host"])
		p.ticket, e2 = parseBlob(o["ticket"], "ticket")
		return first(e1, e2)
	case "mode":
		o, err := fields(raw, "body", []string{"mode"})
		if err != nil {
			return err
		}
		p.mode, err = oneOf(o["mode"], modes, "mode")
		return err
	}
	return fmt.Errorf("unknown type %s", p.typ)
}

func parseEntry(e Entry) (*payload, []byte, error) {
	b, raw, err := decodeJSON(e.Payload, "The payload")
	if err != nil {
		return nil, nil, err
	}
	o, err := fields(raw, "The payload", []string{"v", "space", "seq", "at", "by", "type", "body"}, "prev")
	if err != nil {
		return nil, nil, err
	}
	var v float64
	if json.Unmarshal(o["v"], &v) != nil || v != ChainVersion {
		return nil, nil, fmt.Errorf("the payload is version %s, not %d", string(o["v"]), ChainVersion)
	}
	p := &payload{}
	if p.typ, err = oneOf(o["type"], entryTypes, "type"); err != nil {
		return nil, nil, err
	}
	seq, err := integer(o["seq"], "seq")
	if err != nil {
		return nil, nil, err
	}
	p.seq = int(seq)
	if raw, ok := o["prev"]; ok {
		prev, err := str(raw, "prev")
		if err != nil {
			return nil, nil, err
		}
		p.prev = &prev
	}
	if p.typ == "host.add" {
		if by, err := str(o["by"], "by"); err != nil || by != "ticket" {
			return nil, nil, errors.New("a host.add is signed by its ticket")
		}
		p.by = "ticket"
	} else if p.by, err = str(o["by"], "by"); err != nil {
		return nil, nil, err
	}
	if p.space, err = id(o["space"], "space"); err != nil {
		return nil, nil, err
	}
	if p.at, err = integer(o["at"], "at"); err != nil {
		return nil, nil, err
	}
	if err := parseBody(p, o["body"]); err != nil {
		return nil, nil, err
	}
	return p, b, nil
}

// EntryHash is base64url(SHA-256(payload ‖ sig)).
func EntryHash(e Entry) string {
	p, _ := FromB64(e.Payload)
	s, _ := FromB64(e.Sig)
	h := sha256.New()
	h.Write(p)
	h.Write(s)
	return B64(h.Sum(nil))
}

type ticket struct {
	space, genesis, name, key, by string
	exp                           int64
}

func parseTicket(e Entry) (*ticket, []byte, error) {
	b, raw, err := decodeJSON(e.Payload, "The ticket")
	if err != nil {
		return nil, nil, err
	}
	o, err := fields(raw, "The ticket", []string{"v", "type", "space", "genesis", "name", "key", "exp", "by"})
	if err != nil {
		return nil, nil, err
	}
	var v float64
	if json.Unmarshal(o["v"], &v) != nil || v != ChainVersion {
		return nil, nil, errors.New("the ticket is another version")
	}
	if typ, err := str(o["type"], "type"); err != nil || typ != "host.ticket" {
		return nil, nil, errors.New("the ticket is not a host ticket")
	}
	t := &ticket{}
	var errs [6]error
	t.name, errs[0] = str(o["name"], "ticket.name")
	if errs[0] == nil && jsLength(t.name) > maxLabel {
		errs[0] = errors.New("ticket.name is too long")
	}
	t.space, errs[1] = id(o["space"], "ticket.space")
	t.genesis, errs[2] = str(o["genesis"], "ticket.genesis")
	t.key, errs[3] = key32(o["key"], "ticket.key")
	t.exp, errs[4] = integer(o["exp"], "ticket.exp")
	t.by, errs[5] = str(o["by"], "ticket.by")
	return t, b, first(errs[:]...)
}

func signed(context, b []byte) []byte { return append(append([]byte{}, context...), b...) }

func mustKey(s string) []byte {
	b, _ := FromB64(s)
	return b
}

func (s *State) isAdminDevice(deviceID string) bool {
	d, ok := s.Devices[deviceID]
	return ok && s.Members[d.User] == "admin"
}

func (s *State) spend(keys ...string) error {
	for _, k := range keys {
		if s.spent[k] {
			return errors.New("was in the chain before")
		}
		s.spent[k] = true
	}
	return nil
}

func (s *State) spendDevice(d Device) error {
	if s.spend("device:"+d.ID, "key:"+d.Sign, "key:"+d.DH) != nil {
		return fmt.Errorf("device %s or one of its keys was in the chain before", d.ID)
	}
	return nil
}

func apply(state *State, e Entry, pin string) (*State, error) {
	p, b, err := parseEntry(e)
	if err != nil {
		return nil, err
	}
	sig, err := FromB64(e.Sig)
	if err != nil {
		return nil, errors.New("the entry's signature is not base64url")
	}
	hash := EntryHash(e)
	if state == nil {
		if p.typ != "genesis" {
			return nil, errors.New("the chain must start with a genesis")
		}
		if p.seq != 0 || p.prev != nil {
			return nil, errors.New("the genesis is seq 0 with no prev")
		}
		if pin != "" && hash != pin {
			return nil, errors.New("this isn't the genesis this device or host pinned")
		}
		d := p.device
		if p.by != d.ID {
			return nil, errors.New("the genesis is signed by the device it lists")
		}
		if d.ID != KeyID("kd", mustKey(d.Sign)) {
			return nil, errors.New("device.id isn't its key's")
		}
		if !verify(mustKey(d.Sign), signed(entryContext, b), sig) {
			return nil, errors.New("the genesis's signature is wrong")
		}
		next := &State{
			Space: p.space, Genesis: hash, Head: hash, Seq: 0, Mode: p.mode,
			Members: map[string]string{d.User: "admin"}, Devices: map[string]Device{d.ID: d},
			Hosts: map[string]ChainHost{}, spent: map[string]bool{}, Hashes: []string{hash}, At: p.at,
		}
		if err := next.spendDevice(d); err != nil {
			return nil, err
		}
		return next, nil
	}
	if p.space != state.Space {
		return nil, errors.New("the entry is for another space")
	}
	if p.seq != state.Seq+1 {
		return nil, fmt.Errorf("the entry is seq %d, not %d", p.seq, state.Seq+1)
	}
	if p.prev == nil || *p.prev != state.Head {
		return nil, errors.New("the entry doesn't follow the chain's head")
	}
	if p.typ == "genesis" {
		return nil, errors.New("a second genesis")
	}
	next := state.clone()
	if p.typ == "host.add" {
		t, tb, err := parseTicket(p.ticket)
		if err != nil {
			return nil, err
		}
		if t.space != state.Space || t.genesis != state.Genesis {
			return nil, errors.New("the ticket is for another space")
		}
		if !next.isAdminDevice(t.by) {
			return nil, errors.New("the ticket wasn't signed by an admin's device")
		}
		if state.Mode == ModeStrict && next.Devices[t.by].Class == ClassWeb {
			return nil, errors.New("this space is strict: a web device's ticket isn't taken")
		}
		tsig, err := FromB64(p.ticket.Sig)
		if err != nil {
			return nil, errors.New("the ticket's signature is not base64url")
		}
		if !verify(mustKey(next.Devices[t.by].Sign), signed(ticketContext, tb), tsig) {
			return nil, errors.New("the ticket's signature is wrong")
		}
		if p.at > t.exp {
			return nil, errors.New("the ticket had expired")
		}
		if p.host.Name != t.name {
			return nil, errors.New("the host's name isn't the ticket's")
		}
		if next.spent["ticket:"+t.key] {
			return nil, errors.New("the ticket was used before")
		}
		if !verify(mustKey(t.key), signed(entryContext, b), sig) {
			return nil, errors.New("the host.add isn't signed by the ticket's key")
		}
		if _, ok := next.Hosts[p.host.ID]; ok {
			return nil, fmt.Errorf("host %s is in the chain already", p.host.ID)
		}
		if next.spend("ticket:"+t.key, "key:"+p.host.Sign, "key:"+p.host.DH) != nil {
			return nil, errors.New("a key of this host was in the chain before")
		}
		next.Hosts[p.host.ID] = p.host
	} else {
		signer, ok := next.Devices[p.by]
		if !ok {
			return nil, fmt.Errorf("the signer %s isn't a device in the chain", p.by)
		}
		// In a strict space the hosted console can't open sessions, so it can't change the chain either.
		if state.Mode == ModeStrict && signer.Class == ClassWeb {
			return nil, errors.New("this space is strict: a web device's entries aren't taken")
		}
		if !verify(mustKey(signer.Sign), signed(entryContext, b), sig) {
			return nil, errors.New("the entry's signature is wrong")
		}
		admin := next.Members[signer.User] == "admin"
		needAdmin := func() error {
			if !admin {
				return fmt.Errorf("%s needs an admin's device", p.typ)
			}
			return nil
		}
		switch p.typ {
		case "member.add":
			if err := needAdmin(); err != nil {
				return nil, err
			}
			next.Members[p.user] = p.role
		case "member.remove":
			if err := needAdmin(); err != nil {
				return nil, err
			}
			if _, ok := next.Members[p.user]; !ok {
				return nil, fmt.Errorf("%s isn't a member", p.user)
			}
			delete(next.Members, p.user)
			for id, d := range next.Devices {
				if d.User == p.user {
					delete(next.Devices, id)
				}
			}
		case "device.add":
			d := p.device
			if _, ok := next.Members[d.User]; !ok {
				return nil, fmt.Errorf("%s isn't a member", d.User)
			}
			if !admin && signer.User != d.User {
				return nil, errors.New("only an admin adds another person's device")
			}
			if d.ID != KeyID("kd", mustKey(d.Sign)) {
				return nil, errors.New("device.id isn't its key's")
			}
			if err := next.spendDevice(d); err != nil {
				return nil, err
			}
			next.Devices[d.ID] = d
		case "device.remove":
			d, ok := next.Devices[p.target]
			if !ok {
				return nil, fmt.Errorf("%s isn't a device in the chain", p.target)
			}
			if !admin && signer.User != d.User {
				return nil, errors.New("only an admin removes another person's device")
			}
			delete(next.Devices, d.ID)
		case "host.remove":
			if err := needAdmin(); err != nil {
				return nil, err
			}
			if _, ok := next.Hosts[p.target]; !ok {
				return nil, fmt.Errorf("%s isn't a host in the chain", p.target)
			}
			delete(next.Hosts, p.target)
		case "mode":
			if err := needAdmin(); err != nil {
				return nil, err
			}
			next.Mode = p.mode
		}
	}
	adminLeft := false
	for _, d := range next.Devices {
		if next.Members[d.User] == "admin" {
			adminLeft = true
			break
		}
	}
	if !adminLeft {
		return nil, errors.New("no admin would have a device left")
	}
	next.Seq = p.seq
	next.Head = hash
	next.Hashes = append(next.Hashes, hash)
	next.At = p.at
	return next, nil
}

// VerifyChain is the state after entries, from the genesis; with pin, the genesis must be the one pinned.
func VerifyChain(entries []Entry, pin string) (*State, error) {
	if len(entries) == 0 {
		return nil, &ChainError{0, "the chain is empty"}
	}
	var state *State
	for seq, e := range entries {
		next, err := apply(state, e, pin)
		if err != nil {
			return nil, &ChainError{seq, err.Error()}
		}
		state = next
	}
	return state, nil
}

// ExtendChain is state moved on by entries, which start at seq from: those it has must be the same (else a fork),
// the rest must follow. Older entries change nothing.
func ExtendChain(state *State, entries []Entry, from int) (*State, error) {
	next := state
	for i, e := range entries {
		seq := from + i
		if seq <= next.Seq {
			if seq < 0 || EntryHash(e) != next.Hashes[seq] {
				return nil, &ChainError{seq, "this entry differs from the one already verified: a fork"}
			}
			continue
		}
		if seq != next.Seq+1 {
			return nil, &ChainError{seq, fmt.Sprintf("the entries skip seq %d", next.Seq+1)}
		}
		n, err := apply(next, e, "")
		if err != nil {
			return nil, &ChainError{seq, err.Error()}
		}
		next = n
	}
	return next, nil
}

// Allowed says why a device may not open a session now, or "" when it may.
func (s *State) Allowed(deviceID string) string {
	d, ok := s.Devices[deviceID]
	if !ok {
		return "This device isn't in the space's chain"
	}
	if _, ok := s.Members[d.User]; !ok {
		return "This device's person isn't a member"
	}
	if s.Mode == ModeStrict && d.Class == ClassWeb {
		return "This space is strict: the hosted console isn't let in"
	}
	return ""
}

// DeviceByDH is the device whose Noise key is dh (base64url).
func (s *State) DeviceByDH(dh string) (Device, bool) {
	for _, d := range s.Devices {
		if d.DH == dh {
			return d, true
		}
	}
	return Device{}, false
}

// JoinTicket is what `kantel-host e2e join` is given: an admin's ticket and the seed of its one-off key.
type JoinTicket struct {
	Ticket Entry  `json:"ticket"`
	Seed   string `json:"seed"`
}

// DecodeJoinTicket reads the one base64url word the CLI prints.
func DecodeJoinTicket(word string) (*JoinTicket, error) {
	_, raw, err := decodeJSON(word, "The join ticket")
	if err != nil {
		return nil, err
	}
	o, err := fields(raw, "The join ticket", []string{"ticket", "seed"})
	if err != nil {
		return nil, err
	}
	t, err := parseBlob(o["ticket"], "ticket")
	if err != nil {
		return nil, err
	}
	if _, _, err := parseTicket(t); err != nil {
		return nil, err
	}
	seed, err := key32(o["seed"], "seed")
	if err != nil {
		return nil, err
	}
	return &JoinTicket{Ticket: t, Seed: seed}, nil
}

// TicketSpace is the space and pinned genesis a join ticket is for.
func (j *JoinTicket) TicketSpace() (space, genesis, name string) {
	t, _, _ := parseTicket(j.Ticket)
	if t == nil {
		return "", "", ""
	}
	return t.space, t.genesis, t.name
}
