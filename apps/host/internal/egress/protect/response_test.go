package protect

import (
	"bufio"
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
)

func response(header http.Header, body []byte, oneByte bool) *http.Response {
	var r io.Reader = bytes.NewReader(body)
	if oneByte {
		r = iotest.OneByteReader(r)
	}
	return &http.Response{
		StatusCode:    200,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        header,
		Body:          io.NopCloser(r),
		ContentLength: int64(len(body)),
	}
}

func TestScrubResponseHeaders(t *testing.T) {
	resp := response(http.Header{"X-Echo": {"token " + githubValue}, "Set-Cookie": {"a=" + npmValue, "b=c"}}, nil, false)
	resp.Body = http.NoBody
	if err := ScrubResponse(resp, testEntries()); err != nil {
		t.Fatal(err)
	}
	if got := resp.Header.Get("X-Echo"); got != "token "+phGitHub {
		t.Fatalf("X-Echo is %q", got)
	}
	if got := resp.Header.Values("Set-Cookie"); len(got) != 2 || got[0] != "a="+phNPM || got[1] != "b=c" {
		t.Fatalf("Set-Cookie is %q", got)
	}
}

func TestScrubResponseBody(t *testing.T) {
	longer := Entry{Placeholder: "kph_" + strings.Repeat("L", 40), Name: "LONG", Value: githubValue + "-and-more"}
	tests := []struct {
		name     string
		entries  []Entry
		encoding string
		body     string
		oneByte  bool
		want     string
		// untouched is a body that must pass through as it came: one this package can't see into, or nothing to
		// scrub.
		untouched bool
	}{
		{name: "identity", entries: testEntries(), body: "echo " + githubValue + " and " + npmValue, want: "echo " + phGitHub + " and " + phNPM},
		{name: "split across reads", entries: testEntries(), body: githubValue + githubValue + "|" + npmValue, oneByte: true, want: phGitHub + phGitHub + "|" + phNPM},
		{name: "at the very end", entries: testEntries(), body: "x" + githubValue, oneByte: true, want: "x" + phGitHub},
		{name: "the longer value wins", entries: append(testEntries(), longer), body: githubValue + "-and-more " + githubValue, oneByte: true, want: longer.Placeholder + " " + phGitHub},
		{name: "a partial value", entries: testEntries(), body: githubValue[:10] + "!" + githubValue[10:], oneByte: true, want: githubValue[:10] + "!" + githubValue[10:]},
		{name: "gzip", entries: testEntries(), encoding: "gzip", body: `{"echo":"` + githubValue + `"}`, want: `{"echo":"` + phGitHub + `"}`},
		{name: "gzip split across reads", entries: testEntries(), encoding: "gzip", body: strings.Repeat("y", 1000) + githubValue, oneByte: true, want: strings.Repeat("y", 1000) + phGitHub},
		{name: "another encoding", entries: testEntries(), encoding: "br", body: "opaque " + githubValue, want: "opaque " + githubValue, untouched: true},
		{name: "no values", entries: []Entry{{Placeholder: phGitHub, Name: "EMPTY"}}, body: "nothing", want: "nothing", untouched: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(tt.body)
			header := http.Header{"Content-Type": {"application/json"}}
			if tt.encoding == "gzip" {
				body = gzipped(t, tt.body)
			}
			if tt.encoding != "" {
				header.Set("Content-Encoding", tt.encoding)
			}
			header.Set("Content-Length", strconv.Itoa(len(body)))
			resp := response(header, body, tt.oneByte)
			if err := ScrubResponse(resp, tt.entries); err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want {
				t.Fatalf("body %q, want %q", got, tt.want)
			}
			if tt.untouched {
				if resp.ContentLength != int64(len(body)) || resp.Header.Get("Content-Encoding") != tt.encoding {
					t.Fatalf("an untouched body's headers changed")
				}
				return
			}
			if resp.ContentLength != -1 || resp.Header.Get("Content-Length") != "" || resp.Header.Get("Content-Encoding") != "" {
				t.Fatalf("length %d, Content-Length %q, Content-Encoding %q: want an unknown length, uncompressed",
					resp.ContentLength, resp.Header.Get("Content-Length"), resp.Header.Get("Content-Encoding"))
			}
		})
	}
}

// TestScrubResponseWrites checks a scrubbed response still writes as valid HTTP/1.1 (chunked, since its length
// changed).
func TestScrubResponseWrites(t *testing.T) {
	body := []byte("value: " + githubValue)
	resp := response(http.Header{"Content-Length": {strconv.Itoa(len(body))}}, body, false)
	if err := ScrubResponse(resp, testEntries()); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := resp.Write(&buf); err != nil {
		t.Fatal(err)
	}
	back, err := http.ReadResponse(bufio.NewReader(&buf), nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(back.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "value: "+phGitHub {
		t.Fatalf("written body %q", got)
	}
}
