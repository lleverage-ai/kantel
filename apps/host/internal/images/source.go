package images

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Source kinds (the config's imageSource.type).
const (
	// SourceHTTP is a directory, local or over HTTP(S): <URL>/channel.json names the version ({"version": "…"}), and
	// <URL>/<version>/ holds that version's manifest.json, its signature bundle and the files the manifest lists. Any
	// static file server is one: an S3 or R2 bucket, behind Cloudflare Access or not.
	SourceHTTP = "http"
	// SourceGitHubRelease is a GitHub repository's releases, by its API URL (https://api.github.com/repos/<owner>/<repo>):
	// its latest release is the version, named by its tag, and the release's assets are the manifest, its bundle and
	// the files, fetched by name. A private repository's assets are only served through the API, by asset ID.
	SourceGitHubRelease = "github-release"
)

// channelFile is an http source's pointer to its version.
const channelFile = "channel.json"

// Source is a private place host images come from, which a host follows instead of the control plane's image channel
// (the config's imageSource): how Lleverage's own hosts take images Kantel may not publish, such as a sandbox image
// with Chrome for Testing. Its versions are checked as the channel's are (Updater.Check): the manifest's signature
// first, then every file's digest, then one rename makes the version current.
//
// Headers (the config's headersFile, credentials such as a bearer token or a Cloudflare Access service token) go
// with each request to URL's origin and nowhere else: not to another origin a request is redirected to (a release
// asset's storage), and never with the control plane's channel or the installer's downloads, whose requests carry no
// Source.
type Source struct {
	// Type is SourceHTTP (also when empty) or SourceGitHubRelease.
	Type string
	URL  string
	// Headers are sent to URL's origin only.
	Headers http.Header
}

// Validate refuses a source that can't be followed safely: an unknown type, a URL that is neither a directory nor
// HTTP(S), and headers that would cross the network in the clear (plain HTTP to anything but this machine).
func (s Source) Validate() error {
	switch s.kind() {
	case SourceHTTP:
	case SourceGitHubRelease:
		if !strings.HasPrefix(s.URL, "https://") || !strings.Contains(s.URL, "/repos/") {
			if !loopbackURL(s.URL) {
				return fmt.Errorf("a github-release image source's url is the repository's API URL, https://api.github.com/repos/<owner>/<repo>, not %s", s.URL)
			}
		}
	default:
		return fmt.Errorf(`image source type %q: want "http" or "github-release"`, s.Type)
	}
	if s.URL == "" {
		return errors.New("the image source has no url")
	}
	if isURL(s.URL) && originOf(s.URL) == "" {
		return fmt.Errorf("the image source's url %s has no ASCII host: write an internationalised name in its xn-- form", s.URL)
	}
	if len(s.Headers) > 0 {
		if !isURL(s.URL) {
			return errors.New("the image source is a directory, so it takes no headers")
		}
		if strings.HasPrefix(s.URL, "http://") && !loopbackURL(s.URL) {
			return errors.New("the image source's headers would be sent in the clear: use an https:// url")
		}
	}
	return nil
}

func (s Source) kind() string {
	if s.Type == "" {
		return SourceHTTP
	}
	return s.Type
}

func (s Source) base() string { return strings.TrimSuffix(s.URL, "/") }

// remote is what a source's requests carry in their context (withRemote): the origin its headers may go to, and for a
// GitHub release the URL of each asset by name.
type remote struct {
	origin  string
	headers http.Header
	// accept, when set, is every request's Accept header, whatever the headers say (a release asset's bytes are
	// application/octet-stream, the release itself JSON).
	accept string
	assets map[string]string
}

type remoteKey struct{}

func withRemote(ctx context.Context, r *remote) context.Context {
	return context.WithValue(ctx, remoteKey{}, r)
}

func remoteOf(ctx context.Context) *remote {
	r, _ := ctx.Value(remoteKey{}).(*remote)
	return r
}

func (s Source) remote() *remote {
	if !isURL(s.URL) {
		return nil
	}
	return &remote{origin: originOf(s.URL), headers: s.Headers}
}

// Latest is the version the source names now, as a channel for Updater.Check, and the context its requests are made
// with (Check and Install need it: the files come from the source too).
func (s Source) Latest(ctx context.Context) (context.Context, proto.ImageChannel, error) {
	if err := s.Validate(); err != nil {
		return ctx, proto.ImageChannel{}, err
	}
	if s.kind() == SourceGitHubRelease {
		return s.release(ctx, s.base()+"/releases/latest")
	}
	r := s.remote()
	if r != nil {
		ctx = withRemote(ctx, r)
	}
	in, err := Open(ctx, s.base(), channelFile)
	if err != nil {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: %w", err)
	}
	defer in.Close()
	var pointer struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(in, 64<<10)).Decode(&pointer); err != nil {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: %s: %w", channelFile, err)
	}
	if !ValidVersion(pointer.Version) {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: %s names no usable version (%q)", channelFile, pointer.Version)
	}
	return ctx, s.channel(pointer.Version), nil
}

// At is one version of the source, whichever it names now: one a snapshot fetched from a peer is a layer over.
func (s Source) At(ctx context.Context, version string) (context.Context, proto.ImageChannel, error) {
	if err := s.Validate(); err != nil {
		return ctx, proto.ImageChannel{}, err
	}
	if !ValidVersion(version) {
		return ctx, proto.ImageChannel{}, fmt.Errorf("the version %q can't name a directory", version)
	}
	if s.kind() == SourceGitHubRelease {
		return s.release(ctx, s.base()+"/releases/tags/"+url.PathEscape(version))
	}
	if r := s.remote(); r != nil {
		ctx = withRemote(ctx, r)
	}
	return ctx, s.channel(version), nil
}

