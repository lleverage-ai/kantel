package images

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const secret = "s3cr3t-token-value"

func headersFile(t *testing.T, content string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "image-source.headers")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

// A headers file is read only when its owner alone can read it; a bad line or a wrong mode is refused, and no error
// repeats what the file holds.
func TestReadHeaders(t *testing.T) {
	h, err := ReadHeaders(headersFile(t, "# Cloudflare Access\nCF-Access-Client-Id: id.access\n\nCF-Access-Client-Secret: "+secret+"\n", 0o600))
	if err != nil {
		t.Fatal(err)
	}
	if h.Get("Cf-Access-Client-Id") != "id.access" || h.Get("Cf-Access-Client-Secret") != secret || len(h) != 2 {
		t.Fatalf("headers %v", h)
	}
	for name, tc := range map[string]struct {
		content string
		mode    os.FileMode
		want    string
	}{
		"group-readable":  {"Authorization: Bearer " + secret, 0o640, "only its owner may read"},
		"world-readable":  {"Authorization: Bearer " + secret, 0o644, "chmod 600"},
		"group-writable":  {"Authorization: Bearer " + secret, 0o620, "only its owner may read"},
		"no colon":        {"Authorization Bearer " + secret, 0o600, "line 1 isn't"},
		"bad name":        {"Bad Name: " + secret, 0o600, "line 1 isn't"},
		"no value":        {"Authorization:", 0o600, "line 1 isn't"},
		"sets Host":       {"Host: evil.example\nAuthorization: " + secret, 0o600, "line 1 sets Host"},
		"only a comment":  {"# " + secret, 0o600, "has no headers"},
		"empty":           {"", 0o600, "has no headers"},
		"second line bad": {"Authorization: Bearer x\n" + secret, 0o600, "line 2 isn't"},
	} {
		_, err := ReadHeaders(headersFile(t, tc.content, tc.mode))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want an error saying %q", name, err, tc.want)
			continue
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("%s: the error repeats the file's content: %v", name, err)
		}
	}
	if _, err := ReadHeaders(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("a missing headers file was read")
	}
}

func TestSourceValidate(t *testing.T) {
	auth := http.Header{"Authorization": {"Bearer x"}}
	for _, tc := range []struct {
		src Source
		ok  bool
	}{
		{Source{URL: "https://images.example.com/kantel", Headers: auth}, true},
		{Source{URL: "http://127.0.0.1:8080/kantel", Headers: auth}, true},
		{Source{URL: "http://images.example.com/kantel"}, true},
		{Source{URL: "/srv/kantel-images"}, true},
		{Source{URL: "http://images.example.com/kantel", Headers: auth}, false},
		{Source{URL: "/srv/kantel-images", Headers: auth}, false},
		{Source{}, false},
		{Source{Type: "ftp", URL: "https://images.example.com"}, false},
		{Source{Type: SourceGitHubRelease, URL: "https://api.github.com/repos/acme/images", Headers: auth}, true},
		{Source{Type: SourceGitHubRelease, URL: "https://github.com/acme/images/releases"}, false},
	} {
		if err := tc.src.Validate(); (err == nil) != tc.ok {
			t.Errorf("%+v: Validate() = %v, want ok %v", tc.src, err, tc.ok)
		}
	}
}

// Origins compare as the HTTP transport resolves them: ASCII case is folded, and a host that isn't ASCII (one the
// transport would resolve by IDNA, such as a U+0130 lookalike) is no origin at all, so it never matches.
func TestOrigins(t *testing.T) {
	r := &remote{origin: originOf("https://images.private.example")}
	for raw, want := range map[string]bool{
		"https://images.private.example/kantel/channel.json": true,
		"HTTPS://Images.Private.Example/x":                   true,
		"https://images.pr\u0130vate.example/x":              false,
		"https://images.pr\u0131vate.example/x":              false,
		"https://images.private.example:8443/x":              false,
		"http://images.private.example/x":                    false,
		"https://xn--images-lookalike.example/x":             false,
		"/relative":                                          false,
	} {
		if got := r.sameOrigin(raw); got != want {
			t.Errorf("sameOrigin(%s) = %v, want %v", raw, got, want)
		}
	}
	// A source whose own host isn't ASCII is refused, and matches nothing were it used: "" is no origin.
	if err := (Source{URL: "https://images.pr\u0130vate.example", Headers: http.Header{"X-A": {"b"}}}).Validate(); err == nil {
		t.Error("a source with a Unicode host was taken")
	}
	unicode := &remote{origin: originOf("https://images.pr\u0130vate.example")}
	if unicode.sameOrigin("https://images.pr\u0130vate.example/x") || unicode.sameOrigin("https://other.example/x") {
		t.Error("a remote without an origin matched a URL")
	}
}

