package e2e

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

type joinVector struct {
	Entries      []Entry `json:"entries"`
	Word         string  `json:"word"`
	OtherEntries []Entry `json:"otherEntries"`
}

func TestJoinSignsAHostAddTheChainTakes(t *testing.T) {
	var v joinVector
	readVector(t, "join.json", &v)
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	join, err := DecodeJoinTicket(v.Word)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Join(join, v.OtherEntries, "host_two", time.Now()); err == nil {
		t.Fatal("joined from another space's chain")
	}
	entry, st, err := store.Join(join, v.Entries, "host_two", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := store.Identity()
	if h, ok := st.Hosts["host_two"]; !ok || h.Name != "rack-9" || h.DH != B64(id.DHPublic()) {
		t.Fatalf("hosts %+v", st.Hosts)
	}
	// What a device does with the entry it fetches: the chain takes it.
	if _, err := VerifyChain(append(append([]Entry{}, v.Entries...), entry), ""); err != nil {
		t.Fatal(err)
	}
	if store.Mode(st.Space) != ModeOn {
		t.Fatalf("mode %s", store.Mode(st.Space))
	}
	// Again (a publish that failed): nothing new to sign.
	again, _, err := store.Join(join, append(append([]Entry{}, v.Entries...), entry), "host_two", time.Now())
	if err != nil || again.Payload != "" {
		t.Fatalf("again: %v", err)
	}
	// Again, with the gateway's chain from before the host.add (its publish was lost): the same entry, not a new one
	// signed onto the old head, which would fork the chain.
	resent, _, err := store.Join(join, v.Entries, "host_two", time.Now().Add(time.Minute))
	if err != nil || resent != entry {
		t.Fatalf("resent %+v, %v", resent, err)
	}
	// The gateway's chain from further back, without entries the host holds: refused, not taken.
	if _, _, err := store.Join(join, v.Entries[:len(v.Entries)-1], "host_two", time.Now()); err == nil {
		t.Fatal("a rejoin rolled the host's chain back")
	}
	if got := store.Space(st.Space).Entries(0); len(got) != len(v.Entries)+1 {
		t.Fatalf("the host's chain has %d entries", len(got))
	}
	// A second host with the same ticket is refused: it was spent.
	other, _ := OpenStore(t.TempDir())
	if _, _, err := other.Join(join, append(append([]Entry{}, v.Entries...), entry), "host_three", time.Now()); err == nil {
		t.Fatal("a spent ticket joined another host")
	}
}

func TestAChainFileThatDoesntVerifyShutsPlaintextOut(t *testing.T) {
	var v joinVector
	readVector(t, "join.json", &v)
	dir := t.TempDir()
	store, _ := OpenStore(dir)
	join, _ := DecodeJoinTicket(v.Word)
	_, st, err := store.Join(join, v.Entries, "host_two", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "spaces", st.Space+".json")
	raw, _ := os.ReadFile(path)
	// Someone edits a signature on the host's disk.
	raw[len(raw)/2] ^= 1
	later := time.Now().Add(time.Second)
	_ = os.WriteFile(path, raw, 0o600)
	_ = os.Chtimes(path, later, later)
	if store.Mode(st.Space) != ModeStrict || store.Space(st.Space).State() != nil {
		t.Fatalf("mode %s after the file changed", store.Mode(st.Space))
	}
	// Someone deletes it: still locked, here and in a new process, rather than off.
	_ = os.Remove(path)
	if store.Mode(st.Space) != ModeStrict {
		t.Fatalf("mode %s after the file went", store.Mode(st.Space))
	}
	fresh, _ := OpenStore(dir)
	if fresh.Mode(st.Space) != ModeStrict || len(fresh.Spaces()) != 1 {
		t.Fatalf("a new process: mode %s, spaces %v", fresh.Mode(st.Space), fresh.Spaces())
	}
}

// Entries put past the next seq are refused, here and in the store, rather than taken (or panicking the daemon).
func TestAnExtensionThatSkipsASeqIsRefused(t *testing.T) {
	var v joinVector
	readVector(t, "join.json", &v)
	k := len(v.Entries) - 1
	state, err := VerifyChain(v.Entries[:k], "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ExtendChain(state, v.Entries[k:], k+3); err == nil {
		t.Fatal("an entry was taken at a seq it doesn't have")
	}
	if next, err := ExtendChain(state, v.Entries[k:], k); err != nil || next.Seq != k {
		t.Fatalf("the next entry: %v", err)
	}
	if next, err := ExtendChain(state, v.Entries, 0); err != nil || next.Seq != k {
		t.Fatalf("the whole chain: %v", err)
	}
	store, _ := OpenStore(t.TempDir())
	if err := store.save(state.Space, EntryHash(v.Entries[0]), v.Entries[:k]); err != nil {
		t.Fatal(err)
	}
	chain := store.Space(state.Space)
	for _, from := range []int{k + 3, -2} {
		if _, err := chain.Extend(from, v.Entries[k:]); err == nil {
			t.Fatalf("the store took entries from %d", from)
		}
	}
	if got := chain.Entries(0); len(got) != k {
		t.Fatalf("the store has %d entries", len(got))
	}
	if st, err := chain.Extend(k, v.Entries[k:]); err != nil || st.Seq != k || len(chain.Entries(0)) != k+1 {
		t.Fatalf("the next entry: %v", err)
	}
}

// The daemon and `kantel-host e2e join` are two processes with a Store each: a write waits for the other's to end.
func TestTwoStoresOnOneDirectoryTakeTurns(t *testing.T) {
	var v joinVector
	readVector(t, "join.json", &v)
	dir := t.TempDir()
	cli, _ := OpenStore(dir)
	join, _ := DecodeJoinTicket(v.Word)
	entry, st, err := cli.Join(join, v.Entries, "host_two", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	daemon, _ := OpenStore(dir)
	held, release := make(chan struct{}), make(chan struct{})
	go func() {
		_ = cli.locked(func() error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	done := make(chan error, 1)
	go func() {
		_, err := daemon.Space(st.Space).Extend(0, append(append([]Entry{}, v.Entries...), entry))
		done <- err
	}()
	select {
	case <-done:
		t.Fatal("the daemon wrote while the CLI held the lock")
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := daemon.Space(st.Space).Entries(0); len(got) != len(v.Entries)+1 {
		t.Fatalf("%d entries", len(got))
	}
}

// The daemon and the CLI asking for the host's keys at once, on a host without any, end up with one pair.
func TestTwoStoresMakeOneIdentity(t *testing.T) {
	dir := t.TempDir()
	a, _ := OpenStore(dir)
	b, _ := OpenStore(dir)
	ids := make(chan *Identity, 2)
	for _, s := range []*Store{a, b} {
		go func() {
			id, err := s.Identity()
			if err != nil {
				t.Error(err)
			}
			ids <- id
		}()
	}
	one, two := <-ids, <-ids
	if one == nil || two == nil || B64(one.DHPublic()) != B64(two.DHPublic()) {
		t.Fatal("two processes made two identities")
	}
}
