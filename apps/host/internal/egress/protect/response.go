package protect

import (
	"io"
	"net/http"
	"strconv"
	"strings"
)

// ScrubResponse turns every protected value in resp back into its placeholder, so a bound API that echoes a value
// (a gist's body, a reflected header, an error quoting the request) never puts the real value into the sandbox. A
// value is found as it was sent and escaped, by any encoder, up to two layers deep (percent-escapes, JSON's and
// HTML's; see scrubber). It rewrites the header values now and the body (and trailers) as it is read, in constant
// memory: only text from where a match has begun but not yet ended is held back between reads.
//
// It can't see a value the API transforms otherwise (base64, a hash, its own encryption): binding a value only to the
// hosts that should have it is the protection, and scrubbing keeps an echo from undoing it.
//
// The body is read as Go gives it (de-chunked). A gzip or deflate body is decoded and sent on uncompressed, so
// Content-Encoding and Content-Length go and the length is unknown (chunked); an identity body's length changes too.
// A body in any other Content-Encoding (br, zstd, a chain) can't be searched, so it is refused with a *Refusal
// (CodeUnreadableResponse) and resp is left as it came: the caller closes its body and answers 502 instead of passing
// it on. LimitAcceptEncoding, on the request, makes that rare. Empty values are ignored, and with none to scrub resp
// passes through unchanged.
func ScrubResponse(resp *http.Response, entries []Entry) error {
	sc := newScrubber(entries)
	if resp == nil || sc == nil {
		return nil
	}
	hasBody := resp.Body != nil && resp.Body != http.NoBody
	coding, ok := contentCoding(resp.Header)
	if hasBody && !ok {
		// The coding's name is the server's text: scrubbed too, in case it echoes a value even there.
		named, _ := sc.replace([]byte(strings.Join(resp.Header.Values("Content-Encoding"), ", ")))
		return &Refusal{
			Code:    CodeUnreadableResponse,
			Message: "a response in Content-Encoding " + strconv.Quote(string(named)) + " can't be searched for protected values, so it wasn't passed on",
		}
	}
	sc.header(resp.Header)
	if !hasBody {
		return nil
	}
	orig := resp.Body
	var src io.Reader = orig
	if coding != "" {
		src = &lazyDecoder{coding: coding, src: orig}
		resp.Header.Del("Content-Encoding")
	}
	st := newStream(src, orig, sc.step)
	st.onEOF = func() { sc.header(resp.Trailer) }
	resp.Body = st
	resp.ContentLength = -1
	resp.Header.Del("Content-Length")
	if resp.ProtoAtLeast(1, 1) {
		resp.TransferEncoding = []string{"chunked"}
	}
	return nil
}
