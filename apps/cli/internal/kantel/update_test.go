package kantel

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// A fake release: GitHub's releases/latest redirect to v<latest>, and each release's files, SHA256SUMS among them.

type fakeRelease struct {
	server *httptest.Server
	// files are each release's, by version then name.
	files  map[string]map[string]string
	latest string
	heads  atomic.Int32
	// hold, when set, keeps releases/latest from answering until it is closed.
	hold chan struct{}
}

// binary is a stand-in for a release's kantel: a script that says it is version.
func binary(version string) string { return "#!/bin/sh\necho " + version + "\n" }

func sumsOf(files map[string]string) string {
	var b strings.Builder
	for name, body := range files {
		sum := sha256.Sum256([]byte(body))
		fmt.Fprintf(&b, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	return b.String()
}

// releaseFiles is a release's kantel and kantel-admin for this platform, with SHA256SUMS.
func releaseFiles(version string) map[string]string {
	files := map[string]string{"kantel-" + platform: binary(version), "kantel-admin-" + platform: binary(version)}
	files["SHA256SUMS"] = sumsOf(files)
	return files
}

func newRelease(t *testing.T, latest string) *fakeRelease {
	r := &fakeRelease{files: map[string]map[string]string{latest: releaseFiles(latest)}, latest: latest}
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/lleverage-ai/kantel/releases/latest" {
			r.heads.Add(1)
			if r.hold != nil {
				select {
				case <-r.hold:
				case <-req.Context().Done():
					return
				}
			}
			http.Redirect(w, req, "/lleverage-ai/kantel/releases/tag/v"+r.latest, http.StatusFound)
			return
		}
		rest, ok := strings.CutPrefix(req.URL.Path, "/lleverage-ai/kantel/releases/download/v")
		version, name, _ := strings.Cut(rest, "/")
		body, found := r.files[version][name]
		if !ok || !found {
			http.NotFound(w, req)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(r.server.Close)
	old := releasesURL
	releasesURL = r.server.URL + "/lleverage-ai/kantel/releases"
	t.Cleanup(func() { releasesURL = old })
	return r
}

func withVersion(t *testing.T, v string) {
	old := Version
	Version = v
	t.Cleanup(func() { Version = old })
}

type updateRun struct {
	self string
	env  cli.Env
	tty  bool
	home string
}

func runUpdateCLI(t *testing.T, argv []string, o updateRun) result {
	t.Helper()
	if o.env == nil {
		o.env = cli.Env{}
	}
	if o.home == "" {
		o.home = t.TempDir()
	}
	var stdout, stderr bytes.Buffer
	code := cli.Run(Program(), argv, &cli.IO{
		Stdout: &stdout, Stderr: &stderr, Stdin: strings.NewReader(""), StderrTTY: o.tty,
		Env: o.env, Home: o.home, ConfigDir: o.home, Cwd: o.home, HTTP: http.DefaultClient, Now: time.Now, Self: o.self,
	})
	return result{Code: code, Stdout: stdout.String(), Stderr: stderr.String()}
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func write(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
}

// leftovers is any temporary file update left in dir.
func leftovers(t *testing.T, dir string) []string {
	matches, _ := filepath.Glob(filepath.Join(dir, ".kantel-update-*"))
	return matches
}

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		sign int
	}{
		{"0.4.2", "0.5.0", -1}, {"0.5.0", "0.5.0", 0}, {"1.0.0", "0.9.9", 1}, {"0.10.0", "0.9.0", 1},
		{"0.5.0-rc.1", "0.5.0", -1}, {"0.5.0-rc.2", "0.5.0-rc.10", -1}, {"0.5.0-beta", "0.5.0-rc.1", -1},
		{"0.5.0-rc.1.1", "0.5.0-rc.1", 1},
	} {
		got := compareVersions(c.a, c.b)
		if (got < 0 && c.sign >= 0) || (got > 0 && c.sign <= 0) || (got == 0 && c.sign != 0) {
			t.Errorf("compareVersions(%s, %s) = %d, want sign %d", c.a, c.b, got, c.sign)
		}
	}
	v, err := releaseVersion(" v0.3.0-rc.1 ")
	eq(t, "version", v, "0.3.0-rc.1")
	eq(t, "no error", err, error(nil))
	if _, err := releaseVersion("latest"); err == nil {
		t.Error("latest is a version")
	}
}

func TestUpdateReplacesKantelAndAdmin(t *testing.T) {
	withVersion(t, "0.4.2")
	newRelease(t, "0.5.0")
	root := t.TempDir()
	real := filepath.Join(root, "real")
	write(t, filepath.Join(real, "kantel"), binary("0.4.2"), 0o755)
	write(t, filepath.Join(real, "kantel-admin"), binary("0.4.2"), 0o755)
	// kantel is run through a link, as from ~/.local/bin; the file it points to is what is replaced.
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(real, "kantel"), filepath.Join(bin, "kantel")); err != nil {
		t.Fatal(err)
	}
	// A process running the old binary keeps its file: the new one is renamed over it, not written into it.
	old, err := os.Open(filepath.Join(real, "kantel"))
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()

	r := runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(bin, "kantel")})
	eq(t, "exit", r.Code, 0)
	contains(t, "stderr", r.Stderr, "Updating kantel 0.4.2 to 0.5.0")
	contains(t, "stderr", r.Stderr, "Checked the download against SHA256SUMS")
	contains(t, "stdout", r.Stdout, "Updated kantel to 0.5.0: "+filepath.Join(real, "kantel"))
	contains(t, "stdout", r.Stdout, "Updated kantel-admin to 0.5.0: "+filepath.Join(real, "kantel-admin"))
	eq(t, "kantel", read(t, filepath.Join(real, "kantel")), binary("0.5.0"))
	eq(t, "kantel-admin", read(t, filepath.Join(real, "kantel-admin")), binary("0.5.0"))
	info, _ := os.Stat(filepath.Join(real, "kantel"))
	eq(t, "mode", info.Mode().Perm(), os.FileMode(0o755))
	if link, err := os.Readlink(filepath.Join(bin, "kantel")); err != nil || link != filepath.Join(real, "kantel") {
		t.Errorf("the link changed: %q %v", link, err)
	}
	var kept bytes.Buffer
	_, _ = kept.ReadFrom(old)
	eq(t, "the running binary's file", kept.String(), binary("0.4.2"))
	eq(t, "leftovers", len(leftovers(t, real)), 0)

	// Now it is up to date.
	withVersion(t, "0.5.0")
	r = runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(bin, "kantel")})
	eq(t, "exit", r.Code, 0)
	eq(t, "up to date", r.Stdout, "kantel 0.5.0 is up to date.\n")
}

