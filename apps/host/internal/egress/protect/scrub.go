package protect

import (
	"bytes"
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
)

// scrubDepth is how many layers of escaping the scrubber reads through: an echo escapes a value once (a query, a JSON
// string) and often twice (a JSON body echoed inside a JSON string, a query quoted in JSON).
const scrubDepth = 2

// scrubber turns protected values back into their placeholders, wherever a response holds one as it is or escaped in
// any of the common ways, up to scrubDepth layers deep, by any encoder: percent-escapes in either case (and '+' for a
// space), JSON's escapes (short ones, \/, and \uXXXX in either case, surrogate pairs past the BMP), \xHH and \', and
// HTML's character references. It decodes rather than lists the forms an encoder might write, since each escapes a
// different set of characters, in its own case: what decodes to the value is the value.
//
// The leftmost match goes first, the longest where two start at one byte, and the one read through the fewest layers
// where two such end at one byte too: where one value's escaped form is another value's text ("a b" queried is
// "a+b"), that text is taken as the other value. A match is replaced whole by the placeholder, which is only ASCII
// letters, digits and '_' and so is the same in every escaping. A scrubber is never changed once made, so one can be
// shared between goroutines.
type scrubber struct {
	values [][]byte
	repl   [][]byte
	// starts are the bytes a match can begin at: each value's first byte, and the first byte of an escape.
	starts [256]bool
	// gate holds the first gateLen bytes (or fewer, for a shorter one) of every spelling of each value's first
	// character, scrubDepth layers deep: an escape whose text begins otherwise can't begin a match.
	gate map[string]bool
}

// gateLen is how much of an escape's text the gate looks at.
const gateLen = 6

// newScrubber answers nil when there is nothing to scrub; a nil scrubber changes nothing.
func newScrubber(entries []Entry) *scrubber {
	sc := &scrubber{}
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Value == "" || seen[e.Value] {
			continue
		}
		seen[e.Value] = true
		sc.values = append(sc.values, []byte(e.Value))
		sc.repl = append(sc.repl, []byte(e.Placeholder))
		sc.starts[e.Value[0]] = true
	}
	if len(sc.values) == 0 {
		return nil
	}
	for b, ok := range escapeStart {
		sc.starts[b] = sc.starts[b] || ok
	}
	sc.gate = map[string]bool{}
	for _, v := range sc.values {
		for _, p := range gateFor(v) {
			sc.gate[p] = true
		}
	}
	return sc
}

// gates caches gateFor by a value's first character: a scrubber is made for every response.
var gates sync.Map

// gateFor answers the first gateLen bytes of every spelling, scrubDepth layers deep, of v's first character.
func gateFor(v []byte) []string {
	_, size := utf8.DecodeRune(v)
	key := string(v[:size])
	if g, ok := gates.Load(key); ok {
		return g.([]string)
	}
	var out []string
	for _, f := range firstForms(v) {
		out = append(out, spellingPrefixes(f, scrubDepth-1, gateLen)...)
	}
	slices.Sort(out)
	out = slices.Compact(out)
	gates.Store(key, out)
	return out
}

// firstForms answers every way one layer of escaping spells a unit that v begins with: its first byte, and its first
// character.
func firstForms(v []byte) []string {
	forms := byteForms(v[0])
	if r, size := utf8.DecodeRune(v); r != utf8.RuneError || size > 1 {
		forms = append(forms, runeForms(r)...)
	}
	return forms
}

