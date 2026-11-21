package mounts

// A manifest mount against a real S3-compatible store (MinIO), the host's side end to end without a VM:
//
//	KANTEL_TEST_S3=http://127.0.0.1:9000 KANTEL_TEST_S3_KEY=… KANTEL_TEST_S3_SECRET=… \
//		go test -run TestManifestMountOnAStore ./internal/mounts/
//
// apps/host/test/manifest-mounts.sh runs it beside a MinIO of its own. Skipped without KANTEL_TEST_S3.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// countingTransport counts the requests for each object key it carries.
type countingTransport struct {
	mu   sync.Mutex
	gets map[string]int
}

func (c *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodGet {
		c.mu.Lock()
		c.gets[r.URL.Path]++
		c.mu.Unlock()
	}
	return http.DefaultTransport.RoundTrip(r)
}

func (c *countingTransport) count(suffix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for p, v := range c.gets {
		if strings.HasSuffix(p, suffix) {
			n += v
		}
	}
	return n
}

func TestManifestMountOnAStore(t *testing.T) {
	endpoint := os.Getenv("KANTEL_TEST_S3")
	key, secret := os.Getenv("KANTEL_TEST_S3_KEY"), os.Getenv("KANTEL_TEST_S3_SECRET")
	if endpoint == "" || key == "" || secret == "" {
		t.Skip("needs KANTEL_TEST_S3, KANTEL_TEST_S3_KEY and KANTEL_TEST_S3_SECRET (an S3-compatible store)")
	}
	ctx := context.Background()
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	bucketName := "kantel-manifest-" + hex.EncodeToString(suffix)
	admin, err := bucket.NewClient(bucket.Source{Provider: "s3", Bucket: bucketName, Endpoint: endpoint, Credentials: bucket.Credentials{AccessKeyID: key, SecretAccessKey: secret}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.MakeBucket(ctx); err != nil {
		t.Fatal(err)
	}
	large := strings.Repeat("0123456789abcdef", int(3*ChunkSize/16))
	put := func(k, v string) string {
		t.Helper()
		if err := admin.Put(ctx, k, []byte(v)); err != nil {
			t.Fatal(err)
		}
		objs, _, err := admin.List(ctx, k, 0)
		if err != nil || len(objs) != 1 {
			t.Fatalf("listing %s: %v %v", k, objs, err)
		}
		return objs[0].ETag
	}
	entries := []ManifestFileEntry{
		{Path: "project/readme.md", Key: "blobs/r1", Size: 6, ETag: put("blobs/r1", "readme")},
		{Path: "project/data/large.bin", Key: "blobs/l1", Size: int64(len(large)), ETag: put("blobs/l1", large)},
		{Path: "skills/s/SKILL.md", Key: "blobs/s1", Size: 5, ETag: put("blobs/s1", "skill")},
		{Path: "project/changes.txt", Key: "blobs/c1", Size: 6, ETag: put("blobs/c1", "before")},
	}
	put("blobs/secret", "not for this sandbox")
	raw, digest := manifestBytes(t, entries...)
	put("manifests/session.json", raw)

	transport := &countingTransport{gets: map[string]int{}}
	cache, err := OpenCache(t.TempDir(), 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	now := time.Now()
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	expires := map[string]time.Time{"bks_a": now.Add(10 * time.Minute), "bks_b": now.Add(10 * time.Minute)}
	var resolves atomic.Int64
	m := New(Config{Cache: cache, HTTP: &http.Client{Transport: transport}, Resolve: func(_ context.Context, _, id string) (proto.BucketSource, error) {
		resolves.Add(1)
		mu.Lock()
		exp, ok := expires[id]
		mu.Unlock()
		if !ok {
			return proto.BucketSource{}, &proto.Error{Code: proto.ErrNotFound, Message: "no such source"}
		}
		return proto.BucketSource{ID: id, Provider: "s3", Bucket: bucketName, Endpoint: endpoint,
			Credentials: &proto.BucketCredentials{AccessKeyID: key, SecretAccessKey: secret, ExpiresAt: exp.UnixMilli()}}, nil
	}})
	m.clock, m.resolveBackoff = clock, 0
	mount := func(sandboxID, sourceID string) http.Handler {
		s := m.Sandbox(sandboxID, []proto.Mount{{Path: "/workspace/files", Kind: proto.MountManifest, BucketSourceID: sourceID, ManifestKey: "manifests/session.json", Digest: digest}})
		s.Load(ctx)
		s.Applied([]guest.MountResult{{Path: "/workspace/files"}}, nil)
		if st := s.Status(); st[0].State != proto.MountReady || st[0].Objects != len(entries) {
			t.Fatalf("%s: status %+v", sandboxID, st)
		}
		return s.handler()
	}
	h := mount("sbx_a", "bks_a")
	shown := manifestOf(t, h)
	var files []string
	for p, e := range shown {
		if !e.Dir {
			files = append(files, p)
		}
	}
	if len(files) != len(entries) {
		t.Fatalf("files %v", files)
	}
	if _, ok := shown["blobs/secret"]; ok {
		t.Fatal("an object the manifest doesn't list is shown")
	}

	// Exactly its files, each from its own object.
	if rec := readRange(h, shown["project/readme.md"], "bytes=0-5"); rec.Body.String() != "readme" {
		t.Fatalf("readme: %d %q", rec.Code, rec.Body.String())
	}
	// The first read of 4 KiB of a 24 MiB file: one ranged GET of that file, nothing else.
	others := transport.count("/blobs/s1") + transport.count("/blobs/c1")
	if rec := readRange(h, shown["project/data/large.bin"], "bytes=100-4195"); rec.Code != 200 || rec.Body.String() != large[100:4196] {
		t.Fatalf("large.bin: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if n := transport.count("/blobs/l1"); n != 1 {
		t.Errorf("large.bin: %d GETs for its first 4 KiB (want 1)", n)
	}
	if transport.count("/blobs/s1")+transport.count("/blobs/c1") != others {
		t.Error("reading one file fetched another")
	}

	// A changed object is never served under its old entry.
	put("blobs/c1", "after!")
	if rec := readRange(h, shown["project/changes.txt"], "bytes=0-5"); rec.Code != http.StatusGone {
		t.Errorf("changed object: %d %q", rec.Code, rec.Body.String())
	}

	// Expired and not refreshed: a clean error, no request; refreshed: the read works.
	mu.Lock()
	now = now.Add(11 * time.Minute)
	mu.Unlock()
	before := transport.count("/blobs/s1")
	if rec := readRange(h, shown["skills/s/SKILL.md"], "bytes=0-4"); rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "expired") {
		t.Errorf("expired: %d %q", rec.Code, rec.Body.String())
	}
	if transport.count("/blobs/s1") != before {
		t.Error("a request with expired credentials")
	}
	mu.Lock()
	expires["bks_a"], expires["bks_b"] = now.Add(10*time.Minute), now.Add(10*time.Minute)
	mu.Unlock()
	if rec := readRange(h, shown["skills/s/SKILL.md"], "bytes=0-4"); rec.Code != 200 || rec.Body.String() != "skill" {
		t.Errorf("refreshed: %d %q", rec.Code, rec.Body.String())
	}

	// Another account's source, the same credentials: its own fetch, not this one's cache.
	hb := mount("sbx_b", "bks_b")
	before = transport.count("/blobs/r1")
	if rec := readRange(hb, manifestOf(t, hb)["project/readme.md"], "bytes=0-5"); rec.Body.String() != "readme" {
		t.Fatalf("B's readme: %d %q", rec.Code, rec.Body.String())
	}
	if transport.count("/blobs/r1") != before+1 {
		t.Error("another account's mount read this one's cached bytes")
	}
	// The same source's other sandbox: from the cache.
	ha2 := mount("sbx_a2", "bks_a")
	before = transport.count("/blobs/r1")
	if rec := readRange(ha2, manifestOf(t, ha2)["project/readme.md"], "bytes=0-5"); rec.Body.String() != "readme" {
		t.Fatalf("A2's readme: %d %q", rec.Code, rec.Body.String())
	}
	if transport.count("/blobs/r1") != before {
		t.Error("the same source's sandbox didn't share the cache")
	}
}
