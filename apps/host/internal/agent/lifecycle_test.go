package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// lifecycleTier is a microVM tier that keeps each sandbox's egress as microvm keeps it in meta.json, inherits it on
// a fork with none, and can fail or hold its calls for a test.
type lifecycleTier struct {
	Tier // unimplemented methods panic

	mu      sync.Mutex
	egress  map[string]*proto.Egress
	running map[string]bool
	stopped map[string]bool
	execs   []proto.ExecParams
	// failExecs is how many installs fail before they work.
	failExecs int
	// failSetEgress is how many SetEgress calls fail (a meta.json that can't be written).
	failSetEgress int
	// failCreate is how many creates (forks included) fail, leaving nothing.
	failCreate int
	// hold, when set, is waited on inside Create and SetEgress (once each call has started).
	hold    chan struct{}
	inside  atomic.Int32
	maxSeen atomic.Int32
}

func newLifecycleTier() *lifecycleTier {
	return &lifecycleTier{egress: map[string]*proto.Egress{}, running: map[string]bool{}, stopped: map[string]bool{}}
}

func (f *lifecycleTier) enter() func() {
	n := f.inside.Add(1)
	for {
		m := f.maxSeen.Load()
		if n <= m || f.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	f.mu.Lock()
	hold := f.hold
	f.mu.Unlock()
	if hold != nil {
		<-hold
	}
	return func() { f.inside.Add(-1) }
}

func (f *lifecycleTier) Create(_ context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	defer f.enter()()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.running[p.SandboxID] {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrConflict, Message: p.SandboxID}
	}
	if f.failCreate > 0 {
		f.failCreate--
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrUnavailable, Message: "no room"}
	}
	f.egress[p.SandboxID] = p.Egress
	f.running[p.SandboxID] = true
	return proto.SandboxInfo{ID: p.SandboxID, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *lifecycleTier) Fork(ctx context.Context, p proto.ForkParams) (proto.SandboxInfo, error) {
	f.mu.Lock()
	e := p.Egress
	if e == nil {
		e = f.egress[p.SandboxID]
	}
	f.mu.Unlock()
	return f.Create(ctx, proto.CreateParams{SandboxID: p.NewID, Egress: e})
}

func (f *lifecycleTier) EgressOf(id string) (*proto.Egress, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.egress[id]
	if e == nil {
		return nil, nil
	}
	c := *e
	return &c, nil
}

func (f *lifecycleTier) Get(id string) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case f.running[id]:
		return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning}, nil
	case f.stopped[id]:
		return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateStopped}, nil
	}
	return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
}

func (f *lifecycleTier) Stop(_ context.Context, p proto.StopParams) (proto.SnapshotInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.running, p.SandboxID)
	f.stopped[p.SandboxID] = true
	return proto.SnapshotInfo{}, nil
}

// Resume is as both tiers have it: nothing at all when it runs; otherwise it boots, with the egress given, if any.
func (f *lifecycleTier) Resume(_ context.Context, p proto.ResumeParams, _ bool) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.running[p.SandboxID] {
		if p.Egress != nil {
			f.egress[p.SandboxID] = p.Egress
		}
		delete(f.stopped, p.SandboxID)
		f.running[p.SandboxID] = true
	}
	return proto.SandboxInfo{ID: p.SandboxID, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *lifecycleTier) SetEgress(id string, e *proto.Egress) error {
	defer f.enter()()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failSetEgress > 0 {
		f.failSetEgress--
		return &proto.Error{Code: proto.ErrUnavailable, Message: "meta.json: no space left"}
	}
	f.egress[id] = e
	return nil
}

func (f *lifecycleTier) Exec(_ context.Context, p proto.ExecParams, _ func(string, string)) (proto.ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execs = append(f.execs, p)
	if f.failExecs > 0 {
		f.failExecs--
		return proto.ExecResult{ExitCode: 1, Stderr: "update-ca-certificates: no space left"}, nil
	}
	return proto.ExecResult{}, nil
}

func (f *lifecycleTier) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.running, id)
	delete(f.stopped, id)
	delete(f.egress, id)
	return nil
}

func (f *lifecycleTier) execCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.execs)
}

