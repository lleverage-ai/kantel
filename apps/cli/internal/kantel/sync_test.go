package kantel

// kantel sync --git: the patch made here, the base chosen, and a whole sync into a "sandbox" that is a second clone
// on this machine, its commands run by sh as a microVM would run them.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

// repositories is a repository at root/local with one commit, and root/sandbox, a clone of it: the sandbox's checkout.
func repositories(t *testing.T) (root, local, sandboxDir, base string) {
	t.Helper()
	gitEnv(t)
	root = t.TempDir()
	local = filepath.Join(root, "local")
	_ = os.MkdirAll(filepath.Join(local, "src"), 0o755)
	gitIn(t, local, "init", "-q", "-b", "main")
	write(t, filepath.Join(local, ".gitignore"), "node_modules/\n*.log\n")
	write(t, filepath.Join(local, "src", "a.ts"), "export const a = 1;\n")
	write(t, filepath.Join(local, "src", "gone.ts"), "export {};\n")
	write(t, filepath.Join(local, "run.sh"), "#!/bin/sh\necho hi\n")
	write(t, filepath.Join(local, "logo.bin"), string([]byte{0, 1, 2, 3, 255, 254, 0, 0}))
	gitIn(t, local, "add", "-A")
	gitIn(t, local, "commit", "-q", "-m", "base")
	base = gitIn(t, local, "rev-parse", "HEAD")
	sandboxDir = filepath.Join(root, "sandbox")
	gitIn(t, root, "clone", "-q", local, sandboxDir)
	return
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func missing(t *testing.T, p string) {
	t.Helper()
	if _, err := os.Lstat(p); err == nil {
		t.Errorf("%s is there", p)
	}
}

// edit edits the working tree at local: a change, a deletion, a new file, an ignored one, a binary and a mode change.
func edit(t *testing.T, local string) {
	write(t, filepath.Join(local, "src", "a.ts"), "export const a = 2;\n")
	_ = os.Remove(filepath.Join(local, "src", "gone.ts"))
	write(t, filepath.Join(local, "src", "new", "b.ts"), "export const b = 'new';\n")
	write(t, filepath.Join(local, "debug.log"), "ignored\n")
	write(t, filepath.Join(local, "node_modules", "x", "index.js"), "ignored\n")
	logo := make([]byte, 4096)
	for i := range logo {
		logo[i] = byte((i * 7) % 256)
	}
	write(t, filepath.Join(local, "logo.bin"), string(logo))
	_ = os.Chmod(filepath.Join(local, "run.sh"), 0o755)
	symlink(t, "src/a.ts", filepath.Join(local, "link.ts"))
}

// workingTree is a tree's ID as git would commit the working tree at dir (every untracked, unignored file added).
func workingTree(t *testing.T, dir string) string {
	t.Helper()
	index := filepath.Join(t.TempDir(), "index")
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index)
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	run("read-tree", "HEAD")
	run("add", "-A")
	return run("write-tree")
}

// shSandbox is a sandbox whose commands run here with sh and whose files are written here, as the files API would in
// the microVM. It was made from snap_1, labelled labels (none: the snapshot is gone).
type shSandbox struct {
	labels  map[string]string
	typ     string
	rewrite func(string) string
	mu      sync.Mutex
	// commands and written are what it was asked to run and write.
	commands, written []string
}

func (s *shSandbox) routes() routes { return s.routesFor("sbx_test1") }

func (s *shSandbox) routesFor(id string) routes {
	typ := s.typ
	if typ == "" {
		typ = "microvm"
	}
	return routes{
		"GET /v1/sandboxes/" + id: func(call) any {
			return sandbox(map[string]any{"type": typ, "source": map[string]any{"snapshotId": "snap_1"}})
		},
		"GET /v1/snapshots/snap_1": func(call) any {
			if s.labels == nil {
				return kantelError(404, "not_found", "no snapshot")
			}
			return map[string]any{"id": "snap_1", "kind": "saved", "name": "app-warm", "labels": s.labels}
		},
		"PUT /v1/sandboxes/" + id + "/files": func(c call) any {
			w := bodyOf(c)
			s.mu.Lock()
			s.written = append(s.written, w.Path)
			s.mu.Unlock()
			_ = os.WriteFile(w.Path, decoded(w), 0o644)
			return map[string]any{"path": w.Path, "size": 1}
		},
		"POST /v1/sandboxes/" + id + "/commands": func(c call) any {
			line := c.Body["command"].(string)
			s.mu.Lock()
			s.commands = append(s.commands, line)
			s.mu.Unlock()
			if s.rewrite != nil {
				line = s.rewrite(line)
			}
			cmd := exec.Command("sh", "-c", line)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			code := 0
			if err := cmd.Run(); err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					return kantelError(500, "internal", err.Error())
				}
				code = exit.ExitCode()
			}
			return command(map[string]any{"exitCode": code, "stdout": stdout.String(), "stderr": stderr.String()})
		},
	}
}

// client is a client of a fake Kantel with s's routes.
func (s *shSandbox) client(t *testing.T) *api.Client {
	f := newFake(t, s.routesFor("sbx_1"))
	return &api.Client{BaseURL: f.server.URL + "/v1", HTTP: f.server.Client(), RetryDelays: []time.Duration{}}
}

func syncInto(t *testing.T, s *shSandbox, o syncOptions) (*synced, error) {
	return syncGit(context.Background(), s.client(t), "sbx_1", o)
}