func TestUpdateJSONAndCheck(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), binary("0.4.2"), 0o755)

	r := runUpdateCLI(t, []string{"update", "--check"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "check", r.Stdout, "kantel 0.5.0 is out (you have 0.4.2): kantel update installs it.\n")
	eq(t, "unchanged", read(t, filepath.Join(dir, "kantel")), binary("0.4.2"))

	r = runUpdateCLI(t, []string{"update", "--check", "--json"}, updateRun{})
	var state map[string]any
	if err := json.Unmarshal([]byte(r.Stdout), &state); err != nil {
		t.Fatalf("not JSON: %q", r.Stdout)
	}
	eq(t, "available", state["updateAvailable"], any(true))
	eq(t, "target", state["target"], any("0.5.0"))

	r = runUpdateCLI(t, []string{"update", "--json"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 0)
	_ = json.Unmarshal([]byte(r.Stdout), &state)
	eq(t, "updated", state["updated"], any(true))

	withVersion(t, "0.6.0")
	r = runUpdateCLI(t, []string{"update", "--check"}, updateRun{})
	eq(t, "newer", r.Stdout, "kantel 0.6.0 is up to date, newer than the latest release (0.5.0).\n")
	r = runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "nothing to do", r.Stdout, "kantel 0.6.0 is newer than the latest release (0.5.0): nothing to do.\n")

	// --version installs that release, older or not; one that isn't there says so.
	release.files["0.4.0"] = releaseFiles("0.4.0")
	r = runUpdateCLI(t, []string{"update", "--version", "v0.4.0"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 0)
	eq(t, "downgraded", read(t, filepath.Join(dir, "kantel")), binary("0.4.0"))
	r = runUpdateCLI(t, []string{"update", "--version", "0.3.0"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 1)
	contains(t, "no release", r.Stderr, "there is no release v0.3.0")
	r = runUpdateCLI(t, []string{"update", "--version", "soon"}, updateRun{})
	eq(t, "bad version", r.Code, 2)
}

func TestUpdateRefusesABadChecksum(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	release.files["0.5.0"]["kantel-"+platform] = binary("0.5.0") + "# tampered\n"
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), binary("0.4.2"), 0o755)

	r := runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 1)
	contains(t, "says why", r.Stderr, "kantel-"+platform+"'s SHA-256 is ")
	contains(t, "says why", r.Stderr, "but SHA256SUMS says")
	eq(t, "unchanged", read(t, filepath.Join(dir, "kantel")), binary("0.4.2"))
	eq(t, "leftovers", len(leftovers(t, dir)), 0)
}

