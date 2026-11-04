// Package bucket reads S3-compatible object stores for the host's bucket mounts: one paginated ListObjectsV2 per
// manifest, and ranged GETs of an object's bytes, signed with AWS Signature Version 4. Google Cloud Storage is read
// the same way, through its S3-compatible XML API: signed with an HMAC key, or with a service account's key's OAuth
// token (read-only scope) as a bearer.
//
// Credentials stay in the host: nothing here puts them in an error or a log.
package bucket

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Providers.
const (
	ProviderS3  = "s3"
	ProviderGCS = "gcs"
)

// GCSEndpoint is Cloud Storage's XML API, which speaks S3's protocol to HMAC keys.
const GCSEndpoint = "https://storage.googleapis.com"

// Source is where a bucket is and how to sign for it.
type Source struct {
	Provider string
	Bucket   string
	// Endpoint is the store's origin (scheme and host); empty is the provider's own.
	Endpoint    string
	Region      string
	Credentials Credentials
	// ServiceAccountKey is a GCS service account's JSON key, instead of Credentials.
	ServiceAccountKey string
}

// ErrStale is an object that changed since the manifest listed it (its ETag no longer matches).
var ErrStale = errors.New("the object changed since it was listed")

// ErrDenied is the store refusing the credentials (401 or 403).
var ErrDenied = errors.New("the store refused the bucket source's credentials")

// ErrNotFound is a bucket or object that isn't there.
var ErrNotFound = errors.New("not found")

// Client reads one source.
type Client struct {
	src    Source
	base   *url.URL
	hosted bool
	region string
	http   *http.Client
	now    func() time.Time
	tokens *tokenSource
}

// NewClient checks a source and makes its client. httpClient carries the host's rules for where it may connect.
func NewClient(src Source, httpClient *http.Client) (*Client, error) {
	if src.Bucket == "" {
		return nil, errors.New("the bucket source names no bucket")
	}
	if strings.ContainsAny(src.Bucket, "/?#") {
		return nil, fmt.Errorf("bad bucket name %q", src.Bucket)
	}
	region := src.Region
	endpoint := src.Endpoint
	hosted := false
	switch src.Provider {
	case ProviderS3, "":
		if region == "" {
			region = "us-east-1"
		}
		if endpoint == "" {
			// AWS itself: virtual-hosted style, the only one every new bucket takes; except a name with a dot, which as
			// labels of the host isn't covered by AWS's certificate (*.s3.<region>.amazonaws.com), so path-style.
			endpoint = "https://s3." + region + ".amazonaws.com"
			hosted = !strings.Contains(src.Bucket, ".")
		}
	case ProviderGCS:
		if region == "" {
			region = "auto"
		}
		if endpoint == "" {
			endpoint = GCSEndpoint
		}
	default:
		return nil, fmt.Errorf("unknown bucket provider %q", src.Provider)
	}
	base, err := url.Parse(endpoint)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, fmt.Errorf("bad bucket endpoint %q", endpoint)
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("bad bucket endpoint %q: only a scheme, host and path", endpoint)
	}
	if hosted {
		base.Host = src.Bucket + "." + base.Host
	}
	base.Path = strings.TrimSuffix(base.Path, "/")
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	c := &Client{src: src, base: base, hosted: hosted, region: region, http: httpClient, now: time.Now}
	if src.ServiceAccountKey != "" {
		if src.Provider != ProviderGCS {
			return nil, errors.New("a service account key reads only a gcs bucket source")
		}
		ts, err := newTokenSource(src.ServiceAccountKey, httpClient, c.now)
		if err != nil {
			return nil, err
		}
		c.tokens = ts
	}
	return c, nil
}

// objectURL is the object's URL (the bucket's with no key), path-style unless virtual-hosted.
func (c *Client) objectURL(key string, query url.Values) *url.URL {
	u := *c.base
	path := u.Path
	if !c.hosted {
		path += "/" + c.src.Bucket
	}
	rawPath := uriEncodePath(path) + "/" + uriEncode(key, false)
	u.Path = path + "/" + key
	u.RawPath = rawPath
	if query != nil {
		// Encoded as SigV4 canonicalises it, so what is signed is what is sent.
		u.RawQuery = canonicalQuery(query)
	}
	return &u
}

