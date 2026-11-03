// Package protect swaps protected environment variables at the host's egress proxy. A sandbox holds a placeholder
// (kph_…) where it would hold a credential, so nothing inside it (a prompt-injected agent, a malicious package, a
// log upload) can read or send the real value. The proxy swaps the placeholder for the value only on requests to the
// destinations the variable is bound to, refuses a request that carries one anywhere else, and turns the value back
// into its placeholder in whatever comes back, so an API that echoes it never puts it into the sandbox.
//
// The real value is never logged, never put into an error and never put into a Refusal: only the variable's name is.
package protect

import (
	"bytes"
	"crypto/rand"
	"io"
)

// PlaceholderPrefix starts every placeholder, so one can be found in any text without knowing which exist.
const PlaceholderPrefix = "kph_"

// PlaceholderLen is a placeholder's length in bytes: the prefix and 40 characters from [0-9A-Za-z], about 238 bits,
// so one can't be guessed. Every placeholder is the same length, which keeps the streaming replacer's carry fixed.
const PlaceholderLen = 44

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var prefixBytes = []byte(PlaceholderPrefix)

// NewPlaceholder makes a placeholder from crypto/rand.
func NewPlaceholder() (string, error) {
	out := make([]byte, 0, PlaceholderLen)
	out = append(out, PlaceholderPrefix...)
	var buf [64]byte
	for len(out) < PlaceholderLen {
		if _, err := io.ReadFull(rand.Reader, buf[:]); err != nil {
			return "", err
		}
		for _, c := range buf {
			// 248 is the largest multiple of 62 a byte holds: the bytes above it would make the first characters of
			// the alphabet likelier than the rest, so they are dropped.
			if c >= 248 {
				continue
			}
			out = append(out, alphabet[c%62])
			if len(out) == PlaceholderLen {
				break
			}
		}
	}
	return string(out), nil
}

// IsPlaceholder says whether s is exactly one placeholder.
func IsPlaceholder(s string) bool {
	m := Find([]byte(s))
	return len(m) == 1 && m[0] == [2]int{0, len(s)}
}

// Find answers the start and end offsets of every placeholder in b. A match may not be preceded or followed by an
// alphanumeric character: a placeholder inside a longer word isn't one, so text that merely looks like one (and a
// value that happens to contain one) is left alone.
func Find(b []byte) [][2]int {
	return scan(b, false)
}

// scan is Find for a window of a longer stream: prevAlnum says whether the byte before b[0] was alphanumeric. The
// end of b counts as a boundary, so a streaming caller only trusts matches that end before the end of its window.
func scan(b []byte, prevAlnum bool) [][2]int {
	var out [][2]int
	for i := 0; i+PlaceholderLen <= len(b); {
		j := bytes.Index(b[i:], prefixBytes)
		if j < 0 {
			break
		}
		start := i + j
		end := start + PlaceholderLen
		if end > len(b) {
			break
		}
		before := prevAlnum
		if start > 0 {
			before = isAlnum(b[start-1])
		}
		if !before && allAlnum(b[start+len(PlaceholderPrefix):end]) && (end == len(b) || !isAlnum(b[end])) {
			out = append(out, [2]int{start, end})
			i = end
			continue
		}
		i = start + 1
	}
	return out
}

func isAlnum(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z'
}

func allAlnum(b []byte) bool {
	for _, c := range b {
		if !isAlnum(c) {
			return false
		}
	}
	return true
}
