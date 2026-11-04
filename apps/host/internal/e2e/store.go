package e2e

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
)

// Store is what a host keeps of E2E, under its root (Root/e2e, root's only):
//
//	key.json            the host's seeds (Seeds), made on first use
//	joined.json          every space the host has joined, so a chain file that goes missing locks its space
//	owners.json          the sandbox IDs seen in E2E spaces, so their snapshots stay covered when an ID is reused
//	born.json            the sandboxes made while their space was E2E (Born): the only ones a device's session reaches
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
	if err := os.MkdirAll(filepath.Join(dir, "pending"), 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dir, "spaces"), 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, spaces: map[string]*spaceChain{}}, nil
}

// writeFile replaces path durably: once it returns, a crash leaves the new contents. Callers hold the store's lock,
// so its one temporary file isn't shared.
func writeFile(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileDurably(path, append(raw, '\n'), 0o600)
}

// locked runs fn holding the store's lock (an flock on <dir>/lock), which every writer of its files holds: the daemon
// and `kantel-host e2e join` are separate processes, so a mutex can't keep one from writing over the other's chain
// between its read and its write. It isn't reentrant, and is taken before the store's mutexes, never under them.
func (s *Store) locked(fn func() error) error {
	f, err := os.OpenFile(filepath.Join(s.dir, "lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return fn()
}

// ErrEnrolled refuses an update the gateway picks on a host that has joined a space.
var ErrEnrolled = errors.New("this host has joined an E2E space: it is updated on the machine (kantel-host update), not by the gateway")

// Enrolled says whether this host has ever joined a space, whatever the space's mode now: its host key stays trusted
// while a space is off, so turning one off and on doesn't make the key safe to hand to a binary the gateway picked.
func (s *Store) Enrolled() bool { return len(s.Spaces()) > 0 }

// Unenrolled runs fn (a gateway-driven update: its download, the downloaded binary's version probe and the swap) only
// on a host that hasn't joined a space, holding the enrolment lock that Join takes first: an update that started before
// a join finishes, or is refused, before the join can make the host's key worth stealing.
func (s *Store) Unenrolled(fn func() error) error {
	return s.enrolling(func() error {
		if s.Enrolled() {
			return ErrEnrolled
		}
		return fn()
	})
}

// enrolling holds <dir>/enrol, an flock apart from the store's lock so that a long update doesn't hold up sessions'
// chain writes. It is taken before the store's lock, never under it.
func (s *Store) enrolling(fn func() error) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.dir, "enrol"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return fn()
}

// Identity is the host's keys, made the first time they are asked for (under the store's lock, so the daemon and the
// CLI can't each make one). Not to be called holding the lock, unless the keys are already loaded.
func (s *Store) Identity() (*Identity, error) {
	s.mu.Lock()
	id := s.identity
	s.mu.Unlock()
	if id != nil {
		return id, nil
	}
	path := filepath.Join(s.dir, "key.json")
	var seeds Seeds
	err := s.locked(func() error {
		raw, err := os.ReadFile(path)
		switch {
		case err == nil:
			if err := json.Unmarshal(raw, &seeds); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			return nil
		case errors.Is(err, os.ErrNotExist):
			seeds = NewSeeds()
			return writeFile(path, seeds)
		default:
			return err
		}
	})
	if err != nil {
		return nil, err
	}
	if id, err = IdentityFromSeeds(seeds); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.identity == nil {
		s.identity = id
	}
	return s.identity, nil
}

func validSpace(space string) bool {
	return idPattern.MatchString(space) && !strings.ContainsAny(space, "/\\")
}

// joined are the spaces the host has ever joined (joined.json). A space listed there whose chain file is missing or
// unreadable is locked (strict), not off.
func (s *Store) joined() map[string]bool {
	out := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(s.dir, "joined.json"))
	if err != nil {
		return out
	}
	var spaces []string
	_ = json.Unmarshal(raw, &spaces)
	for _, space := range spaces {
		out[space] = true
	}
	return out
}

