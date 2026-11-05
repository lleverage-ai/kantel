package protect

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// MaxBufferedBody is the most of a request body RewriteRequest holds in memory. A larger identity body streams; a
// larger compressed one is refused, since it can't be searched without inflating all of it.
const MaxBufferedBody = 16 << 20

// Refusal codes, for the proxy's answer and the control plane's events.
const (
	CodeUnbound = "placeholder-unbound"
	// CodeUnknown is a placeholder that isn't one of the sandbox's: another sandbox's, such as a fork's parent's.
	CodeUnknown     = "placeholder-unknown"
	CodeUnavailable = "secret-unavailable"
	CodeTooLarge    = "body-too-large"

	// CodeUnreadableResponse is a response whose body is in a Content-Encoding ScrubResponse can't decode, so an
	// echoed value in it can't be found: the proxy answers 502 rather than pass it on.
	CodeUnreadableResponse = "response-unreadable"
)

// Refusal is a request (or a response) the proxy must not pass on. Variable is the variable's name (empty when unknown); neither it
// nor Message ever holds a value.
type Refusal struct {
	Code     string
	Variable string
	Message  string
}

func (r *Refusal) Error() string {
	if r.Message == "" {
		return "protect: " + r.Code
	}
	return "protect: " + r.Message
}

// RewriteRequest swaps the placeholders in req for their values, where dest is one of their bindings: in every
// header value (inside the credentials of "Authorization: Basic" too), the URL's query and the body. It answers the
// names of the variables it swapped, sorted.
//
// Every placeholder found is resolved before anything changes, so a refusal (*Refusal: an unbound placeholder, one
// that isn't the sandbox's, or values that can't be fetched) leaves req as it came, body included. A placeholder
// is left as it is only where the Provider answers plain ErrUnknown (a sandbox with no protected variables). The path isn't searched, and req.RequestURI is left alone (the proxy clears
// it before passing the request on).
//
// A body is read as http.ReadRequest gives it (already de-chunked). Identity, gzip and deflate bodies up to
// MaxBufferedBody are swapped in memory and re-encoded with the same Content-Encoding, with Content-Length set to the
// new length. A larger identity body streams, chunked: a placeholder in it beyond the first MaxBufferedBody bytes is
// only met once bytes have gone, so an unbound one makes the body's Read fail (with a *Refusal) and the request is
// aborted rather than refused, and its name isn't in the answer. A body in any other Content-Encoding passes through
// untouched: its placeholders reach the destination as placeholders, which only fails there.
func RewriteRequest(ctx context.Context, req *http.Request, sandboxID string, dest Destination, p Provider) ([]string, error) {
	s := newSwapper(ctx, p, sandboxID, dest)
	var found []string

	var hits []headerHit
	for key, values := range req.Header {
		for i, v := range values {
			h := headerHit{key: key, index: i, text: []byte(v)}
			if prefix, decoded, ok := basicCredentials(key, v); ok {
				h.basic, h.prefix, h.text = true, prefix, decoded
			}
			h.matches = Find(h.text)
			if len(h.matches) > 0 {
				hits = append(hits, h)
				found = appendPlaceholders(found, h.text, h.matches)
			}
		}
	}

	var query []byte
	var queryMatches [][2]int
	if req.URL != nil {
		query = []byte(req.URL.RawQuery)
		queryMatches = Find(query)
		found = appendPlaceholders(found, query, queryMatches)
	}

	body, err := takeBody(req)
	if err != nil {
		body.restore(req)
		return nil, err
	}
	found = appendPlaceholders(found, body.plain, body.matches)

	slices.Sort(found)
	for _, ph := range slices.Compact(found) {
		if ref := s.resolve(ph); ref != nil {
			body.restore(req)
			return nil, ref
		}
	}

	if err := body.install(req, s); err != nil {
		body.restore(req)
		return nil, err
	}
	for _, h := range hits {
		out, changed := s.apply(h.text, h.matches, nil)
		// install may have rewritten the framing headers; a placeholder can't be in them, but check rather than trust.
		values := req.Header[h.key]
		if !changed || h.index >= len(values) {
			continue
		}
		if h.basic {
			values[h.index] = h.prefix + base64.StdEncoding.EncodeToString(out)
		} else {
			values[h.index] = string(out)
		}
	}
	if req.URL != nil {
		// A value may hold characters with a meaning in a query ('&', '+', '='), so it goes in escaped.
		if out, changed := s.apply(query, queryMatches, url.QueryEscape); changed {
			req.URL.RawQuery = string(out)
		}
	}
	return s.swapped(), nil
}