func newLifecycleHost(t *testing.T, tier *lifecycleTier) *Host {
	t.Helper()
	dir := t.TempDir()
	h := &Host{
		cfg: Config{Root: dir, ProxyDataPath: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: map[string]Tier{microvm.Tier: tier}, order: []string{microvm.Tier}, bySlot: map[int]egress.Rules{},
		cas: egress.NewCAStore(dir + "/egress-ca"),
	}
	h.secrets = protect.NewStore(h.fetchSecrets)
	return h
}

func call(t *testing.T, h *Host, method string, params any) error {
	t.Helper()
	raw, _ := json.Marshal(params)
	_, err := h.Call(context.Background(), method, raw, nil)
	return err
}

func protectedEgress(version int64, hosts ...string) *proto.Egress {
	return &proto.Egress{Mode: "proxy", Protected: &proto.Protected{Version: version, Intercept: hosts}}
}

// An install that failed is tried again by the next identical update, rather than taken as done; once it has
// worked, identical updates install nothing.
func TestFailedCAInstallIsRetried(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: protectedEgress(1, "api.github.com")}); err != nil {
		t.Fatal(err)
	}
	tier.failExecs = 1
	update := proto.ResumeParams{SandboxID: "sbx_1", Egress: protectedEgress(1, "api.github.com", "uploads.github.com")}
	if err := call(t, h, proto.MethodEgress, update); err == nil {
		t.Fatal("a failed install was reported as done")
	}
	if err := call(t, h, proto.MethodEgress, update); err != nil {
		t.Fatalf("the retry: %v", err)
	}
	ca, _ := h.cas.Get("sbx_1")
	tier.mu.Lock()
	last := tier.execs[len(tier.execs)-1]
	tier.mu.Unlock()
	stdin, _ := base64.StdEncoding.DecodeString(last.Stdin)
	if tier.execCount() != 2 || !strings.Contains(string(stdin), ca.CertPEM()) {
		t.Fatalf("%d installs; the last %q", tier.execCount(), stdin)
	}
	if !h.cas.Installed("sbx_1") {
		t.Fatal("a confirmed install wasn't recorded")
	}
	if err := call(t, h, proto.MethodEgress, update); err != nil || tier.execCount() != 2 {
		t.Fatalf("an unchanged update installed again: %v, %d installs", err, tier.execCount())
	}
	// The record survives a host restart (a new CAStore over the same directory).
	if !egress.NewCAStore(h.cfg.Root + "/egress-ca").Installed("sbx_1") {
		t.Fatal("the install record didn't survive a restart")
	}
}

// A fork that inherits its source's egress gets a CA of its own, and the fork's egress carries that CA's
// certificate, not its source's.
func TestForkWithInheritedEgressGetsItsOwnCA(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	upstreamCA := "-----BEGIN CERTIFICATE-----\nupstream\n-----END CERTIFICATE-----\n"
	e := protectedEgress(1, "api.github.com")
	e.CACert = upstreamCA
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_parent", Egress: e}); err != nil {
		t.Fatal(err)
	}
	parent, err := h.cas.Get("sbx_parent")
	if err != nil {
		t.Fatal(err)
	}
	parentPEM := parent.CertPEM()
	if err := call(t, h, proto.MethodFork, proto.ForkParams{SandboxID: "sbx_parent", NewID: "sbx_child"}); err != nil {
		t.Fatal(err)
	}
	child, err := h.cas.Get("sbx_child")
	if err != nil {
		t.Fatalf("the fork has no CA: %v", err)
	}
	if child.CertPEM() == parentPEM {
		t.Fatal("the fork shares its source's CA")
	}
	tier.mu.Lock()
	ce := tier.egress["sbx_child"]
	tier.mu.Unlock()
	if ce == nil || ce.Protected == nil || !strings.Contains(ce.CACert, child.CertPEM()) || strings.Contains(ce.CACert, strings.TrimSpace(parentPEM)) || !strings.HasPrefix(ce.CACert, upstreamCA) {
		t.Fatalf("the fork's egress CACert %q", ce.CACert)
	}
	if again, _ := h.cas.Get("sbx_parent"); again.CertPEM() != parentPEM {
		t.Fatal("the fork changed its source's CA")
	}
	// A source that intercepts nothing makes a fork with no CA.
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_plain", Egress: &proto.Egress{Mode: "proxy"}}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodFork, proto.ForkParams{SandboxID: "sbx_plain", NewID: "sbx_plain2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.cas.Get("sbx_plain2"); !errors.Is(err, egress.ErrNoCA) {
		t.Fatalf("a fork of an unintercepted sandbox has a CA: %v", err)
	}
}

