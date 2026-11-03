package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// --- calls to Kantel ------------------------------------------------------------------------------------------------

// callTimeout bounds a call the host makes to Kantel when its caller gives no sooner deadline.
const callTimeout = 15 * time.Second

// errDisconnected is a call made while the host has no connection to Kantel: it fails at once rather than waiting
// for one, so a request through the proxy is refused promptly instead of hanging.
var errDisconnected = &proto.Error{Code: proto.ErrUnavailable, Message: "the host isn't connected to the control plane"}

// caller is the host's side of the calls it makes to Kantel over one connection: each gets an ID ("h1", "h2", …,
// never one of Kantel's, which don't start with h) and waits for the result with that ID.
type caller struct {
	send    func(ctx context.Context, m proto.Message) error
	timeout time.Duration

	mu      sync.Mutex
	next    uint64
	pending map[string]chan proto.Message
	closed  bool
}

func newCaller(send func(ctx context.Context, m proto.Message) error) *caller {
	return &caller{send: send, timeout: callTimeout, pending: map[string]chan proto.Message{}}
}

// Call sends method with params to Kantel and answers its result, or its error as a *proto.Error.
func (c *caller) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c == nil {
		return nil, errDisconnected
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	ch := make(chan proto.Message, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errDisconnected
	}
	c.next++
	id := "h" + strconv.FormatUint(c.next, 10)
	c.pending[id] = ch
	c.mu.Unlock()
	defer c.drop(id)
	if err := c.send(ctx, proto.Message{Type: "call", ID: id, Method: method, Params: raw}); err != nil {
		return nil, &proto.Error{Code: proto.ErrUnavailable, Message: "couldn't send " + method + " to the control plane: " + err.Error()}
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return nil, errDisconnected
		}
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	case <-ctx.Done():
		return nil, &proto.Error{Code: proto.ErrTimeout, Message: method + " had no answer from the control plane in time"}
	}
}

// deliver hands a result to the call waiting for it; false is a result no call is waiting for.
func (c *caller) deliver(m proto.Message) bool {
	c.mu.Lock()
	ch, ok := c.pending[m.ID]
	delete(c.pending, m.ID)
	c.mu.Unlock()
	if ok {
		ch <- m // buffered, and only ever sent once: never blocks the read loop
	}
	return ok
}

func (c *caller) drop(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// close fails every waiting call, and every later one, at once: the connection has gone.
func (c *caller) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
}

// kantelCall makes a call to Kantel over the current connection.
func (h *Host) kantelCall(ctx context.Context, method string, params any) (json.RawMessage, error) {
	h.mu.Lock()
	c := h.link
	h.mu.Unlock()
	if c == nil {
		return nil, errDisconnected
	}
	return c.Call(ctx, method, params)
}

// --- protected variables --------------------------------------------------------------------------------------------

// fetchSecrets is the protect.Store's fetch: secrets.fetch to Kantel.
func (h *Host) fetchSecrets(ctx context.Context, sandboxID string) (protect.Table, error) {
	return fetchTable(ctx, h.kantelCall, sandboxID)
}

// fetchTable asks Kantel for a sandbox's protected variables. Its errors never quote the answer, which holds values.
func fetchTable(ctx context.Context, call func(ctx context.Context, method string, params any) (json.RawMessage, error), sandboxID string) (protect.Table, error) {
	raw, err := call(ctx, proto.MethodSecretsFetch, proto.SandboxRef{SandboxID: sandboxID})
	if err != nil {
		return protect.Table{}, err
	}
	var t proto.SecretsTable
	if err := json.Unmarshal(raw, &t); err != nil {
		return protect.Table{}, errors.New("secrets.fetch answered something that isn't a table")
	}
	out := protect.Table{Version: t.Version, Entries: make([]protect.Entry, 0, len(t.Entries))}
	for _, e := range t.Entries {
		entry := protect.Entry{Placeholder: e.Placeholder, Name: e.Name, Value: e.Value}
		for _, b := range e.Bindings {
			entry.Bindings = append(entry.Bindings, protect.Binding{Host: b.Host, PathPrefixes: slices.Clone(b.PathPrefixes), Methods: slices.Clone(b.Methods)})
		}
		out.Entries = append(out.Entries, entry)
	}
	return out, nil
}

// requireProtected passes the protected-table version an egress advertises to the store: a cached table older than
// it is no longer used.
func (h *Host) requireProtected(sandboxID string, e *proto.Egress) {
	if h.secrets != nil && e != nil && e.Protected != nil {
		h.secrets.Require(sandboxID, e.Protected.Version)
	}
}