func (s *Store) markJoined(space string) error {
	joined := s.joined()
	if joined[space] {
		return nil
	}
	joined[space] = true
	spaces := make([]string, 0, len(joined))
	for name := range joined {
		spaces = append(spaces, name)
	}
	sort.Strings(spaces)
	return writeFile(filepath.Join(s.dir, "joined.json"), spaces)
}

// RecordOwner keeps, for good, that sandboxID was a sandbox of space while E2E was on there (owners.json). Its
// snapshots stay that space's even after the sandbox is deleted and its ID made again for someone else.
func (s *Store) RecordOwner(sandboxID, space string) error {
	return s.locked(func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		owners := s.ownersLocked()
		if owners[sandboxID] == space {
			return nil
		}
		owners[sandboxID] = space
		return writeFile(filepath.Join(s.dir, "owners.json"), owners)
	})
}

// Born is the host's own record that a sandbox was made while its space was E2E: in Space, under the chain's OnSince
// then, at At (epoch ms, the host's clock). Nothing the gateway sends sets it; only the host's create and fork do.
type Born struct {
	Space   string `json:"space"`
	OnSince string `json:"onSince"`
	At      int64  `json:"at"`
}

// RecordBorn keeps that sandboxID was made under E2E (born.json), replacing what an earlier sandbox of that ID left.
func (s *Store) RecordBorn(sandboxID string, b Born) error {
	return s.locked(func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		all := s.bornLocked()
		all[sandboxID] = b
		return writeFile(filepath.Join(s.dir, "born.json"), all)
	})
}

// ForgetBorn drops sandboxID's record: a sandbox made again under that ID without E2E isn't the one that was born.
func (s *Store) ForgetBorn(sandboxID string) error {
	return s.locked(func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		all := s.bornLocked()
		if _, ok := all[sandboxID]; !ok {
			return nil
		}
		delete(all, sandboxID)
		return writeFile(filepath.Join(s.dir, "born.json"), all)
	})
}

// BornRecord is sandboxID's Born record, if it has one.
func (s *Store) BornRecord(sandboxID string) (Born, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.bornLocked()[sandboxID]
	return b, ok
}

func (s *Store) bornLocked() map[string]Born {
	all := map[string]Born{}
	if raw, err := os.ReadFile(filepath.Join(s.dir, "born.json")); err == nil {
		_ = json.Unmarshal(raw, &all)
	}
	return all
}

// OnSince is the space's chain's OnSince, "" when E2E is off there or its chain can't be verified.
func (s *Store) OnSince(space string) string {
	c := s.Space(space)
	if c == nil {
		return ""
	}
	st, err := c.load()
	if err != nil || st.Mode == ModeOff {
		return ""
	}
	return st.OnSince
}

// RecordedOwner is the E2E space sandboxID was recorded in, if any.
func (s *Store) RecordedOwner(sandboxID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	space, ok := s.ownersLocked()[sandboxID]
	return space, ok
}

func (s *Store) ownersLocked() map[string]string {
	owners := map[string]string{}
	if raw, err := os.ReadFile(filepath.Join(s.dir, "owners.json")); err == nil {
		_ = json.Unmarshal(raw, &owners)
	}
	return owners
}

