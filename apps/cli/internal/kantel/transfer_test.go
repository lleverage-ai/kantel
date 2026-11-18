package kantel

import (
	"bytes"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
)

// gitEnv runs git as it comes: no one's global config (signing, hooks, renames), as a test user.
func gitEnv(t *testing.T) {
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
}

// gitIn runs git in dir, failing the test when it fails.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// files writes each file under dir, making its directories; each holds its own path.
func files(t *testing.T, dir string, paths ...string) {
	t.Helper()
	for _, p := range paths {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(p+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// space is a run's directories, as the TS tests have them: the working directory base, the home base/home and Kantel's
// config base/kantel.
func space(base string) opts {
	return opts{configDir: filepath.Join(base, "kantel"), cwd: base, home: filepath.Join(base, "home")}
}

type pushedResult struct {
	result
	written []string
}

// pushed pushes with args into an isolate, answering the paths it wrote.
func pushed(t *testing.T, o opts, args ...string) pushedResult {
	t.Helper()
	var mu sync.Mutex
	var paths []string
	o.routes = routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(nil) },
		"PUT /v1/sandboxes/sbx_test1/files": func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			paths = append(paths, bodyOf(c).Path)
			return map[string]any{"path": bodyOf(c).Path, "size": 1}
		},
	}
	r := run(t, append([]string{"push", "sbx_test1"}, args...), o)
	sort.Strings(paths)
	return pushedResult{r, paths}
}

func eqList(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	eq(t, what, strings.Join(got, ","), strings.Join(want, ","))
}

func TestPushSendsADirectorysFilesKeepingTheExecutableBit(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	files(t, dir, "src/a.ts", ".git/HEAD")
	_ = os.WriteFile(filepath.Join(dir, "src", "a.ts"), []byte("export {};\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "logo.bin"), []byte{0xff, 0x00, 0xfe}, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh\n"), 0o755)
	var mu sync.Mutex
	byPath := map[string]written{}
	o := space(base)
	o.routes = routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(nil) },
		"PUT /v1/sandboxes/sbx_test1/files": func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			w := bodyOf(c)
			byPath[w.Path] = w
			return map[string]any{"path": w.Path, "size": 1}
		},
	}
	r := run(t, []string{"push", "sbx_test1", "app"}, o)
	eq(t, "exit", r.Code, 0)
	contains(t, "stdout", r.Stdout, "Pushed 3 files")
	// An isolate keeps its files in /workspace, so that's where a relative destination lands.
	contains(t, "stdout", r.Stdout, "to /workspace/app.")
	var paths []string
	for p := range byPath {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	eqList(t, "paths", paths, "app/logo.bin", "app/run.sh", "app/src/a.ts")
	eq(t, "text", byPath["app/src/a.ts"], written{Path: "app/src/a.ts", Content: "export {};\n", Encoding: "utf8"})
	eq(t, "binary", byPath["app/logo.bin"].Content, "/wD+")
	eq(t, "binary encoding", byPath["app/logo.bin"].Encoding, "base64")
	eq(t, "mode", byPath["app/run.sh"].Mode, "0755")
}

