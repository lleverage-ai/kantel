package kantel

// Kantel's releases, for `kantel update` and the update notice. Each GitHub Release v<version> carries
// kantel-<os>-<arch> and kantel-admin-<os>-<arch> (static Go binaries for linux and darwin, amd64 and arm64),
// install-cli.sh stamped with its version, and SHA256SUMS (tools/release/pack.sh).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// releasesURL is Kantel's GitHub Releases; a test points it at a fake.
var releasesURL = "https://github.com/lleverage-ai/kantel/releases"

// platform is this binary's in the release's file names: linux-amd64, darwin-arm64…
var platform = runtime.GOOS + "-" + runtime.GOARCH

// maxBinary is the most a release's binary may be.
const maxBinary = 256 << 20

var versionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)

// releaseVersion is a release's version from what someone typed, without a leading v; a usage error when it isn't one.
func releaseVersion(input string) (string, error) {
	version := strings.TrimPrefix(strings.TrimSpace(input), "v")
	if !versionPattern.MatchString(version) {
		return "", cli.Usage(fmt.Sprintf("'%s' isn't a version such as 0.2.0 or 0.3.0-rc.1", input))
	}
	return version, nil
}

// compareVersions is below zero when a is older than b, zero when they are the same and above when newer, by semver's
// precedence: a prerelease comes before its release, and its parts compare as numbers where both are.
func compareVersions(a, b string) int {
	left, right := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	part := func(m []string, i int) string {
		if m == nil {
			return ""
		}
		return m[i]
	}
	for i := 1; i <= 3; i++ {
		l, _ := strconv.Atoi(part(left, i))
		r, _ := strconv.Atoi(part(right, i))
		if l != r {
			return l - r
		}
	}
	lp, rp := part(left, 4), part(right, 4)
	switch {
	case lp == rp:
		return 0
	case lp == "":
		return 1
	case rp == "":
		return -1
	}
	ls, rs := strings.Split(lp, "."), strings.Split(rp, ".")
	for i := 0; i < len(ls) && i < len(rs); i++ {
		ln, lerr := strconv.Atoi(ls[i])
		rn, rerr := strconv.Atoi(rs[i])
		switch {
		case lerr == nil && rerr == nil && ln != rn:
			return ln - rn
		case lerr == nil && rerr != nil:
			return -1
		case lerr != nil && rerr == nil:
			return 1
		case lerr != nil && rerr != nil && ls[i] != rs[i]:
			return strings.Compare(ls[i], rs[i])
		}
	}
	return len(ls) - len(rs)
}

// mirror is KANTEL_RELEASE_URL: a directory holding one release's files (https:// or file://), or "".
func mirror(env cli.Env) string { return strings.TrimSuffix(env.Get("KANTEL_RELEASE_URL"), "/") }

// releaseBase is where version's files are: the mirror's directory, or the GitHub Release's downloads.
func releaseBase(version string, env cli.Env) string {
	if m := mirror(env); m != "" {
		return m
	}
	return releasesURL + "/download/v" + version
}

// errNotFound is a release file that isn't there.
var errNotFound = errors.New("not found")

// open opens a release's file: over HTTP(S), or from disk for a file:// mirror. A missing file is errNotFound.
func open(ctx context.Context, client *http.Client, u string) (io.ReadCloser, error) {
	if parsed, err := url.Parse(u); err == nil && parsed.Scheme == "file" {
		f, err := os.Open(parsed.Path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, errNotFound
		}
		return f, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", UserAgent())
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, errNotFound
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return res.Body, nil
}

// fetchText is a small release file's text, such as SHA256SUMS.
func fetchText(ctx context.Context, client *http.Client, u string) (string, error) {
	body, err := open(ctx, client, u)
	if err != nil {
		return "", err
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, 1<<20))
	return string(raw), err
}

var stampedVersion = regexp.MustCompile(`(?m)^KANTEL_RELEASE_VERSION="([^"]+)"$`)
var tagLocation = regexp.MustCompile(`/releases/tag/v([^/?#]+)$`)

// latestRelease is the latest release's version: the one a mirror holds (stamped in its install-cli.sh), or where
// GitHub's releases/latest redirects (no API, so no rate limit).
func latestRelease(ctx context.Context, client *http.Client, env cli.Env) (string, error) {
	if m := mirror(env); m != "" {
		script, err := fetchText(ctx, client, m+"/install-cli.sh")
		if err != nil {
			return "", cli.Fail(fmt.Sprintf("couldn't read %s/install-cli.sh to find the release KANTEL_RELEASE_URL holds (%v): give --version", m, err))
		}
		match := stampedVersion.FindStringSubmatch(script)
		if match == nil || !versionPattern.MatchString(match[1]) {
			return "", cli.Fail(fmt.Sprintf("%s/install-cli.sh doesn't say which release it is: give --version", m))
		}
		return match[1], nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, releasesURL+"/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", UserAgent())
	noRedirect := *client
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := noRedirect.Do(req)
	if err != nil {
		return "", &cli.Error{Message: "couldn't reach GitHub to find the latest release: " + err.Error(), Code: "unreachable", Exit: cli.ExitFailed}
	}
	res.Body.Close()
	match := tagLocation.FindStringSubmatch(res.Header.Get("Location"))
	if match == nil || !versionPattern.MatchString(match[1]) {
		return "", cli.Fail(fmt.Sprintf("couldn't tell the latest release from %s/latest (HTTP %d)", releasesURL, res.StatusCode))
	}
	return match[1], nil
}

// parseSums reads sha256sum's output: "<hex>  <name>" a line ("*<name>" in binary mode).
func parseSums(text string) map[string]string {
	sums := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && len(fields[0]) == 64 {
			sums[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
		}
	}
	return sums
}

// download writes the release file at u to a new file in dir, executable, checking its SHA-256 is want. It answers
// the new file's path; on any failure it leaves nothing behind.
func download(ctx context.Context, client *http.Client, u, want, dir string) (string, error) {
	body, err := open(ctx, client, u)
	if errors.Is(err, errNotFound) {
		return "", cli.Fail("there is no " + u)
	}
	if err != nil {
		return "", cli.Fail(fmt.Sprintf("couldn't download %s: %v", u, err))
	}
	defer body.Close()
	tmp, err := os.CreateTemp(dir, ".kantel-update-*")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		if !keep {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(body, maxBinary+1))
	if err != nil {
		return "", cli.Fail(fmt.Sprintf("couldn't download %s: %v", u, err))
	}
	if n > maxBinary {
		return "", cli.Fail(fmt.Sprintf("%s is bigger than %d MiB; not installing it", u, maxBinary>>20))
	}
	name := u[strings.LastIndex(u, "/")+1:]
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		return "", cli.Fail(fmt.Sprintf("%s's SHA-256 is %s, but SHA256SUMS says %s; not installing it", name, got, want))
	}
	if err := tmp.Chmod(0o755); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	keep = true
	return tmp.Name(), nil
}

// writable says whether a file can be made in dir: nil, or why not.
func writable(dir string) error {
	f, err := os.CreateTemp(dir, ".kantel-update-*")
	if err != nil {
		return err
	}
	f.Close()
	return os.Remove(filepath.Join(dir, filepath.Base(f.Name())))
}
