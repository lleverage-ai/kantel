package protect

import (
	"context"
	"strings"
)

// The tests' variables: GITHUB_TOKEN is bound to api.github.com, NPM_TOKEN (whose value has characters that need
// escaping in a query, a form or JSON) to registry.npmjs.org.
var (
	phGitHub  = "kph_" + strings.Repeat("aB3", 13) + "Z"
	phNPM     = "kph_" + strings.Repeat("n", 40)
	phUnknown = "kph_" + strings.Repeat("u", 40)

	githubValue = "ghp_0123456789abcdefREAL"
	npmValue    = `npm/se+cr=t&"x"`

	githubDest = Destination{Host: "api.github.com", Port: 443, Method: "POST", Path: "/x"}
	npmDest    = Destination{Host: "registry.npmjs.org", Port: 443, Method: "PUT", Path: "/pkg"}
)

func testEntries() []Entry {
	return []Entry{
		{Placeholder: phGitHub, Name: "GITHUB_TOKEN", Value: githubValue, Bindings: []Binding{{Host: "api.github.com"}}},
		{Placeholder: phNPM, Name: "NPM_TOKEN", Value: npmValue, Bindings: []Binding{{Host: "registry.npmjs.org"}}},
	}
}

// noProtected is the provider for a sandbox with no protected variables, like the proxy's: nothing is its placeholder.
type noProtected struct{}

func (noProtected) Resolve(context.Context, string, string, Destination) (Resolution, error) {
	return Resolution{}, ErrUnknown
}

func testStore() *Store {
	return NewStore(func(context.Context, string) (Table, error) {
		return Table{Version: 1, Entries: testEntries()}, nil
	})
}