// An egress update advertising a newer table version makes the host fetch again, and use the new values and
// bindings.
func TestEgressVersionRefreshesTheTable(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	var mu sync.Mutex
	version, value, host := int64(3), "ghs_v3", "api.github.com"
	l := newFakeLink(func(m proto.Message) *proto.Message {
		mu.Lock()
		defer mu.Unlock()
		raw, _ := json.Marshal(proto.SecretsTable{Version: version, Entries: []proto.SecretEntry{{
			Placeholder: testPlaceholder, Name: "GITHUB_TOKEN", Value: value, Bindings: []proto.DestinationBinding{{Host: host}},
		}}})
		return &proto.Message{Type: "result", ID: m.ID, Result: raw}
	})
	h.link = l.c
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: protectedEgress(3, "api.github.com")}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	gh := protect.Destination{Host: "api.github.com", Port: 443, Method: "GET", Path: "/"}
	if r, err := h.secrets.Resolve(ctx, testPlaceholder, "sbx_1", gh); err != nil || r.Value != "ghs_v3" {
		t.Fatalf("v3: %v", err)
	}
	mu.Lock()
	version, value, host = 4, "ghs_v4", "uploads.github.com"
	mu.Unlock()
	// The same intercept hosts, a newer version: the values are fetched again.
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: protectedEgress(4, "api.github.com")}); err != nil {
		t.Fatal(err)
	}
	up := protect.Destination{Host: "uploads.github.com", Port: 443, Method: "GET", Path: "/"}
	if r, err := h.secrets.Resolve(ctx, testPlaceholder, "sbx_1", up); err != nil || r.Value != "ghs_v4" {
		t.Fatalf("v4: %v", err)
	}
	var unbound *protect.UnboundError
	if _, err := h.secrets.Resolve(ctx, testPlaceholder, "sbx_1", gh); !errors.As(err, &unbound) {
		t.Fatalf("v3's binding still applies: %v", err)
	}
	// A notice of version 5 while Kantel still answers 4: refused until it answers 5.
	if err := call(t, h, proto.MethodSecrets, proto.SecretsParams{SandboxID: "sbx_1", Version: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.secrets.Resolve(ctx, testPlaceholder, "sbx_1", up); !errors.Is(err, protect.ErrUnavailable) {
		t.Fatalf("a stale table was used: %v", err)
	}
}

// Overlapping lifecycle calls for one sandbox run one at a time, so the CA the proxy holds, the one in the tier's
// egress and the one installed in the guest are the same; a rejected duplicate create leaves the winner's CA.
func TestLifecycleCallsForOneSandboxDontInterleave(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: protectedEgress(1, "a.example.com")}); err != nil {
		t.Fatal(err)
	}
	hold := make(chan struct{})
	tier.mu.Lock()
	tier.hold = hold
	tier.mu.Unlock()
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for _, hosts := range [][]string{{"b.example.com"}, {"c.example.com"}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, _ := json.Marshal(proto.ResumeParams{SandboxID: "sbx_1", Egress: protectedEgress(1, hosts...)})
			_, err := h.Call(context.Background(), proto.MethodEgress, raw, nil)
			errs <- err
		}()
	}
	// Another sandbox isn't held up by sbx_1's calls.
	wg.Add(1)
	go func() {
		defer wg.Done()
		raw, _ := json.Marshal(proto.CreateParams{SandboxID: "sbx_2", Egress: protectedEgress(1, "a.example.com")})
		_, err := h.Call(context.Background(), proto.MethodCreate, raw, nil)
		errs <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for tier.inside.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := tier.inside.Load(); n != 2 {
		t.Fatalf("%d calls in the tier at once, want sbx_1's first update and sbx_2's create", n)
	}
	close(hold)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	ca, _ := h.cas.Get("sbx_1")
	tier.mu.Lock()
	inTier := tier.egress["sbx_1"].CACert
	var lastInstall string
	for _, e := range tier.execs {
		if e.SandboxID == "sbx_1" {
			stdin, _ := base64.StdEncoding.DecodeString(e.Stdin)
			lastInstall = string(stdin)
		}
	}
	tier.mu.Unlock()
	if !strings.Contains(inTier, ca.CertPEM()) || !strings.Contains(lastInstall, ca.CertPEM()) {
		t.Fatal("the proxy's CA, the tier's and the guest's disagree")
	}

	// Two creates of one ID: the second is refused and the first's CA stays.
	hold = make(chan struct{})
	tier.mu.Lock()
	tier.hold = hold
	tier.mu.Unlock()
	results := make(chan error, 2)
	for range 2 {
		go func() {
			raw, _ := json.Marshal(proto.CreateParams{SandboxID: "sbx_3", Egress: protectedEgress(1, "a.example.com")})
			_, err := h.Call(context.Background(), proto.MethodCreate, raw, nil)
			results <- err
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(hold)
	var conflicts int
	for range 2 {
		var pe *proto.Error
		if err := <-results; errors.As(err, &pe) && pe.Code == proto.ErrConflict {
			conflicts++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if conflicts != 1 {
		t.Fatalf("%d conflicts, want 1", conflicts)
	}
	ca3, err := h.cas.Get("sbx_3")
	if err != nil {
		t.Fatalf("the winner's CA went: %v", err)
	}
	tier.mu.Lock()
	inTier = tier.egress["sbx_3"].CACert
	tier.mu.Unlock()
	if !strings.Contains(inTier, ca3.CertPEM()) {
		t.Fatal("the winner's egress isn't the CA the proxy holds")
	}
	if tier.maxSeen.Load() > 2 {
		t.Fatalf("%d calls were in the tier at once", tier.maxSeen.Load())
	}
}

// An egress update older than the one the sandbox has is ignored, a null one's too; a newer or unordered one is
// taken.
func TestStaleEgressUpdateIsIgnored(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	held := func() *proto.Egress { e, _ := tier.EgressOf("sbx_1"); return e }
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(20, "new.example"), Revision: 20}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(10, "old.example"), Revision: 10}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "new.example" || e.Revision != 20 {
		t.Fatalf("a stale update replaced a newer one: %+v", e)
	}
	// A stale clear doesn't clear it either.
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 15}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "new.example" {
		t.Fatalf("a stale clear replaced a newer egress: %+v", e)
	}
	// A newer clear does, and one older than it is still refused once the egress is null.
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("a stale update replaced a newer clear: %+v", e)
	}
	// Unordered (an older control plane) is always taken.
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(0, "any.example")}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "any.example" {
		t.Fatalf("an unordered update wasn't taken: %+v", e)
	}
}