// Each redirect hop is checked on its own: Go copies the first request's headers onto every hop, and the source's go
// only on a hop to its own origin, not to an intermediate elsewhere nor to a lookalike of the source after it.
func TestEveryRedirectHopDropsTheSourcesHeadersOffItsOrigin(t *testing.T) {
	headers := http.Header{"Cf-Access-Client-Secret": {secret}, "Authorization": {"Bearer " + secret}}
	var third, second requests
	thirdSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		third.add(r)
		_, _ = w.Write([]byte("ok"))
	}))
	defer thirdSrv.Close()
	secondSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		second.add(r)
		http.Redirect(w, r, thirdSrv.URL+"/blob", http.StatusFound)
	}))
	defer secondSrv.Close()
	var own requests
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		own.add(r)
		if r.URL.Path == "/plain" {
			_, _ = w.Write([]byte("ok"))
			return
		}
		http.Redirect(w, r, secondSrv.URL+"/hop", http.StatusFound)
	}))
	defer src.Close()
	r := &remote{origin: originOf(src.URL), headers: headers}
	ctx := withRemote(context.Background(), r)
	for _, path := range []string{"/plain", "/redirected"} {
		in, err := httpGet(ctx, src.URL+path)
		if err != nil {
			t.Fatal(err)
		}
		in.Close()
	}
	if own.count() != 2 || !own.carried(secret) {
		t.Fatalf("the source got %d requests, with its headers: %v", own.count(), own.carried(secret))
	}
	if second.count() != 1 || second.carried(secret) || third.count() != 1 || third.carried(secret) {
		t.Fatalf("off-origin hops: %d and %d requests, headers %v and %v", second.count(), third.count(), second.carried(secret), third.carried(secret))
	}

	// A hop to a U+0130 lookalike of the source (which can't be served here): its request, as Go makes it with the
	// first request's headers, has them taken off before it goes.
	via := []*http.Request{{URL: mustURL(t, src.URL)}, {URL: mustURL(t, secondSrv.URL)}}
	for _, host := range []string{"https://images.pr\u0130vate.example/x", "HTTPS://IMAGES.PR\u0130VATE.EXAMPLE/x"} {
		lookalike := &remote{origin: originOf("https://images.private.example"), headers: headers}
		req, err := http.NewRequest(http.MethodGet, host, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = headers.Clone()
		if err := lookalike.client().CheckRedirect(req, via); err != nil {
			t.Fatal(err)
		}
		if req.Header.Get("Authorization") != "" || req.Header.Get("Cf-Access-Client-Secret") != "" {
			t.Fatalf("a redirect to %s kept the source's headers", host)
		}
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// requests records what each request a test server answered carried.
type requests struct {
	mu   sync.Mutex
	seen []http.Header
	path []string
}

func (r *requests) add(req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seen = append(r.seen, req.Header.Clone())
	r.path = append(r.path, req.URL.Path)
}

// carried says whether any request carried the secret, in any header.
func (r *requests) carried(value string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, h := range r.seen {
		for _, vs := range h {
			for _, v := range vs {
				if strings.Contains(v, value) {
					return true
				}
			}
		}
	}
	return false
}

func (r *requests) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.seen)
}

func signedUpdater(store Store, t *testing.T) *Updater {
	cosign := filepath.Join(t.TempDir(), "cosign")
	touch(t, cosign, nil)
	return &Updater{
		Store: store, Arch: "amd64", KVM: true, Log: quiet(),
		Verifier: Verifier{Key: "/etc/kantel-host/image.pub", Cosign: cosign, Log: quiet(), Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if !strings.Contains(strings.Join(args, " "), "--key /etc/kantel-host/image.pub") {
				return nil, errors.New("not checked against the configured key")
			}
			return nil, nil
		}},
	}
}