func TestPushSendsAMicroVMOneGzippedTarInParts(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	long := strings.Repeat("deep/", 30) + "file.txt"
	files(t, dir, "src/a.ts", long)
	_ = os.WriteFile(filepath.Join(dir, "src", "a.ts"), []byte("export {};\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, long), []byte("long name\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "run.sh"), []byte("#!/bin/sh\n"), 0o755)
	// Incompressible, so the archive is cut into more than one part.
	big := make([]byte, 2*1024*1024)
	_, _ = rand.Read(big)
	_ = os.WriteFile(filepath.Join(dir, "big.bin"), big, 0o644)
	var mu sync.Mutex
	var parts []written
	var lines []string
	o := space(base)
	o.routes = routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(map[string]any{"type": "microvm"}) },
		"PUT /v1/sandboxes/sbx_test1/files": func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			parts = append(parts, bodyOf(c))
			return map[string]any{"path": bodyOf(c).Path, "size": 1}
		},
		commands: func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, c.Body["command"].(string))
			return command(nil)
		},
	}
	r := run(t, []string{"push", "sbx_test1", "app"}, o)
	eq(t, "exit", r.Code, 0)
	contains(t, "stdout", r.Stdout, "Pushed 4 files")
	contains(t, "stdout", r.Stdout, "to /home/user/app.")
	if len(parts) < 2 {
		t.Fatalf("%d parts", len(parts))
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].Path < parts[j].Path })
	name := regexp.MustCompile(`^/tmp/\.kantel-push-[0-9a-f]{12}-\d{6}$`)
	for _, p := range parts {
		if !name.MatchString(p.Path) {
			t.Errorf("part %q", p.Path)
		}
	}
	prefix := strings.TrimSuffix(parts[0].Path, "-000000")
	id := prefix[len(prefix)-12:]
	// It checks the destination, extracts into it where the files API would put it, and removes the parts.
	stage := "/home/user/app/.kantel-push-" + id
	eqList(t, "commands", lines,
		"mkdir -p /home/user/app && test -w /home/user/app && test -w /tmp && command -v tar >/dev/null && mv --help 2>&1 | grep -q -- --target-directory",
		"umask 022 && mkdir "+stage+" && cat "+prefix+"-* | tar -xzf - -C "+stage+" --no-same-owner --same-permissions && "+
			"(cd "+stage+" && find . -type d -exec sh -c '"+placeScript+"' /home/user/app "+id+" {} +); s=$?; rm -rf "+stage+"; exit $s",
		"rm -f "+prefix+"-*; true",
	)
	// The parts, joined in order, are a tar that tar itself extracts to the same tree.
	var archive bytes.Buffer
	for _, p := range parts {
		archive.Write(decoded(p))
	}
	out := filepath.Join(base, "out")
	_ = os.Mkdir(out, 0o755)
	tar := exec.Command("tar", "-xzf", "-", "-C", out)
	tar.Stdin = &archive
	if b, err := tar.CombinedOutput(); err != nil {
		t.Fatalf("tar: %v %s", err, b)
	}
	read := func(p string) string { b, _ := os.ReadFile(filepath.Join(out, p)); return string(b) }
	eq(t, "a.ts", read("src/a.ts"), "export {};\n")
	eq(t, "long", read(long), "long name\n")
	eq(t, "big", read("big.bin") == string(big), true)
	info, _ := os.Stat(filepath.Join(out, "run.sh"))
	eq(t, "run.sh mode", info.Mode().Perm(), os.FileMode(0o755))
	info, _ = os.Stat(filepath.Join(out, "src", "a.ts"))
	eq(t, "a.ts mode", info.Mode().Perm()&0o111, os.FileMode(0))
}

type microvmPush struct {
	result
	written, commands []string
}

// pushedToMicrovm pushes app/ (one small file) into a microVM whose routes overrides change.
func pushedToMicrovm(t *testing.T, overrides routes) microvmPush {
	t.Helper()
	base := t.TempDir()
	files(t, filepath.Join(base, "app"), "a.ts")
	var mu sync.Mutex
	var w, lines []string
	o := space(base)
	o.routes = routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(map[string]any{"type": "microvm"}) },
		"PUT /v1/sandboxes/sbx_test1/files": func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			w = append(w, bodyOf(c).Path)
			return map[string]any{"path": bodyOf(c).Path, "size": 1}
		},
		commands: func(c call) any {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, c.Body["command"].(string))
			return command(nil)
		},
	}
	for k, v := range overrides {
		inner := v
		o.routes[k] = func(c call) any {
			if k == commands {
				mu.Lock()
				lines = append(lines, c.Body["command"].(string))
				mu.Unlock()
			}
			return inner(c)
		}
	}
	r := run(t, []string{"push", "sbx_test1", "app"}, o)
	return microvmPush{r, w, lines}
}

