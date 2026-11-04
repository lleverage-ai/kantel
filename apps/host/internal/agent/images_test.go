package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// signedUpdater is an updater for a host without KVM (so a version is its manifest alone) whose releases, in the
// directory it answers, are signed: cosign is asked, and says the signature checks out. onActivate runs inside the
// check, once the version is current.
func signedUpdater(t *testing.T, h *Host, onActivate func(string)) (*images.Updater, string) {
	t.Helper()
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "manifest.json"), `{"version":"0.0.0-dev","files":{}}`)
	writeFile(t, filepath.Join(src, "manifest.json.sigstore.json"), "{}")
	cosign := filepath.Join(t.TempDir(), "cosign")
	writeFile(t, cosign, "")
	u := &images.Updater{
		Store: images.Store{Dir: filepath.Join(h.cfg.Root, "images")}, Arch: "amd64", Log: h.log, OnActivate: onActivate,
		Verifier: images.Verifier{Cosign: cosign, Log: h.log, Run: func(context.Context, string, ...string) ([]byte, error) {
			return nil, nil
		}},
	}
	return u, src
}

// A gateway's image update runs under the enrolment lock: a join waits for one that started before it, and once the
// host has joined, the next is refused before anything is fetched. A host that never joined takes a signed one.
func TestAGatewayImageUpdateNeverCrossesAJoin(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	var err error
	if h.e2e, err = e2e.OpenStore(filepath.Join(h.cfg.Root, "e2e")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "e2e", "vectors", "join.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Entries []e2e.Entry `json:"entries"`
		Word    string      `json:"word"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	ticket, err := e2e.DecodeJoinTicket(v.Word)
	if err != nil {
		t.Fatal(err)
	}
	activated, release := make(chan string, 2), make(chan struct{})
	u, src := signedUpdater(t, h, func(version string) {
		activated <- version
		<-release
	})
	first := proto.ImageChannel{Channel: "stable", Version: "host-images-20261103", URL: src}
	updated := make(chan error, 1)
	go func() { updated <- h.checkImages(context.Background(), u, first) }()
	select {
	case <-activated:
	case err := <-updated:
		t.Fatalf("the update on a host that never joined: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the update didn't run")
	}
	joined := make(chan error, 1)
	go func() {
		_, _, err := h.e2e.Join(ticket, v.Entries, "host_two", time.Now())
		joined <- err
	}()
	select {
	case err := <-joined:
		t.Fatalf("the join went ahead while an image update ran: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-updated; err != nil {
		t.Fatal(err)
	}
	if err := <-joined; err != nil {
		t.Fatal(err)
	}
	if !h.e2e.Enrolled() {
		t.Fatal("the join didn't enrol the host")
	}
	next := proto.ImageChannel{Channel: "stable", Version: "host-images-20261104", URL: src}
	if err := h.checkImages(context.Background(), u, next); !errors.Is(err, e2e.ErrEnrolled) {
		t.Fatalf("an image update on a joined host: %v", err)
	}
	if got, _ := u.Store.Current(); got != first.Version {
		t.Fatalf("current = %q, want %q", got, first.Version)
	}
	if _, err := os.Stat(filepath.Join(u.Store.Dir, "v", next.Version)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the joined host fetched images: %v", err)
	}
}

// baseTier is a tier whose sandboxes are on image versions, and which records how a prune holds its base lock.
type baseTier struct {
	Tier // unimplemented methods panic

	inUse   map[string]bool
	locked  bool
	walked  bool // BasesInUse ran with the lock held
	unlock  func()
	unlocks int
}

func (b *baseTier) BasesInUse() map[string]bool {
	b.walked = b.locked
	return b.inUse
}

func (b *baseTier) ImagesChanged() {}

func (b *baseTier) LockBases() func() {
	b.locked = true
	return func() {
		b.unlocks++
		if b.unlock != nil {
			b.unlock()
		}
		b.locked = false
	}
}

// A prune holds the tiers' base lock from its walk of what is in use until it has removed what wasn't: a reference
// made or moved meanwhile waits, so the version it names can't go between the walk and the removal.
func TestAPruneHoldsTheBasesUntilItHasRemoved(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("e"); err != nil {
		t.Fatal(err)
	}
	gone := func(v string) bool {
		_, err := os.Stat(filepath.Join(store.Dir, "v", v))
		return errors.Is(err, os.ErrNotExist)
	}
	tier := &baseTier{inUse: map[string]bool{"a": true}}
	tier.unlock = func() {
		if !gone("b") || !gone("c") {
			t.Error("the base lock was let go before the unused versions were removed")
		}
	}
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.order = []string{microvm.Tier}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}
	removed := h.pruneImages()
	slices.Sort(removed)
	if !slices.Equal(removed, []string{"b", "c"}) {
		t.Fatalf("removed %v, want [b c]", removed)
	}
	if !tier.walked || tier.unlocks != 1 || tier.locked {
		t.Fatalf("walked under the lock %v, unlocked %d times, still locked %v", tier.walked, tier.unlocks, tier.locked)
	}
	for _, v := range []string{"a", "d", "e"} {
		if gone(v) {
			t.Errorf("%s was removed", v)
		}
	}
}

// A start whose rebase the gateway expects on images this host hasn't taken is refused before anything changes; on
// the images it has, it goes ahead.
func TestARebaseOntoImagesTheHostHasNotTakenIsRefused(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	h.cfg.ImagePatching, h.cfg.ImagesDir = true, filepath.Join(h.cfg.Root, "images")
	store := images.Store{Dir: h.cfg.ImagesDir}
	writeFile(t, filepath.Join(store.Dir, "v", "host-images-20261103", "manifest.json"), "{}")
	if err := store.Activate("host-images-20261103"); err != nil {
		t.Fatal(err)
	}
	tier.stopped["sbx_1"] = true
	err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "host-images-20261104"})
	if err == nil || !strings.Contains(err.Error(), "this host's images are host-images-20261103, not host-images-20261104; it hasn't taken the update yet") {
		t.Fatalf("a rebase onto images the host hasn't taken: %v", err)
	}
	if info, _ := tier.Get("sbx_1"); info.State != proto.StateStopped {
		t.Fatalf("the refused start left the sandbox %s", info.State)
	}
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "host-images-20261103"}); err != nil {
		t.Fatal(err)
	}
	if info, _ := tier.Get("sbx_1"); info.State != proto.StateRunning {
		t.Fatalf("the start left the sandbox %s", info.State)
	}
}

func TestHostImagesAnswersTheImagesAsTheyAreNow(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	if err := call(t, h, proto.MethodHostImages, struct{}{}); err == nil || !strings.Contains(err.Error(), "image patching is off") {
		t.Fatalf("host.images with image patching off: %v", err)
	}
	h.cfg.ImagePatching = true
	h.patching.facts.Store(&proto.HostImages{Version: "host-images-20261104"})
	raw, err := h.Call(context.Background(), proto.MethodHostImages, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := raw.(*proto.HostImages); !ok || got.Version != "host-images-20261104" {
		t.Fatalf("host.images answered %#v", raw)
	}
}
