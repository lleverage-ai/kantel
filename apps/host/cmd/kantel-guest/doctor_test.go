package main

import (
	"net/http"
	"slices"
	"testing"
)

// A check is a request the binding allows: its first method and path prefix, or HEAD / where any goes.
func TestProbesStayInTheirBindings(t *testing.T) {
	got := probes([]binding{
		{Host: "api.github.com", Methods: []string{"get", "POST"}, PathPrefixes: []string{"/repos/acme", "/user"}},
		{Host: "uploads.github.com"},
		{Host: "registry.npmjs.org", PathPrefixes: []string{"npm"}},
		{Host: "*.example.com", Methods: []string{"PUT"}},
		// The same check twice is made once.
		{Host: "uploads.github.com"},
	}, []string{"api.github.com", "uploads.github.com"})
	want := []probe{
		{host: "api.github.com", method: http.MethodGet, path: "/repos/acme"},
		{host: "uploads.github.com", method: http.MethodHead, path: "/"},
		{host: "registry.npmjs.org", method: http.MethodHead, path: "/npm"},
		{host: "*.example.com", method: http.MethodPut, path: "/"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("probes = %+v, want %+v", got, want)
	}
	// An older host's answer has hosts only.
	if got := probes(nil, []string{"api.github.com"}); !slices.Equal(got, []probe{{host: "api.github.com", method: http.MethodHead, path: "/"}}) {
		t.Fatalf("hosts only: %+v", got)
	}
	// A variable bound nowhere has nothing to check.
	if got := probes([]binding{}, []string{}); len(got) != 0 {
		t.Fatalf("no bindings: %+v", got)
	}
}