// forgetSecrets drops a sandbox's values (stop, delete); the next request fetches them again.
func (h *Host) forgetSecrets(sandboxID string) {
	if h.secrets != nil {
		h.secrets.Forget(sandboxID)
	}
}

// --- the sandbox's CA -----------------------------------------------------------------------------------------------

// caFile is where the guest agent installs Egress.CACert, and where a running guest gets a new one.
const caFile = "/usr/local/share/ca-certificates/kantel-egress.crt"

// prepareEgress gives a microVM sandbox's egress its interception CA: when it intercepts any host, the CA's
// certificate goes after the upstream's in CACert, which the guest agent installs at create, start, resume and fork.
// fresh says the CA is new (the guest doesn't trust it yet). Only the certificate goes into the egress, which is
// persisted in meta.json; the key stays in the CA store.
func (h *Host) prepareEgress(tier, sandboxID string, e *proto.Egress) (*proto.Egress, bool, error) {
	if e == nil || h.cas == nil || tier != microvm.Tier {
		// The isolate tier makes its https requests in proxy form, which the proxy reads without a CA.
		return e, false, nil
	}
	hosts := h.egressRules(sandboxID, "", e).InterceptHosts()
	if len(hosts) == 0 {
		_ = h.cas.Forget(sandboxID)
		return e, false, nil
	}
	ca, fresh, err := h.cas.Ensure(sandboxID, hosts)
	if err != nil {
		return nil, false, fmt.Errorf("the sandbox's egress certificate: %w", err)
	}
	out := *e
	out.CACert = joinPEM(e.CACert, ca.CertPEM())
	return &out, fresh, nil
}

func joinPEM(upstream, own string) string {
	upstream = strings.TrimSpace(upstream)
	switch {
	case upstream == "":
		return own
	case strings.Contains(upstream, strings.TrimSpace(own)):
		return upstream + "\n"
	}
	return upstream + "\n" + own
}

// withoutPEM is bundle without own: a parent's egress CA bundle without the parent's own CA, for its fork.
func withoutPEM(bundle, own string) string {
	own = strings.TrimSpace(own)
	if own == "" {
		return bundle
	}
	out := strings.TrimSpace(strings.ReplaceAll(bundle, own, ""))
	if out == "" {
		return ""
	}
	return out + "\n"
}

// egressRevision is the revision of the egress a sandbox has: the latest the host has taken (kept on disk, a null
// egress's too), or what its kept egress says (from a host before the floor was kept).
func (h *Host) egressRevision(t Tier, sandboxID string) int64 {
	held := h.revisionFloor(sandboxID)
	if r, ok := t.(egressReader); ok {
		if e, err := r.EgressOf(sandboxID); err == nil && e != nil && e.Revision > held {
			held = e.Revision
		}
	}
	return held
}

// revisionOf is the revision an egress-carrying call is ordered by: its own, else its egress's; 0 is unordered.
func revisionOf(p proto.ResumeParams) int64 {
	if p.Revision == 0 && p.Egress != nil {
		return p.Egress.Revision
	}
	return p.Revision
}

// floorDir holds each sandbox's revision floor: a file per sandbox holding the latest egress revision the host has
// taken for it. It outlives a null egress, which leaves nothing in meta.json to order by, and a host restart.
func (h *Host) floorDir() string { return filepath.Join(h.cfg.Root, "egress-revision") }