// An http source: channel.json names the version, the files are under it, and the source's header goes to its own
// origin and nowhere else, not even when a file redirects to another origin (a bucket's signed URL).
func TestAnHTTPSourceSendsItsHeadersOnlyToItsOrigin(t *testing.T) {
	dir := t.TempDir()
	release(t, filepath.Join(dir, "cft-1"), "kernel", "rootfs")
	touch(t, filepath.Join(dir, "cft-1", bundleFile), []byte("{}"))
	touch(t, filepath.Join(dir, channelFile), []byte(`{"version": "cft-1"}`))

	var elsewhere requests
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.add(r)
		http.ServeFile(w, r, filepath.Join(dir, "cft-1", "sandbox-amd64.ext4.gz"))
	}))
	defer storage.Close()
	var own requests
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		own.add(r)
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		if strings.HasSuffix(r.URL.Path, ".ext4.gz") {
			http.Redirect(w, r, storage.URL+"/signed", http.StatusFound)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, filepath.FromSlash(r.URL.Path)))
	}))
	defer src.Close()

	store := Store{Dir: t.TempDir()}
	u := signedUpdater(store, t)
	source := Source{URL: src.URL + "/", Headers: http.Header{"Authorization": {"Bearer " + secret}}}
	ctx, ch, err := source.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ch.Version != "cft-1" || ch.URL != src.URL+"/cft-1" {
		t.Fatalf("channel %+v", ch)
	}
	if err := u.Check(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if v, _ := store.Current(); v != "cft-1" {
		t.Fatalf("current = %q", v)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); string(raw) != "rootfs" {
		t.Fatalf("sandbox.ext4 = %q", raw)
	}
	if elsewhere.count() != 1 || elsewhere.carried(secret) {
		t.Fatalf("the redirect's target got %d requests, the header: %v", elsewhere.count(), elsewhere.carried(secret))
	}
	// channel.json, manifest, bundle, kernel, sandbox image.
	if own.count() != 5 {
		t.Fatalf("the source got %d requests: %v", own.count(), own.path)
	}
}