func TestUpdateRefusesABinaryThatIsntTheRelease(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	files := map[string]string{"kantel-" + platform: binary("0.1.0")}
	files["SHA256SUMS"] = sumsOf(files)
	release.files["0.5.0"] = files
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), binary("0.4.2"), 0o755)

	r := runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 1)
	contains(t, "says why", r.Stderr, `says it is "0.1.0", not 0.5.0; not installing it`)
	eq(t, "unchanged", read(t, filepath.Join(dir, "kantel")), binary("0.4.2"))
	eq(t, "leftovers", len(leftovers(t, dir)), 0)
}

func TestUpdateSaysHowWhenTheDirectoryIsntWritable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write anywhere")
	}
	withVersion(t, "0.4.2")
	newRelease(t, "0.5.0")
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), binary("0.4.2"), 0o755)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	r := runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 1)
	contains(t, "says why", r.Stderr, "kantel: can't write to "+dir+", where kantel is, so it can't be updated (permission denied)")
	contains(t, "sudo", r.Stderr, "sudo "+filepath.Join(dir, "kantel")+" update")
	contains(t, "reinstall", r.Stderr, installCommand)
	eq(t, "unchanged", read(t, filepath.Join(dir, "kantel")), binary("0.4.2"))
}

func TestUpdateFromAMirror(t *testing.T) {
	withVersion(t, "0.4.2")
	mirrorDir := t.TempDir()
	for name, body := range releaseFiles("0.5.0") {
		write(t, filepath.Join(mirrorDir, name), body, 0o644)
	}
	write(t, filepath.Join(mirrorDir, "install-cli.sh"), "#!/bin/sh\nKANTEL_RELEASE_VERSION=\"0.5.0\"\n", 0o755)
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), binary("0.4.2"), 0o755)
	// An old Node.js kantel-admin: a link to kantel-admin.mjs. The binary takes the link's place.
	write(t, filepath.Join(dir, "share", "kantel-admin.mjs"), "// node\n", 0o755)
	if err := os.Symlink(filepath.Join(dir, "share", "kantel-admin.mjs"), filepath.Join(dir, "kantel-admin")); err != nil {
		t.Fatal(err)
	}

	env := cli.Env{"KANTEL_RELEASE_URL": "file://" + mirrorDir + "/"}
	r := runUpdateCLI(t, []string{"update", "--check"}, updateRun{env: env})
	eq(t, "check", r.Stdout, "kantel 0.5.0 is out (you have 0.4.2): kantel update installs it.\n")
	r = runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel"), env: env})
	eq(t, "exit", r.Code, 0)
	eq(t, "kantel", read(t, filepath.Join(dir, "kantel")), binary("0.5.0"))
	if info, err := os.Lstat(filepath.Join(dir, "kantel-admin")); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("kantel-admin is still a link: %v", err)
	}
	eq(t, "kantel-admin", read(t, filepath.Join(dir, "kantel-admin")), binary("0.5.0"))
}

