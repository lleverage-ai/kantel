package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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

// setEgress is sandbox.egress: the new rules, and when they change the intercepted hosts of a running microVM, a new
// CA installed in its guest.
func (h *Host) setEgress(ctx context.Context, t Tier, tier string, p proto.ResumeParams) error {
	if p.Egress == nil && h.cas != nil {
		// The host's default egress intercepts nothing.
		_ = h.cas.Forget(p.SandboxID)
	}
	e, fresh, err := h.prepareEgress(tier, p.SandboxID, p.Egress)
	if err != nil {
		return err
	}
	if err := t.SetEgress(p.SandboxID, e); err != nil {
		return err
	}
	if !fresh {
		return nil
	}
	info, err := t.Get(p.SandboxID)
	if err != nil || info.State != proto.StateRunning {
		// A stopped sandbox gets the new certificate with its identity when it starts again.
		return nil
	}
	if err := installCA(ctx, t, p.SandboxID, e.CACert); err != nil {
		return fmt.Errorf("the egress changed, but the sandbox's new egress certificate couldn't be installed: %w", err)
	}
	return nil
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
