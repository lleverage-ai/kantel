package protect

import (
	"net/url"
	"path"
	"slices"
	"strings"
)

// Binding is one destination a protected variable may be sent to.
type Binding struct {
	// Host is "api.example.com", or "*.example.com" for any subdomain (not example.com itself).
	Host string
	// PathPrefixes restrict the paths; empty allows any. A prefix matches whole segments: "/repos/acme" covers
	// "/repos/acme" and "/repos/acme/x" but not "/repos/acmecorp".
	PathPrefixes []string
	// Methods restrict the methods; empty allows any.
	Methods []string
}

// Destination is where a request is going, as the proxy saw it.
type Destination struct {
	// Host is the host name without a port.
	Host string
	Port int
	// Method is the request's method; Path is its path as sent (escaped, as url.URL.EscapedPath gives it).
	Method, Path string
}

// Matches says whether d is one of b's destinations. Only HTTPS on 443 is: a value sent in clear text, or to another
// port on the same name, could be read by whoever answers there.
func (b Binding) Matches(d Destination) bool {
	if d.Port != 443 || !hostMatches(b.Host, d.Host) {
		return false
	}
	if len(b.Methods) > 0 {
		method := strings.ToUpper(d.Method)
		if !slices.ContainsFunc(b.Methods, func(m string) bool { return strings.ToUpper(strings.TrimSpace(m)) == method }) {
			return false
		}
	}
	if len(b.PathPrefixes) == 0 {
		return true
	}
	p, ok := cleanPath(d.Path)
	if !ok {
		return false
	}
	return slices.ContainsFunc(b.PathPrefixes, func(prefix string) bool { return underPrefix(p, prefix) })
}

// normaliseHost lowercases a host and drops a trailing dot, so "API.example.com." and "api.example.com" are one.
func normaliseHost(h string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
}

func hostMatches(pattern, host string) bool {
	pattern, host = normaliseHost(pattern), normaliseHost(host)
	if pattern == "" || host == "" {
		return false
	}
	if suffix, ok := strings.CutPrefix(pattern, "*"); ok {
		// "*.example.com": at least one non-empty label before ".example.com".
		if !strings.HasPrefix(suffix, ".") || len(host) <= len(suffix) || !strings.HasSuffix(host, suffix) {
			return false
		}
		return !strings.HasSuffix(host[:len(host)-len(suffix)], ".")
	}
	return host == pattern
}

// cleanPath answers the decoded, cleaned path a server will act on, or false for a path whose meaning depends on
// the server: a ".." segment, an encoded slash, a backslash or an escape left after decoding once could reach
// outside a prefix on one server and not on another, so a prefix-restricted binding never matches one.
func cleanPath(raw string) (string, bool) {
	raw, _, _ = strings.Cut(raw, "?")
	raw, _, _ = strings.Cut(raw, "#")
	if raw == "" {
		raw = "/"
	}
	if hasEncodedSeparator(raw) {
		return "", false
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || !strings.HasPrefix(decoded, "/") || hasEncodedSeparator(decoded) || strings.ContainsRune(decoded, 0) {
		return "", false
	}
	// A server that decodes twice reads "%252e%252e" (or "%2e%252e") as "..": what one decoding leaves escaped
	// can't be judged against a prefix, and a real path rarely needs it.
	if hasEscape(decoded) {
		return "", false
	}
	for _, seg := range strings.Split(decoded, "/") {
		if seg == ".." {
			return "", false
		}
	}
	cleaned := path.Clean(decoded)
	if strings.HasSuffix(decoded, "/") && cleaned != "/" {
		cleaned += "/"
	}
	return cleaned, true
}

// hasEncodedSeparator also catches a double-encoded one ("%252f" decodes to "%2f"), for a server that decodes twice.
func hasEncodedSeparator(s string) bool {
	lower := strings.ToLower(s)
	return strings.Contains(s, `\`) || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c")
}

// hasEscape says whether s holds a percent-escape: '%' and two hex digits.
func hasEscape(s string) bool {
	for i := 0; i+2 < len(s); i++ {
		if s[i] == '%' && isHex(s[i+1]) && isHex(s[i+2]) {
			return true
		}
	}
	return false
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func underPrefix(p, prefix string) bool {
	switch {
	case prefix == "":
		return false
	case p == prefix:
		return true
	case strings.HasSuffix(prefix, "/"):
		return strings.HasPrefix(p, prefix)
	}
	return strings.HasPrefix(p, prefix+"/")
}