// swapper resolves each distinct placeholder once and swaps the ones it may.
type swapper struct {
	ctx       context.Context
	p         Provider
	sandboxID string
	dest      Destination
	resolved  map[string]Resolution
	unknown   map[string]bool
	names     map[string]bool
}

func newSwapper(ctx context.Context, p Provider, sandboxID string, dest Destination) *swapper {
	return &swapper{ctx: ctx, p: p, sandboxID: sandboxID, dest: dest, resolved: map[string]Resolution{}, unknown: map[string]bool{}, names: map[string]bool{}}
}

// resolve answers a refusal for a placeholder that must stop the request; otherwise the placeholder is either in
// resolved (swap it) or unknown (leave it).
func (s *swapper) resolve(ph string) *Refusal {
	if _, ok := s.resolved[ph]; ok || s.unknown[ph] {
		return nil
	}
	if s.p == nil {
		return &Refusal{Code: CodeUnavailable, Message: "protected environment variables can't be fetched right now"}
	}
	r, err := s.p.Resolve(s.ctx, ph, s.sandboxID, s.dest)
	var unbound *UnboundError
	switch {
	case err == nil:
		s.resolved[ph] = r
	case errors.As(err, &unbound) && unbound != nil:
		return &Refusal{Code: CodeUnbound, Variable: unbound.Name, Message: unbound.Name + " may not be sent to " + s.dest.Host + ", which isn't one of its destinations"}
	case errors.Is(err, ErrForeign):
		return foreignRefusal(ph)
	case errors.Is(err, ErrUnknown):
		s.unknown[ph] = true
	default:
		// The cause isn't passed on: a Provider's error is its own, and may say more than the sandbox should hear.
		return &Refusal{Code: CodeUnavailable, Message: "protected environment variables can't be fetched right now"}
	}
	return nil
}

// foreignRefusal refuses a placeholder that isn't the sandbox's. It names the placeholder by its first characters only,
// as kantel-doctor does: enough to tell which variable in the sandbox's environment it is.
func foreignRefusal(ph string) *Refusal {
	return &Refusal{Code: CodeUnknown, Message: ph[:min(len(ph), 8)] + "… isn't one of this sandbox's placeholders, so it is never swapped. " +
		"A fork has placeholders of its own: a process started before the fork still holds its parent's and needs restarting"}
}

// apply swaps the resolved placeholders among matches, escaping each value; it answers b itself when none was.
func (s *swapper) apply(b []byte, matches [][2]int, escape func(string) string) ([]byte, bool) {
	var out []byte
	changed := false
	last := 0
	for _, m := range matches {
		r, ok := s.resolved[string(b[m[0]:m[1]])]
		if !ok {
			continue
		}
		if !changed {
			out = make([]byte, 0, len(b)+len(r.Value))
			changed = true
		}
		out = append(out, b[last:m[0]]...)
		out = append(out, escaped(r.Value, escape)...)
		last = m[1]
		s.names[r.Name] = true
	}
	if !changed {
		return b, false
	}
	return append(out, b[last:]...), true
}