func wantError(t *testing.T, err error, pattern string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error; wanted %q", pattern)
	}
	if !regexp.MustCompile(pattern).MatchString(err.Error()) {
		t.Errorf("error %q doesn't match %q", err, pattern)
	}
}

func TestTheBase(t *testing.T) {
	co := checkout{Top: "/home/user/app", Recorded: "c2", Head: "c4"}
	label := &baseLabelled{Commit: "c3", Snapshot: "app-warm"}
	b, _ := chooseBase("c1", co, label, "sbx_1")
	eq(t, "flag", b, chosenBase{Commit: "c1", Source: baseFromFlag, From: "--base"})
	b, _ = chooseBase("", co, label, "sbx_1")
	eq(t, "file", b.Source, baseFromFile)
	eq(t, "file commit", b.Commit, "c2")
	b, _ = chooseBase("", checkout{Top: co.Top, Head: "c4"}, label, "sbx_1")
	eq(t, "label", b, chosenBase{Commit: "c3", Source: baseFromLabel, From: "the git.base label on app-warm"})
	b, _ = chooseBase("", checkout{Top: co.Top, Head: "c4"}, nil, "sbx_1")
	eq(t, "head", b.Source, baseFromHead)
	_, err := chooseBase("", checkout{Top: co.Top}, nil, "sbx_1")
	wantError(t, err, `^/home/user/app in sbx_1 has no base commit recorded: .*--base <commit>, or copy the whole tree with kantel push$`)

	_, local, _, base := repositories(t)
	full, err := resolveLocalBase(local, chosenBase{Commit: base[:8], Source: baseFromLabel, From: "x"})
	eq(t, "full", full, base)
	missingCommit := "0123456789abcdef0123456789abcdef01234567"
	_, err = resolveLocalBase(local, chosenBase{Commit: missingCommit, Source: baseFromFile, From: "its .kantel-base-sha"})
	wantError(t, err, regexp.QuoteMeta("the base commit "+missingCommit+" (its .kantel-base-sha) isn't in your repository at "+local+": fetch it (git fetch origin "+missingCommit+")"))

	eq(t, "default", defaultCheckout("/Users/me/src/lleverage"), "/home/user/lleverage")
	eq(t, "to", checkoutPath("app"), "/home/user/app")
	eq(t, "to ~", checkoutPath("~/app"), "/home/user/app")
	eq(t, "to ..", checkoutPath("/srv/app/../app"), "/srv/app")
}

