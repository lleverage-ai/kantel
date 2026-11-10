package kantel

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// updateCommand is `kantel update`: it replaces this binary with a release's, checked against the release's
// SHA256SUMS, and kantel-admin too where it is installed beside it. The new binary is written beside the old one and
// renamed over it, so a command that is running keeps its file and an update cut short changes nothing.
func updateCommand() *cli.Command {
	return &cli.Command{
		Name:    "update",
		Summary: "Update kantel to the latest release, or to --version",
		Flags: []cli.Flag{
			{Name: "version", Type: cli.String, Value: "<version>", Description: "Install this release, such as 0.2.0"},
			{Name: "check", Type: cli.Bool, Description: "Only say whether there is a newer release"},
			{Name: "force", Type: cli.Bool, Description: "Install it even when it is the version you have"},
		},
		Details: "It downloads the release's kantel for this machine (kantel-<os>-<arch>), checks it against the release's\n" +
			"SHA256SUMS and that it runs, and renames it over this one, and over kantel-admin where it is installed beside\n" +
			"kantel. KANTEL_RELEASE_URL downloads from a mirror instead: a directory holding one release's files.\n" +
			"\n" +
			"After a command, kantel says on stderr when a newer release is out, checking at most once a day. It never does\n" +
			"with --json, when stderr isn't a terminal, in CI or under a coding agent; KANTEL_NO_UPDATE_NOTIFIER=1 turns it\n" +
			"off.",
		Examples: []cli.Example{
			{What: "Say whether there is a newer release", Line: "kantel update --check"},
			{What: "Update to the latest release", Line: "kantel update"},
			{What: "Install a release in particular", Line: "kantel update --version 0.3.2"},
		},
		Run: runUpdate,
	}
}

// releaseClient is the HTTP client for GitHub or a mirror.
func releaseClient(c *cli.Context) *http.Client {
	if c.IO.HTTP != nil {
		return c.IO.HTTP
	}
	return http.DefaultClient
}

// replacement is one binary update replaces: path is what is renamed over (the file a link points to, resolved).
type replacement struct {
	name, path, asset string
	tmp               string
}

