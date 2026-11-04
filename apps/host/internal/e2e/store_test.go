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
