package protect

import (
	"io"
	"net/http"
)

// ScrubResponse turns every protected value in resp back into its placeholder, so a bound API that echoes a value
// (a gist's body, a reflected header, an error quoting the request) never puts the real value into the sandbox. It
// rewrites the header values now and the body (and trailers) as it is read, in constant memory: only the longest
// value less one byte is held back between reads.
//
// The body is read as Go gives it (de-chunked). A gzip or deflate body is decoded and sent on uncompressed, so
// Content-Encoding and Content-Length go and the length is unknown (chunked); an identity body's length changes too.
// A body in any other Content-Encoding (br, zstd, a chain) passes through untouched: this package can't see into it.
// Empty values are ignored.
func ScrubResponse(resp *http.Response, entries []Entry) error {
	sc := newScrubber(entries)
	if resp == nil || sc == nil {
		return nil
	}
	sc.header(resp.Header)
	if resp.Body == nil || resp.Body == http.NoBody {
		return nil
	}
	coding, ok := contentCoding(resp.Header)
	if !ok {
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