// The host reports that it enforces egress policy, so the control plane sends it grants and protected variables.
func TestFactsReportEgressPolicy(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	f := h.makeFacts()
	found := false
	for _, feature := range f.Features {
		found = found || feature == proto.FeatureEgressPolicy
	}
	if !found {
		t.Fatalf("features %v", f.Features)
	}
}

// An egress the host already holds (kept in meta.json across a stop, adopted at a restart, inherited by a fork)
// still sets the oldest table its traffic may use: when the tier attaches it, or an isolate's request reads it, a
// table older than the version it advertises is refused.
func TestHeldEgressRequiresItsTableVersion(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	l := newFakeLink(func(m proto.Message) *proto.Message {
		// Kantel, behind: it still answers version 4.
		raw, _ := json.Marshal(proto.SecretsTable{Version: 4, Entries: []proto.SecretEntry{{
			Placeholder: testPlaceholder, Name: "GITHUB_TOKEN", Value: "ghs_v4", Bindings: []proto.DestinationBinding{{Host: "api.github.com"}},
		}}})
		return &proto.Message{Type: "result", ID: m.ID, Result: raw}
	})
	h.link = l.c
	ctx := context.Background()
	gh := protect.Destination{Host: "api.github.com", Port: 443, Method: "GET", Path: "/"}
	held := protectedEgress(5, "api.github.com")
	for _, attach := range []struct {
		name string
		do   func(id string)
	}{
		{"a microVM's slot", func(id string) { h.attachSlot(7, id, "acc_1", held) }},
		{"an isolate's request", func(id string) { _ = h.liveRules(id, "acc_1", held) }},
	} {
		id := "sbx_" + strings.ReplaceAll(attach.name, " ", "_")
		// Nothing sent the version: the stop forgot what the create required, and the egress comes back from meta.json.
		h.forgetSecrets(id)
		attach.do(id)
		if _, err := h.secrets.Resolve(ctx, testPlaceholder, id, gh); !errors.Is(err, protect.ErrUnavailable) {
			t.Fatalf("%s: a table older than its egress was used: %v", attach.name, err)
		}
	}
	// One that advertises no newer version uses what Kantel answers.
	h.attachSlot(8, "sbx_current", "acc_1", protectedEgress(4, "api.github.com"))
	if r, err := h.secrets.Resolve(ctx, testPlaceholder, "sbx_current", gh); err != nil || r.Value != "ghs_v4" {
		t.Fatalf("a current table: %v", err)
	}
}

