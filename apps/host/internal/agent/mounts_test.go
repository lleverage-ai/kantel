package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A tier with no mounts (the isolate tier, or a microVM host with them off) refuses a create that names any, rather
// than make a sandbox without them; and a refresh of a sandbox there is refused the same way.
func TestMountsRefusedWhereUnsupported(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_1", Mounts: []proto.Mount{
		{Path: "/mnt/a", Kind: proto.MountBucket, BucketSourceID: "bks_1"},
	}})
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("create with mounts: %v (want unsupported)", err)
	}
	if len(tier.running) != 0 {
		t.Error("a sandbox was made anyway")
	}
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_2"}); err != nil {
		t.Fatalf("create without mounts: %v", err)
	}
	err = call(t, h, proto.MethodMountsRefresh, proto.MountsRefreshParams{SandboxID: "sbx_2"})
	if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Errorf("refresh: %v (want unsupported)", err)
	}
	if slices.Contains(h.facts.Features, proto.FeatureBucketMounts) {
		t.Error("the feature is claimed")
	}
}

// A bucket source's endpoint is reached only where the egress proxy may go: never the host's loopback, its LAN or a
// metadata service, unless the operator allows the range (a LAN MinIO).
func TestStoreClientRefusesPrivateEndpoints(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "host secret") }))
	defer srv.Close()
	deny := egress.Destinations{Local: func() []netip.Prefix { return nil }}
	if resp, err := storeClient(deny).Get(srv.URL); err == nil {
		resp.Body.Close()
		t.Fatal("reached the host's loopback")
	} else if !errors.Is(err, egress.ErrDestination) {
		t.Errorf("refusal: %v", err)
	}
	allow := egress.Destinations{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}, Local: func() []netip.Prefix { return nil }}
	resp, err := storeClient(allow).Get(srv.URL)
	if err != nil {
		t.Fatalf("an allowed range: %v", err)
	}
	resp.Body.Close()
}

// bucket.fetch's answer is decoded as lane A's HostBucketSource: credentials nested, either kind.
func TestResolveBucketDecodesHostBucketSource(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	var asked proto.BucketResolveParams
	h.callKantel = func(_ context.Context, method string, params any) (json.RawMessage, error) {
		if method != "bucket.fetch" {
			t.Errorf("method %s", method)
		}
		asked = params.(proto.BucketResolveParams)
		return json.RawMessage(`{"id":"bks_1","provider":"gcs","bucket":"b","credentials":{"serviceAccountKey":"{}"}}`), nil
	}
	src, err := h.resolveBucket(context.Background(), "sbx_1", "bks_1")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(asked)
	if string(raw) != `{"sandboxId":"sbx_1","bucketSourceId":"bks_1"}` {
		t.Errorf("params %s", raw)
	}
	if src.Provider != "gcs" || src.Credentials == nil || src.Credentials.ServiceAccountKey != "{}" {
		t.Errorf("source %+v", src)
	}
	h.callKantel = func(context.Context, string, any) (json.RawMessage, error) {
		return json.RawMessage(`"not an object, with a secret"`), nil
	}
	if _, err := h.resolveBucket(context.Background(), "sbx_1", "bks_1"); err == nil || len(err.Error()) > 80 {
		t.Errorf("a bad answer: %v", err)
	}
}

// The key a host signs mounted object versions with is made once and kept, so an adopted guest's open files still
// read after a restart; only the host can read it.
func TestMountProofKeyIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "root", "mount-proof.key")
	first, err := mountProofKey(path)
	if err != nil || len(first) != 32 {
		t.Fatalf("%d bytes, %v", len(first), err)
	}
	again, err := mountProofKey(path)
	if err != nil || !bytes.Equal(first, again) {
		t.Fatalf("a second start made another key (%v)", err)
	}
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("the key file: %v %v", st.Mode(), err)
	}
}
