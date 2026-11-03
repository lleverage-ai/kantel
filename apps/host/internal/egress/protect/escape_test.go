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

// TestScrubberPrefersAValuesOwnText checks a value's own text keeps its placeholder where it is another value's
// escaped form, and that an escaped form still finds its own value.
func TestScrubberPrefersAValuesOwnText(t *testing.T) {
	spaced := Entry{Placeholder: phGitHub, Value: "a b"}
	plus := Entry{Placeholder: phNPM, Value: "a+b"}
	for _, order := range [][]Entry{{spaced, plus}, {plus, spaced}} {
		sc := newScrubber(order)
		if out, _ := sc.replace([]byte("a+b|a b|a%20b|a%2Bb")); string(out) != phNPM+"|"+phGitHub+"|"+phGitHub+"|"+phNPM {
			t.Fatalf("got %q", out)
		}
	}
}

// TestScrubberCatchesEveryEncoder checks the echoes other encoders write than Go's: each escapes its own set of
// characters, in its own case, once or twice over. Every one must come back as the placeholder, and the text around
// it as it was.
func TestScrubberCatchesEveryEncoder(t *testing.T) {
	const v = "päss \"w/rd\"&k=1+2<\\>😀\n"
	sc := newScrubber([]Entry{{Placeholder: phGitHub, Value: v}, {Placeholder: phNPM, Value: npmValue}})
	pyJSON := `p\u00e4ss \"w/rd\"&k=1+2<\\>\ud83d\ude00\n`
	forms := map[string]string{
		"as it is":                                  v,
		"Python's json (ensure_ascii)":              pyJSON,
		"Python's json, upper-case hex":             `p\u00E4ss \"w/rd\"&k=1+2<\\>\uD83D\uDE00\n`,
		"PHP's json_encode (\\/ and \\uXXXX)":       `p\u00e4ss \"w\/rd\"&k=1+2<\\>\ud83d\ude00\n`,
		"encoding/json (HTML-escaped)":              `päss \"w/rd\"\u0026k=1+2\u003c\\\u003e😀\n`,
		"JavaScript's encodeURIComponent":           "p%C3%A4ss%20%22w%2Frd%22%26k%3D1%2B2%3C%5C%3E%F0%9F%98%80%0A",
		"lower-case percent-escapes":                "p%c3%a4ss%20%22w%2frd%22%26k%3d1%2b2%3c%5c%3e%f0%9f%98%80%0a",
		"Python's quote_plus":                       "p%C3%A4ss+%22w%2Frd%22%26k%3D1%2B2%3C%5C%3E%F0%9F%98%80%0A",
		"every byte percent-escaped":                "%70%C3%A4%73%73%20%22%77%2F%72%64%22%26%6B%3D%31%2B%32%3C%5C%3E%F0%9F%98%80%0A",
		"HTML references":                           `päss &quot;w/rd&#34;&amp;k=1+2&lt;\&gt;😀` + "\n",
		"HTML, numeric references":                  `p&#xe4;ss &#x22;w/rd&#x22;&#38;k=1+2&#60;&#92;&#62;&#x1F600;&#10;`,
		"Python's repr (\\x and \\')":               `päss \x22w/rd\x22&k=1+2<\x5c>😀\x0a`,
		"JSON inside a JSON string":                 `p\\u00e4ss \\\"w/rd\\\"&k=1+2<\\\\>\\ud83d\\ude00\\n`,
		"a percent-escaped query, quoted in JSON":   `p%C3%A4ss%20%22w%2Frd%22%26k%3D1%2B2%3C%5C%3E%F0%9F%98%80%0A`,
		"percent-escaped twice":                     "p%25C3%25A4ss%2520%2522w%252Frd%2522%2526k%253D1%252B2%253C%255C%253E%25F0%259F%2598%2580%250A",
		"JSON, then percent-escaped (a JSON query)": url.QueryEscape(pyJSON),
	}
	for name, form := range forms {
		t.Run(name, func(t *testing.T) {
			got, _ := sc.replace([]byte(`{"echo":"` + form + `","n":"` + npmValue + `"}`))
			if want := `{"echo":"` + phGitHub + `","n":"` + phNPM + `"}`; string(got) != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		})
	}

	t.Run("a near miss is left as it was", func(t *testing.T) {
		for _, text := range []string{v[:len(v)-1], pyJSON[:len(pyJSON)-2], "%", "\\", "&", "&amp", "%2", "\\u00", "+" + npmValue[1:]} {
			if got, changed := sc.replace([]byte(text)); changed {
				t.Fatalf("%q became %q", text, got)
			}
		}
	})
}

// TestScrubberStreams checks an escaped echo split at every byte is still caught, and that a stream holds back only
// what could still be a match: text with nothing like a value passes straight through.
func TestScrubberStreams(t *testing.T) {
	sc := newScrubber([]Entry{{Placeholder: phAwkward, Value: awkwardValue}})
	marshalled, err := json.Marshal(map[string]string{"t": awkwardValue})
	if err != nil {
		t.Fatal(err)
	}
	body := "head " + string(marshalled) + " " + url.QueryEscape(awkwardValue) + " tail"
	want := `head {"t":"` + phAwkward + `"} ` + phAwkward + " tail"
	for cut := 1; cut < len(body); cut++ {
		src := io.MultiReader(strings.NewReader(body[:cut]), strings.NewReader(body[cut:]))
		got, err := io.ReadAll(newStream(oneByteReader{src}, nil, sc.step))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("cut at %d: got %q", cut, got)
		}
	}

	plain := []byte("data: {\"delta\":\"hello\"}\n\n")
	out, used, _ := sc.step(nil, plain, false)
	if used != len(plain) || !bytes.Equal(out, plain) {
		t.Fatalf("an event with nothing like the value was held back: used %d of %d", used, len(plain))
	}
	partial := []byte("data: " + awkwardValue[:4])
	if _, used, _ := sc.step(nil, partial, false); used != len("data: ") {
		t.Fatalf("used %d, want only what comes before a possible match (%d)", used, len("data: "))
	}
}

// oneByteReader reads at most one byte at a time.
type oneByteReader struct{ r io.Reader }

func (o oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return o.r.Read(p)
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