// caFiles is everything the CA store keeps for a sandbox (its key and certificate), by file name.
func caFiles(t *testing.T, h *Host, id string) map[string]string {
	t.Helper()
	out := map[string]string{}
	dir := filepath.Join(h.cfg.Root, "egress-ca", id)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = string(raw)
	}
	return out
}

// A start or resume of a sandbox that runs already changes nothing in it, so it changes nothing of its CA either: not
// the one the proxy signs with, its kept key, nor the egress the sandbox holds, whatever interception it carries. A
// stopped one, which does boot, gets the CA its egress needs.
func TestNoOpStartLeavesTheCA(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	first := protectedEgress(1, "api.github.com")
	first.Revision = 10
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: first}); err != nil {
		t.Fatal(err)
	}
	ca, _ := h.cas.Get("sbx_1")
	files := caFiles(t, h, "sbx_1")
	if len(files) == 0 {
		t.Fatal("no CA was kept")
	}
	other := protectedEgress(1, "uploads.github.com")
	other.Revision = 20
	none := &proto.Egress{Mode: "proxy", Revision: 30}
	for _, method := range []string{proto.MethodStart, proto.MethodResume} {
		for _, e := range []*proto.Egress{other, none} {
			if err := call(t, h, method, proto.ResumeParams{SandboxID: "sbx_1", Egress: e}); err != nil {
				t.Fatalf("%s: %v", method, err)
			}
			now, err := h.cas.Get("sbx_1")
			if err != nil || now.CertPEM() != ca.CertPEM() {
				t.Fatalf("%s of a running sandbox changed its CA: %v", method, err)
			}
			if !maps.Equal(caFiles(t, h, "sbx_1"), files) {
				t.Fatalf("%s of a running sandbox changed its kept CA", method)
			}
			if held, _ := tier.EgressOf("sbx_1"); held == nil || held.Revision != 10 || !strings.Contains(held.CACert, ca.CertPEM()) {
				t.Fatalf("%s of a running sandbox changed its egress: %+v", method, held)
			}
		}
	}
	// Stopped, a start boots it with the egress it carries, and that egress's CA.
	if err := call(t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Egress: other}); err != nil {
		t.Fatal(err)
	}
	now, err := h.cas.Get("sbx_1")
	if err != nil || now.CertPEM() == ca.CertPEM() || !now.Covers("uploads.github.com") {
		t.Fatalf("a real start didn't get its egress's CA: %v", err)
	}
	if held, _ := tier.EgressOf("sbx_1"); held == nil || held.Revision != 20 || !strings.Contains(held.CACert, now.CertPEM()) {
		t.Fatalf("a real start didn't take its egress: %+v", held)
	}
}

