package protect

import (
	"strings"
	"testing"
)

// BenchmarkScrubJSON is the worst case: JSON dense with escapes that begin as an escaped value could.
func BenchmarkScrubJSON(b *testing.B) {
	sc := newScrubber([]Entry{{Placeholder: phGitHub, Value: githubValue}, {Placeholder: phAwkward, Value: awkwardValue}})
	chunk := `{"id":12345,"path":"C:\\Users\\x\\file.txt","url":"https://x.test/a%20b?c=d&e=f","html":"&lt;p&gt;caf\u00e9&lt;/p&gt;","text":"plain words in a sentence with g letters"},`
	body := []byte(strings.Repeat(chunk, (1<<20)/len(chunk)))
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		sc.replace(body)
	}
}

// BenchmarkScrubBinary is a download: random bytes.
func BenchmarkScrubBinary(b *testing.B) {
	sc := newScrubber([]Entry{{Placeholder: phGitHub, Value: githubValue}})
	body := make([]byte, 1<<20)
	x := uint32(1)
	for i := range body {
		x = x*1664525 + 1013904223
		body[i] = byte(x >> 24)
	}
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		sc.replace(body)
	}
}

// BenchmarkScrubAPIJSON is an ordinary API answer.
func BenchmarkScrubAPIJSON(b *testing.B) {
	sc := newScrubber([]Entry{{Placeholder: phGitHub, Value: githubValue}})
	chunk := `{"login":"octocat","id":1,"node_id":"MDQ6VXNlcjE=","avatar_url":"https://github.com/images/error/octocat_happy.gif","html_url":"https://github.com/octocat","type":"User","site_admin":false,"name":"monalisa octocat","company":"GitHub","blog":"https://github.com/blog","location":"San Francisco","bio":"There once was...","public_repos":2,"created_at":"2008-01-14T04:33:35Z"},`
	body := []byte(strings.Repeat(chunk, (1<<20)/len(chunk)))
	b.SetBytes(int64(len(body)))
	for b.Loop() {
		sc.replace(body)
	}
}