func (s *swapper) swapped() []string {
	var out []string
	for name := range s.names {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

type headerHit struct {
	key     string
	index   int
	basic   bool
	prefix  string
	text    []byte
	matches [][2]int
}

func appendPlaceholders(dst []string, b []byte, matches [][2]int) []string {
	for _, m := range matches {
		dst = append(dst, string(b[m[0]:m[1]]))
	}
	return dst
}

// basicCredentials decodes "Authorization: Basic <base64>", where a placeholder (most often the password) is out of
// sight of a search of the header as sent. prefix is the value up to the credentials ("Basic ").
func basicCredentials(key, v string) (prefix string, decoded []byte, ok bool) {
	if http.CanonicalHeaderKey(key) != "Authorization" {
		return "", nil, false
	}
	scheme, token, found := strings.Cut(v, " ")
	if !found || !strings.EqualFold(scheme, "Basic") {
		return "", nil, false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(token))
	if err != nil {
		return "", nil, false
	}
	return v[:len(scheme)+1], decoded, true
}

// requestBody is a request's body as RewriteRequest took it.
type requestBody struct {
	// orig is the body as it came; nil when it wasn't touched.
	orig io.ReadCloser
	// raw is what was read of it: all of it when buffered, the first MaxBufferedBody+1 bytes when streaming.
	raw []byte
	// coding is "" (identity), "gzip", "zlib" or "flate".
	coding string
	// plain is the decoded body (or, streaming, raw) and matches its placeholders.
	plain     []byte
	matches   [][2]int
	buffered  bool
	streaming bool
}

func takeBody(req *http.Request) (*requestBody, error) {
	b := &requestBody{}
	if req.Body == nil || req.Body == http.NoBody {
		return b, nil
	}
	coding, ok := contentCoding(req.Header)
	if !ok {
		// An encoding this package can't decode (br, zstd, a chain) passes through untouched.
		return b, nil
	}
	b.orig = req.Body
	raw, err := io.ReadAll(io.LimitReader(req.Body, MaxBufferedBody+1))
	b.raw = raw
	if err != nil {
		return b, err
	}
	if len(raw) > MaxBufferedBody {
		if coding != "" {
			return b, &Refusal{Code: CodeTooLarge, Message: "a compressed request body larger than 16 MiB can't be searched for placeholders"}
		}
		b.streaming = true
		b.plain = raw
		// Placeholders in the first part are resolved now, so they can still be refused; one running into the rest
		// can't be told from a longer word yet and is left to the stream.
		for _, m := range Find(raw) {
			if m[1] < len(raw) {
				b.matches = append(b.matches, m)
			}
		}
		return b, nil
	}
	b.buffered = true
	if coding == "" {
		b.plain, b.matches = raw, Find(raw)
		return b, nil
	}
	if coding == "deflate" {
		coding = deflateFormat(raw)
	}
	plain, err := decodeAll(coding, raw)
	if err != nil {
		// Not what its Content-Encoding says: passed on as it came, unsearched.
		return b, nil
	}
	if len(plain) > MaxBufferedBody {
		return b, &Refusal{Code: CodeTooLarge, Message: "a compressed request body that inflates past 16 MiB can't be searched for placeholders"}
	}
	b.coding, b.plain, b.matches = coding, plain, Find(plain)
	return b, nil
}

// restore puts back the body as it came, for a request that is refused.
func (b *requestBody) restore(req *http.Request) {
	if b == nil || b.orig == nil {
		return
	}
	req.Body = readCloser{Reader: io.MultiReader(bytes.NewReader(b.raw), b.orig), Closer: b.orig}
}

// install gives req its new body, once nothing can be refused any more.
func (b *requestBody) install(req *http.Request, s *swapper) error {
	escape := bodyEscaper(req.Header.Get("Content-Type"))
	switch {
	case b.buffered:
		out := b.raw
		if plain, changed := s.apply(b.plain, b.matches, escape); changed {
			encoded, err := encodeAll(b.coding, plain)
			if err != nil {
				return err
			}
			out = encoded
		}
		b.orig.Close()
		setBody(req, out)
	case b.streaming:
		for _, m := range b.matches {
			if r, ok := s.resolved[string(b.plain[m[0]:m[1]])]; ok {
				s.names[r.Name] = true
			}
		}
		step := &swapStep{s: s, escape: escape}
		req.Body = newStream(io.MultiReader(bytes.NewReader(b.raw), b.orig), b.orig, step.step)
		req.ContentLength = -1
		req.TransferEncoding = []string{"chunked"}
		req.Header.Del("Content-Length")
		req.GetBody = nil
	}
	return nil
}

func setBody(req *http.Request, body []byte) {
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))
	req.TransferEncoding = nil
	req.Header.Del("Transfer-Encoding")
	if len(body) == 0 {
		req.Body = http.NoBody
		req.GetBody = func() (io.ReadCloser, error) { return http.NoBody, nil }
		return
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
}

// bodyEscaper answers how a value goes into a body of contentType: escaped where the body's syntax gives its
// characters a meaning (a '+' in a form is a space, a '"' ends a JSON string), as it is otherwise.
func bodyEscaper(contentType string) func(string) string {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil
	}
	switch {
	case mt == "application/x-www-form-urlencoded":
		return url.QueryEscape
	case mt == "application/json" || strings.HasSuffix(mt, "+json"):
		return jsonEscape
	}
	return nil
}

// jsonEscape escapes a value for the inside of a JSON string (the placeholder it replaces is already between quotes).
func jsonEscape(v string) string {
	const hex = "0123456789abcdef"
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c == '"' || c == '\\':
			b.WriteByte('\\')
			b.WriteByte(c)
		case c < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0xf])
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}
