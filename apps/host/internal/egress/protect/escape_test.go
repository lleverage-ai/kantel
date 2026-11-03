package protect

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// awkwardValue has a character each echo might escape: JSON's quote, backslash and control characters (a newline,
// which encoding/json and jsonEscape write differently), HTML's '<', '>' and '&', a query's '&', '=', '+' and space,
// and a path's '/'.
const awkwardValue = "a\"b\\c\x01d\ne&f=g+h i/j<k>"

var phAwkward = "kph_" + strings.Repeat("Aw", 20)

func awkwardStore() *Store {
	return NewStore(func(context.Context, string) (Table, error) {
		return Table{Version: 1, Entries: []Entry{{Placeholder: phAwkward, Name: "AWKWARD", Value: awkwardValue, Bindings: []Binding{{Host: "api.github.com"}}}}}, nil
	})
}

// sentTo answers what the destination is sent for a request: its body, or its query when the body is empty.
func sentTo(t *testing.T, store *Store, target, contentType, body string) string {
	t.Helper()
	var headers []string
	if contentType != "" {
		headers = append(headers, "Content-Type: "+contentType)
	}
	req := readRequest(t, rawRequest("POST", target, headers, body))
	if _, err := RewriteRequest(context.Background(), req, "sbx-1", githubDest, store); err != nil {
		t.Fatal(err)
	}
	if body == "" {
		return req.URL.RawQuery
	}
	return readBody(t, req)
}

func jsonNoHTML(t *testing.T, v any) string {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}

// TestScrubResponseCatchesEscapedEchoes swaps a value that needs escaping into a request, then checks every form
// the destination might echo it in comes back as the placeholder: split across one-byte reads, and inside gzip.
func TestScrubResponseCatchesEscapedEchoes(t *testing.T) {
	store := awkwardStore()
	entries, err := store.Values(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}

	jsonSent := sentTo(t, store, "https://api.github.com/x", "application/json", `{"t":"`+phAwkward+`"}`)
	var decoded struct{ T string }
	if err := json.Unmarshal([]byte(jsonSent), &decoded); err != nil || decoded.T != awkwardValue {
		t.Fatalf("the JSON sent doesn't hold the value: %v", err)
	}
	formSent := sentTo(t, store, "https://api.github.com/x", "application/x-www-form-urlencoded", "t="+phAwkward)
	if form, err := url.ParseQuery(formSent); err != nil || form.Get("t") != awkwardValue {
		t.Fatalf("the form sent doesn't hold the value: %v", err)
	}
	querySent := sentTo(t, store, "https://api.github.com/x?t="+phAwkward, "", "")
	if q, err := url.ParseQuery(querySent); err != nil || q.Get("t") != awkwardValue {
		t.Fatalf("the query sent doesn't hold the value: %v", err)
	}
	marshalled, err := json.Marshal(map[string]string{"t": awkwardValue})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(marshalled), `\u003c`) {
		t.Fatalf("encoding/json didn't escape '<': the HTML-escaped form isn't being tested")
	}

	echoes := []struct {
		name, body, want string
	}{
		{"the JSON body as sent", jsonSent, `{"t":"` + phAwkward + `"}`},
		{"re-encoded by encoding/json", string(marshalled), `{"t":"` + phAwkward + `"}`},
		{"re-encoded without HTML escaping", jsonNoHTML(t, map[string]string{"t": awkwardValue}), `{"t":"` + phAwkward + `"}` + "\n"},
		{"the form as sent", "echo: " + formSent, "echo: t=" + phAwkward},
		{"the query as sent", "https://api.github.com/x?" + querySent + "&n=1", "https://api.github.com/x?t=" + phAwkward + "&n=1"},
		{"in a path", "https://api.github.com/files/" + url.PathEscape(awkwardValue) + "/raw", "https://api.github.com/files/" + phAwkward + "/raw"},
		{"as it is", "raw " + awkwardValue + "!", "raw " + phAwkward + "!"},
		{"every form at once", jsonSent + string(marshalled) + formSent + awkwardValue, `{"t":"` + phAwkward + `"}{"t":"` + phAwkward + `"}t=` + phAwkward + phAwkward},
	}
	for _, e := range echoes {
		for _, gz := range []bool{false, true} {
			name := e.name
			if gz {
				name += ", gzip"
			}
			t.Run(name, func(t *testing.T) {
				body := []byte(e.body)
				header := http.Header{"Content-Type": {"text/plain"}}
				if gz {
					body = gzipped(t, e.body)
					header.Set("Content-Encoding", "gzip")
				}
				resp := response(header, body, true)
				if err := ScrubResponse(resp, entries); err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if string(got) != e.want {
					t.Fatalf("body %q, want %q", got, e.want)
				}
			})
		}
	}

	t.Run("in a header", func(t *testing.T) {
		resp := response(http.Header{"Location": {"/x?t=" + url.QueryEscape(awkwardValue)}}, nil, false)
		resp.Body = http.NoBody
		if err := ScrubResponse(resp, entries); err != nil {
			t.Fatal(err)
		}
		if got := resp.Header.Get("Location"); got != "/x?t="+phAwkward {
			t.Fatalf("Location is %q", got)
		}
	})
}