func TestPushGoesFileByFileWhenItCantReadTheSandboxOrWriteTheDestination(t *testing.T) {
	unreadable := pushedToMicrovm(t, routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return kantelError(403, "forbidden", "This key can't read sandboxes") },
	})
	eq(t, "unreadable exit", unreadable.Code, 0)
	eqList(t, "unreadable written", unreadable.written, "app/a.ts")
	eq(t, "unreadable commands", len(unreadable.commands), 0)
	rootOwned := pushedToMicrovm(t, routes{
		commands: func(call) any { return command(map[string]any{"exitCode": 1, "stderr": "mkdir: Permission denied"}) },
	})
	eq(t, "root-owned exit", rootOwned.Code, 0)
	eqList(t, "root-owned written", rootOwned.written, "app/a.ts")
}

var cleanUp = regexp.MustCompile(`^rm -f /tmp/\.kantel-push-([0-9a-f]{12})-\*; rm -rf /home/user/app/\.kantel-push-([0-9a-f]{12}); find -L /home/user/app -name \.kantel-in-([0-9a-f]{12}) `)

func checkCleanUp(t *testing.T, line string) {
	t.Helper()
	m := cleanUp.FindStringSubmatch(line)
	if m == nil || m[1] != m[2] || m[1] != m[3] {
		t.Errorf("clean-up %q", line)
	}
}

func TestPushFallsBackWhenTheArchiveWontExtract(t *testing.T) {
	r := pushedToMicrovm(t, routes{
		commands: func(c call) any {
			if strings.Contains(c.Body["command"].(string), "tar -xzf") {
				return command(map[string]any{"exitCode": 2, "stderr": "tar: apps: Cannot mkdir: Permission denied"})
			}
			return command(nil)
		},
	})
	eq(t, "exit", r.Code, 0)
	contains(t, "stderr", r.Stderr, "couldn't be extracted")
	contains(t, "stderr", r.Stderr, "sending file by file")
	n := 0
	for _, w := range r.written {
		if w == "app/a.ts" {
			n++
		}
	}
	eq(t, "file by file", n, 1)
	checkCleanUp(t, r.commands[len(r.commands)-1])
}

func TestPushExtractsWhereTheFilesAPIWouldWrite(t *testing.T) {
	for to, where := range map[string]string{"/srv/link/../app": "/srv/app", "work/../app/": "/home/user/app"} {
		base := t.TempDir()
		files(t, filepath.Join(base, "app"), "a.ts")
		var mu sync.Mutex
		var lines []string
		o := space(base)
		o.routes = routes{
			"GET /v1/sandboxes/sbx_test1":       func(call) any { return sandbox(map[string]any{"type": "microvm"}) },
			"PUT /v1/sandboxes/sbx_test1/files": func(c call) any { return map[string]any{"path": bodyOf(c).Path, "size": 1} },
			commands: func(c call) any {
				mu.Lock()
				defer mu.Unlock()
				lines = append(lines, c.Body["command"].(string))
				return command(nil)
			},
		}
		r := run(t, []string{"push", "sbx_test1", "app", "--to", to}, o)
		eq(t, "exit", r.Code, 0)
		contains(t, "check", lines[0], "mkdir -p "+where+" && test -w "+where)
		contains(t, "extract", lines[1], "-C "+where+"/.kantel-push-")
		if !regexp.MustCompile(`' ` + regexp.QuoteMeta(where) + ` [0-9a-f]{12} \{\} \+`).MatchString(lines[1]) {
			t.Errorf("place: %q", lines[1])
		}
		if strings.Contains(strings.Join(lines, "\n"), "..") {
			t.Errorf("a .. in %q", lines)
		}
	}
}

func TestPushRemovesThePartsItSentWhenOneFails(t *testing.T) {
	writes := 0
	r := pushedToMicrovm(t, routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any {
			writes++
			return kantelError(507, "exhausted", "No space left on the sandbox's disk")
		},
	})
	if r.Code == 0 || writes == 0 {
		t.Errorf("exit %d after %d writes", r.Code, writes)
	}
	checkCleanUp(t, r.commands[len(r.commands)-1])
}