// The control plane's channel, and anything else fetched without a source's context (the installer), carries no
// credentials, even in a process that follows a source with headers.
func TestThePublicChannelSendsNoCredentials(t *testing.T) {
	dir := t.TempDir()
	release(t, dir, "kernel", "rootfs")
	touch(t, filepath.Join(dir, bundleFile), []byte("{}"))
	var seen requests
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.add(r)
		http.ServeFile(w, r, filepath.Join(dir, filepath.FromSlash(r.URL.Path)))
	}))
	defer public.Close()

	// A source with headers, on the same origin as the public channel, is read first.
	touch(t, filepath.Join(dir, channelFile), []byte(`{"version": "cft-1"}`))
	source := Source{URL: public.URL, Headers: http.Header{"Authorization": {"Bearer " + secret}, "X-Extra": {secret}}}
	if _, _, err := source.Latest(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !seen.carried(secret) {
		t.Fatal("the source's own request went without its headers")
	}
	seen = requests{}

	store := Store{Dir: t.TempDir()}
	u := signedUpdater(store, t)
	ch := proto.ImageChannel{Channel: "stable", Version: "host-images-20261117", URL: public.URL}
	if err := u.Check(context.Background(), ch); err != nil {
		t.Fatal(err)
	}
	in, err := Open(context.Background(), public.URL, "vmlinux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	in.Close()
	if seen.count() != 5 {
		t.Fatalf("the public channel got %d requests: %v", seen.count(), seen.path)
	}
	if seen.carried(secret) {
		t.Fatal("a request on the public channel carried the source's credentials")
	}
	for _, h := range seen.seen {
		if h.Get("Authorization") != "" {
			t.Fatalf("a request on the public channel had an Authorization header")
		}
	}
}

// A source pointed back at a version the host still has makes it current again, reading only its manifest and
// bundle: the rollback.
func TestASourceRollsBackToAVersionTheHostHas(t *testing.T) {
	dir := t.TempDir()
	for _, v := range []string{"cft-1", "cft-2"} {
		release(t, filepath.Join(dir, v), "kernel "+v, "rootfs "+v)
		touch(t, filepath.Join(dir, v, bundleFile), []byte("{}"))
	}
	store := Store{Dir: t.TempDir()}
	u := signedUpdater(store, t)
	source := Source{URL: dir}
	for _, v := range []string{"cft-1", "cft-2"} {
		touch(t, filepath.Join(dir, channelFile), []byte(fmt.Sprintf(`{"version": %q}`, v)))
		ctx, ch, err := source.Latest(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if err := u.Check(ctx, ch); err != nil {
			t.Fatal(err)
		}
	}
	// The files of cft-1 are gone from the source: a rollback mustn't need them.
	for _, f := range []string{"vmlinux-amd64", "sandbox-amd64.ext4.gz"} {
		if err := os.Remove(filepath.Join(dir, "cft-1", f)); err != nil {
			t.Fatal(err)
		}
	}
	touch(t, filepath.Join(dir, channelFile), []byte(`{"version": "cft-1"}`))
	ctx, ch, err := source.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Check(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); string(raw) != "rootfs cft-1" {
		t.Fatalf("after the rollback sandbox.ext4 = %q", raw)
	}
	// A pointer that can't name a directory is refused.
	touch(t, filepath.Join(dir, channelFile), []byte(`{"version": "../etc"}`))
	if _, _, err := source.Latest(context.Background()); err == nil {
		t.Fatal("a channel.json naming ../etc was taken")
	}
}

// A GitHub release source: the latest release's tag is the version, its assets are fetched through the API by name
// with Accept: application/octet-stream and the token, and the token doesn't follow the asset's redirect to storage.
func TestAGitHubReleaseSource(t *testing.T) {
	dir := t.TempDir()
	release(t, dir, "kernel", "rootfs")
	touch(t, filepath.Join(dir, bundleFile), []byte("{}"))
	var stored requests
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stored.add(r)
		http.ServeFile(w, r, filepath.Join(dir, strings.TrimPrefix(r.URL.Path, "/blob/")))
	}))
	defer storage.Close()
	names := []string{manifestFile, bundleFile, "vmlinux-amd64", "sandbox-amd64.ext4.gz"}
	var api requests
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		api.add(r)
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		switch {
		case r.URL.Path == "/repos/acme/images/releases/latest" || r.URL.Path == "/repos/acme/images/releases/tags/cft-7":
			if r.Header.Get("Accept") != "application/vnd.github+json" {
				http.Error(w, "want JSON", http.StatusUnsupportedMediaType)
				return
			}
			type asset struct {
				Name string `json:"name"`
				URL  string `json:"url"`
			}
			rel := struct {
				TagName string  `json:"tag_name"`
				Assets  []asset `json:"assets"`
			}{TagName: "cft-7"}
			for i, n := range names {
				rel.Assets = append(rel.Assets, asset{Name: n, URL: fmt.Sprintf("%s/repos/acme/images/releases/assets/%d", srv.URL, i)})
			}
			_ = json.NewEncoder(w).Encode(rel)
		case strings.HasPrefix(r.URL.Path, "/repos/acme/images/releases/assets/"):
			if r.Header.Get("Accept") != "application/octet-stream" {
				http.Error(w, "want octet-stream", http.StatusUnsupportedMediaType)
				return
			}
			var i int
			_, _ = fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/repos/acme/images/releases/assets/"), "%d", &i)
			http.Redirect(w, r, storage.URL+"/blob/"+names[i], http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	// The headers file's own Accept is overridden per request: the release is JSON, the assets bytes.
	source := Source{Type: SourceGitHubRelease, URL: srv.URL + "/repos/acme/images", Headers: http.Header{
		"Authorization": {"Bearer " + secret}, "Accept": {"application/octet-stream"},
	}}
	store := Store{Dir: t.TempDir()}
	u := signedUpdater(store, t)
	ctx, ch, err := source.Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ch.Version != "cft-7" {
		t.Fatalf("version %q", ch.Version)
	}
	if err := u.Check(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(store.Dir, "current", "sandbox.ext4")); string(raw) != "rootfs" {
		t.Fatalf("sandbox.ext4 = %q", raw)
	}
	if stored.count() != 4 || stored.carried(secret) {
		t.Fatalf("storage got %d requests, the token: %v", stored.count(), stored.carried(secret))
	}
	// A version by tag (a snapshot from a peer is a layer over it).
	if _, ch, err := source.At(context.Background(), "cft-7"); err != nil || ch.Version != "cft-7" {
		t.Fatalf("At: %+v, %v", ch, err)
	}
	// A redirect to a signed URL that can't be reached: the error leaves out its signature.
	signed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:1/blob?X-Amz-Signature="+secret, http.StatusFound)
	}))
	defer signed.Close()
	ctx = withRemote(context.Background(), &remote{origin: originOf(signed.URL)})
	if _, err := httpGet(ctx, signed.URL+"/asset"); err == nil || strings.Contains(err.Error(), secret) || !strings.Contains(err.Error(), "127.0.0.1:1/blob?") {
		t.Fatalf("a failed redirect to a signed URL: %v", err)
	}
	// Without the token the release can't be read, and the error says nothing of the headers.
	source.Headers = nil
	if _, _, err := source.Latest(context.Background()); err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("a release read without the token: %v", err)
	}
}
