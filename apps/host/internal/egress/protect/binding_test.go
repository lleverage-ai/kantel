package protect

import (
	"context"
	"errors"
	"testing"
)

func TestMatches(t *testing.T) {
	api := Binding{Host: "api.github.com"}
	wild := Binding{Host: "*.example.com"}
	scoped := Binding{Host: "api.github.com", Methods: []string{"get", "POST"}, PathPrefixes: []string{"/repos/acme/"}}
	segment := Binding{Host: "api.github.com", PathPrefixes: []string{"/repos/acme"}}
	to := func(host string, port int, method, path string) Destination {
		return Destination{Host: host, Port: port, Method: method, Path: path}
	}
	tests := []struct {
		name string
		b    Binding
		d    Destination
		want bool
	}{
		{"exact host", api, to("api.github.com", 443, "GET", "/"), true},
		{"host case", api, to("API.GitHub.com", 443, "GET", "/"), true},
		{"trailing dot", api, to("api.github.com.", 443, "GET", "/"), true},
		{"trailing dot in the binding", Binding{Host: "api.github.com."}, to("api.github.com", 443, "GET", "/"), true},
		{"another host", api, to("github.com", 443, "GET", "/"), false},
		{"a longer name", api, to("evilapi.github.com", 443, "GET", "/"), false},
		{"wildcard subdomain", wild, to("a.example.com", 443, "GET", "/"), true},
		{"wildcard deeper", wild, to("a.b.example.com", 443, "GET", "/"), true},
		{"wildcard apex", wild, to("example.com", 443, "GET", "/"), false},
		{"wildcard lookalike", wild, to("badexample.com", 443, "GET", "/"), false},
		{"wildcard empty label", wild, to(".example.com", 443, "GET", "/"), false},
		{"port 8443", api, to("api.github.com", 8443, "GET", "/"), false},
		{"port 80", api, to("api.github.com", 80, "GET", "/"), false},
		{"any method", api, to("api.github.com", 443, "PATCH", "/"), true},
		{"method listed in lowercase", scoped, to("api.github.com", 443, "GET", "/repos/acme/x"), true},
		{"method sent in lowercase", scoped, to("api.github.com", 443, "post", "/repos/acme/x"), true},
		{"method not listed", scoped, to("api.github.com", 443, "DELETE", "/repos/acme/x"), false},
		{"under the prefix", scoped, to("api.github.com", 443, "GET", "/repos/acme/widgets/issues"), true},
		{"the prefix itself", scoped, to("api.github.com", 443, "GET", "/repos/acme/"), true},
		{"outside the prefix", scoped, to("api.github.com", 443, "GET", "/repos/other/x"), false},
		{"query ignored", scoped, to("api.github.com", 443, "GET", "/repos/acme/x?a=1"), true},
		{"dot segment cleaned", scoped, to("api.github.com", 443, "GET", "/repos/./acme/x"), true},
		{"double slash cleaned", scoped, to("api.github.com", 443, "GET", "//repos/acme/x"), true},
		{"dot-dot", scoped, to("api.github.com", 443, "GET", "/repos/acme/../other/x"), false},
		{"dot-dot staying inside", scoped, to("api.github.com", 443, "GET", "/repos/acme/x/../y"), false},
		{"encoded dot-dot", scoped, to("api.github.com", 443, "GET", "/repos/acme/%2e%2e/other"), false},
		{"encoded slash", scoped, to("api.github.com", 443, "GET", "/repos/acme%2fx"), false},
		{"encoded slash, upper case", scoped, to("api.github.com", 443, "GET", "/repos/acme%2Fx"), false},
		{"double-encoded slash", scoped, to("api.github.com", 443, "GET", "/repos/acme/a%252fb"), false},
		{"backslash", scoped, to("api.github.com", 443, "GET", `/repos/acme/..\other`), false},
		{"encoded backslash", scoped, to("api.github.com", 443, "GET", "/repos/acme/a%5cb"), false},
		{"dot-dot without a prefix", api, to("api.github.com", 443, "GET", "/a/../b"), true},
		{"segment prefix", segment, to("api.github.com", 443, "GET", "/repos/acme"), true},
		{"segment prefix, below", segment, to("api.github.com", 443, "GET", "/repos/acme/x"), true},
		{"segment prefix, a longer name", segment, to("api.github.com", 443, "GET", "/repos/acmecorp/x"), false},
		{"segment prefix, one letter longer", segment, to("api.github.com", 443, "GET", "/repos/acmeX"), false},
		{"double-encoded dot-dot", scoped, to("api.github.com", 443, "GET", "/repos/acme/%252e%252e/other"), false},
		{"double-encoded dot-dot, upper case", scoped, to("api.github.com", 443, "GET", "/repos/acme/%252E%252E/other"), false},
		{"single and double encoding mixed", scoped, to("api.github.com", 443, "GET", "/repos/acme/%2e%252e/other"), false},
		{"double-encoded slash at the prefix", segment, to("api.github.com", 443, "GET", "/repos/acme%252fx"), false},
		{"a double-encoded letter", scoped, to("api.github.com", 443, "GET", "/repos/acme/%2541"), false},
		{"an encoded space", scoped, to("api.github.com", 443, "GET", "/repos/acme/a%20b"), true},
		{"an encoded e-acute", scoped, to("api.github.com", 443, "GET", "/repos/acme/caf%C3%A9"), true},
		{"an encoded percent not followed by hex", scoped, to("api.github.com", 443, "GET", "/repos/acme/100%25"), true},
		{"double encoding without a prefix", api, to("api.github.com", 443, "GET", "/a/%252e%252e/b"), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.b.Matches(tt.d); got != tt.want {
				t.Fatalf("Matches(%+v) = %v, want %v", tt.d, got, tt.want)
			}
		})
	}
}

// TestStoreResolvesPathBindings checks the path rules hold where they matter, in what the Store answers: a scoped
// variable is refused for a path a second decoding would move, and a host-only one isn't.
func TestStoreResolvesPathBindings(t *testing.T) {
	s := NewStore(func(context.Context, string) (Table, error) {
		return Table{Version: 1, Entries: []Entry{
			{Placeholder: phGitHub, Name: "SCOPED", Value: "scoped-value", Bindings: []Binding{{Host: "api.github.com", PathPrefixes: []string{"/repos/acme"}}}},
			{Placeholder: phNPM, Name: "HOST_ONLY", Value: "host-value", Bindings: []Binding{{Host: "api.github.com"}}},
		}}, nil
	})
	tests := []struct {
		path   string
		scoped bool
	}{
		{"/repos/acme/%252e%252e/other", false},
		{"/repos/acme/%252fx", false},
		{"/repos/acme/%2e%252e/other", false},
		{"/repos/acmeX", false},
		{"/repos/acme", true},
		{"/repos/acme/a%20b", true},
		{"/repos/acme/caf%C3%A9", true},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			dest := Destination{Host: "api.github.com", Port: 443, Method: "GET", Path: tt.path}
			r, err := s.Resolve(context.Background(), phGitHub, "sbx-1", dest)
			if tt.scoped {
				if err != nil || r.Value != "scoped-value" {
					t.Fatalf("the scoped variable wasn't resolved: %v", err)
				}
			} else {
				var unbound *UnboundError
				if !errors.As(err, &unbound) || unbound.Name != "SCOPED" {
					t.Fatalf("got %v, want the scoped variable unbound", err)
				}
			}
			if r, err := s.Resolve(context.Background(), phNPM, "sbx-1", dest); err != nil || r.Value != "host-value" {
				t.Fatalf("the host-only variable wasn't resolved: %v", err)
			}
		})
	}
}