func TestPushLeavesCredentialsSignInsAndEnvFilesBehind(t *testing.T) {
	base := t.TempDir()
	files(t, filepath.Join(base, "app"), "src/a.ts", ".env", ".env.local", ".env.example", ".npmrc", "deep/.ssh/id_ed25519",
		"deep/.aws/credentials", ".docker/config.json", ".docker/daemon.json", ".claude/settings.json", "pkg/.netrc", "loud/.SSH/id_rsa")
	r := pushed(t, space(base), "app")
	eq(t, "exit", r.Code, 0)
	eqList(t, "written", r.written, "app/.docker/daemon.json", "app/.env.example", "app/src/a.ts")
	for _, line := range []string{
		"kantel: left out .claude (an agent's sign-in and settings)",
		"kantel: left out .docker/config.json (credentials)",
		"kantel: left out .env (an environment file)",
		"kantel: left out .env.local (an environment file)",
		"kantel: left out .npmrc (it can hold a registry token)",
		"kantel: left out deep/.aws (credentials)",
		"kantel: left out deep/.ssh (credentials)",
		"kantel: left out pkg/.netrc (credentials)",
		"kantel: left out loud/.SSH (credentials)",
		"kantel: --no-default-excludes sends",
	} {
		contains(t, "stderr", r.Stderr, line)
	}
	all := pushed(t, space(base), "app", "--no-default-excludes")
	eq(t, "all exit", all.Code, 0)
	contains(t, "all", strings.Join(all.written, ","), "app/deep/.ssh/id_ed25519")
	contains(t, "all", strings.Join(all.written, ","), "app/.env,")
	if strings.Contains(all.Stderr, "left out") {
		t.Errorf("left out with --no-default-excludes: %q", all.Stderr)
	}
}

func TestPushInGitSendsTrackedSettingsNeverCredentialsOrLinksOut(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	dir := filepath.Join(base, "repo")
	files(t, dir, ".claude/settings.json", ".claude/settings.local.json", ".env", ".env.local", ".ssh/config", "a.ts")
	files(t, filepath.Join(base, "elsewhere"), "x")
	symlink(t, filepath.Join(base, "elsewhere", "x"), filepath.Join(dir, "x-link"))
	symlink(t, filepath.Join(dir, ".ssh", "config"), filepath.Join(dir, "ssh-link"))
	symlink(t, filepath.Join(dir, ".env.local"), filepath.Join(dir, "env-link"))
	symlink(t, filepath.Join(dir, "a.ts"), filepath.Join(dir, "a-link.ts"))
	gitIn(t, dir, "init", "-q")
	gitIn(t, dir, "add", "a.ts", ".claude/settings.json", ".env", ".ssh/config", "x-link", "ssh-link", "env-link", "a-link.ts")
	r := pushed(t, space(base), "repo")
	eq(t, "exit", r.Code, 0)
	eqList(t, "written", r.written, "repo/.claude/settings.json", "repo/.env", "repo/a-link.ts", "repo/a.ts")
	contains(t, "stderr", r.Stderr, "kantel: left out .claude/settings.local.json (an agent's sign-in and settings)")
	contains(t, "stderr", r.Stderr, "kantel: left out .ssh (credentials)")
	contains(t, "stderr", r.Stderr, "kantel: left out x-link (a link to outside the directory)")
	contains(t, "stderr", r.Stderr, "kantel: left out ssh-link (a link to .ssh, credentials)")
	// Git tracks the link, not the untracked file it points to.
	contains(t, "stderr", r.Stderr, "kantel: left out env-link (a link to .env.local, an environment file)")

	// A directory in the repository named like one push leaves out is pushed by its tracked files.
	claude := pushed(t, space(base), "repo/.claude")
	eq(t, "claude exit", claude.Code, 0)
	eqList(t, "claude", claude.written, ".claude/settings.json")
	contains(t, "claude stderr", claude.Stderr, "kantel: left out settings.local.json (an agent's sign-in and settings)")

	// A link out of the tree stays here even for someone who means the rest.
	all := pushed(t, space(base), "repo", "--no-default-excludes")
	contains(t, "all", strings.Join(all.written, ","), "repo/.ssh/config")
	if strings.Contains(strings.Join(all.written, ","), "repo/x-link") {
		t.Error("sent x-link")
	}
}

