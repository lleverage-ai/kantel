package bucket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// emptySHA256 is the SHA-256 of an empty body: every request this package makes is a GET.
const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// Credentials are an access key for AWS Signature Version 4 (an HMAC key for GCS's XML API). Empty signs nothing.
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

func (c Credentials) empty() bool { return c.AccessKeyID == "" || c.SecretAccessKey == "" }

// sign adds AWS Signature Version 4 headers to a request (bodiless unless it sets x-amz-content-sha256): the request's URL must already be what goes on
// the wire (its EscapedPath and RawQuery are what is signed). The Range header, when set, is signed too.
func sign(req *http.Request, creds Credentials, region, service string, now time.Time) {
	now = now.UTC()
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	// A request with a body says how it is hashed (UNSIGNED-PAYLOAD); a GET has none.
	payload := req.Header.Get("x-amz-content-sha256")
	if payload == "" {
		payload = emptySHA256
		req.Header.Set("x-amz-content-sha256", payload)
	}
	if creds.SessionToken != "" {
		req.Header.Set("x-amz-security-token", creds.SessionToken)
	}
	headers := map[string]string{"host": req.URL.Host}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if lower == "range" || strings.HasPrefix(lower, "x-amz-") || lower == "if-match" {
			headers[lower] = strings.TrimSpace(strings.Join(values, ","))
		}
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, name := range names {
		canonHeaders.WriteString(name + ":" + headers[name] + "\n")
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join([]string{
		req.Method,
		canonicalPath(req.URL),
		canonicalQuery(req.URL.Query()),
		canonHeaders.String(),
		signed,
		payload,
	}, "\n")
	scope := day + "/" + region + "/" + service + "/aws4_request"
	hashed := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(hashed[:])
	key := hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+creds.AccessKeyID+"/"+scope+", SignedHeaders="+signed+", Signature="+signature)
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// canonicalPath is the URL's path as sent: S3 signs it encoded once, as it is on the wire.
func canonicalPath(u *url.URL) string {
	p := u.EscapedPath()
	if p == "" {
		return "/"
	}
	return p
}

// canonicalQuery is the query sorted by name, each name and value encoded as SigV4 wants (RFC 3986, %20 for space).
func canonicalQuery(q url.Values) string {
	names := make([]string, 0, len(q))
	for name := range q {
		names = append(names, name)
	}
	sort.Strings(names)
	var parts []string
	for _, name := range names {
		values := append([]string{}, q[name]...)
		sort.Strings(values)
		for _, v := range values {
			parts = append(parts, uriEncode(name, true)+"="+uriEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

// uriEncode encodes every byte but the unreserved ones (and '/' when slash is false), as SigV4 and S3 want.
func uriEncode(s string, slash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !slash:
			b.WriteByte(c)
		default:
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}