// Space is the space's chain, or nil when the host hasn't joined it. A space the host joined whose file is gone is
// still answered (its chain won't load, so it is strict).
func (s *Store) Space(space string) *spaceChain {
	if !validSpace(space) {
		return nil
	}
	path := filepath.Join(s.dir, "spaces", space+".json")
	if _, err := os.Stat(path); err != nil {
		s.mu.Lock()
		_, seen := s.spaces[space]
		s.mu.Unlock()
		if !seen && !s.joined()[space] {
			return nil
		}
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
	all := s.joined()
	for _, n := range names {
		all[strings.TrimSuffix(filepath.Base(n), ".json")] = true
	}
	out := make([]string, 0, len(all))
	for space := range all {
		out = append(out, space)
	}
	sort.Strings(out)
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
	c.store.dropStaged(c.space)
	return st, nil
}

// State is the chain's state, or nil when it doesn't verify.
func (c *spaceChain) State() *State {
	st, _ := c.load()
	return st
}

// Extend takes entries a device brings, keeping them once they verify.
func (c *spaceChain) Extend(from int, entries []Entry) (*State, error) {
	var out *State
	err := c.store.locked(func() error {
		c.mu.Lock()
		defer c.mu.Unlock()
		// Under the lock the file is read again whatever its time says, so another process's write is never lost.
		c.state = nil
		st, err := c.loadLocked()
		if err != nil {
			return err
		}
		next, err := ExtendChain(st, entries, from)
		if err != nil {
			return err
		}
		if next.Seq == st.Seq {
			out = st
			return nil
		}
		start := st.Seq + 1 - from
		if from < 0 || start < 0 || start > len(entries) {
			return fmt.Errorf("the entries don't follow seq %d", st.Seq)
		}
		f := spaceFile{Genesis: c.file.Genesis, Entries: append(append([]Entry{}, c.file.Entries...), entries[start:]...)}
		if err := writeFile(c.path, f); err != nil {
			return err
		}
		info, _ := os.Stat(c.path)
		c.file, c.state = f, next
		if info != nil {
			c.modTime = info.ModTime()
		}
		out = next
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
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
func (s *Store) Join(join *JoinTicket, entries []Entry, hostID string, now time.Time) (e Entry, st *State, err error) {
	// No gateway update runs across a join (Unenrolled).
	if eerr := s.enrolling(func() error {
		e, st, err = s.joinEnrolling(join, entries, hostID, now)
		return nil
	}); eerr != nil {
		return Entry{}, nil, eerr
	}
	return e, st, err
}

func (s *Store) joinEnrolling(join *JoinTicket, entries []Entry, hostID string, now time.Time) (e Entry, st *State, err error) {
	// The keys first: they are made under the lock, which isn't reentrant.
	if _, err := s.Identity(); err != nil {
		return Entry{}, nil, err
	}
	// The check against the chain held and the write are one step under the store's lock, so a session's extension
	// between them can't be written over.
	lerr := s.locked(func() error {
		e, st, err = s.join(join, entries, hostID, now)
		return nil
	})
	if lerr != nil {
		return Entry{}, nil, lerr
	}
	return e, st, err
}

func (s *Store) join(join *JoinTicket, entries []Entry, hostID string, now time.Time) (Entry, *State, error) {
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
	// A chain the host holds already: the gateway's must carry it on, not go back on it or fork from it (an older
	// prefix would bring back removed devices, and signing a host.add onto it would fork the chain).
	if c := s.Space(space); c != nil {
		c.mu.Lock()
		c.state = nil
		c.mu.Unlock()
		cur, err := c.load()
		var have []Entry
		switch {
		case err == nil:
			have = c.Entries(0)
		case errors.Is(err, os.ErrNotExist):
			// A first join that stopped between marking the space joined and writing its chain finishes from the chain
			// it staged first; a joined space with neither stays strict.
			if cur, have, err = s.staged(space); err != nil {
				return Entry{}, nil, fmt.Errorf("this host joined %s but holds no chain for it, so it can't be joined again: %w", space, err)
			}
			if err := s.save(space, cur.Genesis, have); err != nil {
				return Entry{}, nil, err
			}
		default:
			return Entry{}, nil, fmt.Errorf("this host's chain for %s doesn't verify, so it can't be joined again: %w", space, err)
		}
		if cur.Genesis != genesis {
			return Entry{}, nil, fmt.Errorf("this host already holds another chain for %s", space)
		}
		if !samePrefix(have, entries) && lostHostAdd(have, entries, cur, hostID, id.DHPublic()) {
			// This host's own last host.add lost its seq to another entry the gateway took: it was never in the chain
			// anyone else follows, so it is dropped, and the host joins the chain as it is (with a new ticket, if the
			// chain spent the old one). Nothing anyone else signed is gone back on.
			have = have[:len(have)-1]
		}
		if !samePrefix(have, entries) {
			if samePrefix(entries, have) {
				// The gateway is behind: if what it lacks starts with this host's own host.add, publish that again.
				if h, ok := cur.Hosts[hostID]; ok && h.DH == B64(id.DHPublic()) && isHostAdd(have[len(entries)], hostID) {
					return have[len(entries)], cur, nil
				}
				return Entry{}, nil, fmt.Errorf("the gateway's chain for %s is behind the one this host holds (seq %d, not %d)", space, len(entries)-1, cur.Seq)
			}
			return Entry{}, nil, fmt.Errorf("the gateway's chain for %s forks from the one this host holds", space)
		}
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

// save writes a joined space's chain. The first time, the chain is staged in pending/ before the space is marked
// joined, so a join that stops between the marker and the chain stays strict (joined, no chain) and a retry finishes
// it from the staged chain (staged), without going back on it.
func (s *Store) save(space, genesis string, entries []Entry) error {
	path := filepath.Join(s.dir, "spaces", space+".json")
	if _, err := os.Stat(path); err != nil {
		if err := writeFile(s.pendingPath(space), spaceFile{Genesis: genesis, Entries: entries}); err != nil {
			return err
		}
	}
	if err := s.markJoined(space); err != nil {
		return err
	}
	if err := writeFile(path, spaceFile{Genesis: genesis, Entries: entries}); err != nil {
		return err
	}
	s.dropStaged(space)
	return nil
}

func (s *Store) pendingPath(space string) string {
	return filepath.Join(s.dir, "pending", space+".json")
}

// dropStaged forgets a first join's staged chain once the chain is in place, so it can't be used to go back on the
// chain if that is lost later. One left behind (a failed removal) goes when the chain is next read (loadLocked).
func (s *Store) dropStaged(space string) { _ = os.Remove(s.pendingPath(space)) }

// staged is the chain a first join of space staged before it marked the space joined, verified.
func (s *Store) staged(space string) (*State, []Entry, error) {
	raw, err := os.ReadFile(s.pendingPath(space))
	if err != nil {
		return nil, nil, err
	}
	var f spaceFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, nil, err
	}
	if f.Genesis == "" {
		return nil, nil, errors.New("the staged chain pins no genesis")
	}
	st, err := VerifyChain(f.Entries, f.Genesis)
	if err != nil {
		return nil, nil, err
	}
	if st.Space != space {
		return nil, nil, errors.New("the staged chain is another space's")
	}
	return st, f.Entries, nil
}

// samePrefix reports whether prefix is the start of entries.
func samePrefix(prefix, entries []Entry) bool {
	if len(prefix) > len(entries) {
		return false
	}
	for i, e := range prefix {
		if entries[i] != e {
			return false
		}
	}
	return true
}

// isHostAdd reports whether e is a host.add of hostID.
// lostHostAdd is whether the only entry of have that entries doesn't carry on is have's last, this host's own host.add
// (with these keys), and entries holds another entry at its seq: an append the gateway refused for that one.
func lostHostAdd(have, entries []Entry, cur *State, hostID string, dh []byte) bool {
	n := len(have) - 1
	if n < 1 || len(entries) <= n || !isHostAdd(have[n], hostID) || !samePrefix(have[:n], entries) {
		return false
	}
	h, ok := cur.Hosts[hostID]
	return ok && h.DH == B64(dh) && EntryHash(entries[n]) != EntryHash(have[n])
}

func isHostAdd(e Entry, hostID string) bool {
	raw, err := FromB64(e.Payload)
	if err != nil {
		return false
	}
	var p struct {
		Type string `json:"type"`
		Body struct {
			Host struct {
				ID string `json:"id"`
			} `json:"host"`
		} `json:"body"`
	}
	return json.Unmarshal(raw, &p) == nil && p.Type == "host.add" && p.Body.Host.ID == hostID
}
