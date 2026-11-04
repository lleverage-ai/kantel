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
}