func TestUpdateRefusesADevelopmentBuild(t *testing.T) {
	newRelease(t, "0.5.0")
	dir := t.TempDir()
	write(t, filepath.Join(dir, "kantel"), "dev", 0o755)
	r := runUpdateCLI(t, []string{"update"}, updateRun{self: filepath.Join(dir, "kantel")})
	eq(t, "exit", r.Code, 1)
	contains(t, "says why", r.Stderr, "development build")
	eq(t, "unchanged", read(t, filepath.Join(dir, "kantel")), "dev")
}

// The update notice.

func noticeContext(t *testing.T, env cli.Env, home string) *cli.Context {
	var stderr bytes.Buffer
	return &cli.Context{
		IO:      &cli.IO{Stderr: &stderr, StderrTTY: true, Env: env, Home: home, HTTP: http.DefaultClient, Now: time.Now},
		Command: &cli.Command{Name: "list"}, Values: map[string]any{},
	}
}

func TestNoticeIsOffForScriptsAgentsAndCI(t *testing.T) {
	withVersion(t, "0.4.2")
	on := noticeContext(t, cli.Env{}, t.TempDir())
	eq(t, "on", noticeOff(on), "")
	for _, env := range []cli.Env{
		{"CI": "true"}, {"KANTEL_NO_UPDATE_NOTIFIER": "1"}, {"NO_UPDATE_NOTIFIER": "1"}, {"CLAUDECODE": "1"},
		{"CODEX_SANDBOX": "seatbelt"}, {"CODEX_THREAD_ID": "x"}, {"CURSOR_AGENT": "1"}, {"AI_AGENT": "x"},
		{"GEMINI_CLI": "1"}, {"OPENCODE": "1"},
	} {
		if noticeOff(noticeContext(t, env, "")) == "" {
			t.Errorf("on with %v", env)
		}
	}
	c := noticeContext(t, cli.Env{}, "")
	c.IO.StderrTTY = false
	eq(t, "pipe", noticeOff(c), "stderr isn't a terminal")
	c = noticeContext(t, cli.Env{}, "")
	c.JSON = true
	eq(t, "json", noticeOff(c), "--json")
	for _, name := range []string{"update", "mcp", "completion", "__complete"} {
		c = noticeContext(t, cli.Env{}, "")
		c.Command = &cli.Command{Name: name}
		if noticeOff(c) == "" {
			t.Errorf("on for %s", name)
		}
	}
	withVersion(t, "0.0.0")
	eq(t, "dev", noticeOff(on), "a development build")
}

func TestNoticeChecksOnceADay(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	home := t.TempDir()
	cachePath := filepath.Join(home, ".cache", "kantel", "update-check.json")

	// No cache: it asks, saves the answer, and the notice has it once the check is done.
	u := startUpdateCheck(noticeContext(t, cli.Env{}, home))
	<-u.done
	eq(t, "asked", release.heads.Load(), int32(1))
	eq(t, "notice", u.notice(), "A new kantel is out: 0.5.0 (you have 0.4.2). kantel update installs it.")
	var cache updateCache
	if err := json.Unmarshal([]byte(read(t, cachePath)), &cache); err != nil {
		t.Fatal(err)
	}
	eq(t, "cached", cache.Latest, "0.5.0")

	// Within a day it doesn't ask again, and the notice comes from the cache.
	u = startUpdateCheck(noticeContext(t, cli.Env{}, home))
	eq(t, "no check", u.done == nil, true)
	eq(t, "still once", release.heads.Load(), int32(1))
	eq(t, "from the cache", u.notice(), "A new kantel is out: 0.5.0 (you have 0.4.2). kantel update installs it.")

	// A day later it asks again.
	c := noticeContext(t, cli.Env{}, home)
	c.IO.Now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	u = startUpdateCheck(c)
	<-u.done
	eq(t, "asked again", release.heads.Load(), int32(2))

	// Once updated, there is nothing to say.
	withVersion(t, "0.5.0")
	c.IO.Now = func() time.Time { return time.Now().Add(26 * time.Hour) }
	u = startUpdateCheck(c)
	eq(t, "no check", u.done == nil, true)
	eq(t, "up to date", u.notice(), "")

	// XDG_CACHE_HOME moves the cache.
	xdg := t.TempDir()
	eq(t, "xdg", updateCachePath(&cli.IO{Env: cli.Env{"XDG_CACHE_HOME": xdg}, Home: home}),
		filepath.Join(xdg, "kantel", "update-check.json"))
}