// byteForms are the escapes the decoder reads as byte b, b itself included.
func byteForms(b byte) []string {
	forms := []string{string([]byte{b})}
	if b == ' ' {
		forms = append(forms, "+")
	}
	hh := caseVariants(fmt.Sprintf("%02x", b))
	for _, h := range hh {
		forms = append(forms, "%"+h, `\x`+h)
	}
	for c, to := range shortEscapes {
		if to == b && to != 0 {
			forms = append(forms, `\`+string(rune(c)))
		}
	}
	if b < utf8.RuneSelf {
		forms = append(forms, runeForms(rune(b))...)
	}
	return forms
}

// runeForms are the escapes the decoder reads as character r: \uXXXX (the first half of a surrogate pair past the
// BMP), and HTML's references, named and numeric with any leading zeros.
func runeForms(r rune) []string {
	var forms []string
	u := r
	if r > 0xffff {
		u, _ = utf16.EncodeRune(r)
	}
	for _, h := range caseVariants(fmt.Sprintf("%04x", u)) {
		forms = append(forms, `\u`+h)
	}
	for name, to := range references {
		if to == r {
			forms = append(forms, "&"+name+";")
		}
	}
	dec, hex := strconv.Itoa(int(r)), strconv.FormatInt(int64(r), 16)
	for zeros := 0; len(dec)+zeros <= 6; zeros++ {
		forms = append(forms, "&#"+strings.Repeat("0", zeros)+dec+";")
	}
	for zeros := 0; len(hex)+zeros <= 6; zeros++ {
		for _, h := range caseVariants(strings.Repeat("0", zeros) + hex) {
			forms = append(forms, "&#x"+h+";", "&#X"+h+";")
		}
	}
	return forms
}

// caseVariants answers hex digits h in every mix of cases.
func caseVariants(h string) []string {
	out := []string{""}
	for i := 0; i < len(h); i++ {
		lo, up := strings.ToLower(h[i:i+1]), strings.ToUpper(h[i:i+1])
		var next []string
		for _, o := range out {
			next = append(next, o+lo)
			if up != lo {
				next = append(next, o+up)
			}
		}
		out = next
	}
	return out
}

// spellingPrefixes answers the first n bytes (all of a shorter one) of every spelling of s, depth layers of escaping
// deep: at depth 0, s itself; above, each of s's bytes in any of its byteForms, spelt a layer less deep.
func spellingPrefixes(s string, depth, n int) []string {
	if depth == 0 {
		return []string{s[:min(len(s), n)]}
	}
	acc, done := []string{""}, []string{}
	for i := 0; i < len(s) && len(acc) > 0; i++ {
		var next []string
		for _, a := range acc {
			for _, f := range byteForms(s[i]) {
				for _, p := range spellingPrefixes(f, depth-1, n-len(a)) {
					if q := a + p; len(q) >= n {
						done = append(done, q)
					} else {
						next = append(next, q)
					}
				}
			}
		}
		slices.Sort(next)
		acc = slices.Compact(next)
	}
	return append(done, acc...)
}

// mayBegin reports whether a match can begin at s, where buf[s] starts an escape: whether the text there begins as
// one of the gate's spellings. With fewer than gateLen bytes left, it can't tell, so it says yes.
func (sc *scrubber) mayBegin(buf []byte, s int) bool {
	if len(buf)-s < gateLen {
		return true
	}
	for n := 1; n <= gateLen; n++ {
		if sc.gate[string(buf[s:s+n])] {
			return true
		}
	}
	return false
}

// step scrubs buf, holding back only from the first byte where a match has begun but runs past the end of buf, so
// most of a stream passes through as it comes and a match split across reads is still seen whole.
func (sc *scrubber) step(dst, buf []byte, eof bool) ([]byte, int, error) {
	d := decoder{buf: buf, eof: eof}
	pos := 0
	for s := 0; s < len(buf); s++ {
		if !sc.starts[buf[s]] || (escapeStart[buf[s]] && !sc.mayBegin(buf, s)) {
			continue
		}
		end, which, short := sc.matchAt(&d, s)
		if short {
			// More input could make a match here (or a longer one): keep from s for the next step.
			dst = append(dst, buf[pos:s]...)
			return dst, s, nil
		}
		if which < 0 {
			continue
		}
		dst = append(dst, buf[pos:s]...)
		dst = append(dst, sc.repl[which]...)
		pos = end
		s = end - 1
	}
	dst = append(dst, buf[pos:]...)
	return dst, len(buf), nil
}

// matchAt answers the longest match starting at s (end, and which value; which is -1 for none), and whether a read
// ran past the end of buf before eof, so that a match there can't be ruled out yet.
func (sc *scrubber) matchAt(d *decoder, s int) (end, which int, short bool) {
	end, which = -1, -1
	d.short = false
	// The readings are shared between values and depths at s, never between starts: what is kept is bounded by one
	// candidate, not by how many a message has (a message of near-misses would otherwise keep a reading at each).
	if len(d.memo) > 0 {
		clear(d.memo)
	}
	var tied []int
	for i, v := range sc.values {
		e := d.match(v, s, scrubDepth)
		switch {
		case e < 0 || e < end:
		case e > end:
			end, which, tied = e, i, tied[:0]
		default:
			tied = append(tied, i)
		}
	}
	if len(tied) > 0 {
		// Rare: the value read through the fewest layers keeps the text.
		tied = append([]int{which}, tied...)
		for depth := 0; depth < scrubDepth; depth++ {
			if i := slices.IndexFunc(tied, func(i int) bool { return d.match(sc.values[i], s, depth) == end }); i >= 0 {
				which = tied[i]
				break
			}
		}
	}
	return end, which, d.short
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

// decoder reads buf as text escaped up to scrubDepth layers deep, every way it can be read at once.
type decoder struct {
	buf []byte
	eof bool
	// short is set when a read needed a byte past the end of buf before eof.
	short bool
	// memo holds every reading made at an offset and depth from the current candidate's start: the same for every
	// value, so each is made once. matchAt empties it.
	memo map[int]memoed
}

type memoed struct {
	units []unit
	short bool
}

// unit is one way to read the text at a point: the bytes it decodes to (one byte, or a character's UTF-8) and where
// the text it was read from ends.
type unit struct {
	b   [utf8.UTFMax]byte
	n   int
	end int
}

func byteUnit(c byte, end int) unit {
	u := unit{n: 1, end: end}
	u.b[0] = c
	return u
}

func runeUnit(r rune, end int) unit {
	u := unit{end: end}
	u.n = utf8.EncodeRune(u.b[:], r)
	return u
}

// single answers the unit's byte when it decoded to exactly one.
func (u unit) single() (byte, bool) {
	return u.b[0], u.n == 1
}

// match answers the furthest end of the text from s that decodes to v through up to depth layers, or -1. It follows
// every reading at once (a walk of (offset, bytes of v matched) pairs, each seen once), so ambiguity costs no
// backtracking.
func (d *decoder) match(v []byte, s, depth int) int {
	// Fast path: a byte that starts no escape has one reading at every depth, itself. Walk those; most candidates
	// fail here, and a value echoed as it is ends here.
	k := 0
	for k < len(v) {
		if s+k >= len(d.buf) {
			if !d.eof {
				d.short = true
			}
			return -1
		}
		c := d.buf[s+k]
		if depth > 0 && escapeStart[c] {
			break
		}
		if c != v[k] {
			return -1
		}
		k++
	}
	if k == len(v) {
		return s + k
	}

	// Only an escape-start byte has more than one reading, so only there do walks branch and meet: the states kept
	// (each expanded once) are those at escape starts, and a byte between them is walked like the fast path's.
	type state struct{ off, k int }
	best := -1
	frontier := []state{{s + k, k}}
	seen := map[state]struct{}{}
walks:
	for len(frontier) > 0 {
		st := frontier[len(frontier)-1]
		frontier = frontier[:len(frontier)-1]
		for st.k < len(v) {
			if st.off >= len(d.buf) {
				if !d.eof {
					d.short = true
				}
				continue walks
			}
			c := d.buf[st.off]
			if escapeStart[c] {
				break
			}
			if c != v[st.k] {
				continue walks
			}
			st.off++
			st.k++
		}
		if st.k == len(v) {
			best = max(best, st.off)
			continue
		}
		if _, ok := seen[st]; ok {
			continue
		}
		seen[st] = struct{}{}
		for _, u := range d.units(st.off, depth) {
			if bytes.HasPrefix(v[st.k:], u.b[:u.n]) {
				frontier = append(frontier, state{u.end, st.k + u.n})
			}
		}
	}
	return best
}

// units answers every way to read one unit at off, through depth layers of escaping: at depth 0 the byte as it is;
// at each layer above, every unit of the layer below as it is, and every escape spelled in that layer's units. The
// answer is shared: never changed by the caller.
func (d *decoder) units(off, depth int) []unit {
	if off >= len(d.buf) {
		if !d.eof {
			d.short = true
		}
		return nil
	}
	if depth == 0 || !escapeStart[d.buf[off]] {
		// One reading at every depth: the byte itself.
		return []unit{byteUnit(d.buf[off], off+1)}
	}
	key := off*(scrubDepth+1) + depth
	if m, ok := d.memo[key]; ok {
		d.short = d.short || m.short
		return m.units
	}
	was := d.short
	d.short = false
	units := d.escapes(nil, off, depth)
	if d.memo == nil {
		d.memo = map[int]memoed{}
	}
	d.memo[key] = memoed{units, d.short}
	d.short = was || d.short
	return units
}

// escapes appends the readings at off, at depth, of an escape-start byte.
func (d *decoder) escapes(dst []unit, off, depth int) []unit {
	for _, u := range d.units(off, depth-1) {
		dst = append(dst, u)
		c, ok := u.single()
		if !ok {
			continue
		}
		switch c {
		case '+':
			dst = append(dst, byteUnit(' ', u.end))
		case '%':
			for _, h := range d.hex(u.end, 2, depth-1) {
				dst = append(dst, byteUnit(byte(h.v), h.end))
			}
		case '\\':
			dst = d.backslash(dst, u.end, depth-1)
		case '&':
			dst = d.reference(dst, u.end, depth-1)
		}
	}
	return dst
}

// backslash appends the escapes that follow a backslash at off, read at depth: JSON's (\" \\ \/ \b \f \n \r \t and
// \uXXXX, with a surrogate pair as one character), and \' and \xHH as Python and JavaScript write them.
func (d *decoder) backslash(dst []unit, off, depth int) []unit {
	for _, u := range d.units(off, depth) {
		c, ok := u.single()
		if !ok {
			continue
		}
		if to := shortEscapes[c]; to != 0 {
			dst = append(dst, byteUnit(to, u.end))
			continue
		}
		switch c {
		case 'x':
			for _, h := range d.hex(u.end, 2, depth) {
				dst = append(dst, byteUnit(byte(h.v), h.end))
			}
		case 'u':
			for _, h := range d.hex(u.end, 4, depth) {
				r := rune(h.v)
				if !utf16.IsSurrogate(r) {
					dst = append(dst, runeUnit(r, h.end))
					continue
				}
				// The second half of a pair: \uDC00 to \uDFFF.
				for _, lo := range d.escapedHex4(h.end, depth) {
					if c := utf16.DecodeRune(r, rune(lo.v)); c != utf8.RuneError {
						dst = append(dst, runeUnit(c, lo.end))
					}
				}
			}
		}
	}
	return dst
}

// shortEscapes maps the byte after a backslash to what it stands for; 0 is none.
var shortEscapes = [256]byte{'"': '"', '\\': '\\', '/': '/', '\'': '\'', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}

// escapeStart are the bytes an escape begins with; every other byte reads only as itself.
var escapeStart = [256]bool{'%': true, '+': true, '\\': true, '&': true}

// escapedHex4 reads "\uXXXX" at off, at depth.
func (d *decoder) escapedHex4(off, depth int) []hexRead {
	var out []hexRead
	for _, bs := range d.units(off, depth) {
		if c, ok := bs.single(); !ok || c != '\\' {
			continue
		}
		for _, u := range d.units(bs.end, depth) {
			if c, ok := u.single(); ok && c == 'u' {
				out = append(out, d.hex(u.end, 4, depth)...)
			}
		}
	}
	return out
}

// references are HTML's named character references an echo is likely to use.
var references = map[string]rune{"amp": '&', "lt": '<', "gt": '>', "quot": '"', "apos": '\''}

// reference appends the HTML character reference after an '&' at off, read at depth: a named one, &#NNN; or &#xHH;.
func (d *decoder) reference(dst []unit, off, depth int) []unit {
	type partial struct {
		text [8]byte
		n    int
		end  int
	}
	// Up to 8 characters then ';', each read at depth.
	frontier := []partial{{end: off}}
	for range 9 {
		var next []partial
		for _, p := range frontier {
			for _, u := range d.units(p.end, depth) {
				c, ok := u.single()
				if !ok {
					continue
				}
				if c == ';' {
					if r, ok := referenceRune(string(p.text[:p.n])); ok {
						dst = append(dst, runeUnit(r, u.end))
					}
					continue
				}
				if (isAlnum(c) || c == '#') && p.n < len(p.text) {
					q := p
					q.text[q.n] = c
					q.n++
					q.end = u.end
					next = append(next, q)
				}
			}
		}
		if len(next) == 0 {
			break
		}
		frontier = next
	}
	return dst
}

func referenceRune(name string) (rune, bool) {
	if r, ok := references[name]; ok {
		return r, true
	}
	if len(name) < 2 || name[0] != '#' {
		return 0, false
	}
	digits, base := name[1:], 10
	if digits[0] == 'x' || digits[0] == 'X' {
		digits, base = digits[1:], 16
	}
	if digits == "" || len(digits) > 6 {
		return 0, false
	}
	var r rune
	for i := 0; i < len(digits); i++ {
		v, ok := hexValue(digits[i])
		if !ok || v >= base {
			return 0, false
		}
		r = r*rune(base) + rune(v)
	}
	if r > utf8.MaxRune {
		return 0, false
	}
	return r, true
}

// hexRead is a number read from hex digits, and where its text ends.
type hexRead struct {
	v   int
	end int
}

// hex reads n hex digits (either case) at off, each a unit at depth, every way they can be read.
func (d *decoder) hex(off, n, depth int) []hexRead {
	reads := []hexRead{{0, off}}
	for range n {
		var next []hexRead
		for _, r := range reads {
			for _, u := range d.units(r.end, depth) {
				c, ok := u.single()
				if !ok {
					continue
				}
				if v, ok := hexValue(c); ok && v < 16 {
					next = append(next, hexRead{r.v<<4 | v, u.end})
				}
			}
		}
		if len(next) == 0 {
			return nil
		}
		reads = next
	}
	slices.SortFunc(reads, func(a, b hexRead) int { return cmp.Or(cmp.Compare(a.end, b.end), cmp.Compare(a.v, b.v)) })
	return slices.Compact(reads)
}

// hexValue is a digit's value in base 16 (10 for a decimal digit's use too).
func hexValue(c byte) (int, bool) {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0'), true
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10, true
	}
	return 0, false
}