// Every replacement of a sandbox's egress is ordered by the latest revision the host has taken: a boot read before a
// sandbox.egress the host took while the sandbox was stopped boots with that one, and a clear holds its revision
// across a host restart, though it leaves no egress in meta.json to order by.
func TestEgressOrderingHoldsAcrossBootsAndRestarts(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	held := func() *proto.Egress { e, _ := tier.EgressOf("sbx_1"); return e }
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: deny(5, "first.example")}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(20, "new.example"), Revision: 20}); err != nil {
		t.Fatal(err)
	}
	// A boot read at revision 10, arriving after.
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(10, "old.example"), Revision: 10}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Revision != 20 || e.Grants[0].Host != "new.example" {
		t.Fatalf("a stale boot replaced a newer egress: %+v", e)
	}
	// A clear, then a restart: a new host over the same root, the tier's metadata as it was kept (no egress).
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("the clear: %+v", e)
	}
	restarted := &Host{
		cfg: h.cfg, log: h.log, tiers: h.tiers, order: h.order, bySlot: map[int]egress.Rules{},
		cas: egress.NewCAStore(h.cfg.Root + "/egress-ca"),
	}
	restarted.secrets = protect.NewStore(restarted.fetchSecrets)
	if err := call(t, restarted, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("after a restart, a stale update replaced a newer clear: %+v", e)
	}
	if err := call(t, restarted, proto.MethodStop, proto.StopParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, restarted, proto.MethodResume, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("after a restart, a stale boot replaced a newer clear: %+v", e)
	}
	// The current revision again is taken (a retry), and a newer one, and an unordered one always.
	for _, e := range []*proto.Egress{deny(30, "same.example"), deny(31, "newer.example"), deny(0, "any.example")} {
		if err := call(t, restarted, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: e, Revision: e.Revision}); err != nil {
			t.Fatal(err)
		}
		if got := held(); got == nil || got.Grants[0].Host != e.Grants[0].Host {
			t.Fatalf("revision %d wasn't taken: %+v", e.Revision, got)
		}
	}
	// A deleted sandbox's floor goes with it.
	if err := call(t, restarted, proto.MethodDelete, proto.SandboxRef{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(h.cfg.Root, "egress-revision", "sbx_1")); !os.IsNotExist(err) {
		t.Fatalf("the floor outlived its sandbox: %v", err)
	}
}

// A boot with a revision states the egress, none being the host's default: an update read before it (a push from
// before the stop, still on its way) is refused after, a restart notwithstanding. One without a revision keeps it.
func TestARevisionedBootStatesTheEgress(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	held := func() *proto.Egress { e, _ := tier.EgressOf("sbx_1"); return e }
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: deny(5, "first.example")}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodStop, proto.StopParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	// Its grants were all removed while it was stopped: the boot says so with its revision alone.
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Revision: 40}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("a revisioned boot without egress kept the old one: %+v", e)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(20, "old.example"), Revision: 20}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("a push from before the boot replaced its egress: %+v", e)
	}
	restarted := &Host{
		cfg: h.cfg, log: h.log, tiers: h.tiers, order: h.order, bySlot: map[int]egress.Rules{},
		cas: egress.NewCAStore(h.cfg.Root + "/egress-ca"),
	}
	restarted.secrets = protect.NewStore(restarted.fetchSecrets)
	if err := call(t, restarted, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(30, "old.example"), Revision: 30}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("after a restart, a push from before the boot replaced its egress: %+v", e)
	}
	// Unrevisioned (an older control plane), a boot without egress keeps what it has.
	if err := call(t, restarted, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(41, "kept.example"), Revision: 41}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, restarted, proto.MethodStop, proto.StopParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, restarted, proto.MethodResume, proto.ResumeParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "kept.example" {
		t.Fatalf("an unrevisioned boot without egress didn't keep it: %+v", e)
	}
}