func TestNoticeNeverWaitsForTheCheck(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	release.hold = make(chan struct{})
	home := t.TempDir()

	u := startUpdateCheck(noticeContext(t, cli.Env{}, home))
	start := time.Now()
	eq(t, "nothing yet", u.notice(), "")
	if took := time.Since(start); took > 50*time.Millisecond {
		t.Errorf("the notice waited %s", took)
	}
	// The check finishes after the command; what it found is saved for next time.
	close(release.hold)
	<-u.done
	eq(t, "next time", startUpdateCheck(noticeContext(t, cli.Env{}, home)).notice(),
		"A new kantel is out: 0.5.0 (you have 0.4.2). kantel update installs it.")

	// A check that takes too long gives up, and counts as the day's.
	old := updateCheckTimeout
	updateCheckTimeout = 50 * time.Millisecond
	t.Cleanup(func() { updateCheckTimeout = old })
	release.hold = make(chan struct{})
	defer close(release.hold)
	other := t.TempDir()
	u = startUpdateCheck(noticeContext(t, cli.Env{}, other))
	<-u.done
	eq(t, "no answer", u.notice(), "")
	if _, err := os.Stat(filepath.Join(other, ".cache", "kantel", "update-check.json")); err != nil {
		t.Errorf("the timed-out check wasn't recorded: %v", err)
	}
}

func TestNoticeAfterACommand(t *testing.T) {
	withVersion(t, "0.4.2")
	release := newRelease(t, "0.5.0")
	home := t.TempDir()
	write(t, filepath.Join(home, ".cache", "kantel", "update-check.json"),
		fmt.Sprintf(`{"checkedAt":%q,"latest":"0.5.0"}`, time.Now().Format(time.RFC3339)), 0o644)
	line := "A new kantel is out: 0.5.0 (you have 0.4.2). kantel update installs it.\n"

	r := runUpdateCLI(t, []string{"version"}, updateRun{tty: true, home: home, env: cli.Env{"NO_COLOR": "1"}})
	eq(t, "stdout", r.Stdout, "0.4.2\n")
	eq(t, "stderr", r.Stderr, line)
	for _, o := range []struct {
		argv []string
		env  cli.Env
		tty  bool
	}{
		{[]string{"version"}, nil, false},
		{[]string{"version", "--json"}, nil, true},
		{[]string{"version"}, cli.Env{"CLAUDECODE": "1"}, true},
		{[]string{"version"}, cli.Env{"KANTEL_NO_UPDATE_NOTIFIER": "1"}, true},
		{[]string{"update", "--check"}, nil, true},
		{[]string{"completion", "fish"}, nil, true},
		{[]string{"--version"}, nil, true},
	} {
		r := runUpdateCLI(t, o.argv, updateRun{tty: o.tty, home: home, env: o.env})
		if strings.Contains(r.Stderr, "A new kantel") {
			t.Errorf("%v %v: a notice: %q", o.argv, o.env, r.Stderr)
		}
	}
	eq(t, "no checks with a fresh cache", release.heads.Load(), int32(1)) // update --check's own
}
