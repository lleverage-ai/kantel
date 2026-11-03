package protect

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"errors"
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
		// untouched is a body that must pass through as it came: there is nothing to scrub.
		untouched bool
	}{
		{name: "identity", entries: testEntries(), body: "echo " + githubValue + " and " + npmValue, want: "echo " + phGitHub + " and " + phNPM},
		{name: "split across reads", entries: testEntries(), body: githubValue + githubValue + "|" + npmValue, oneByte: true, want: phGitHub + phGitHub + "|" + phNPM},
		{name: "at the very end", entries: testEntries(), body: "x" + githubValue, oneByte: true, want: "x" + phGitHub},
		{name: "the longer value wins", entries: append(testEntries(), longer), body: githubValue + "-and-more " + githubValue, oneByte: true, want: longer.Placeholder + " " + phGitHub},
		{name: "a partial value", entries: testEntries(), body: githubValue[:10] + "!" + githubValue[10:], oneByte: true, want: githubValue[:10] + "!" + githubValue[10:]},
		{name: "gzip", entries: testEntries(), encoding: "gzip", body: `{"echo":"` + githubValue + `"}`, want: `{"echo":"` + phGitHub + `"}`},
		{name: "gzip split across reads", entries: testEntries(), encoding: "gzip", body: strings.Repeat("y", 1000) + githubValue, oneByte: true, want: strings.Repeat("y", 1000) + phGitHub},
		{name: "deflate", entries: testEntries(), encoding: "deflate", body: `{"echo":"` + githubValue + `"}`, want: `{"echo":"` + phGitHub + `"}`},
		{name: "deflate split across reads", entries: testEntries(), encoding: "deflate", body: strings.Repeat("y", 1000) + npmValue, oneByte: true, want: strings.Repeat("y", 1000) + phNPM},
		{name: "no values", entries: []Entry{{Placeholder: phGitHub, Name: "EMPTY"}}, body: "nothing", want: "nothing", untouched: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(tt.body)
			header := http.Header{"Content-Type": {"application/json"}}
			switch tt.encoding {
			case "gzip":
				body = gzipped(t, tt.body)
			case "deflate":
				body = deflated(t, tt.body)
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

// deflated is HTTP's deflate: zlib.
func deflated(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestScrubResponseRefusesAnUnreadableEncoding checks a body this package can't decode is refused rather than
// passed on with a value it can't see, and that the refusal names the coding but no value.
func TestScrubResponseRefusesAnUnreadableEncoding(t *testing.T) {
	tests := []struct {
		name     string
		encoding []string
		want     string
	}{
		{"br", []string{"br"}, `"br"`},
		{"zstd", []string{"zstd"}, `"zstd"`},
		{"a chain", []string{"gzip, br"}, `"gzip, br"`},
		{"a chain over two lines", []string{"gzip", "br"}, `"gzip, br"`},
		{"gzip twice", []string{"gzip, gzip"}, `"gzip, gzip"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte("opaque " + githubValue)
			header := http.Header{"Content-Encoding": tt.encoding, "X-Echo": {githubValue}}
			header.Set("Content-Length", strconv.Itoa(len(body)))
			resp := response(header, body, false)
			err := ScrubResponse(resp, testEntries())
			var ref *Refusal
			if !errors.As(err, &ref) || ref.Code != CodeUnreadableResponse {
				t.Fatalf("got %v, want an unreadable-response refusal", err)
			}
			if !strings.Contains(ref.Message, tt.want) {
				t.Fatalf("the refusal %q doesn't name the coding %s", ref.Message, tt.want)
			}
			if msg := err.Error(); strings.Contains(msg, githubValue) || strings.Contains(msg, npmValue) {
				t.Fatalf("the refusal %q holds a value", msg)
			}
		})
	}
}

// TestScrubResponseWithoutValuesPassesThrough checks a response with nothing to scrub goes on as it came, whatever
// its coding.
func TestScrubResponseWithoutValuesPassesThrough(t *testing.T) {
	for _, encoding := range []string{"", "gzip", "br", "gzip, br"} {
		for _, entries := range [][]Entry{nil, {{Placeholder: phGitHub, Name: "EMPTY"}}} {
			t.Run(encoding, func(t *testing.T) {
				body := []byte("opaque " + githubValue)
				header := http.Header{"Content-Length": {strconv.Itoa(len(body))}}
				if encoding != "" {
					header.Set("Content-Encoding", encoding)
				}
				resp := response(header, body, false)
				if err := ScrubResponse(resp, entries); err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(got, body) || resp.ContentLength != int64(len(body)) || resp.Header.Get("Content-Encoding") != encoding ||
					resp.Header.Get("Content-Length") != strconv.Itoa(len(body)) {
					t.Fatalf("a response with nothing to scrub changed")
				}
			})
		}
	}
}

// TestScrubResponseWithoutABodyIgnoresItsEncoding checks a body-less answer (to HEAD, or a 304) is only scrubbed in
// its headers: its Content-Encoding describes a body that isn't there.
func TestScrubResponseWithoutABodyIgnoresItsEncoding(t *testing.T) {
	resp := response(http.Header{"Content-Encoding": {"br"}, "X-Echo": {githubValue}}, nil, false)
	resp.Body = http.NoBody
	if err := ScrubResponse(resp, testEntries()); err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("X-Echo") != phGitHub || resp.Header.Get("Content-Encoding") != "br" {
		t.Fatalf("headers %v", resp.Header)
	}
}

func TestLimitAcceptEncoding(t *testing.T) {
	tests := []struct {
		name   string
		values []string
		want   []string
	}{
		{"absent", nil, nil},
		{"a browser's", []string{"gzip, deflate, br, zstd"}, []string{"gzip, deflate"}},
		{"gzip only", []string{"gzip"}, []string{"gzip"}},
		{"x-gzip", []string{"x-gzip, br"}, []string{"gzip"}},
		{"br only", []string{"br"}, nil},
		{"identity", []string{"identity"}, nil},
		{"weights", []string{"br;q=1.0, gzip;q=0.5, deflate;q=0"}, []string{"gzip"}},
		{"any", []string{"*"}, []string{"gzip, deflate"}},
		{"any but gzip", []string{"*, gzip;q=0"}, []string{"deflate"}},
		{"over two lines", []string{"br", "Deflate"}, []string{"deflate"}},
		{"empty", []string{""}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := http.Header{"Other": {"x"}}
			for _, v := range tt.values {
				h.Add("Accept-Encoding", v)
			}
			LimitAcceptEncoding(h)
			got := h.Values("Accept-Encoding")
			if strings.Join(got, "|") != strings.Join(tt.want, "|") || (tt.want == nil && got != nil) {
				t.Fatalf("Accept-Encoding %q, want %q", got, tt.want)
			}
			if h.Get("Other") != "x" {
				t.Fatalf("another header changed")
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
