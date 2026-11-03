package protect

import (
	"bufio"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"io"
	"net/http"
	"strings"
)

// contentCoding answers a message's one Content-Encoding this package can see through: "" for identity, "gzip" or
// "deflate". False is anything else (br, zstd, or a chain of several), which passes through untouched.
func contentCoding(h http.Header) (string, bool) {
	var codings []string
	for _, v := range h.Values("Content-Encoding") {
		for _, c := range strings.Split(v, ",") {
			c = strings.ToLower(strings.TrimSpace(c))
			if c != "" && c != "identity" {
				codings = append(codings, c)
			}
		}
	}
	switch {
	case len(codings) == 0:
		return "", true
	case len(codings) > 1:
		return "", false
	}
	switch codings[0] {
	case "gzip", "x-gzip":
		return "gzip", true
	case "deflate":
		return "deflate", true
	}
	return "", false
}

// HTTP's "deflate" is zlib (RFC 9110), but some clients send raw deflate under the name; the first two bytes tell
// which.
func isZlibHeader(b []byte) bool {
	return len(b) >= 2 && b[0]&0x0f == 8 && (uint16(b[0])<<8|uint16(b[1]))%31 == 0
}

func deflateFormat(b []byte) string {
	if isZlibHeader(b) {
		return "zlib"
	}
	return "flate"
}

// openDecoder decodes src: coding is "gzip", "zlib", "flate", or "deflate" (zlib or raw, decided by its header).
func openDecoder(coding string, src io.Reader) (io.Reader, error) {
	switch coding {
	case "gzip":
		zr, err := gzip.NewReader(src)
		if err != nil {
			return nil, err
		}
		return zr, nil
	case "zlib":
		zr, err := zlib.NewReader(src)
		if err != nil {
			return nil, err
		}
		return zr, nil
	case "flate":
		return flate.NewReader(src), nil
	case "deflate":
		br := bufio.NewReader(src)
		head, err := br.Peek(2)
		if err != nil {
			if errors.Is(err, io.EOF) && len(head) > 0 {
				err = io.ErrUnexpectedEOF
			}
			return nil, err
		}
		return openDecoder(deflateFormat(head), br)
	}
	return src, nil
}

// decodeAll decodes a whole body, stopping one byte past MaxBufferedBody so a small body that inflates to a huge
// one can't fill the host's memory.
func decodeAll(coding string, raw []byte) ([]byte, error) {
	r, err := openDecoder(coding, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(r, MaxBufferedBody+1))
}

// encodeAll encodes plain as coding ("gzip", "zlib" or "flate"); any other coding answers plain as it is.
func encodeAll(coding string, plain []byte) ([]byte, error) {
	var buf bytes.Buffer
	var w io.WriteCloser
	switch coding {
	case "gzip":
		w = gzip.NewWriter(&buf)
	case "zlib":
		w = zlib.NewWriter(&buf)
	case "flate":
		fw, err := flate.NewWriter(&buf, flate.DefaultCompression)
		if err != nil {
			return nil, err
		}
		w = fw
	default:
		return plain, nil
	}
	if _, err := w.Write(plain); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// lazyDecoder opens its decoder on the first Read rather than when it is made: gzip reads its header at once, which
// would block on the network (or fail on an empty body) before anyone asked for the body.
type lazyDecoder struct {
	coding string
	src    io.Reader
	r      io.Reader
	err    error
}

func (l *lazyDecoder) Read(p []byte) (int, error) {
	if l.r == nil && l.err == nil {
		l.r, l.err = openDecoder(l.coding, l.src)
	}
	if l.err != nil {
		return 0, l.err
	}
	return l.r.Read(p)
}

type readCloser struct {
	io.Reader
	io.Closer
}