// floorFile is a sandbox's floor file, or "" for an ID that isn't a plain name (never one of Kantel's).
func (h *Host) floorFile(sandboxID string) string {
	if sandboxID == "" || h.cfg.Root == "" || strings.ContainsAny(sandboxID, `/\`) || strings.Contains(sandboxID, "..") {
		return ""
	}
	return filepath.Join(h.floorDir(), sandboxID)
}

// revisionFloor is the latest egress revision the host has taken for a sandbox, 0 for none.
func (h *Host) revisionFloor(sandboxID string) int64 {
	h.floorMu.Lock()
	defer h.floorMu.Unlock()
	if v, ok := h.floors[sandboxID]; ok {
		return v
	}
	var v int64
	if path := h.floorFile(sandboxID); path != "" {
		if raw, err := os.ReadFile(path); err == nil {
			v, _ = strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		}
	}
	if h.floors == nil {
		h.floors = map[string]int64{}
	}
	h.floors[sandboxID] = v
	return v
}

// raiseFloor records that the host took a sandbox's egress at revision (it never goes down), on disk before it is
// relied on: a write that fails leaves it in memory, as before the floor was kept.
func (h *Host) raiseFloor(sandboxID string, revision int64) {
	if revision <= 0 || revision <= h.revisionFloor(sandboxID) {
		return
	}
	h.floorMu.Lock()
	defer h.floorMu.Unlock()
	h.floors[sandboxID] = revision
	path := h.floorFile(sandboxID)
	if path == "" {
		return
	}
	if err := os.MkdirAll(h.floorDir(), 0o700); err != nil {
		h.logf("egress revision floor for %s: %v", sandboxID, err)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(revision, 10)), 0o600); err != nil {
		h.logf("egress revision floor for %s: %v", sandboxID, err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		h.logf("egress revision floor for %s: %v", sandboxID, err)
	}
}

// forgetFloor drops a deleted sandbox's floor.
func (h *Host) forgetFloor(sandboxID string) {
	h.floorMu.Lock()
	defer h.floorMu.Unlock()
	delete(h.floors, sandboxID)
	if path := h.floorFile(sandboxID); path != "" {
		_ = os.Remove(path)
	}
}

func (h *Host) logf(format string, args ...any) {
	if h.log != nil {
		h.log.Warn(fmt.Sprintf(format, args...))
	}
}

// egressReader is a tier that answers a sandbox's egress as it keeps it (microvm, which a fork inherits from).
type egressReader interface {
	EgressOf(id string) (*proto.Egress, error)
}

// inheritedEgress is the egress a fork with none of its own takes from its source, without the source's own CA:
// the fork is given one of its own.
func (h *Host) inheritedEgress(t Tier, sourceID string) (*proto.Egress, error) {
	r, ok := t.(egressReader)
	if !ok {
		return nil, nil
	}
	e, err := r.EgressOf(sourceID)
	if err != nil || e == nil {
		return nil, err
	}
	out := *e
	if h.cas != nil {
		if ca, err := h.cas.Get(sourceID); err == nil {
			out.CACert = withoutPEM(e.CACert, ca.CertPEM())
		}
	}
	return &out, nil
}

// installCA puts a new CA into a running guest's trust store, as the guest agent does with an identity's CACert.
func installCA(ctx context.Context, t Tier, sandboxID, certPEM string) error {
	res, err := t.Exec(ctx, proto.ExecParams{
		SandboxID: sandboxID,
		Argv:      []string{"/bin/sh", "-c", "cat > " + caFile + " && update-ca-certificates"},
		User:      "root",
		Stdin:     base64.StdEncoding.EncodeToString([]byte(certPEM)),
		TimeoutMs: 60_000,
	}, nil)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("update-ca-certificates exited %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	return nil
}

// setEgress is sandbox.egress: the new rules, and for a running microVM that intercepts, its CA installed in the
// guest until that is confirmed. The caller holds the sandbox's lifecycle lock.
func (h *Host) setEgress(ctx context.Context, t Tier, tier string, p proto.ResumeParams) error {
	revision := revisionOf(p)
	if revision > 0 {
		if h.egressRevision(t, p.SandboxID) > revision {
			// Read before a change whose own update has already come: the sandbox keeps the newer egress.
			return nil
		}
		if p.Egress != nil {
			e := *p.Egress
			e.Revision = revision
			p.Egress = &e
		}
	}
	if p.Egress == nil && h.cas != nil {
		// The host's default egress intercepts nothing.
		_ = h.cas.Forget(p.SandboxID)
	}
	h.requireProtected(p.SandboxID, p.Egress)
	e, _, err := h.prepareEgress(tier, p.SandboxID, p.Egress)
	if err != nil {
		return err
	}
	if err := t.SetEgress(p.SandboxID, e); err != nil {
		return err
	}
	// Taken: an older one is refused from now on, a restart and a null egress notwithstanding. The same revision again
	// still goes (it retries a CA install that failed).
	h.raiseFloor(p.SandboxID, revision)
	if e == nil || h.cas == nil || tier != microvm.Tier {
		return nil
	}
	ca, err := h.cas.Get(p.SandboxID)
	if err != nil || h.cas.Installed(p.SandboxID) {
		// No CA (nothing intercepted), or the guest already trusts this one.
		return nil
	}
	info, err := t.Get(p.SandboxID)
	if err != nil || info.State != proto.StateRunning {
		// A stopped sandbox gets the certificate with its identity when it starts again.
		return nil
	}
	// Not confirmed yet (new, or an install that failed): the guest agent's own install at boot isn't checked, so
	// this one is, and a failure leaves it to be tried again by the next update.
	if err := installCA(ctx, t, p.SandboxID, e.CACert); err != nil {
		return fmt.Errorf("the egress changed, but the sandbox's new egress certificate couldn't be installed: %w", err)
	}
	return h.cas.MarkInstalled(p.SandboxID, ca)
}

// --- one lifecycle change at a time per sandbox ---------------------------------------------------------------------

// sandboxLocks serialises the lifecycle calls that change a sandbox's CA (create, fork, egress, start, resume,
// delete): its preparation, the tier's change, the guest's install and any clean-up happen as one, while different
// sandboxes go on independently.
type sandboxLocks struct {
	mu    sync.Mutex
	locks map[string]*sandboxLock
}

type sandboxLock struct {
	mu    sync.Mutex
	users int
}

// lock takes the locks of ids (in a fixed order, so two calls can't wait on each other) and answers their release.
func (s *sandboxLocks) lock(ids ...string) func() {
	ids = slices.Clone(ids)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	held := make([]*sandboxLock, 0, len(ids))
	for _, id := range ids {
		s.mu.Lock()
		if s.locks == nil {
			s.locks = map[string]*sandboxLock{}
		}
		l, ok := s.locks[id]
		if !ok {
			l = &sandboxLock{}
			s.locks[id] = l
		}
		l.users++
		s.mu.Unlock()
		l.mu.Lock()
		held = append(held, l)
	}
	return func() {
		for i := len(held) - 1; i >= 0; i-- {
			held[i].mu.Unlock()
			s.mu.Lock()
			held[i].users--
			if held[i].users == 0 {
				delete(s.locks, ids[i])
			}
			s.mu.Unlock()
		}
	}
}

// --- egress events --------------------------------------------------------------------------------------------------

const (
	// egressBatch is the most records in one event.
	egressBatch = 100
	// egressInterval is the longest a record waits to be sent.
	egressInterval = 2 * time.Second
	// egressBuffer bounds what waits: past it records are dropped, never waited for.
	egressBuffer = 2000
)

// egressBatcher sends the proxy's records to Kantel in batches. add never blocks the proxy: records made while
// disconnected, or past the buffer, are dropped.
type egressBatcher struct {
	send     func([]proto.EgressRecord) error
	live     func() bool
	interval time.Duration

	mu      sync.Mutex
	buf     []proto.EgressRecord
	dropped int64

	kick chan struct{}
	stop chan struct{}
	once sync.Once
}

func newEgressBatcher(send func([]proto.EgressRecord) error, live func() bool) *egressBatcher {
	return &egressBatcher{send: send, live: live, interval: egressInterval, kick: make(chan struct{}, 1), stop: make(chan struct{})}
}

func (b *egressBatcher) add(r egress.Record) {
	if b.live != nil && !b.live() {
		b.mu.Lock()
		b.dropped++
		b.mu.Unlock()
		return
	}
	rec := toEgressRecord(r)
	b.mu.Lock()
	if len(b.buf) >= egressBuffer {
		b.dropped++
		b.mu.Unlock()
		return
	}
	b.buf = append(b.buf, rec)
	full := len(b.buf) >= egressBatch
	b.mu.Unlock()
	if full {
		select {
		case b.kick <- struct{}{}:
		default:
		}
	}
}

func (b *egressBatcher) run() {
	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-ticker.C:
		case <-b.kick:
		}
		b.flush()
	}
}

// flush sends what waits, a batch at a time; a batch that can't be sent is dropped with the rest.
func (b *egressBatcher) flush() {
	for {
		b.mu.Lock()
		n := min(len(b.buf), egressBatch)
		if n == 0 {
			b.mu.Unlock()
			return
		}
		batch := slices.Clone(b.buf[:n])
		b.buf = slices.Delete(b.buf, 0, n)
		b.mu.Unlock()
		if err := b.send(batch); err != nil {
			b.mu.Lock()
			b.dropped += int64(n + len(b.buf))
			b.buf = b.buf[:0]
			b.mu.Unlock()
			return
		}
	}
}

func (b *egressBatcher) close() {
	b.once.Do(func() { close(b.stop) })
}

func toEgressRecord(r egress.Record) proto.EgressRecord {
	swapped := slices.Clone(r.Swapped)
	if swapped == nil {
		swapped = []string{}
	}
	return proto.EgressRecord{
		At: r.At.UnixMilli(), SandboxID: r.SandboxID, Method: r.Method, Host: r.Host, Port: r.Port, Path: r.Path,
		Allowed: r.Allowed, Reason: r.Reason, Rule: r.Rule, Code: r.Code, Swapped: swapped, Inspected: r.Inspected,
		Status: r.Status, BytesUp: r.BytesUp, BytesDown: r.BytesDown,
	}
}

// sendEgress sends one batch as an "egress" event over the current connection.
func (h *Host) sendEgress(batch []proto.EgressRecord) error {
	h.mu.Lock()
	c := h.link
	h.mu.Unlock()
	if c == nil {
		return errDisconnected
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.send(ctx, proto.Message{Type: "event", Event: &proto.Event{Kind: "egress", At: time.Now().UnixMilli(), Egress: batch}})
}

func (h *Host) connected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.link != nil
}
