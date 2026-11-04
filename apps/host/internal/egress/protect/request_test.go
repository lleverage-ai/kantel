package protect

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// rawRequest is a proxy-form request as a sandbox sends it, with a Content-Length for a body.
func rawRequest(method, target string, headers []string, body string) string {
	var b strings.Builder
	u, _ := url.Parse(target)
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\nHost: %s\r\n", method, target, u.Host)
	for _, h := range headers {
		b.WriteString(h + "\r\n")
	}
	if body != "" {
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(body))
	}
	b.WriteString("\r\n" + body)
	return b.String()
}

func readRequest(t *testing.T, raw string) *http.Request {
	t.Helper()
	req, err := http.ReadRequest(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func readBody(t *testing.T, req *http.Request) string {
	t.Helper()
	b, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func gzipped(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gunzipped(t *testing.T, b []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// wantLength checks a buffered body's length is the new one, both in the request and its header.
func wantLength(t *testing.T, req *http.Request, n int) {
	t.Helper()
	if req.ContentLength != int64(n) || req.Header.Get("Content-Length") != strconv.Itoa(n) || req.TransferEncoding != nil {
		t.Fatalf("length %d (header %q, transfer encoding %v), want %d", req.ContentLength, req.Header.Get("Content-Length"), req.TransferEncoding, n)
	}
}

func TestRewriteRequest(t *testing.T) {
	jsonBody := `{"token":"` + phGitHub + `","n":1}`
	chunked := "POST https://api.github.com/x HTTP/1.1\r\nHost: api.github.com\r\nTransfer-Encoding: chunked\r\n\r\n" +
		fmt.Sprintf("%x\r\n%s\r\n", 20, jsonBody[:20]) + fmt.Sprintf("%x\r\n%s\r\n", len(jsonBody)-20, jsonBody[20:]) + "0\r\n\r\n"
	tests := []struct {
		name    string
		raw     string
		dest    Destination
		p       Provider // testStore() when nil
		swapped []string
		check   func(t *testing.T, req *http.Request)
	}{
		{
			name:    "authorization token",
			raw:     rawRequest("GET", "https://api.github.com/user", []string{"Authorization: token " + phGitHub}, ""),
			dest:    githubDest,
			swapped: []string{"GITHUB_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				if got := req.Header.Get("Authorization"); got != "token "+githubValue {
					t.Fatalf("Authorization isn't the value")
				}
			},
		},
		{
			name:    "basic auth password",
			raw:     rawRequest("GET", "https://api.github.com/user", []string{"Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+phGitHub))}, ""),
			dest:    githubDest,
			swapped: []string{"GITHUB_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				user, pass, ok := req.BasicAuth()
				if !ok || user != "x-access-token" || pass != githubValue {
					t.Fatalf("basic credentials weren't swapped (user %q)", user)
				}
			},
		},
		{
			name:    "query string",
			raw:     rawRequest("GET", "https://registry.npmjs.org/pkg?token="+phNPM+"&a=1", nil, ""),
			dest:    npmDest,
			swapped: []string{"NPM_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				if req.URL.RawQuery != "token="+url.QueryEscape(npmValue)+"&a=1" {
					t.Fatalf("the query isn't the escaped value")
				}
				if q := req.URL.Query(); q.Get("token") != npmValue || q.Get("a") != "1" {
					t.Fatalf("the query doesn't decode to the value")
				}
			},
		},
		{
			name:    "JSON body",
			raw:     rawRequest("POST", "https://api.github.com/x", []string{"Content-Type: application/json"}, jsonBody),
			dest:    githubDest,
			swapped: []string{"GITHUB_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				want := `{"token":"` + githubValue + `","n":1}`
				if readBody(t, req) != want {
					t.Fatalf("the body isn't swapped")
				}
				wantLength(t, req, len(want))
			},
		},
		{
			name:    "JSON body with a value that needs escaping",
			raw:     rawRequest("PUT", "https://registry.npmjs.org/pkg", []string{"Content-Type: application/json; charset=utf-8"}, `{"t":"`+phNPM+`"}`),
			dest:    npmDest,
			swapped: []string{"NPM_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				var v struct{ T string }
				if err := json.Unmarshal([]byte(readBody(t, req)), &v); err != nil || v.T != npmValue {
					t.Fatalf("the body isn't JSON holding the value: %v", err)
				}
			},
		},
		{
			name:    "form body",
			raw:     rawRequest("PUT", "https://registry.npmjs.org/pkg", []string{"Content-Type: application/x-www-form-urlencoded"}, "user=a&password="+phNPM),
			dest:    npmDest,
			swapped: []string{"NPM_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				form, err := url.ParseQuery(readBody(t, req))
				if err != nil || form.Get("password") != npmValue || form.Get("user") != "a" {
					t.Fatalf("the form doesn't hold the value: %v", err)
				}
			},
		},
		{
			name:    "chunked body",
			raw:     chunked,
			dest:    githubDest,
			swapped: []string{"GITHUB_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				want := `{"token":"` + githubValue + `","n":1}`
				if readBody(t, req) != want {
					t.Fatalf("the body isn't swapped")
				}
				wantLength(t, req, len(want))
			},
		},
		{
			name:    "placeholder-like text in a sandbox with no protected variables left alone",
			raw:     rawRequest("POST", "https://api.github.com/x", []string{"X-Other: " + phUnknown}, "a "+phUnknown),
			dest:    githubDest,
			p:       noProtected{},
			swapped: nil,
			check: func(t *testing.T, req *http.Request) {
				if req.Header.Get("X-Other") != phUnknown || readBody(t, req) != "a "+phUnknown {
					t.Fatalf("an unknown placeholder changed")
				}
			},
		},
		{
			name:    "two variables, one in a header and one in the body",
			raw:     rawRequest("POST", "https://api.github.com/x", []string{"Authorization: Bearer " + phGitHub, "X-Again: " + phGitHub}, "a "+phGitHub),
			dest:    githubDest,
			swapped: []string{"GITHUB_TOKEN"},
			check: func(t *testing.T, req *http.Request) {
				if req.Header.Get("Authorization") != "Bearer "+githubValue || req.Header.Get("X-Again") != githubValue || readBody(t, req) != "a "+githubValue {
					t.Fatalf("not every placeholder was swapped")
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := readRequest(t, tt.raw)
			p := tt.p
			if p == nil {
				p = testStore()
			}
			swapped, err := RewriteRequest(context.Background(), req, "sbx-1", tt.dest, p)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(swapped, tt.swapped) {
				t.Fatalf("swapped %v, want %v", swapped, tt.swapped)
			}
			tt.check(t, req)
		})
	}
}

func TestRewriteRequestGzipBody(t *testing.T) {
	body := gzipped(t, "password="+phGitHub)
	req := readRequest(t, rawRequest("POST", "https://api.github.com/x", []string{"Content-Type: text/plain", "Content-Encoding: gzip"}, string(body)))
	swapped, err := RewriteRequest(context.Background(), req, "sbx-1", githubDest, testStore())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(swapped, []string{"GITHUB_TOKEN"}) {
		t.Fatalf("swapped %v", swapped)
	}
	if req.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding is %q, want gzip", req.Header.Get("Content-Encoding"))
	}
	out := readBody(t, req)
	if gunzipped(t, []byte(out)) != "password="+githubValue {
		t.Fatalf("the gzip body isn't swapped")
	}
	wantLength(t, req, len(out))
}

func TestRewriteRequestRefuses(t *testing.T) {
	failing := NewStore(func(context.Context, string) (Table, error) { return Table{}, errors.New("vault unreachable") })
	tests := []struct {
		name     string
		headers  []string
		body     string
		p        Provider
		code     string
		variable string
	}{
		{"unbound in a header", []string{"Authorization: Bearer " + phNPM}, "", testStore(), CodeUnbound, "NPM_TOKEN"},
		{"unbound in the body", []string{"Authorization: Bearer " + phGitHub}, `{"npm":"` + phNPM + `"}`, testStore(), CodeUnbound, "NPM_TOKEN"},
		{"unbound in basic credentials", []string{"Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("u:"+phNPM))}, "x", testStore(), CodeUnbound, "NPM_TOKEN"},
		{"values unavailable", []string{"Authorization: Bearer " + phGitHub}, "body", failing, CodeUnavailable, ""},
		// Another sandbox's placeholder, such as a fork's parent's: refused, not sent on unswapped.
		{"another sandbox's in a header", []string{"Authorization: Bearer " + phUnknown}, "", testStore(), CodeUnknown, ""},
		{"another sandbox's in the body", []string{"Authorization: Bearer " + phGitHub}, `{"t":"` + phUnknown + `"}`, testStore(), CodeUnknown, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := readRequest(t, rawRequest("POST", "https://api.github.com/x", tt.headers, tt.body))
			before := req.Header.Clone()
			length := req.ContentLength
			_, err := RewriteRequest(context.Background(), req, "sbx-1", githubDest, tt.p)
			var ref *Refusal
			if !errors.As(err, &ref) || ref.Code != tt.code || ref.Variable != tt.variable {
				t.Fatalf("got %v, want a %s refusal for %q", err, tt.code, tt.variable)
			}
			if msg := err.Error(); strings.Contains(msg, githubValue) || strings.Contains(msg, npmValue) {
				t.Fatalf("the refusal %q holds a value", msg)
			}
			for k, v := range before {
				if !slices.Equal(req.Header[k], v) {
					t.Fatalf("header %s changed", k)
				}
			}
			if req.ContentLength != length {
				t.Fatalf("the length changed")
			}
			if tt.body != "" && readBody(t, req) != tt.body {
				t.Fatalf("the body changed")
			}
		})
	}
}

// bigBody is a body over the buffer limit with placeholders where a stream could miss one: at the start, across a
// read boundary, across the end of the part read ahead, and at the very end.
func bigBody(ph string, at ...int) []byte {
	body := bytes.Repeat([]byte("."), MaxBufferedBody+(100<<10))
	for _, i := range at {
		if i < 0 {
			i += len(body)
		}
		copy(body[i:], ph)
	}
	return body
}

func TestRewriteRequestStreamsALargeBody(t *testing.T) {
	body := bigBody(phGitHub, 10, streamChunk-20, MaxBufferedBody-10, -PlaceholderLen)
	req, err := http.NewRequest("POST", "https://api.github.com/upload", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	swapped, err := RewriteRequest(context.Background(), req, "sbx-1", githubDest, testStore())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(swapped, []string{"GITHUB_TOKEN"}) {
		t.Fatalf("swapped %v", swapped)
	}
	if req.ContentLength != -1 || !slices.Equal(req.TransferEncoding, []string{"chunked"}) || req.Header.Get("Content-Length") != "" {
		t.Fatalf("length %d, transfer encoding %v: want a chunked stream", req.ContentLength, req.TransferEncoding)
	}
	got, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	want := bytes.ReplaceAll(body, []byte(phGitHub), []byte(githubValue))
	if !bytes.Equal(got, want) {
		t.Fatalf("the streamed body isn't swapped (%d bytes, want %d)", len(got), len(want))
	}
}

func TestRewriteRequestAbortsAStreamWithAnUnboundPlaceholder(t *testing.T) {
	body := bigBody(phNPM, MaxBufferedBody+50)
	req, err := http.NewRequest("POST", "https://api.github.com/upload", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RewriteRequest(context.Background(), req, "sbx-1", githubDest, testStore()); err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(req.Body)
	var ref *Refusal
	if !errors.As(err, &ref) || ref.Code != CodeUnbound || ref.Variable != "NPM_TOKEN" {
		t.Fatalf("reading the body: %v, want an unbound refusal", err)
	}
}
