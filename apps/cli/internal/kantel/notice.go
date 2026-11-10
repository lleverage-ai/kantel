package kantel

// The update notice: after a command, one line on stderr when a newer kantel is out. Program.Before starts the check
// as a command starts, at most once a day, in the background and for 1.5 seconds at most; Program.After prints the
// notice from what is known when the command is done, without waiting for a check still running (what it finds is
// saved for next time if it finishes first). It is never for a script, a coding agent or CI, nor with --json.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// updateCheckEvery is how often the notice asks GitHub (or the mirror) for the latest release.
const updateCheckEvery = 24 * time.Hour

// updateCheckTimeout is how long one check may take; a test shortens it.
var updateCheckTimeout = 1500 * time.Millisecond

// agentVariables say a coding agent is running the command; CODEX_ is a prefix (CODEX_SANDBOX, CODEX_HOME…).
var agentVariables = []string{"CLAUDECODE", "CURSOR_AGENT", "AI_AGENT", "GEMINI_CLI", "OPENCODE"}

// quietCommands never get the notice: update says it itself, mcp's stderr is an agent's, and completion's is a shell's.
var quietCommands = map[string]bool{"update": true, "mcp": true, "completion": true, "__complete": true}

// updateCache is update-check.json: when the latest release was last asked for, and what it was.
type updateCache struct {
	CheckedAt time.Time `json:"checkedAt"`
	// AttemptedAt is when a check last started, saved before it asks: a command that ends before the check does
	// (most do) still counts, so the next ones don't each start another.
	AttemptedAt time.Time `json:"attemptedAt,omitzero"`
	Latest      string    `json:"latest,omitempty"`
}

// updateAttemptEvery is how often a check that never finished is tried again.
const updateAttemptEvery = time.Hour

// updateGrace is how long a command's end waits for a check under way, so a quick command's check is saved.
const updateGrace = 300 * time.Millisecond

// updateCachePath is ${XDG_CACHE_HOME:-~/.cache}/kantel/update-check.json, or "" with neither.
func updateCachePath(io *cli.IO) string {
	if xdg := io.Env.Get("XDG_CACHE_HOME"); xdg != "" {
		return filepath.Join(xdg, "kantel", "update-check.json")
	}
	if io.Home == "" {
		return ""
	}
	return filepath.Join(io.Home, ".cache", "kantel", "update-check.json")
}

// noticeOff says why the notice is off for this command, or "" when it is on.
func noticeOff(c *cli.Context) string {
	env := c.IO.Env
	set := func(name string) bool { return env.Get(name) != "" }
	switch {
	case Version == "0.0.0":
		return "a development build"
	case c.JSON:
		return "--json"
	case !c.IO.StderrTTY:
		return "stderr isn't a terminal"
	case c.Command != nil && quietCommands[c.Command.Name]:
		return "the command is " + c.Command.Name
	case set("KANTEL_NO_UPDATE_NOTIFIER"), set("NO_UPDATE_NOTIFIER"):
		return "turned off"
	case set("CI"):
		return "CI"
	}
	for _, name := range agentVariables {
		if set(name) {
			return "a coding agent (" + name + ")"
		}
	}
	for name, value := range env {
		if strings.HasPrefix(name, "CODEX_") && value != "" {
			return "a coding agent (" + name + ")"
		}
	}
	return ""
}

// updateCheck is one command's check: the latest release known from the cache, and the check under way, if any.
type updateCheck struct {
	known string
	// done closes when the check has finished; nil when the cache was fresh and no check was made.
	done   chan struct{}
	latest string
}

// startUpdateCheck reads the cache and, when it is a day old or more, asks for the latest release in the background,
// saving what it finds. It answers nil when the notice is off.
func startUpdateCheck(c *cli.Context) *updateCheck {
	if noticeOff(c) != "" {
		return nil
	}
	path := updateCachePath(c.IO)
	if path == "" {
		return nil
	}
	var cache updateCache
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &cache)
	}
	u := &updateCheck{known: cache.Latest}
	at := now(c)
	if age := at.Sub(cache.CheckedAt); age >= 0 && age < updateCheckEvery {
		return u
	}
	if age := at.Sub(cache.AttemptedAt); age >= 0 && age < updateAttemptEvery {
		return u
	}
	attempted := cache
	attempted.AttemptedAt = at
	if raw, err := json.Marshal(attempted); err == nil && os.MkdirAll(filepath.Dir(path), 0o755) == nil {
		_ = cli.WriteFileAtomic(path, append(raw, '\n'), 0o644)
	}
	client := releaseClient(c)
	env := c.IO.Env
	clock := c.IO.Now
	if clock == nil {
		clock = time.Now
	}
	u.done = make(chan struct{})
	go func() {
		defer close(u.done)
		ctx, cancel := context.WithTimeout(context.Background(), updateCheckTimeout)
		defer cancel()
		timed := *client
		timed.Timeout = updateCheckTimeout
		latest, err := latestRelease(ctx, &timed, env)
		next := updateCache{CheckedAt: clock(), AttemptedAt: attempted.AttemptedAt, Latest: cache.Latest}
		if err == nil {
			next.Latest, u.latest = latest, latest
		}
		// A check that failed counts too, so a machine that is offline doesn't ask on every command.
		if raw, err := json.Marshal(next); err == nil && os.MkdirAll(filepath.Dir(path), 0o755) == nil {
			_ = cli.WriteFileAtomic(path, append(raw, '\n'), 0o644)
		}
	}()
	return u
}

// notice is the line to print when a newer release is known: the check's answer if it has finished, else the
// cache's. It never waits.
func (u *updateCheck) notice() string {
	latest := u.known
	if u.done != nil {
		// A moment's grace for a check under way, so it is saved; never longer, so no command waits on the network.
		t := time.NewTimer(updateGrace)
		defer t.Stop()
		select {
		case <-u.done:
			if u.latest != "" {
				latest = u.latest
			}
		case <-t.C:
		}
	}
	if !versionPattern.MatchString(latest) || compareVersions(Version, latest) >= 0 {
		return ""
	}
	return fmt.Sprintf("A new kantel is out: %s (you have %s). kantel update installs it.", latest, Version)
}

// beforeCommand starts the update check (Program.Before).
func beforeCommand(c *cli.Context) {
	if u := startUpdateCheck(c); u != nil {
		c.Values["updateCheck"] = u
	}
}

// afterCommand prints the update notice, if there is one (Program.After).
func afterCommand(c *cli.Context, _ int) {
	if u, ok := c.Values["updateCheck"].(*updateCheck); ok {
		if line := u.notice(); line != "" {
			fmt.Fprintln(c.IO.Stderr, c.ErrStyle.Paint(cli.Dim, line))
		}
	}
}
