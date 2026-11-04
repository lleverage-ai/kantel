package bucket

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// AWS's own example (Signature Version 4, "GET Object" with a range): the signature must be theirs.
func TestSignMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	creds := Credentials{AccessKeyID: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}
	sign(req, creds, "us-east-1", "s3", time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("authorization:\n got %s\nwant %s", got, want)
	}
}

func TestEncodingIsWhatIsSigned(t *testing.T) {
	c, err := NewClient(Source{Provider: "s3", Bucket: "b", Endpoint: "http://store:9000"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	u := c.objectURL("dir/a b+c~ü.txt", nil)
	if got := u.EscapedPath(); got != "/b/dir/a%20b%2Bc~%C3%BC.txt" {
		t.Errorf("path %s", got)
	}
	if got := c.objectURL("", url.Values{"prefix": {"a b/"}, "list-type": {"2"}}).RawQuery; got != "list-type=2&prefix=a%20b%2F" {
		t.Errorf("query %s", got)
	}
	aws, _ := NewClient(Source{Provider: "s3", Bucket: "mine", Region: "eu-west-1"}, nil)
	if got := aws.objectURL("k", nil).String(); got != "https://mine.s3.eu-west-1.amazonaws.com/k" {
		t.Errorf("AWS URL %s", got)
	}
	// A dotted name as host labels isn't covered by AWS's wildcard certificate: path-style on the regional endpoint.
	dotted, _ := NewClient(Source{Provider: "s3", Bucket: "company.data", Region: "eu-west-1"}, nil)
	if got := dotted.objectURL("k", nil).String(); got != "https://s3.eu-west-1.amazonaws.com/company.data/k" {
		t.Errorf("a dotted bucket's AWS URL %s", got)
	}
	gcs, _ := NewClient(Source{Provider: "gcs", Bucket: "g"}, nil)
	if got := gcs.objectURL("k", nil).String(); got != "https://storage.googleapis.com/g/k" {
		t.Errorf("GCS URL %s", got)
	}
	for _, bad := range []Source{
		{Provider: "s3"}, {Provider: "s3", Bucket: "a/b"}, {Provider: "azure", Bucket: "b"},
		{Provider: "s3", Bucket: "b", Endpoint: "ftp://x"}, {Provider: "s3", Bucket: "b", Endpoint: "http://u:p@x"},
		{Provider: "s3", Bucket: "b", ServiceAccountKey: "{}"},
	} {
		if _, err := NewClient(bad, nil); err == nil {
			t.Errorf("%+v: no error", bad)
		}
	}
}

// fakeStore is just enough S3: ListObjectsV2 in pages, ranged GETs with If-Match, and a refusal for other keys.
type fakeStore struct {
	objects map[string]string
	etags   map[string]string
	page    int
	lists   atomic.Int64
	auth    func(r *http.Request) bool
	// ignoreRange answers every read with the whole object (200), as a store or proxy that drops Range does.
	ignoreRange bool
	// wrongRange answers a range one byte later than the one asked for.
	wrongRange bool
}

func (s *fakeStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.auth != nil && !s.auth(r) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/b/")
	if r.URL.Query().Get("list-type") == "2" {
		s.lists.Add(1)
		prefix := r.URL.Query().Get("prefix")
		var keys []string
		for k := range s.objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		start, _ := strconv.Atoi(r.URL.Query().Get("continuation-token"))
		end := min(start+s.page, len(keys))
		fmt.Fprint(w, "<ListBucketResult>")
		for _, k := range keys[start:end] {
			fmt.Fprintf(w, "<Contents><Key>%s</Key><Size>%d</Size><LastModified>2026-11-04T10:00:00.000Z</LastModified><ETag>&quot;%s&quot;</ETag></Contents>", k, len(s.objects[k]), s.etags[k])
		}
		if end < len(keys) {
			fmt.Fprintf(w, "<IsTruncated>true</IsTruncated><NextContinuationToken>%d</NextContinuationToken>", end)
		} else {
			fmt.Fprint(w, "<IsTruncated>false</IsTruncated>")
		}
		fmt.Fprint(w, "</ListBucketResult>")
		return
	}
	body, ok := s.objects[key]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
		return
	}
	if m := r.Header.Get("If-Match"); m != "" && m != `"`+s.etags[key]+`"` {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	var from, to int
	if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &from, &to); err == nil && !s.ignoreRange {
		if s.wrongRange {
			from, to = from+1, to+1
		}
		to = min(to, len(body)-1)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, len(body)))
		w.WriteHeader(http.StatusPartialContent)
		io.WriteString(w, body[from:to+1])
		return
	}
	io.WriteString(w, body)
}