func (s Source) channel(version string) proto.ImageChannel {
	return proto.ImageChannel{Channel: "source", Version: version, URL: s.base() + "/" + version}
}

// release reads a GitHub release (the latest, or one by tag): its tag is the version, and its assets' API URLs are
// where the version's files are fetched from.
func (s Source) release(ctx context.Context, u string) (context.Context, proto.ImageChannel, error) {
	r := s.remote()
	r.accept = "application/vnd.github+json"
	in, err := httpGet(withRemote(ctx, r), u)
	if err != nil {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: %w", err)
	}
	defer in.Close()
	var rel struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(in, 4<<20)).Decode(&rel); err != nil {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: the release: %w", err)
	}
	if !ValidVersion(rel.TagName) {
		return ctx, proto.ImageChannel{}, fmt.Errorf("image source: the release's tag %q can't name a version", rel.TagName)
	}
	files := &remote{origin: r.origin, headers: r.headers, accept: "application/octet-stream", assets: map[string]string{}}
	for _, a := range rel.Assets {
		files.assets[a.Name] = a.URL
	}
	ch := proto.ImageChannel{Channel: "source", Version: rel.TagName, URL: s.base() + "/releases/tags/" + url.PathEscape(rel.TagName)}
	return withRemote(ctx, files), ch, nil
}

// authorize adds the source's headers to a request for its origin; a request anywhere else goes without them.
func (r *remote) authorize(req *http.Request) {
	if !r.sameOrigin(req.URL.String()) {
		return
	}
	for name, values := range r.headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	if r.accept != "" {
		req.Header.Set("Accept", r.accept)
	}
}

// client follows redirects as the default client does, but a redirect off the source's origin (a release asset's
// storage, a signed URL) drops the source's headers first: Go keeps custom headers on such a redirect.
func (r *remote) client() *http.Client {
	return &http.Client{CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		if !r.sameOrigin(req.URL.String()) {
			for name := range r.headers {
				req.Header.Del(name)
			}
			req.Header.Del("Authorization")
		}
		return nil
	}}
}

// sameOrigin says whether a URL is the source's origin, which its headers may go to. A URL without one never is.
func (r *remote) sameOrigin(raw string) bool {
	o := originOf(raw)
	return o != "" && o == r.origin
}

// originOf is a URL's scheme and host (with its port), lower case: "" for one that doesn't parse, and for a host
// that isn't printable ASCII. Unicode case folding could make two hosts the HTTP transport resolves as different
// names (by IDNA) compare equal, such as one with U+0130 for an i, so only ASCII is folded, and a Unicode host is no
// origin headers go to.
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	for _, c := range u.Scheme + u.Host {
		if c <= ' ' || c > '~' {
			return ""
		}
	}
	return asciiLower(u.Scheme + "://" + u.Host)
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// withoutQuery is a URL without its query and fragment, which may hold a signature.
func withoutQuery(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(a URL that doesn't parse)"
	}
	queried := u.RawQuery != ""
	u.RawQuery, u.Fragment = "", ""
	if queried {
		return u.Redacted() + "?…"
	}
	return u.Redacted()
}

// loopbackURL says whether a URL's host is this machine (localhost, 127.0.0.0/8, ::1).
func loopbackURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// ReadHeaders reads an image source's headers file: one `Name: value` per line, with blank lines and lines starting
// with # skipped. It holds credentials, so it must belong to the user the host runs as and be readable by it alone
// (chmod 600, or 400); otherwise it is refused and nothing in it is used. No error repeats anything the file holds.
func ReadHeaders(path string) (http.Header, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("the image source's headers file: %w", err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("the image source's headers file %s isn't a regular file", path)
	}
	if perm := st.Mode().Perm(); perm&0o077 != 0 {
		return nil, fmt.Errorf("the image source's headers file %s is mode %#o: it holds credentials, so only its owner may read or write it (chmod 600 %s)", path, perm, path)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("the image source's headers file %s belongs to uid %d, not the user kantel-host runs as (uid %d)", path, sys.Uid, os.Geteuid())
	}
	h := http.Header{}
	scanner := bufio.NewScanner(io.LimitReader(f, 64<<10))
	for n := 1; scanner.Scan(); n++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, ":")
		name, value = strings.TrimSpace(name), strings.TrimSpace(value)
		if !ok || !headerName(name) || value == "" {
			return nil, fmt.Errorf("the image source's headers file %s: line %d isn't `Name: value`", path, n)
		}
		if strings.EqualFold(name, "Host") {
			return nil, fmt.Errorf("the image source's headers file %s: line %d sets Host, which a request takes from its URL", path, n)
		}
		h.Add(name, value)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("the image source's headers file %s: %w", path, err)
	}
	if len(h) == 0 {
		return nil, fmt.Errorf("the image source's headers file %s has no headers", path)
	}
	return h, nil
}

// headerName says whether s is an HTTP header name (an RFC 9110 token).
func headerName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r > 0x7e || r <= ' ' || strings.ContainsRune(`"(),/:;<=>?@[\]{}`, r) {
			return false
		}
	}
	return true
}