// TestNewScrubberNeedles checks the forms are deduplicated and that a value's own text keeps its placeholder where
// it is another value's escaped form.
func TestNewScrubberNeedles(t *testing.T) {
	plain := newScrubber([]Entry{{Placeholder: phGitHub, Value: githubValue}})
	if len(plain.needles) != 1 {
		t.Fatalf("a value needing no escaping has %d needles, want 1", len(plain.needles))
	}
	spaced := Entry{Placeholder: phGitHub, Value: "a b"}
	plus := Entry{Placeholder: phNPM, Value: "a+b"}
	sc := newScrubber([]Entry{spaced, plus})
	if out, _ := sc.replace([]byte("a+b|a b|a%20b")); string(out) != phNPM+"|"+phGitHub+"|"+phGitHub {
		t.Fatalf("got %q", out)
	}
	for i, n := range sc.needles {
		if i > 0 && len(n) > len(sc.needles[i-1]) {
			t.Fatalf("the needles aren't longest first")
		}
	}
}

// TestRelayScrubsEscapedEchoes checks the WebSocket downlink catches the escaped forms too, compressed or not.
func TestRelayScrubsEscapedEchoes(t *testing.T) {
	store := awkwardStore()
	entries, err := store.Values(context.Background(), "sbx-1")
	if err != nil {
		t.Fatal(err)
	}
	marshalled, err := json.Marshal(map[string]string{"t": awkwardValue})
	if err != nil {
		t.Fatal(err)
	}
	echo := string(marshalled) + " " + url.QueryEscape(awkwardValue) + " " + url.PathEscape(awkwardValue) + " " + jsonEscape(awkwardValue)
	want := `{"t":"` + phAwkward + `"} ` + phAwkward + " " + phAwkward + " " + phAwkward

	t.Run("plain", func(t *testing.T) {
		h := startRelayWith(t, Extensions{}, store, entries)
		h.fromServer(t, encodeFrame(true, false, opText, []byte(echo), false))
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opText, want})
		h.finish(t)
	})

	t.Run("permessage-deflate, fragmented", func(t *testing.T) {
		h := startRelayWith(t, Extensions{Deflate: true}, store, entries)
		compressed := newCompressor(t).message(t, echo)
		h.fromServer(t,
			encodeFrame(false, true, opText, compressed[:7], false),
			encodeFrame(true, false, opContinuation, compressed[7:], false),
		)
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opText, want})
		h.finish(t)
	})

	t.Run("a ping", func(t *testing.T) {
		h := startRelayWith(t, Extensions{}, store, entries)
		h.fromServer(t, encodeFrame(true, false, opPing, []byte("p "+url.QueryEscape(awkwardValue)), false))
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opPing, "p " + phAwkward})
		h.finish(t)
	})
}