// A create or fork that saved its floor and then failed leaves that floor: a delayed older attempt for the same ID
// makes nothing, rather than a sandbox with the older egress; the newer one again does.
func TestAStaleCreateOrForkMakesNothing(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	stale := func(err error) bool {
		var perr *proto.Error
		return errors.As(err, &perr) && perr.Code == proto.ErrConflict
	}
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_p", Egress: deny(1, "parent.example")}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		make func(e *proto.Egress) error
		id   string
	}{
		{"create", func(e *proto.Egress) error {
			return call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: e})
		}, "sbx_1"},
		{"fork", func(e *proto.Egress) error {
			return call(t, h, proto.MethodFork, proto.ForkParams{SandboxID: "sbx_p", NewID: "sbx_2", Egress: e})
		}, "sbx_2"},
	} {
		tier.mu.Lock()
		tier.failCreate = 1
		tier.mu.Unlock()
		if err := c.make(deny(30, "new.example")); err == nil {
			t.Fatalf("%s: the failing attempt succeeded", c.name)
		}
		if err := c.make(deny(25, "old.example")); !stale(err) {
			t.Fatalf("%s: a stale attempt after a newer one wasn't refused: %v", c.name, err)
		}
		if _, err := tier.Get(c.id); err == nil {
			t.Fatalf("%s: a stale attempt made the sandbox", c.name)
		}
		if err := c.make(deny(30, "new.example")); err != nil {
			t.Fatalf("%s: the retry: %v", c.name, err)
		}
		if e, _ := tier.EgressOf(c.id); e == nil || e.Grants[0].Host != "new.example" {
			t.Fatalf("%s: the retry's egress: %+v", c.name, e)
		}
	}
}

// A fork that inherits its parent's egress is ordered by the inherited revision, in either tier: after a newer
// attempt for its ID saved its floor and failed, an inheriting fork read before it makes nothing.
func TestAnInheritingForkIsOrderedInEveryTier(t *testing.T) {
	for _, name := range []string{microvm.Tier, isolate.Tier} {
		tier := newLifecycleTier()
		h := newLifecycleHost(t, tier)
		h.tiers, h.order = map[string]Tier{name: tier}, []string{name}
		deny := func(rev int64, host string) *proto.Egress {
			return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
		}
		if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_p", Egress: deny(25, "parent.example")}); err != nil {
			t.Fatal(err)
		}
		tier.mu.Lock()
		tier.failCreate = 1
		tier.mu.Unlock()
		if err := call(t, h, proto.MethodFork, proto.ForkParams{SandboxID: "sbx_p", NewID: "sbx_2", Egress: deny(30, "new.example")}); err == nil {
			t.Fatalf("%s: the failing fork succeeded", name)
		}
		err := call(t, h, proto.MethodFork, proto.ForkParams{SandboxID: "sbx_p", NewID: "sbx_2"})
		var perr *proto.Error
		if !errors.As(err, &perr) || perr.Code != proto.ErrConflict {
			t.Fatalf("%s: a stale inheriting fork wasn't refused: %v", name, err)
		}
		if _, err := tier.Get("sbx_2"); err == nil {
			t.Fatalf("%s: a stale inheriting fork made the sandbox", name)
		}
	}
}

// The floor is saved before the egress is applied: an update that fails to apply has already refused everything
// older, and the same revision again applies it.
func TestTheFloorIsSavedBeforeTheEgressIsApplied(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	held := func() *proto.Egress { e, _ := tier.EgressOf("sbx_1"); return e }
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: deny(5, "first.example")}); err != nil {
		t.Fatal(err)
	}
	tier.mu.Lock()
	tier.failSetEgress = 1
	tier.mu.Unlock()
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30}); err == nil {
		t.Fatal("an update that wasn't applied was acknowledged")
	}
	if raw, err := os.ReadFile(filepath.Join(h.cfg.Root, "egress-revision", "sbx_1")); err != nil || strings.TrimSpace(string(raw)) != "30" {
		t.Fatalf("the floor wasn't saved first: %q %v", raw, err)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "first.example" {
		t.Fatalf("an older update was applied after a newer one failed: %+v", e)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("the retry: %+v", e)
	}
}