func TestPushRefusesTheHomeDirectoryWithoutAllowHome(t *testing.T) {
	base := t.TempDir()
	files(t, filepath.Join(base, "home"), "notes.txt", ".ssh/id_ed25519")
	home := pushed(t, space(base), "home")
	eq(t, "home exit", home.Code, 1)
	contains(t, "home", home.Stderr, "is your home directory: push a project directory, or add --allow-home")
	eq(t, "home written", len(home.written), 0)
	above := pushed(t, space(base), ".")
	eq(t, "above exit", above.Code, 1)
	contains(t, "above", above.Stderr, "holds your home directory")

	allowed := pushed(t, space(base), "home", "--allow-home")
	eq(t, "allowed exit", allowed.Code, 0)
	eqList(t, "allowed", allowed.written, "home/notes.txt")

	tree := filepath.Join(base, "tree")
	config := filepath.Join(tree, ".config", "kantel")
	files(t, tree, "a.txt", ".config/other.json")
	files(t, config, "ssh/known_hosts")
	_ = os.WriteFile(filepath.Join(config, "config.json"), []byte("{}\n"), 0o600)
	withConfig := space(base)
	withConfig.configDir = config
	holding := pushed(t, withConfig, "tree")
	eq(t, "holding exit", holding.Code, 1)
	contains(t, "holding", holding.Stderr, "holds Kantel's config directory")
	rest := pushed(t, withConfig, "tree", "--allow-home", "--no-default-excludes")
	eq(t, "rest exit", rest.Code, 0)
	eqList(t, "rest", rest.written, "tree/.config/other.json", "tree/a.txt")
	contains(t, "rest stderr", rest.Stderr, "kantel: left out .config/kantel (Kantel's config, with your API key)")
	inside := pushed(t, withConfig, "tree/.config/kantel", "--allow-home", "--no-default-excludes")
	eq(t, "inside exit", inside.Code, 1)
	contains(t, "inside", inside.Stderr, "is in Kantel's config directory")
	eq(t, "inside written", len(inside.written), 0)
}

func TestPushRefusesADirectoryInsideOneItLeavesOut(t *testing.T) {
	base := t.TempDir()
	files(t, filepath.Join(base, "elsewhere"), ".ssh/id_ed25519", ".ssh/keys/old", ".docker/config.json", ".docker/a.json")
	for _, dir := range []string{"elsewhere/.ssh", "elsewhere/.ssh/keys"} {
		refused := pushed(t, space(base), dir)
		eq(t, dir+" exit", refused.Code, 1)
		contains(t, dir, refused.Stderr, "one push leaves out (credentials): add --no-default-excludes")
		eq(t, dir+" written", len(refused.written), 0)
	}
	eqList(t, "meant", pushed(t, space(base), "elsewhere/.ssh", "--no-default-excludes").written, ".ssh/id_ed25519", ".ssh/keys/old")
	docker := pushed(t, space(base), "elsewhere/.docker")
	eqList(t, "docker", docker.written, ".docker/a.json")
	contains(t, "docker", docker.Stderr, "kantel: left out config.json (credentials)")
}

