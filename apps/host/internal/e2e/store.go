package e2e

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Store is what a host keeps of E2E, under its root (Root/e2e, root's only):
//
//	key.json            the host's seeds (Seeds), made on first use
//	spaces/<space>.json  each space's chain: the genesis the host pinned when it joined, and the entries
//
// A chain file is verified from its pinned genesis whenever it is read, and kept only once extended entries verify, so
// a file someone edits can't make the host trust a key: it would fail and leave the space refusing every session.
type Store struct {
	dir string

	mu       sync.Mutex
	identity *Identity
	spaces   map[string]*spaceChain
}

type spaceFile struct {
	Genesis string  `json:"genesis"`
	Entries []Entry `json:"entries"`
}

type spaceChain struct {
	store   *Store
	space   string
	path    string
	mu      sync.Mutex
	modTime time.Time
	file    spaceFile
	state   *State
	err     error
}

// OpenStore opens dir (made if missing).
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "spaces"), 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, spaces: map[string]*spaceChain{}}, nil
}

func writeFile(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Identity is the host's keys, made the first time they are asked for.
func (s *Store) Identity() (*Identity, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.identity != nil {
		return s.identity, nil
	}
	path := filepath.Join(s.dir, "key.json")
	var seeds Seeds
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &seeds); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	case errors.Is(err, os.ErrNotExist):
		seeds = NewSeeds()
		if err := writeFile(path, seeds); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	id, err := IdentityFromSeeds(seeds)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	s.identity = id
	return id, nil
}

func validSpace(space string) bool {
	return idPattern.MatchString(space) && !strings.ContainsAny(space, "/\\")
}

// Space is the space's chain, or nil when the host hasn't joined it.
func (s *Store) Space(space string) *spaceChain {
	if !validSpace(space) {
		return nil
	}
	path := filepath.Join(s.dir, "spaces", space+".json")
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.spaces[space]
	if !ok {
		c = &spaceChain{store: s, space: space, path: path}
		s.spaces[space] = c
	}
	return c
}

// Spaces are the spaces the host has joined.
func (s *Store) Spaces() []string {
	names, _ := filepath.Glob(filepath.Join(s.dir, "spaces", "*.json"))
	out := []string{}
	for _, n := range names {
		out = append(out, strings.TrimSuffix(filepath.Base(n), ".json"))
	}
	return out
}

// Mode is the space's E2E mode: "off" unless the host holds its chain (a chain it can't verify is "strict", so a
// damaged file shuts plaintext out rather than letting it in).
func (s *Store) Mode(space string) string {
	c := s.Space(space)
	if c == nil {
		return ModeOff
	}
	st, err := c.load()
	if err != nil {
		return ModeStrict
	}
	return st.Mode
}

// load reads the file again when it changed (`kantel-host e2e join` writes it while the daemon runs).
func (c *spaceChain) load() (*State, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.loadLocked()
}

func (c *spaceChain) loadLocked() (*State, error) {
	info, err := os.Stat(c.path)
	if err != nil {
		return nil, err
	}
	if c.state != nil && info.ModTime().Equal(c.modTime) {
		return c.state, nil
	}
	raw, err := os.ReadFile(c.path)
	if err != nil {
		return nil, err
	}
	var f spaceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", c.path, err)
	}
	if f.Genesis == "" {
		return nil, fmt.Errorf("%s pins no genesis", c.path)
	}
	st, err := VerifyChain(f.Entries, f.Genesis)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", c.path, err)
	}
	if st.Space != c.space {
		return nil, fmt.Errorf("%s is another space's chain", c.path)
	}
	c.file, c.state, c.modTime = f, st, info.ModTime()
	return st, nil
}

// State is the chain's state, or nil when it doesn't verify.
func (c *spaceChain) State() *State {
	st, _ := c.load()
	return st
}

// Extend takes entries a device brings, keeping them once they verify.
func (c *spaceChain) Extend(from int, entries []Entry) (*State, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st, err := c.loadLocked()
	if err != nil {
		return nil, err
	}
	next, err := ExtendChain(st, entries, from)
	if err != nil {
		return nil, err
	}
	if next.Seq == st.Seq {
		return st, nil
	}
	f := spaceFile{Genesis: c.file.Genesis, Entries: append(append([]Entry{}, c.file.Entries...), entries[st.Seq+1-from:]...)}
	if err := writeFile(c.path, f); err != nil {
		return nil, err
	}
	info, _ := os.Stat(c.path)
	c.file, c.state = f, next
	if info != nil {
		c.modTime = info.ModTime()
	}
	return next, nil
}

// Entries are the chain's entries from seq from on.
func (c *spaceChain) Entries(from int) []Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.loadLocked(); err != nil {
		return nil
	}
	if from < 0 || from >= len(c.file.Entries) {
		return []Entry{}
	}
	return append([]Entry{}, c.file.Entries[from:]...)
}

// Join adds the host to the space the ticket is for: entries are the space's chain as the gateway gave it, which must
// start at the genesis the ticket pins; the host signs its host.add, keeps the chain with it, and gives the entry back
// to publish. The host's ID is the one the gateway knows it by.
func (s *Store) Join(join *JoinTicket, entries []Entry, hostID string, now time.Time) (Entry, *State, error) {
	space, genesis, _ := join.TicketSpace()
	if !validSpace(space) {
		return Entry{}, nil, errors.New("the ticket names no space")
	}
	st, err := VerifyChain(entries, genesis)
	if err != nil {
		return Entry{}, nil, fmt.Errorf("the gateway's chain for %s isn't the one the ticket was made from: %w", space, err)
	}
	if st.Space != space {
		return Entry{}, nil, errors.New("the gateway gave another space's chain")
	}
	id, err := s.Identity()
	if err != nil {
		return Entry{}, nil, err
	}
	if h, ok := st.Hosts[hostID]; ok {
		if h.DH == B64(id.DHPublic()) {
			// Joined before (the publish may have failed): keep the chain and publish nothing new.
			return Entry{}, st, s.save(space, genesis, entries)
		}
		return Entry{}, nil, fmt.Errorf("the chain has host %s with other keys", hostID)
	}
	at := max(now.UnixMilli(), st.At)
	e, err := SignHostAdd(st, join, hostID, id, at)
	if err != nil {
		return Entry{}, nil, err
	}
	all := append(append([]Entry{}, entries...), e)
	next, err := VerifyChain(all, genesis)
	if err != nil {
		return Entry{}, nil, err
	}
	if err := s.save(space, genesis, all); err != nil {
		return Entry{}, nil, err
	}
	return e, next, nil
}

func (s *Store) save(space, genesis string, entries []Entry) error {
	return writeFile(filepath.Join(s.dir, "spaces", space+".json"), spaceFile{Genesis: genesis, Entries: entries})
}