func TestThePatchHoldsEveryKindOfChangeAndNotIgnoredFiles(t *testing.T) {
	root, local, sandboxDir, base := repositories(t)
	edit(t, local)
	status := gitIn(t, local, "status", "--porcelain")
	before := read(t, filepath.Join(local, ".git", "index"))
	patch, err := buildPatch(local, base, patchOptions{DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	// Your index stays as it was.
	eq(t, "index", read(t, filepath.Join(local, ".git", "index")) == before, true)
	eq(t, "status", gitIn(t, local, "status", "--porcelain"), status)
	eq(t, "tree", patch.Tree, workingTree(t, local))
	eq(t, "files", patch.Files, 6)
	eq(t, "skipped", len(patch.Skipped), 0)
	text := string(patch.Patch)
	contains(t, "patch", text, "GIT binary patch")
	contains(t, "patch", text, "old mode 100644\nnew mode 100755")
	if strings.Contains(text, "debug.log") || strings.Contains(text, "node_modules") {
		t.Error("ignored files in the patch")
	}
	// Applied to a clone at the base, it gives the same tree.
	file := filepath.Join(root, "p.patch")
	_ = os.WriteFile(file, patch.Patch, 0o644)
	gitIn(t, sandboxDir, "apply", "--index", file)
	eq(t, "applied", gitIn(t, sandboxDir, "write-tree"), patch.Tree)
	eq(t, "logo", read(t, filepath.Join(sandboxDir, "logo.bin")), read(t, filepath.Join(local, "logo.bin")))
}

func TestThePatchSeesARacilyCleanChange(t *testing.T) {
	_, local, _, base := repositories(t)
	file := filepath.Join(local, "src", "a.ts")
	then := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = os.Chtimes(file, then, then)
	gitIn(t, local, "update-index", "-q", "--really-refresh")
	// Changed at the same size in the same second, and the index written in that second too.
	write(t, file, "export const a = 2;\n")
	_ = os.Chtimes(file, then, then)
	_ = os.Chtimes(filepath.Join(local, ".git", "index"), then, then)
	patch, err := buildPatch(local, base, patchOptions{DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "files", patch.Files, 1)
	contains(t, "patch", string(patch.Patch), "+export const a = 2;")
}

func TestThePatchIsEmptyAtTheBaseAndTakesCommitsSince(t *testing.T) {
	_, local, _, base := repositories(t)
	patch, _ := buildPatch(local, base, patchOptions{DefaultExcludes: true})
	eq(t, "empty", len(patch.Patch), 0)
	eq(t, "files", patch.Files, 0)
	eq(t, "tree", patch.Tree, gitIn(t, local, "rev-parse", "HEAD^{tree}"))

	write(t, filepath.Join(local, "committed.ts"), "1\n")
	gitIn(t, local, "add", "committed.ts")
	gitIn(t, local, "commit", "-q", "-m", "later")
	write(t, filepath.Join(local, "staged.ts"), "2\n")
	gitIn(t, local, "add", "staged.ts")
	patch, _ = buildPatch(local, base, patchOptions{DefaultExcludes: true})
	eq(t, "tree since", patch.Tree, workingTree(t, local))
	eq(t, "files since", patch.Files, 2)
}

func skippedPaths(s []skipped) string {
	var out []string
	for _, x := range s {
		out = append(out, x.Path)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

func TestThePatchLeavesNewEnvFilesAndSettingsAtTheBase(t *testing.T) {
	_, local, _, base := repositories(t)
	write(t, filepath.Join(local, ".env.local"), "SECRET=1\n")
	write(t, filepath.Join(local, ".env.example"), "SECRET=\n")
	write(t, filepath.Join(local, ".claude", "settings.local.json"), "{}\n")
	patch, _ := buildPatch(local, base, patchOptions{DefaultExcludes: true})
	text := string(patch.Patch)
	contains(t, "patch", text, ".env.example")
	if strings.Contains(text, ".env.local") || strings.Contains(text, "settings.local.json") {
		t.Error("sent what it leaves out")
	}
	eq(t, "skipped", skippedPaths(patch.Skipped), ".claude/settings.local.json,.env.local")
	eq(t, "files", patch.Files, 1)
	all, _ := buildPatch(local, base, patchOptions{DefaultExcludes: false})
	eq(t, "all files", all.Files, 3)
	eq(t, "all tree", all.Tree, workingTree(t, local))
}

func TestThePatchKeepsWhatItLeavesOutOutOfTheRepositorysObjects(t *testing.T) {
	root, local, sandboxDir, base := repositories(t)
	config := filepath.Join(local, ".config", "kantel")
	secrets := map[string]string{".env": "SECRET=one\n", ".config/kantel/config.json": `{"apiKey":"ksk_two"}` + "\n"}
	for p, content := range secrets {
		write(t, filepath.Join(local, p), content)
	}
	write(t, filepath.Join(local, "src", "a.ts"), "export const a = 'sent';\n")
	objects := func() string {
		return regexp.MustCompile(`(?m)^count: (\d+)`).FindStringSubmatch(gitIn(t, local, "count-objects", "-v"))[1]
	}
	before := objects()
	patch, err := buildPatch(local, base, patchOptions{DefaultExcludes: true, Keep: []string{config}})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "skipped", skippedPaths(patch.Skipped), ".config/kantel,.env")
	for _, content := range secrets {
		cmd := exec.Command("git", "hash-object", "--stdin")
		cmd.Dir, cmd.Stdin = local, strings.NewReader(content)
		id, _ := cmd.Output()
		if exec.Command("git", "-C", local, "cat-file", "-e", strings.TrimSpace(string(id))).Run() == nil {
			t.Errorf("%q is in the repository's objects", content)
		}
	}
	if exec.Command("git", "-C", local, "cat-file", "-e", patch.Tree).Run() == nil {
		t.Error("the tree is in the repository's objects")
	}
	eq(t, "objects", objects(), before)
	// It still applies, the base's blobs read from the repository's own objects.
	_ = os.WriteFile(filepath.Join(root, "p.patch"), patch.Patch, 0o644)
	gitIn(t, sandboxDir, "apply", "--index", filepath.Join(root, "p.patch"))
	eq(t, "applied", gitIn(t, sandboxDir, "write-tree"), patch.Tree)
}

func TestThePatchIgnoresTheUsersDiffSettings(t *testing.T) {
	root, local, sandboxDir, _ := repositories(t)
	write(t, filepath.Join(local, "src", "a.ts"), "1\n2\n3\n4\n5\n6\n7\n")
	gitIn(t, local, "commit", "-qam", "longer")
	gitIn(t, sandboxDir, "fetch", "-q", local, "main")
	gitIn(t, sandboxDir, "reset", "-q", "--hard", "FETCH_HEAD")
	longer := gitIn(t, local, "rev-parse", "HEAD")
	write(t, filepath.Join(local, "src", "a.ts"), "1\n2\n3\nfour\n5\n6\n7\n")
	for _, kv := range [][2]string{{"diff.context", "0"}, {"diff.noprefix", "true"}, {"diff.mnemonicPrefix", "true"},
		{"diff.relative", "true"}, {"diff.external", "false"}, {"color.diff", "always"}} {
		gitIn(t, local, "config", kv[0], kv[1])
	}
	patch, _ := buildPatch(local, longer, patchOptions{DefaultExcludes: true})
	contains(t, "patch", string(patch.Patch), "@@ -1,7 +1,7 @@")
	_ = os.WriteFile(filepath.Join(root, "p.patch"), patch.Patch, 0o644)
	gitIn(t, sandboxDir, "apply", "--index", filepath.Join(root, "p.patch"))
	eq(t, "applied", gitIn(t, sandboxDir, "write-tree"), patch.Tree)
}

func TestThePatchLeavesKantelsConfigWhateverTheExcludes(t *testing.T) {
	_, local, _, base := repositories(t)
	config := filepath.Join(local, ".config", "kantel")
	write(t, filepath.Join(config, "config.json"), `{"apiKey":"ksk_secret"}`+"\n")
	write(t, filepath.Join(local, ".config", "other.json"), "{}\n")
	for _, defaultExcludes := range []bool{true, false} {
		patch, _ := buildPatch(local, base, patchOptions{DefaultExcludes: defaultExcludes, Keep: []string{config}})
		if strings.Contains(string(patch.Patch), "ksk_secret") {
			t.Error("sent the key")
		}
		contains(t, "patch", string(patch.Patch), ".config/other.json")
		eq(t, "skipped", jsonOf(t, patch.Skipped), `[{"path":".config/kantel","why":"Kantel's config, with your API key"}]`)
	}
}

func TestThePatchClassifiesUnderTheRepositorysName(t *testing.T) {
	gitEnv(t)
	docker := filepath.Join(t.TempDir(), ".docker")
	write(t, filepath.Join(docker, "a.json"), "{}\n")
	gitIn(t, docker, "init", "-q")
	gitIn(t, docker, "add", "-A")
	gitIn(t, docker, "commit", "-q", "-m", "base")
	base := gitIn(t, docker, "rev-parse", "HEAD")
	write(t, filepath.Join(docker, "config.json"), `{"auths":{"r":{"auth":"c2VjcmV0"}}}`+"\n")
	patch, _ := buildPatch(docker, base, patchOptions{DefaultExcludes: true})
	eq(t, "files", patch.Files, 0)
	eq(t, "skipped", jsonOf(t, patch.Skipped), `[{"path":"config.json","why":"credentials","byDefault":true}]`)
	all, _ := buildPatch(docker, base, patchOptions{DefaultExcludes: false})
	contains(t, "all", string(all.Patch), "c2VjcmV0")
}

func TestThePatchLeavesOutARepositoryInsideTheTree(t *testing.T) {
	_, local, _, base := repositories(t)
	lib := filepath.Join(local, "vendor", "lib")
	_ = os.MkdirAll(lib, 0o755)
	gitIn(t, lib, "init", "-q")
	write(t, filepath.Join(lib, "x.ts"), "x\n")
	patch, _ := buildPatch(local, base, patchOptions{DefaultExcludes: true})
	eq(t, "skipped", jsonOf(t, patch.Skipped), `[{"path":"vendor/lib","why":"a git repository of its own"}]`)
	eq(t, "files", patch.Files, 0)
}

func TestASyncBringsTheCheckoutToTheWorkingTree(t *testing.T) {
	_, local, sandboxDir, base := repositories(t)
	edit(t, local)
	// The sandbox has moved on: a commit of its own, a change, an untracked file, and its ignored node_modules.
	write(t, filepath.Join(sandboxDir, "theirs.ts"), "x\n")
	gitIn(t, sandboxDir, "add", "theirs.ts")
	gitIn(t, sandboxDir, "commit", "-q", "-m", "theirs")
	write(t, filepath.Join(sandboxDir, "src", "a.ts"), "dirty\n")
	write(t, filepath.Join(sandboxDir, "scratch.txt"), "untracked\n")
	write(t, filepath.Join(sandboxDir, "node_modules", "dep", "index.js"), "kept\n")
	write(t, filepath.Join(sandboxDir, ".kantel-base-sha"), base+"\n")
	s := &shSandbox{}
	got, err := syncInto(t, s, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "path", got.Path, sandboxDir)
	eq(t, "base", got.Base, base)
	eq(t, "source", got.BaseSource, baseFromFile)
	eq(t, "files", got.Files, 6)
	eq(t, "tree", got.Tree, workingTree(t, local))
	eq(t, "their tree", gitIn(t, sandboxDir, "write-tree"), got.Tree)
	eq(t, "their HEAD", gitIn(t, sandboxDir, "rev-parse", "HEAD"), base)
	// Staged, as git apply --index leaves it, with nothing else changed or untracked.
	lines := strings.Split(gitIn(t, sandboxDir, "status", "--porcelain"), "\n")
	sort.Strings(lines)
	eq(t, "status", strings.Join(lines, "|"), "?? .kantel-base-sha|A  link.ts|A  src/new/b.ts|D  src/gone.ts|M  logo.bin|M  run.sh|M  src/a.ts")
	eq(t, "a.ts", read(t, filepath.Join(sandboxDir, "src", "a.ts")), "export const a = 2;\n")
	info, _ := os.Stat(filepath.Join(sandboxDir, "run.sh"))
	if info.Mode()&0o111 == 0 {
		t.Error("run.sh isn't executable")
	}
	missing(t, filepath.Join(sandboxDir, "scratch.txt"))
	missing(t, filepath.Join(sandboxDir, "theirs.ts"))
	eq(t, "node_modules", read(t, filepath.Join(sandboxDir, "node_modules", "dep", "index.js")), "kept\n")
	eq(t, "base file", read(t, filepath.Join(sandboxDir, ".kantel-base-sha")), base+"\n")
	// The patch went up in parts under /tmp, which the sandbox side removed.
	if len(s.written) == 0 {
		t.Error("no parts")
	}
	for _, p := range s.written {
		if !regexp.MustCompile(`^/tmp/\.kantel-sync-[0-9a-f]{12}-\d{6}$`).MatchString(p) {
			t.Errorf("part %q", p)
		}
		missing(t, p)
	}
	eq(t, "commands", len(s.commands), 2)

}

func TestASyncWithNothingNewSendsNothing(t *testing.T) {
	_, local, sandboxDir, base := repositories(t)
	write(t, filepath.Join(sandboxDir, "scratch.txt"), "untracked\n")
	s := &shSandbox{}
	got, err := syncInto(t, s, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "base", got.Base, base)
	eq(t, "source", got.BaseSource, baseFromHead)
	eq(t, "files", got.Files, 0)
	eq(t, "patch", got.PatchBytes, 0)
	eq(t, "written", len(s.written), 0)
	missing(t, filepath.Join(sandboxDir, "scratch.txt"))
}

func TestASyncKeepsFilesIgnoredByARuleAddedSince(t *testing.T) {
	_, local, sandboxDir, base := repositories(t)
	write(t, filepath.Join(sandboxDir, ".kantel-base-sha"), base+"\n")
	write(t, filepath.Join(local, ".gitignore"), "node_modules/\n*.log\n.cache/\n.env.local\n")
	if _, err := syncInto(t, &shSandbox{}, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true}); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(sandboxDir, ".cache", "build.bin"), "cached\n")
	write(t, filepath.Join(sandboxDir, ".env.local"), "SECRET=1\n")
	write(t, filepath.Join(sandboxDir, "scratch.txt"), "untracked\n")
	write(t, filepath.Join(local, "src", "a.ts"), "export const a = 'again';\n")
	again, err := syncInto(t, &shSandbox{}, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "tree", gitIn(t, sandboxDir, "write-tree"), again.Tree)
	eq(t, "cache", read(t, filepath.Join(sandboxDir, ".cache", "build.bin")), "cached\n")
	eq(t, "env", read(t, filepath.Join(sandboxDir, ".env.local")), "SECRET=1\n")
	missing(t, filepath.Join(sandboxDir, "scratch.txt"))
}

func TestSyncsIntoOneCheckoutTakeTurns(t *testing.T) {
	root, local, sandboxDir, base := repositories(t)
	other := filepath.Join(root, "other")
	gitIn(t, root, "clone", "-q", local, other)
	write(t, filepath.Join(local, "mine.ts"), "1\n")
	write(t, filepath.Join(other, "theirs.ts"), "2\n")
	// Each sync's apply waits a moment after its reset, so without the lock both resets come before either apply.
	slow := &shSandbox{rewrite: func(c string) string { return strings.Replace(c, "cat /tmp/", "sleep 0.5; cat /tmp/", 1) }}
	o := syncOptions{To: sandboxDir, Base: base, DefaultExcludes: true}
	var mine, theirs *synced
	var wg sync.WaitGroup
	wg.Go(func() {
		m := o
		m.Top = local
		mine, _ = syncInto(t, slow, m)
	})
	wg.Go(func() {
		m := o
		m.Top = other
		theirs, _ = syncInto(t, slow, m)
	})
	wg.Wait()
	if mine == nil || theirs == nil {
		t.Fatal("a sync failed")
	}
	now := gitIn(t, sandboxDir, "write-tree")
	if now != mine.Tree && now != theirs.Tree {
		t.Errorf("tree %s is neither", now)
	}
	// A lock held elsewhere makes the next one wait, and it goes once that ends.
	lock := filepath.Join(sandboxDir, ".git", "kantel-sync.lock")
	holder := exec.Command("flock", lock, "sleep", "1")
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	started := time.Now()
	m := o
	m.Top = local
	if _, err := syncInto(t, &shSandbox{}, m); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) < 800*time.Millisecond {
		t.Errorf("didn't wait: %v", time.Since(started))
	}
	_ = holder.Wait()
	eq(t, "tree", gitIn(t, sandboxDir, "write-tree"), mine.Tree)
}

func TestSyncChangesNothingWithoutFlock(t *testing.T) {
	_, local, sandboxDir, _ := repositories(t)
	write(t, filepath.Join(sandboxDir, "scratch.txt"), "untracked\n")
	write(t, filepath.Join(local, "mine.ts"), "1\n")
	noFlock := func(c string) string { return strings.ReplaceAll(c, "command -v flock", "command -v no-such-flock") }
	probed := &shSandbox{rewrite: noFlock}
	_, err := syncInto(t, probed, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	wantError(t, err, "sbx_1 has no flock, which sync --git needs so two syncs into one checkout take turns")
	eq(t, "written", len(probed.written), 0)
	// Gone between the look and the sync: the script itself stops before it changes anything.
	late := &shSandbox{rewrite: func(c string) string {
		if strings.Contains(c, "flock -w") {
			return noFlock(c)
		}
		return c
	}}
	_, err = syncInto(t, late, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	wantError(t, err, "sbx_1 has no flock, which sync --git needs: install util-linux there")
	eq(t, "scratch", read(t, filepath.Join(sandboxDir, "scratch.txt")), "untracked\n")
	for _, p := range late.written {
		missing(t, p)
	}
}

func TestSyncTakesTheBaseFromTheSnapshotsLabel(t *testing.T) {
	_, local, sandboxDir, base := repositories(t)
	write(t, filepath.Join(sandboxDir, "theirs.ts"), "x\n")
	gitIn(t, sandboxDir, "add", "theirs.ts")
	gitIn(t, sandboxDir, "commit", "-q", "-m", "theirs")
	write(t, filepath.Join(local, "mine.ts"), "y\n")
	got, err := syncInto(t, &shSandbox{labels: map[string]string{"git.base": base[:12]}}, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "base", got.Base, base)
	eq(t, "source", got.BaseSource, baseFromLabel)
	eq(t, "files", got.Files, 1)
	eq(t, "HEAD", gitIn(t, sandboxDir, "rev-parse", "HEAD"), base)
}

func TestSyncRefusesABaseEitherSideLacks(t *testing.T) {
	_, local, sandboxDir, _ := repositories(t)
	write(t, filepath.Join(local, "later.ts"), "1\n")
	gitIn(t, local, "add", "later.ts")
	gitIn(t, local, "commit", "-q", "-m", "later")
	later := gitIn(t, local, "rev-parse", "HEAD")
	s := &shSandbox{}
	_, err := syncInto(t, s, syncOptions{Top: local, To: sandboxDir, Base: later, DefaultExcludes: true})
	wantError(t, err, regexp.QuoteMeta("the base commit "+later[:10]+" (--base) isn't in "+sandboxDir+" in sbx_1: fetch it there"))
	// Nothing was reset, and the parts are gone.
	eq(t, "status", gitIn(t, sandboxDir, "status", "--porcelain"), "")
	for _, p := range s.written {
		missing(t, p)
	}

	_, local, sandboxDir, _ = repositories(t)
	write(t, filepath.Join(sandboxDir, "theirs.ts"), "x\n")
	gitIn(t, sandboxDir, "add", "theirs.ts")
	gitIn(t, sandboxDir, "commit", "-q", "-m", "theirs")
	theirs := gitIn(t, sandboxDir, "rev-parse", "HEAD")
	_, err = syncInto(t, &shSandbox{}, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	wantError(t, err, regexp.QuoteMeta("the base commit "+theirs+" (its HEAD) isn't in your repository at "+local+": fetch it (git fetch origin "+theirs+")"))
}

func TestSyncRefusesNoBaseNoCheckoutAndAnIsolate(t *testing.T) {
	root, local, _, _ := repositories(t)
	empty := filepath.Join(root, "empty")
	_ = os.Mkdir(empty, 0o755)
	gitIn(t, empty, "init", "-q")
	_, err := syncInto(t, &shSandbox{}, syncOptions{Top: local, To: empty, DefaultExcludes: true})
	wantError(t, err, regexp.QuoteMeta(empty+" in sbx_1 has no base commit recorded"))
	plain := filepath.Join(root, "plain")
	_ = os.Mkdir(plain, 0o755)
	_, err = syncInto(t, &shSandbox{}, syncOptions{Top: local, To: plain, DefaultExcludes: true})
	wantError(t, err, regexp.QuoteMeta(plain+" in sbx_1 isn't a git checkout"))
	nowhere := filepath.Join(root, "nowhere")
	_, err = syncInto(t, &shSandbox{}, syncOptions{Top: local, To: nowhere, DefaultExcludes: true})
	wantError(t, err, regexp.QuoteMeta(nowhere+" isn't in sbx_1: sync --git needs a clone of this repository there"))
	_, err = syncInto(t, &shSandbox{typ: "isolate"}, syncOptions{Top: local, To: plain, DefaultExcludes: true})
	wantError(t, err, "sbx_1 is an isolate: sync --git needs a microVM")
}

func TestSyncSaysWhenThePatchDoesntApplyOrTheTreesDiffer(t *testing.T) {
	_, local, sandboxDir, base := repositories(t)
	write(t, filepath.Join(local, "src", "a.ts"), "export const a = 3;\n")
	// A patch cut short on the way.
	cut := &shSandbox{rewrite: func(c string) string { return strings.Replace(c, "gzip -dc >", "gzip -dc | head -c 120 >", 1) }}
	_, err := syncInto(t, cut, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	wantError(t, err, `(?s)^the patch didn't apply to `+regexp.QuoteMeta(sandboxDir)+` in sbx_1: .*It's left at `+base[:10]+`, with nothing applied$`)
	for _, p := range cut.written {
		missing(t, p)
	}
	// A change git apply doesn't make: a file staged on the sandbox's side after it.
	extra := &shSandbox{rewrite: func(c string) string {
		return strings.Replace(c, "t=$(git write-tree)", "echo extra > extra.ts && git add extra.ts; t=$(git write-tree)", 1)
	}}
	_, err = syncInto(t, extra, syncOptions{Top: local, To: sandboxDir, DefaultExcludes: true})
	wantError(t, err, `^after the patch `+regexp.QuoteMeta(sandboxDir)+` in sbx_1 has tree [0-9a-f]{10}, not this working tree's [0-9a-f]{10}: A {2}extra\.ts`)
}

func TestSendingThePatchStopsAfterAFailedPart(t *testing.T) {
	var mu sync.Mutex
	started, settled := 0, 0
	f := newFake(t, routes{"PUT /v1/sandboxes/sbx_1/files": func(c call) any {
		mu.Lock()
		started++
		mu.Unlock()
		first := strings.HasSuffix(bodyOf(c).Path, "-000000")
		if first {
			time.Sleep(5 * time.Millisecond)
		} else {
			time.Sleep(300 * time.Millisecond)
		}
		mu.Lock()
		settled++
		mu.Unlock()
		if first {
			return kantelError(400, "invalid", "part 0 failed")
		}
		return map[string]any{"path": "x", "size": 0}
	}})
	client := &api.Client{BaseURL: f.server.URL + "/v1", HTTP: f.server.Client()}
	_, err := sendParts(context.Background(), client, "sbx_1", "/tmp/.kantel-sync-x", bytes.Repeat([]byte{1}, partSize*20))
	wantError(t, err, "part 0 failed")
	// The six that started at once all landed or failed before it answered, and none started after the failure.
	mu.Lock()
	eq(t, "settled", settled, started)
	eq(t, "started", started, 6)
	mu.Unlock()
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	eq(t, "none after", started, 6)
	mu.Unlock()
}

func TestTheSandboxSide(t *testing.T) {
	script := applyScript("/home/user/my app", strings.Repeat("b", 40), strings.Repeat("t", 40), "/tmp/.kantel-sync-abc-*", "/tmp/.kantel-sync-abc.patch")
	contains(t, "cd", script, "cd '/home/user/my app' || exit 1; ")
	contains(t, "no lock", script, "command -v flock >/dev/null || { rm -f /tmp/.kantel-sync-abc-* /tmp/.kantel-sync-abc.patch; exit 47; }")
	contains(t, "busy", script, "flock -w 300 9 || { rm -f /tmp/.kantel-sync-abc-* /tmp/.kantel-sync-abc.patch; exit 46; }")
	contains(t, "reset", script, "git clean -fdq -e /.kantel-base-sha && git reset -q --hard "+strings.Repeat("b", 40))
	contains(t, "apply", script, "cat /tmp/.kantel-sync-abc-* | gzip -dc > /tmp/.kantel-sync-abc.patch && git apply --index --whitespace=nowarn /tmp/.kantel-sync-abc.patch")
	contains(t, "tree", script, `[ "$t" = `+strings.Repeat("t", 40)+` ]`)
	eq(t, "clean-ups", strings.Count(script, "rm -f /tmp/.kantel-sync-abc-* /tmp/.kantel-sync-abc.patch"), 6)
}

// The command itself, as the TS CLI's tests run it.

func syncedRun(t *testing.T, s *shSandbox, base string, args []string, cwd, config string) result {
	t.Helper()
	o := space(base)
	o.cwd = cwd
	if config != "" {
		o.configDir = config
	}
	o.routes = s.routes()
	return run(t, append([]string{"sync", "sbx_test1"}, args...), o)
}

// cloned is a repository at local with one commit, and a clone of it at co, the sandbox's.
func cloned(t *testing.T, base, local, co string) string {
	t.Helper()
	write(t, filepath.Join(local, "a.ts"), "1\n")
	gitIn(t, local, "init", "-q")
	gitIn(t, local, "add", "-A")
	gitIn(t, local, "commit", "-q", "-m", "base")
	gitIn(t, base, "clone", "-q", local, co)
	return gitIn(t, local, "rev-parse", "HEAD")
}

func TestSyncGitSendsAPatchAgainstTheSnapshotsBase(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	local := filepath.Join(base, "repo")
	write(t, filepath.Join(local, ".gitignore"), "node_modules/\n")
	commit := cloned(t, base, local, filepath.Join(base, "checkout"))
	co := filepath.Join(base, "checkout")
	// The sandbox's HEAD has moved on; the label still names the base.
	write(t, filepath.Join(co, "theirs.ts"), "x\n")
	gitIn(t, co, "add", "theirs.ts")
	gitIn(t, co, "commit", "-q", "-m", "theirs")
	write(t, filepath.Join(co, "node_modules", "dep.js"), "kept\n")
	write(t, filepath.Join(local, "a.ts"), "2\n")
	write(t, filepath.Join(local, "src", "b.ts"), "new\n")
	write(t, filepath.Join(local, ".env"), "SECRET=1\n")
	labels := map[string]string{"git.base": commit}

	r := syncedRun(t, &shSandbox{labels: labels}, base, []string{"--git", "src", "--to", co}, local, "")
	eq(t, "exit", r.Code, 0)
	if !regexp.MustCompile(`^Synced ` + regexp.QuoteMeta(co) + ` in sbx_test1 \(2 files changed: a \d+ B patch, \d+ B sent\) on ` + commit[:10] +
		` \(its snapshot's git\.base\) in \d+\.\d s\. Both trees are [0-9a-f]{10}\.\n$`).MatchString(r.Stdout) {
		t.Errorf("stdout %q", r.Stdout)
	}
	contains(t, "stderr", r.Stderr, "kantel: left out .env (an environment file)")
	contains(t, "stderr", r.Stderr, "kantel: --no-default-excludes sends credentials, sign-ins and .env files too")
	eq(t, "HEAD", gitIn(t, co, "rev-parse", "HEAD"), commit)
	eq(t, "a.ts", read(t, filepath.Join(co, "a.ts")), "2\n")
	eq(t, "b.ts", read(t, filepath.Join(co, "src", "b.ts")), "new\n")
	eq(t, "kept", read(t, filepath.Join(co, "node_modules", "dep.js")), "kept\n")
	missing(t, filepath.Join(co, "theirs.ts"))
	missing(t, filepath.Join(co, ".env"))

	j := syncedRun(t, &shSandbox{labels: labels}, base, []string{"--git", "--to", co, "--json"}, local, "")
	eq(t, "json exit", j.Code, 0)
	var answer map[string]any
	if err := json.Unmarshal([]byte(j.Stdout), &answer); err != nil {
		t.Fatal(err)
	}
	eq(t, "sandboxId", answer["sandboxId"], any("sbx_test1"))
	eq(t, "path", answer["path"], any(co))
	eq(t, "base", answer["base"], any(commit))
	eq(t, "baseSource", answer["baseSource"], any("label"))
	eq(t, "files", answer["files"], any(float64(2)))
	eq(t, "tree", answer["tree"], any(gitIn(t, co, "write-tree")))
	contains(t, "timings", j.Stdout, `"timings": {
    "probeMs": `)
	if !regexp.MustCompile(`"probeMs"[^}]*"patchMs"[^}]*"uploadMs"[^}]*"applyMs"[^}]*"totalMs"`).MatchString(j.Stdout) {
		t.Errorf("timings %s", j.Stdout)
	}
}

func TestSyncRefusesARepositoryAsPushRefusesADirectory(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	// The home is a repository, with Kantel's config in it.
	home := filepath.Join(base, "home")
	co := filepath.Join(base, "checkout")
	commit := cloned(t, base, home, co)
	config := filepath.Join(home, ".config", "kantel")
	write(t, filepath.Join(config, "config.json"), `{"apiKey":"ksk_secret"}`+"\n")
	write(t, filepath.Join(home, "a.ts"), "2\n")
	refused := syncedRun(t, &shSandbox{}, base, []string{"--git", "--to", co, "--base", commit}, home, config)
	eq(t, "refused exit", refused.Code, 1)
	contains(t, "refused", refused.Stderr, "is your home directory: sync a project repository, or add --allow-home")
	eq(t, "refused calls", len(refused.Calls), 0)
	r := syncedRun(t, &shSandbox{}, base, []string{"--git", "--to", co, "--base", commit, "--allow-home", "--no-default-excludes"},
		filepath.Join(home, ".config"), config)
	eq(t, "exit", r.Code, 0)
	contains(t, "stderr", r.Stderr, "kantel: left out .config/kantel (Kantel's config, with your API key)")
	eq(t, "a.ts", read(t, filepath.Join(co, "a.ts")), "2\n")
	missing(t, filepath.Join(co, ".config", "kantel", "config.json"))
	for _, c := range r.Calls {
		if c.Method == "PUT" && strings.Contains(string(decoded(bodyOf(c))), "ksk_secret") {
			t.Error("sent the key")
		}
	}

	// A repository in .ssh, named from a directory in it.
	keys := filepath.Join(base, ".ssh", "keys")
	cloned(t, base, keys, filepath.Join(base, "keys-checkout"))
	_ = os.Mkdir(filepath.Join(keys, "sub"), 0o755)
	ssh := syncedRun(t, &shSandbox{}, base, []string{"--git", "sub"}, keys, "")
	eq(t, "ssh exit", ssh.Code, 1)
	contains(t, "ssh", ssh.Stderr, "is in ")
	contains(t, "ssh", ssh.Stderr, "one sync leaves out (credentials): add --no-default-excludes if you mean it")
	eq(t, "ssh calls", len(ssh.Calls), 0)

	// A repository named .docker: its changed config.json stays behind.
	docker := filepath.Join(base, ".docker")
	dockerCheckout := filepath.Join(base, "docker-checkout")
	cloned(t, base, docker, dockerCheckout)
	write(t, filepath.Join(docker, "config.json"), `{"auths":{"r":{"auth":"c2VjcmV0"}}}`+"\n")
	auth := syncedRun(t, &shSandbox{}, base, []string{"--git", "--to", dockerCheckout}, docker, "")
	eq(t, "docker exit", auth.Code, 0)
	contains(t, "docker", auth.Stderr, "kantel: left out config.json (credentials)")
	missing(t, filepath.Join(dockerCheckout, "config.json"))
}

func TestSyncWorksFromAWorktreeInClaudeWorktrees(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	project := filepath.Join(base, "project")
	co := filepath.Join(base, "checkout")
	cloned(t, base, project, co)
	worktree := filepath.Join(project, ".claude", "worktrees", "fix")
	gitIn(t, project, "worktree", "add", "-q", worktree)
	write(t, filepath.Join(worktree, "a.ts"), "from the worktree\n")
	write(t, filepath.Join(worktree, "b.ts"), "new\n")
	r := syncedRun(t, &shSandbox{}, base, []string{"--git", "--to", co}, worktree, "")
	eq(t, "exit", r.Code, 0)
	contains(t, "stdout", r.Stdout, "(2 files changed:")
	eq(t, "a.ts", read(t, filepath.Join(co, "a.ts")), "from the worktree\n")
	eq(t, "b.ts", read(t, filepath.Join(co, "b.ts")), "new\n")
}

func TestSyncNeedsGitAWorkingTreeAndNoOtherArguments(t *testing.T) {
	gitEnv(t)
	base := t.TempDir()
	bare := run(t, []string{"sync", "sbx_test1"}, space(base))
	eq(t, "bare exit", bare.Code, 2)
	contains(t, "bare", bare.Stderr, "sync works as a git patch for now: add --git")
	plain := filepath.Join(base, "plain")
	_ = os.Mkdir(plain, 0o755)
	outside := run(t, []string{"sync", "sbx_test1", plain, "--git"}, space(base))
	eq(t, "outside exit", outside.Code, 1)
	contains(t, "outside", outside.Stderr, plain+" isn't in a git working tree")
	eq(t, "calls", len(bare.Calls)+len(outside.Calls), 0)
	if !regexp.MustCompile(`(?m)^ {2}sync <id> \[dir\] {2,}Bring a git checkout in a microVM`).MatchString(run(t, []string{"help"}, opts{}).Stdout) {
		t.Error("sync isn't in the help")
	}
	extra := run(t, []string{"sync", "sbx_test1", "a", "b", "--git"}, space(base))
	eq(t, "extra exit", extra.Code, 2)
}
