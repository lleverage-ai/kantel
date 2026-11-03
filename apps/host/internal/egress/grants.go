package egress

import (
	"net/url"
	"path"
	"slices"
	"strings"
)

// Grant is one of the control plane's allow or deny rules, on top of the allow and deny lists (deny wins). One with
// methods or paths can only be applied to a request the proxy can read, so its host is intercepted.
type Grant struct {
	// Action is "allow" or "deny"; any other grant is ignored.
	Action string
	// Host is a pattern: "api.github.com", "*.example.com" or "*".
	Host string
	// Methods restrict it to these methods; empty is any.
	Methods []string
	// Paths restrict it to paths matching these globs: "*" is one segment, "**" the rest. Empty is any.
	Paths []string
	// Rule is the grant as text, for the log and refusals.
	Rule string
}

func (g Grant) deny() bool  { return strings.EqualFold(strings.TrimSpace(g.Action), "deny") }
func (g Grant) allow() bool { return strings.EqualFold(strings.TrimSpace(g.Action), "allow") }

// detailed is a grant that needs the request's method or path.
func (g Grant) detailed() bool { return len(g.Methods) > 0 || len(g.Paths) > 0 }

// text is the grant as the log and the sandbox see it.
func (g Grant) text() string {
	if r := headerSafe(strings.TrimSpace(g.Rule)); r != "" {
		return r
	}
	parts := []string{strings.ToLower(strings.TrimSpace(g.Action))}
	if len(g.Methods) > 0 {
		parts = append(parts, strings.ToUpper(strings.Join(g.Methods, ",")))
	}
	parts = append(parts, g.Host)
	if len(g.Paths) > 0 {
		parts = append(parts, strings.Join(g.Paths, ","))
	}
	return headerSafe(strings.Join(parts, " "))
}

// matchesRequest says whether a request's method and path (as sent, escaped) are the grant's.
func (g Grant) matchesRequest(method, rawPath string) bool {
	if len(g.Methods) > 0 && !slices.ContainsFunc(g.Methods, func(m string) bool { return strings.EqualFold(strings.TrimSpace(m), method) }) {
		return false
	}
	if len(g.Paths) == 0 {
		return true
	}
	p, ok := requestPath(rawPath)
	if !ok {
		// A path whose meaning depends on the server (a "..", an encoded slash): a deny grant counts it, so it can't
		// be walked round, and an allow grant doesn't, so it can't be stretched.
		return g.deny()
	}
	return slices.ContainsFunc(g.Paths, func(pattern string) bool { return globMatch(pattern, p) })
}

// requestPath is the decoded, cleaned path a server acts on, or false when that depends on the server.
func requestPath(raw string) (string, bool) {
	raw, _, _ = strings.Cut(raw, "?")
	if raw == "" {
		raw = "/"
	}
	lower := strings.ToLower(raw)
	if strings.Contains(raw, `\`) || strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%25") {
		return "", false
	}
	decoded, err := url.PathUnescape(raw)
	if err != nil || !strings.HasPrefix(decoded, "/") || strings.ContainsRune(decoded, 0) {
		return "", false
	}
	for _, seg := range strings.Split(decoded, "/") {
		if seg == ".." || seg == "." {
			return "", false
		}
	}
	return path.Clean(decoded), true
}

// globMatch matches a cleaned path against a grant's glob: segment by segment, "*" (and path.Match's patterns)
// within one, "**" any number of them.
func globMatch(pattern, p string) bool {
	return matchSegments(segments(pattern), segments(p))
}

func segments(s string) []string {
	s = strings.Trim(strings.TrimSpace(s), "/")
	if s == "" {
		return nil
	}
	return strings.Split(s, "/")
}

func matchSegments(ps, xs []string) bool {
	for len(ps) > 0 {
		if ps[0] == "**" {
			for i := 0; i <= len(xs); i++ {
				if matchSegments(ps[1:], xs[i:]) {
					return true
				}
			}
			return false
		}
		if len(xs) == 0 {
			return false
		}
		if ok, err := path.Match(ps[0], xs[0]); err != nil || !ok {
			return false
		}
		ps, xs = ps[1:], xs[1:]
	}
	return len(xs) == 0
}

// What a decision can see of a connection.
const (
	// scopeTunnel is a CONNECT that stays a blind tunnel: only its host.
	scopeTunnel = iota
	// scopeConnect is a CONNECT to an intercepted host, before its requests: only the host, but each request is
	// decided again.
	scopeConnect
	// scopeRequest is one request the proxy can read: method and path too.
	scopeRequest
)

// verdict is a decision; rule is the grant that made it, if one did.
type verdict struct {
	allowed      bool
	reason, rule string
}

// decide applies a sandbox's rules and grants to a destination. Deny wins: a deny grant, then the deny list, then
// an allow grant, then the allow list, then DefaultDeny.
func (r Rules) decide(host, method, rawPath string, scope int) verdict {
	host = normaliseHost(host)
	if r.Mode == "none" {
		return verdict{reason: "this sandbox has no network"}
	}
	for _, g := range r.Grants {
		if !g.deny() || !patternMatches(g.Host, host) {
			continue
		}
		// A blind tunnel has no method or path to judge, and an intercepted host's requests are judged one by one.
		if g.detailed() && (scope != scopeRequest || !g.matchesRequest(method, rawPath)) {
			continue
		}
		return verdict{reason: "denied by a grant (" + g.text() + ")", rule: g.text()}
	}
	listed, denied, reason := r.lists(host)
	if denied {
		return verdict{reason: reason}
	}
	for _, g := range r.Grants {
		if !g.allow() || !patternMatches(g.Host, host) {
			continue
		}
		if g.detailed() {
			switch scope {
			case scopeTunnel:
				// Its methods and paths can't be checked in a tunnel, so it allows nothing there.
				continue
			case scopeConnect:
				return verdict{allowed: true}
			}
			if !g.matchesRequest(method, rawPath) {
				continue
			}
		}
		return verdict{allowed: true, rule: g.text()}
	}
	if listed || !r.DefaultDeny {
		return verdict{allowed: true}
	}
	return verdict{reason: "not on the proxy settings' allow list"}
}

// InterceptHosts are the host patterns the proxy terminates TLS for: the protected variables' bound hosts and the
// hosts of grants with methods or paths. Sorted, without repeats; "*" can't be intercepted and isn't.
func (r Rules) InterceptHosts() []string {
	hosts := slices.Clone(r.Intercept)
	for _, g := range r.Grants {
		if g.detailed() && (g.allow() || g.deny()) {
			hosts = append(hosts, g.Host)
		}
	}
	return normaliseHosts(hosts)
}

// intercepts says whether the proxy terminates TLS for host on port.
func (r Rules) intercepts(host string, port int) bool {
	if port != 443 {
		return false
	}
	return slices.ContainsFunc(r.InterceptHosts(), func(p string) bool { return patternMatches(p, host) })
}

// headerSafe keeps text (a grant's rule) to one header line.
func headerSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r < 0x20 && r != '\t' {
			return ' '
		}
		return r
	}, s)
}
