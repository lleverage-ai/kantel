package protect

import "testing"

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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.b.Matches(tt.d); got != tt.want {
				t.Fatalf("Matches(%+v) = %v, want %v", tt.d, got, tt.want)
			}
		})
	}
}
