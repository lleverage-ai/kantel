package protect

import (
	"bytes"
	"io"
	"net/http"
	"slices"
)

// streamChunk is how much a stream reads from its source at once.
const streamChunk = 32 << 10

// stepFunc turns as much of buf as it can decide into output, appended to dst, and answers how many bytes of buf it
// used; the rest is carried into the next step with more input. At eof it must use all of buf.
type stepFunc func(dst, buf []byte, eof bool) (out []byte, used int, err error)

// stream rewrites a body as it is read, holding back only the carry a match could still need, so a body of any size
// passes through in constant memory.
type stream struct {
	src   io.Reader
	close io.Closer
	step  stepFunc
	// onEOF runs once, when the source ends (after which a response's trailers are known).
	onEOF func()

	chunk []byte
	buf   []byte
	out   []byte
	off   int
	eof   bool
	err   error
}

func newStream(src io.Reader, closer io.Closer, step stepFunc) *stream {
	return &stream{src: src, close: closer, step: step}
}

func (s *stream) Read(p []byte) (int, error) {
	for s.off == len(s.out) {
		if s.err != nil {
			return 0, s.err
		}
		if s.eof && len(s.buf) == 0 {
			return 0, io.EOF
		}
		s.out, s.off = s.out[:0], 0
		if !s.eof {
			if err := s.fill(); err != nil {
				s.err = err
				return 0, err
			}
		}
		out, used, err := s.step(s.out, s.buf, s.eof)
		if err != nil {
			s.err = err
			return 0, err
		}
		if s.eof && used < len(s.buf) {
			s.err = io.ErrNoProgress
			return 0, s.err
		}
		s.out = out
		s.buf = s.buf[:copy(s.buf, s.buf[used:])]
	}
	n := copy(p, s.out[s.off:])
	s.off += n
	return n, nil
}

func (s *stream) fill() error {
	if s.chunk == nil {
		s.chunk = make([]byte, streamChunk)
	}
	for range 100 {
		n, err := s.src.Read(s.chunk)
		s.buf = append(s.buf, s.chunk[:n]...)
		if err == io.EOF {
			s.eof = true
			if s.onEOF != nil {
				s.onEOF()
			}
			return nil
		}
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
	}
	return io.ErrNoProgress
}

func (s *stream) Close() error {
	if s.close == nil {
		return nil
	}
	return s.close.Close()
}

// swapStep swaps placeholders in a request body as it streams. Every placeholder is 44 bytes and a match needs the
// byte after it (to see it isn't part of a longer word), so 44 bytes of carry suffice.
type swapStep struct {
	s         *swapper
	escape    func(string) string
	prevAlnum bool
}

func (w *swapStep) step(dst, buf []byte, eof bool) ([]byte, int, error) {
	limit := len(buf)
	if !eof {
		// A placeholder starting at or after limit can't be told from a longer word yet.
		limit -= PlaceholderLen
	}
	if limit <= 0 {
		return dst, 0, nil
	}
	pos, end := 0, limit
	for _, m := range scan(buf, w.prevAlnum) {
		if m[0] >= limit {
			break
		}
		end = max(end, m[1])
		ph := string(buf[m[0]:m[1]])
		if ref := w.s.resolve(ph); ref != nil {
			return dst, 0, midStream(ref)
		}
		r, ok := w.s.resolved[ph]
		if !ok {
			continue
		}
		dst = append(dst, buf[pos:m[0]]...)
		dst = append(dst, escaped(r.Value, w.escape)...)
		pos = m[1]
	}
	dst = append(dst, buf[pos:end]...)
	w.prevAlnum = isAlnum(buf[end-1])
	return dst, end, nil
}

// midStream is a refusal found after a streamed body had begun to be sent: it can no longer be answered as a refusal,
// so the body's Read fails with it and the request is aborted instead.
func midStream(r *Refusal) *Refusal {
	c := *r
	c.Message += "; it was found in a request body already being sent, so the request was aborted"
	return &c
}

func escaped(v string, escape func(string) string) string {
	if escape == nil {
		return v
	}
	return escape(v)
}

// scrubber turns protected values back into their placeholders: leftmost match first, the longest value where two
// start at the same byte.
type scrubber struct {
	needles [][]byte
	repl    [][]byte
	longest int
}

// newScrubber answers nil when there is nothing to scrub; a nil scrubber changes nothing.
func newScrubber(entries []Entry) *scrubber {
	type pair struct{ value, placeholder string }
	seen := map[string]bool{}
	var pairs []pair
	for _, e := range entries {
		if e.Value == "" || seen[e.Value] {
			continue
		}
		seen[e.Value] = true
		pairs = append(pairs, pair{e.Value, e.Placeholder})
	}
	if len(pairs) == 0 {
		return nil
	}
	slices.SortStableFunc(pairs, func(a, b pair) int { return len(b.value) - len(a.value) })
	sc := &scrubber{longest: len(pairs[0].value)}
	for _, p := range pairs {
		sc.needles = append(sc.needles, []byte(p.value))
		sc.repl = append(sc.repl, []byte(p.placeholder))
	}
	return sc
}

// step carries the longest value less one byte: anything longer either holds a whole match or none.
func (sc *scrubber) step(dst, buf []byte, eof bool) ([]byte, int, error) {
	limit := len(buf)
	if !eof {
		limit -= sc.longest - 1
	}
	if limit <= 0 {
		return dst, 0, nil
	}
	// next[i] is where needle i next occurs at or after the last search; len(buf) is never.
	next := make([]int, len(sc.needles))
	for i := range next {
		next[i] = -1
	}
	pos := 0
	for {
		best, which := -1, -1
		for i, n := range sc.needles {
			if next[i] < pos {
				if j := bytes.Index(buf[pos:], n); j < 0 {
					next[i] = len(buf)
				} else {
					next[i] = pos + j
				}
			}
			if next[i] < limit && (best < 0 || next[i] < best) {
				best, which = next[i], i
			}
		}
		if best < 0 {
			break
		}
		dst = append(dst, buf[pos:best]...)
		dst = append(dst, sc.repl[which]...)
		pos = best + len(sc.needles[which])
	}
	end := max(pos, limit)
	dst = append(dst, buf[pos:end]...)
	return dst, end, nil
}

// replace scrubs a whole buffer, answering whether anything changed.
func (sc *scrubber) replace(b []byte) ([]byte, bool) {
	if sc == nil || len(b) == 0 {
		return b, false
	}
	out, _, _ := sc.step(nil, b, true)
	if bytes.Equal(out, b) {
		return b, false
	}
	return out, true
}

// header scrubs every value of h in place.
func (sc *scrubber) header(h http.Header) {
	for _, values := range h {
		for i, v := range values {
			if out, changed := sc.replace([]byte(v)); changed {
				values[i] = string(out)
			}
		}
	}
}