func uriEncodePath(p string) string {
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = uriEncode(part, true)
	}
	return strings.Join(parts, "/")
}

func (c *Client) do(ctx context.Context, u *url.URL, header http.Header) (*http.Response, error) {
	return c.send(ctx, http.MethodGet, u, header, nil)
}

func (c *Client) send(ctx context.Context, method string, u *url.URL, header http.Header, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	// The URL as built, not as re-parsed: its encoding is what was signed.
	req.URL = u
	for k, v := range header {
		req.Header[k] = v
	}
	switch {
	case c.tokens != nil:
		token, err := c.tokens.Token(ctx)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
	case !c.src.Credentials.empty():
		sign(req, c.src.Credentials, c.region, "s3", c.now())
	}
	resp, err := c.http.Do(req)
	if err == nil && c.tokens != nil && resp.StatusCode == http.StatusUnauthorized {
		// A token revoked or expired early: the next request trades for a new one.
		c.tokens.Forget()
	}
	return resp, err
}

// statusError turns a store's refusal into an error that names no credential.
func statusError(resp *http.Response, what string) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	_ = xml.Unmarshal(body, &e)
	detail := strings.TrimSpace(e.Code)
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		if detail != "" {
			return fmt.Errorf("%s: %w (%s)", what, ErrDenied, detail)
		}
		return fmt.Errorf("%s: %w", what, ErrDenied)
	case http.StatusNotFound:
		if detail != "" {
			return fmt.Errorf("%s: %w (%s)", what, ErrNotFound, detail)
		}
		return fmt.Errorf("%s: %w", what, ErrNotFound)
	case http.StatusPreconditionFailed:
		return fmt.Errorf("%s: %w", what, ErrStale)
	}
	if detail != "" {
		return fmt.Errorf("%s: the store answered %d (%s)", what, resp.StatusCode, detail)
	}
	return fmt.Errorf("%s: the store answered %d", what, resp.StatusCode)
}

// Object is one listed object.
type Object struct {
	Key          string
	Size         int64
	LastModified time.Time
	// ETag, without its quotes.
	ETag string
	// Generation is GCS's, when it gives one.
	Generation string
}

// Version is what identifies this object's content: its generation (GCS) or its ETag.
func (o Object) Version() string {
	if o.Generation != "" {
		return "g" + o.Generation
	}
	return "e" + o.ETag
}

type listResult struct {
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
	Contents              []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag"`
		Generation   string `xml:"Generation"`
	} `xml:"Contents"`
}

// List lists every object under prefix, recursively: one ListObjectsV2 of as many pages as it takes (1000 objects
// a page), answering how many pages (requests) it took. It stops with an error once more than limit objects are
// listed.
func (c *Client) List(ctx context.Context, prefix string, limit int) ([]Object, int, error) {
	var out []Object
	token := ""
	for pages := 1; ; pages++ {
		q := url.Values{"list-type": {"2"}, "max-keys": {"1000"}}
		if prefix != "" {
			q.Set("prefix", prefix)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		u := c.objectURL("", q)
		// The bucket's URL ends in "/": "/bucket/" path-style, "/" virtual-hosted.
		resp, err := c.do(ctx, u, nil)
		if err != nil {
			return nil, pages, fmt.Errorf("list %s: %w", c.src.Bucket, err)
		}
		if resp.StatusCode != http.StatusOK {
			err := statusError(resp, "list "+c.src.Bucket)
			resp.Body.Close()
			return nil, pages, err
		}
		var page listResult
		err = xml.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, pages, fmt.Errorf("list %s: the answer isn't a listing: %w", c.src.Bucket, err)
		}
		for _, item := range page.Contents {
			modified, _ := time.Parse(time.RFC3339Nano, item.LastModified)
			out = append(out, Object{Key: item.Key, Size: item.Size, LastModified: modified, ETag: strings.Trim(item.ETag, `"`), Generation: item.Generation})
		}
		if limit > 0 && len(out) > limit {
			return nil, pages, fmt.Errorf("list %s: the prefix holds more than %d objects", c.src.Bucket, limit)
		}
		if !page.IsTruncated {
			return out, pages, nil
		}
		if page.NextContinuationToken == "" || page.NextContinuationToken == token {
			return nil, pages, fmt.Errorf("list %s: a truncated page with no continuation", c.src.Bucket)
		}
		token = page.NextContinuationToken
	}
}

