package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
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
	execs   []proto.ExecParams
	// failExecs is how many installs fail before they work.
	failExecs int
	// hold, when set, is waited on inside Create and SetEgress (once each call has started).
	hold    chan struct{}
	inside  atomic.Int32
	maxSeen atomic.Int32
}

func newLifecycleTier() *lifecycleTier {
	return &lifecycleTier{egress: map[string]*proto.Egress{}, running: map[string]bool{}}
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
	if !f.running[id] {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *lifecycleTier) SetEgress(id string, e *proto.Egress) error {
	defer f.enter()()
	f.mu.Lock()
	defer f.mu.Unlock()
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