// A clear whose floor can't be written fails before it is applied, so Kantel sends it again; the retry (the same
// revision) writes the floor and applies it, and only then is it acknowledged: a restart after that still refuses an
// older update.
func TestAFloorThatIsNotSavedFailsTheCallUntilARetrySavesIt(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	deny := func(rev int64, host string) *proto.Egress {
		return &proto.Egress{Mode: "proxy", Revision: rev, Grants: []proto.Grant{{Action: "deny", Host: host, Rule: "deny " + host}}}
	}
	held := func() *proto.Egress { e, _ := tier.EgressOf("sbx_1"); return e }
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Egress: deny(5, "first.example")}); err != nil {
		t.Fatal(err)
	}
	// The floor's directory can't be made (a file is in its way).
	dir := filepath.Join(h.cfg.Root, "egress-revision")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("in the way"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30})
	var perr *proto.Error
	if !errors.As(err, &perr) || perr.Code != proto.ErrUnavailable {
		t.Fatalf("a clear whose floor wasn't saved was acknowledged: %v", err)
	}
	// Not applied (the floor goes first), and ordered in memory meanwhile: an older update is refused.
	if e := held(); e == nil || e.Grants[0].Host != "first.example" {
		t.Fatalf("a clear whose floor wasn't saved was applied: %+v", e)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e == nil || e.Grants[0].Host != "first.example" {
		t.Fatalf("a stale update was applied after a newer one: %+v", e)
	}
	// The same clear again, once the disk is fine, saves it and is acknowledged.
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Revision: 30}); err != nil {
		t.Fatalf("the retry: %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "sbx_1")); err != nil || strings.TrimSpace(string(raw)) != "30" {
		t.Fatalf("the retry didn't save the floor: %q %v", raw, err)
	}
	restarted := &Host{
		cfg: h.cfg, log: h.log, tiers: h.tiers, order: h.order, bySlot: map[int]egress.Rules{},
		cas: egress.NewCAStore(h.cfg.Root + "/egress-ca"),
	}
	restarted.secrets = protect.NewStore(restarted.fetchSecrets)
	if err := call(t, restarted, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: deny(25, "old.example"), Revision: 25}); err != nil {
		t.Fatal(err)
	}
	if e := held(); e != nil {
		t.Fatalf("after a restart, a stale update replaced a newer clear: %+v", e)
	}
}

// stickyTier is a lifecycleTier with sticky disks, whose block maps are made when the test says.
type stickyTier struct {
	*lifecycleTier
	waiting chan struct{}
	mapped  chan string
}

func (f *stickyTier) CommitSticky(_ context.Context, p proto.StickyCommitParams) (proto.StickyCommitResult, error) {
	return proto.StickyCommitResult{Version: p.Version}, nil
}

func (f *stickyTier) StickyMapDigest(_ context.Context, _, _ string) string {
	close(f.waiting)
	return <-f.mapped
}

func (f *stickyTier) DeleteSticky(proto.StickyDeleteParams) error { return nil }

func (f *stickyTier) StickyHoldings() []proto.StickyDiskHolding { return nil }

// A commit waits for its version's block map outside the sandbox's lifecycle lock: the sandbox's other calls (another
// commit, a stop) don't wait for a slow map. The answer has the map's digest.
func TestStickyCommitWaitsForItsMapOutsideTheLock(t *testing.T) {
	tier := &stickyTier{lifecycleTier: newLifecycleTier(), waiting: make(chan struct{}), mapped: make(chan string)}
	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1"}); err != nil {
		t.Fatal(err)
	}
	answered := make(chan proto.StickyCommitResult, 1)
	go func() {
		raw, _ := json.Marshal(proto.StickyCommitParams{SandboxID: "sbx_1", DiskID: "ci", Version: "v1"})
		res, err := h.Call(context.Background(), proto.MethodStickyCommit, raw, nil)
		if err != nil {
			t.Error(err)
		}
		r, _ := res.(proto.StickyCommitResult)
		answered <- r
	}()
	// While the commit waits for its map, the sandbox's lifecycle calls go on.
	<-tier.waiting
	done := make(chan error, 1)
	go func() { done <- call(t, h, proto.MethodEgress, proto.ResumeParams{SandboxID: "sbx_1", Egress: protectedEgress(1, "b.example.com")}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a lifecycle call waited for a commit's map")
	}
	tier.mapped <- "sha256:abc"
	if res := <-answered; res.MapDigest != "sha256:abc" || res.Version != "v1" {
		t.Fatalf("answer %+v", res)
	}
}