// Put writes an object. The host's mounts never write (they are read-only); this is for tests and tools that fill a
// bucket to mount.
func (c *Client) Put(ctx context.Context, key string, data []byte) error {
	if key == "" {
		return errors.New("an empty object key")
	}
	header := http.Header{}
	header.Set("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
	resp, err := c.send(ctx, http.MethodPut, c.objectURL(key, nil), header, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return statusError(resp, "put "+key)
	}
	return nil
}

// MakeBucket makes the bucket (path-style stores; for tests and tools, like Put). One already there is not an error.
func (c *Client) MakeBucket(ctx context.Context) error {
	u := c.objectURL("", nil)
	u.Path, u.RawPath = strings.TrimSuffix(u.Path, "/"), strings.TrimSuffix(u.RawPath, "/")
	header := http.Header{}
	header.Set("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
	resp, err := c.send(ctx, http.MethodPut, u, header, http.NoBody)
	if err != nil {
		return fmt.Errorf("make bucket %s: %w", c.src.Bucket, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusConflict {
		return nil
	}
	return statusError(resp, "make bucket "+c.src.Bucket)
}

// checkContentRange says whether a 206's Content-Range ("bytes a-b/size") is the range asked for: from off, length
// bytes or to the object's end.
func checkContentRange(h string, off, length int64) error {
	spec, ok := strings.CutPrefix(h, "bytes ")
	rng, total, ok2 := strings.Cut(spec, "/")
	a, b, ok3 := strings.Cut(rng, "-")
	if !ok || !ok2 || !ok3 {
		return fmt.Errorf("the store answered a part with no range it names (Content-Range %q)", h)
	}
	start, err1 := strconv.ParseInt(a, 10, 64)
	end, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil || end < start {
		return fmt.Errorf("the store answered a bad range (Content-Range %q)", h)
	}
	last := off + length - 1
	if start != off || end > last {
		return fmt.Errorf("the store answered bytes %d-%d, not %d-%d", start, end, off, last)
	}
	if end < last {
		// Short: only at the object's end.
		if size, err := strconv.ParseInt(total, 10, 64); err != nil || end != size-1 {
			return fmt.Errorf("the store answered bytes %d-%d, not %d-%d", start, end, off, last)
		}
	}
	return nil
}

// Get reads length bytes of an object from off, refusing it with ErrStale when its ETag isn't etag any more.
func (c *Client) Get(ctx context.Context, key, etag string, off, length int64) (io.ReadCloser, error) {
	if key == "" {
		return nil, errors.New("an empty object key")
	}
	header := http.Header{}
	if length > 0 {
		header.Set("Range", "bytes="+strconv.FormatInt(off, 10)+"-"+strconv.FormatInt(off+length-1, 10))
	}
	if etag != "" {
		header.Set("If-Match", `"`+etag+`"`)
	}
	resp, err := c.do(ctx, c.objectURL(key, nil), header)
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	switch resp.StatusCode {
	case http.StatusOK:
		// The whole object: the range asked for only if it starts at the beginning (the caller stops at its length).
		if length > 0 && off != 0 {
			resp.Body.Close()
			return nil, fmt.Errorf("get %s: the store ignored the range and answered the whole object", key)
		}
		return resp.Body, nil
	case http.StatusPartialContent:
		if length > 0 {
			if err := checkContentRange(resp.Header.Get("Content-Range"), off, length); err != nil {
				resp.Body.Close()
				return nil, fmt.Errorf("get %s: %w", key, err)
			}
		}
		return resp.Body, nil
	case http.StatusRequestedRangeNotSatisfiable:
		resp.Body.Close()
		return io.NopCloser(strings.NewReader("")), nil
	}
	defer resp.Body.Close()
	return nil, statusError(resp, "get "+key)
}