func TestListAndGet(t *testing.T) {
	store := &fakeStore{page: 2, objects: map[string]string{}, etags: map[string]string{}}
	for i := range 5 {
		k := fmt.Sprintf("p/f%d", i)
		store.objects[k], store.etags[k] = fmt.Sprintf("content %d", i), fmt.Sprintf("e%d", i)
	}
	store.objects["other/x"], store.etags["other/x"] = "x", "ex"
	const secret = "wJalrXUtnFEMI-the-secret"
	store.auth = func(r *http.Request) bool {
		return strings.Contains(r.Header.Get("Authorization"), "Credential=AKID/") && r.Header.Get("x-amz-content-sha256") != ""
	}
	srv := httptest.NewServer(store)
	defer srv.Close()
	c, err := NewClient(Source{Provider: "s3", Bucket: "b", Endpoint: srv.URL, Credentials: Credentials{AccessKeyID: "AKID", SecretAccessKey: secret}}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	objs, pages, err := c.List(ctx, "p/", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 5 || pages != 3 || store.lists.Load() != 3 {
		t.Fatalf("listed %d objects in %d pages (%d requests)", len(objs), pages, store.lists.Load())
	}
	if objs[0].ETag != "e0" || objs[0].Size != 9 || objs[0].LastModified.IsZero() {
		t.Errorf("object %+v", objs[0])
	}
	if _, _, err := c.List(ctx, "p/", 3); err == nil {
		t.Error("a listing over the limit: no error")
	}
	body, err := c.Get(ctx, "p/f1", "e1", 2, 4)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(body)
	body.Close()
	if string(got) != "nten" {
		t.Errorf("range: %q", got)
	}
	// The final part of an object, shorter than asked for, is its end.
	if body, err := c.Get(ctx, "p/f1", "e1", 6, 10); err != nil {
		t.Errorf("the object's end: %v", err)
	} else {
		got, _ := io.ReadAll(body)
		body.Close()
		if string(got) != "t 1" {
			t.Errorf("the object's end: %q", got)
		}
	}
	// A store that ignores Range, or answers another one, isn't taken for the bytes asked for.
	store.ignoreRange = true
	if _, err := c.Get(ctx, "p/f1", "e1", 2, 4); err == nil {
		t.Error("a whole object answered for a range from byte 2: no error")
	}
	if body, err := c.Get(ctx, "p/f1", "e1", 0, 4); err != nil {
		t.Errorf("a whole object answered for a range from byte 0: %v", err)
	} else {
		body.Close()
	}
	store.ignoreRange, store.wrongRange = false, true
	if _, err := c.Get(ctx, "p/f1", "e1", 2, 4); err == nil {
		t.Error("another range than the one asked for: no error")
	}
	store.wrongRange = false
	if _, err := c.Get(ctx, "p/f1", "stale", 0, 4); !errors.Is(err, ErrStale) {
		t.Errorf("a changed object: %v", err)
	}
	if _, err := c.Get(ctx, "p/nope", "", 0, 4); !errors.Is(err, ErrNotFound) {
		t.Errorf("a missing object: %v", err)
	}
	bad, _ := NewClient(Source{Provider: "s3", Bucket: "b", Endpoint: srv.URL, Credentials: Credentials{AccessKeyID: "OTHER", SecretAccessKey: secret}}, srv.Client())
	_, _, err = bad.List(ctx, "p/", 0)
	if !errors.Is(err, ErrDenied) {
		t.Errorf("refused credentials: %v", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Errorf("the error quotes the secret: %v", err)
	}
}

func TestServiceAccountToken(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: must(x509.MarshalPKCS8PrivateKey(key))})
	var tokens atomic.Int64
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			_ = r.ParseForm()
			parts := strings.Split(r.Form.Get("assertion"), ".")
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" || len(parts) != 3 {
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			tokens.Add(1)
			json.NewEncoder(w).Encode(map[string]any{"access_token": "tok-" + strconv.FormatInt(tokens.Load(), 10), "expires_in": 3600})
		case r.Header.Get("Authorization") == "Bearer tok-1":
			io.WriteString(w, "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer srv.Close()
	sa, _ := json.Marshal(map[string]string{"type": "service_account", "client_email": "reader@p.iam.gserviceaccount.com", "private_key": string(pemKey), "token_uri": srv.URL + "/token"})
	c, err := NewClient(Source{Provider: "gcs", Bucket: "b", Endpoint: srv.URL, ServiceAccountKey: string(sa)}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, _, err := c.List(context.Background(), "", 0); err != nil {
			t.Fatal(err)
		}
	}
	if tokens.Load() != 1 {
		t.Errorf("%d tokens for three listings (want one, kept)", tokens.Load())
	}
	for _, bad := range []string{"not json", `{"type":"authorized_user"}`, `{"client_email":"x","private_key":"nope"}`} {
		if _, err := NewClient(Source{Provider: "gcs", Bucket: "b", ServiceAccountKey: bad}, nil); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