func TestPushClassifiesFilesUnderWhatLeadsToTheRoot(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	// A root deeper in an agent directory, in a repository: its untracked files still stay behind.
	repo := filepath.Join(base, "repo")
	files(t, repo, ".cursor/rules.md", ".cursor/User/settings.json", ".cursor/User/auth.json", "a.ts")
	gitIn(t, repo, "init", "-q")
	gitIn(t, repo, "add", ".cursor/rules.md", ".cursor/User/settings.json", "a.ts")
	deeper := pushed(t, space(base), "repo/.cursor/User")
	eq(t, "deeper exit", deeper.Code, 0)
	eqList(t, "deeper", deeper.written, "User/settings.json")
	contains(t, "deeper", deeper.Stderr, "kantel: left out auth.json (an agent's sign-in and settings)")

	// A root named .docker through a link, outside and inside a repository.
	files(t, filepath.Join(base, "elsewhere", "docker-files"), "config.json", "daemon.json")
	symlink(t, filepath.Join(base, "elsewhere", "docker-files"), filepath.Join(base, "elsewhere", ".docker"))
	linked := pushed(t, space(base), "elsewhere/.docker")
	eq(t, "linked exit", linked.Code, 0)
	eqList(t, "linked", linked.written, ".docker/daemon.json")
	contains(t, "linked", linked.Stderr, "kantel: left out config.json (credentials)")
	eqList(t, "meant", pushed(t, space(base), "elsewhere/.docker", "--no-default-excludes").written, ".docker/config.json", ".docker/daemon.json")
	files(t, filepath.Join(repo, "docker-files"), "config.json", "daemon.json")
	symlink(t, filepath.Join(repo, "docker-files"), filepath.Join(repo, ".docker"))
	gitIn(t, repo, "add", "docker-files")
	linkedInRepo := pushed(t, space(base), "repo/.docker")
	eqList(t, "linked in repo", linkedInRepo.written, ".docker/daemon.json")
	contains(t, "linked in repo", linkedInRepo.Stderr, "kantel: left out config.json (credentials)")

	// A separate worktree in .claude/worktrees is a project of its own: its new files go, its .env doesn't.
	outer := filepath.Join(base, "outer")
	worktree := filepath.Join(outer, ".claude", "worktrees", "wt")
	files(t, outer, "README.md")
	files(t, worktree, "a.ts", "new.ts", ".env")
	gitIn(t, outer, "init", "-q")
	gitIn(t, worktree, "init", "-q")
	gitIn(t, worktree, "add", "a.ts")
	separate := pushed(t, space(base), worktree)
	eq(t, "separate exit", separate.Code, 0)
	eqList(t, "separate", separate.written, "wt/a.ts", "wt/new.ts")
	contains(t, "separate", separate.Stderr, "kantel: left out .env (an environment file)")

	// The same worktree through a link in another project's .claude: still a project of its own.
	_ = os.MkdirAll(filepath.Join(repo, ".claude", "worktrees"), 0o755)
	symlink(t, worktree, filepath.Join(repo, ".claude", "worktrees", "wt"))
	throughLink := pushed(t, space(base), "repo/.claude/worktrees/wt")
	eq(t, "through link exit", throughLink.Code, 0)
	eqList(t, "through link", throughLink.written, "wt/a.ts", "wt/new.ts")

	// An agent directory that is a link, above the root: what's under it still counts as its.
	linkedAgent := filepath.Join(base, "linked-agent")
	files(t, linkedAgent, "editor-state/User/settings.json", "editor-state/User/auth.json", "a.ts")
	symlink(t, filepath.Join(linkedAgent, "editor-state"), filepath.Join(linkedAgent, ".cursor"))
	gitIn(t, linkedAgent, "init", "-q")
	gitIn(t, linkedAgent, "add", "editor-state/User/settings.json", "a.ts")
	throughAgentLink := pushed(t, space(base), "linked-agent/.cursor/User")
	eq(t, "agent link exit", throughAgentLink.Code, 0)
	eqList(t, "agent link", throughAgentLink.written, "User/settings.json")
	contains(t, "agent link", throughAgentLink.Stderr, "kantel: left out auth.json (an agent's sign-in and settings)")

	// A repository whose top is .docker itself.
	dockerRepo := filepath.Join(base, "docker-home", ".docker")
	files(t, dockerRepo, "config.json", "daemon.json")
	gitIn(t, dockerRepo, "init", "-q")
	dockerTop := pushed(t, space(base), "docker-home/.docker")
	eq(t, "docker top exit", dockerTop.Code, 0)
	eqList(t, "docker top", dockerTop.written, ".docker/daemon.json")
	contains(t, "docker top", dockerTop.Stderr, "kantel: left out config.json (credentials)")
}