func runUpdate(c *cli.Context) error {
	client := releaseClient(c)
	env := c.IO.Env
	asked, given := c.Str("version")
	var target string
	var err error
	if given {
		target, err = releaseVersion(asked)
	} else {
		ctx, cancel := context.WithTimeout(c.Ctx, 30*time.Second)
		target, err = latestRelease(ctx, client, env)
		cancel()
	}
	if err != nil {
		return err
	}
	order := compareVersions(Version, target)
	state := map[string]any{"current": Version, "target": target, "updateAvailable": order < 0 || (given && order != 0)}
	if c.Bool("check") {
		c.Emit(nil, state, func() string {
			if order < 0 {
				return fmt.Sprintf("kantel %s is out (you have %s): kantel update installs it.", target, Version)
			}
			if order > 0 {
				return fmt.Sprintf("kantel %s is up to date, newer than the latest release (%s).", Version, target)
			}
			return fmt.Sprintf("kantel %s is up to date.", Version)
		})
		return nil
	}
	if !c.Bool("force") && (order == 0 || (!given && order > 0)) {
		state["updated"] = false
		c.Emit(nil, state, func() string {
			if order == 0 {
				return fmt.Sprintf("kantel %s is up to date.", Version)
			}
			return fmt.Sprintf("kantel %s is newer than the latest release (%s): nothing to do.", Version, target)
		})
		return nil
	}
	if Version == "0.0.0" && !c.Bool("force") {
		return &cli.Error{Message: "this kantel is a development build (0.0.0), so it doesn't update itself",
			Hint: "Install a release with: " + installCommand + " (or replace this one with kantel update --force)",
			Code: "failed", Exit: cli.ExitFailed}
	}

	targets, err := installed(c.IO.Self)
	if err != nil {
		return err
	}
	for _, t := range targets {
		dir := filepath.Dir(t.path)
		if err := writable(dir); err != nil {
			return &cli.Error{
				Message: fmt.Sprintf("can't write to %s, where %s is, so it can't be updated (%v)", dir, t.name, unwrapPath(err)),
				Hint: fmt.Sprintf("Update it as the directory's owner: sudo %s update. Or install kantel for yourself, in ~/.local/bin, with: %s",
					localShellPath(c.IO.Self), installCommand),
				Code: "failed", Exit: cli.ExitFailed,
			}
		}
	}

	base := releaseBase(target, env)
	ctx, cancel := context.WithTimeout(c.Ctx, 10*time.Minute)
	defer cancel()
	text, err := fetchText(ctx, client, base+"/SHA256SUMS")
	if errors.Is(err, errNotFound) {
		return cli.Fail(fmt.Sprintf("there is no release v%s (%s/SHA256SUMS)", target, base))
	}
	if err != nil {
		return cli.Fail(fmt.Sprintf("couldn't download %s/SHA256SUMS: %v", base, err))
	}
	sums := parseSums(text)
	defer func() {
		for _, t := range targets {
			if t.tmp != "" {
				os.Remove(t.tmp)
			}
		}
	}()
	c.Note(fmt.Sprintf("Updating kantel %s to %s", Version, target))
	var ready []*replacement
	for i := range targets {
		t := &targets[i]
		want := sums[t.asset]
		if want == "" {
			if t.name != "kantel" {
				c.Note(fmt.Sprintf("Release %s has no %s, so %s stays as it is", target, t.asset, t.path))
				continue
			}
			return cli.Fail(fmt.Sprintf("release %s has no %s (its SHA256SUMS has no line for it)", target, t.asset))
		}
		c.Note(fmt.Sprintf("Downloading %s from %s", t.asset, base))
		if t.tmp, err = download(ctx, client, base+"/"+t.asset, want, filepath.Dir(t.path)); err != nil {
			return err
		}
		if err := runsAs(ctx, t.tmp, target); err != nil {
			return cli.Fail(fmt.Sprintf("the downloaded %s %v; not installing it", t.asset, err))
		}
		ready = append(ready, t)
	}
	c.Note("Checked the download against SHA256SUMS")
	var lines []string
	for _, t := range ready {
		if err := os.Rename(t.tmp, t.path); err != nil {
			return cli.Fail(fmt.Sprintf("couldn't put the new %s in place: %v", t.name, err))
		}
		t.tmp = ""
		lines = append(lines, fmt.Sprintf("Updated %s to %s: %s", t.name, target, t.path))
	}
	state["updated"] = true
	c.Emit(nil, state, func() string { return strings.Join(lines, "\n") })
	return nil
}

// installed is what update replaces: this kantel (self, its links resolved), and kantel-admin where it is beside it,
// in the directory kantel is in or the one its link is in. An older kantel-admin that is a link to the Node.js
// release's kantel-admin.mjs is replaced by the binary itself.
func installed(self string) ([]replacement, error) {
	if self == "" {
		return nil, cli.Fail("can't tell where this kantel is, so it can't update itself. Install the release with: " + installCommand)
	}
	real, err := filepath.EvalSymlinks(self)
	if err != nil {
		return nil, cli.Fail(fmt.Sprintf("can't find this kantel (%s): %v", self, err))
	}
	targets := []replacement{{name: "kantel", path: real, asset: "kantel-" + platform}}
	for _, dir := range []string{filepath.Dir(real), filepath.Dir(self)} {
		link := filepath.Join(dir, "kantel-admin")
		if _, err := os.Lstat(link); err != nil {
			continue
		}
		path, err := filepath.EvalSymlinks(link)
		if err != nil {
			continue
		}
		if strings.HasSuffix(path, ".mjs") {
			path = link
		}
		targets = append(targets, replacement{name: "kantel-admin", path: path, asset: "kantel-admin-" + platform})
		break
	}
	return targets, nil
}

// runsAs checks the binary at path runs here and says it is version.
func runsAs(ctx context.Context, path, version string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		return fmt.Errorf("doesn't run here (%v)", err)
	}
	if got := strings.TrimSpace(string(out)); got != version {
		return fmt.Errorf("says it is %q, not %s", got, version)
	}
	return nil
}

// unwrapPath is an *os.PathError's reason alone, such as "permission denied".
func unwrapPath(err error) error {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err
	}
	return err
}

// localShellPath is how to type a local path in a shell.
func localShellPath(path string) string {
	if path == "" {
		return "kantel"
	}
	return ShellQuote(path)
}
