package kantel

// kantel sync <id> --git: brings a git checkout in a microVM to this working tree by sending one patch against the
// commit the checkout started from, rather than every file as kantel push does. The sandbox's clone, its node_modules
// and its build caches stay; only the difference goes over.
//
// Here, in a copy of the index (yours is never touched): git add -u and the new files .gitignore doesn't leave out,
// then git write-tree names the tree the sandbox must end with, and git diff-tree --binary <base> <tree> is the patch.
// There, in one command: git reset --hard <base>, git clean -fd (ignored files stay), git apply --index and git
// write-tree, which must name the same tree, or sync fails.

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

const (
	// baseLabel is the snapshot label that names a checkout's base commit, as the saved-snapshots guide suggests.
	baseLabel = "git.base"
	// baseFile is the file in a checkout that records its base commit, where its HEAD may have moved on.
	baseFile = ".kantel-base-sha"
	// applyTimeoutMs is the sandbox side's time limit: a reset of a big checkout with a stale index reads every file.
	applyTimeoutMs = 600_000
	// lockWaitSeconds is how long the sandbox side waits for another sync into the same checkout to finish.
	lockWaitSeconds = 300
)

// Exit codes of the sandbox side, each a failure sync explains.
const (
	exitNoBase   = 41
	exitReset    = 42
	exitApply    = 43
	exitTree     = 44
	exitWorktree = 45
	exitBusy     = 46
	exitNoLock   = 47
)

func short(commit string) string {
	if len(commit) > 10 {
		return commit[:10]
	}
	return commit
}

// gitOut is git's stdout, or a failure with its stderr.
func gitOut(cwd string, args []string, env []string, input *string) ([]byte, error) {
	run, err := runGit(cwd, args, env, input)
	if err != nil {
		return nil, cli.Fail("couldn't run git (" + err.Error() + "): kantel sync --git needs git on your PATH")
	}
	if run.code != 0 {
		why := run.stderr
		if why == "" {
			why = fmt.Sprintf("it exited %d", run.code)
		}
		return nil, cli.Fail("git " + args[0] + " failed in " + cwd + ": " + why)
	}
	return run.stdout, nil
}

// repositoryTop is the top of the working tree dir is in; a failure outside one.
func repositoryTop(dir string) (string, error) {
	run, err := runGit(dir, []string{"rev-parse", "--show-toplevel"}, nil, nil)
	if err != nil {
		return "", cli.Fail("couldn't run git (" + err.Error() + "): kantel sync --git needs git on your PATH")
	}
	top := strings.TrimSpace(string(run.stdout))
	if run.code != 0 || top == "" {
		return "", cli.Fail(dir + " isn't in a git working tree: sync --git sends a patch of one; kantel push copies any directory")
	}
	return resolvePath(dir, top), nil
}

// baseSource is where a base commit came from.
type baseSource string

const (
	baseFromFlag  baseSource = "flag"
	baseFromFile  baseSource = "file"
	baseFromLabel baseSource = "label"
	baseFromHead  baseSource = "head"
)

// chosenBase is the commit to sync against.
type chosenBase struct {
	// Commit is as recorded: maybe abbreviated.
	Commit string
	Source baseSource
	// From is in words, for messages: its .kantel-base-sha, the git.base label on lleverage-checks-warm.
	From string
}

// checkout is what the sandbox says about its checkout.
type checkout struct {
	// Top is the checkout's top in the sandbox.
	Top string
	// Head is its HEAD, if it has a commit checked out.
	Head string
	// Recorded is what its .kantel-base-sha holds.
	Recorded string
}

// baseLabelled is a git.base label and the snapshot it is on.
type baseLabelled struct{ Commit, Snapshot string }

// chooseBase is the commit to sync against: --base, else the checkout's .kantel-base-sha (its own record, where its
// HEAD has moved on), else the git.base label on the snapshot the sandbox was made from, else the checkout's HEAD.
func chooseBase(flag string, co checkout, label *baseLabelled, sandboxID string) (chosenBase, error) {
	switch {
	case flag != "":
		return chosenBase{Commit: flag, Source: baseFromFlag, From: "--base"}, nil
	case co.Recorded != "":
		return chosenBase{Commit: co.Recorded, Source: baseFromFile, From: "its " + baseFile}, nil
	case label != nil && label.Commit != "":
		return chosenBase{Commit: label.Commit, Source: baseFromLabel, From: "the " + baseLabel + " label on " + label.Snapshot}, nil
	case co.Head != "":
		return chosenBase{Commit: co.Head, Source: baseFromHead, From: "its HEAD"}, nil
	}
	return chosenBase{}, cli.Fail(fmt.Sprintf("%s in %s has no base commit recorded: no %s in it, no %s "+
		"label on the snapshot the sandbox was made from, and no commit checked out. Give one with --base <commit>, "+
		"or copy the whole tree with kantel push", co.Top, sandboxID, baseFile, baseLabel))
}

var (
	fullCommit = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	sha1Commit = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// resolveLocalBase is base as a full commit ID in the repository at top; a failure when it isn't there.
func resolveLocalBase(top string, base chosenBase) (string, error) {
	run, err := runGit(top, []string{"rev-parse", "--verify", "--quiet", base.Commit + "^{commit}"}, nil, nil)
	if err != nil {
		return "", cli.Fail("couldn't run git (" + err.Error() + "): kantel sync --git needs git on your PATH")
	}
	commit := strings.TrimSpace(string(run.stdout))
	if run.code != 0 || !fullCommit.MatchString(commit) {
		fetch := "git fetch origin"
		if sha1Commit.MatchString(base.Commit) {
			fetch = "git fetch origin " + base.Commit
		}
		return "", cli.Fail(fmt.Sprintf("the base commit %s (%s) isn't in your repository at %s: fetch it (%s) "+
			"and sync again, give another with --base, or copy the whole tree with kantel push", base.Commit, base.From, top, fetch))
	}
	return commit, nil
}

// localPatch is the patch from a base to the working tree.
type localPatch struct {
	// Base is the base, in full.
	Base string
	// Tree is the tree the sandbox's index must end with: this working tree, less anything left out.
	Tree string
	// Patch is a binary-safe patch from the base to that tree; empty when they're the same.
	Patch []byte
	// Files is how many paths differ from the base.
	Files   int
	Skipped []skipped
}

// alternate is p as one entry of GIT_ALTERNATE_OBJECT_DIRECTORIES, which git C-quotes when it holds the separator.
func alternate(p string) string {
	if strings.Contains(p, string(os.PathListSeparator)) || strings.HasPrefix(p, `"`) {
		quoted, _ := json.Marshal(p)
		return string(quoted)
	}
	return p
}

// patchOptions say what buildPatch leaves out.
type patchOptions struct {
	DefaultExcludes bool
	// Keep are absolute directories whose files stay at the base's version whatever the excludes.
	Keep []string
	// Contexts lead to top; default its own name, as a repository's top is named.
	Contexts []string
}

// buildPatch is the patch from base to the working tree at top: tracked changes (deletions and mode changes included)
// and the new files .gitignore doesn't leave out, staged in a copy of the index so yours stays as it is. With
// DefaultExcludes, the files push leaves out stay at the base's version: credentials, and untracked agents' sign-ins,
// .npmrc and .env files, classified under Contexts as push does. Files in Keep stay at the base's version whatever the
// excludes. A repository of its own inside the tree isn't sent.
func buildPatch(top, base string, o patchOptions) (*localPatch, error) {
	scratch, err := os.MkdirTemp("", "kantel-sync-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(scratch)
	index := filepath.Join(scratch, "index")
	gitPath := func(name string) (string, error) {
		out, err := gitOut(top, []string{"rev-parse", "--git-path", name}, nil, nil)
		if err != nil {
			return "", err
		}
		return resolvePath(top, strings.TrimSpace(string(out))), nil
	}
	own, err := gitPath("index")
	if err != nil {
		return nil, err
	}
	// The blobs and trees it writes go to its own object directory, which only this user can read and which goes with
	// it, so a credential it leaves out isn't kept in the repository's; the repository's are read through it.
	objects := filepath.Join(scratch, "objects")
	if err := os.Mkdir(objects, 0o700); err != nil {
		return nil, err
	}
	repoObjects, err := gitPath("objects")
	if err != nil {
		return nil, err
	}
	env := []string{
		"GIT_INDEX_FILE=" + index,
		"GIT_OBJECT_DIRECTORY=" + objects,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + alternate(repoObjects),
		"GIT_LITERAL_PATHSPECS=1",
		"GIT_OPTIONAL_LOCKS=0",
	}
	git := func(input *string, args ...string) ([]byte, error) { return gitOut(top, args, env, input) }
	if info, err := os.Stat(own); err != nil {
		if _, err := git(nil, "read-tree", base); err != nil { // A repository with no index yet.
			return nil, err
		}
	} else {
		// A copy keeps the index's file stats, so add -u reads only the files that changed. It keeps the index's time
		// too, or a file changed in the second the index was written, at the same size, would look unchanged: git tells
		// those "racily clean" entries by comparing them with the index file's own time.
		if err := copyFile(own, index); err != nil {
			return nil, err
		}
		if err := os.Chtimes(index, info.ModTime(), info.ModTime()); err != nil {
			return nil, err
		}
	}
	if _, err := git(nil, "add", "-u"); err != nil {
		return nil, err
	}
	left := map[string]skipped{}
	var fresh []string
	out, err := git(nil, "ls-files", "-z", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	for _, p := range nul(out) {
		// A repository inside the tree is listed as its directory: git would add it as a link to a commit.
		if strings.HasSuffix(p, "/") {
			left[p] = skipped{Path: strings.TrimSuffix(p, "/"), Why: "a git repository of its own"}
		} else {
			fresh = append(fresh, p)
		}
	}
	if len(fresh) > 0 {
		input := strings.Join(fresh, "\x00") + "\x00"
		if _, err := git(&input, "add", "--pathspec-from-file=-", "--pathspec-file-nul"); err != nil {
			return nil, err
		}
	}
	writeTree := func() (string, error) {
		out, err := git(nil, "write-tree")
		return strings.TrimSpace(string(out)), err
	}
	tree, err := writeTree()
	if err != nil {
		return nil, err
	}
	changedIn := func(to string) ([]string, error) {
		out, err := git(nil, "diff-tree", "-r", "--no-renames", "-z", "--name-only", base, to)
		return nul(out), err
	}
	changed, err := changedIn(tree)
	if err != nil {
		return nil, err
	}
	contexts := o.Contexts
	if contexts == nil {
		contexts = rootContexts(top, top)
	}
	// The kept directories as paths in the repository, from where they resolve: .config/kantel.
	realTop := realPath(top)
	var kept []string
	for _, dir := range o.Keep {
		if real := realPath(dir); within(real, realTop) {
			rel, _ := filepath.Rel(realTop, real)
			if rel == "." {
				rel = ""
			}
			kept = append(kept, filepath.ToSlash(rel))
		}
	}
	keptBy := func(p string) (string, bool) {
		for _, dir := range kept {
			if dir == "" || p == dir || strings.HasPrefix(p, dir+"/") {
				return dir, true
			}
		}
		return "", false
	}
	isFresh := map[string]bool{}
	for _, p := range fresh {
		isFresh[p] = true
	}
	var back []string
	for _, p := range changed {
		var found *skipped
		if dir, ok := keptBy(p); ok {
			named := dir
			if named == "" {
				named = p
			}
			found = &skipped{Path: named, Why: "Kantel's config, with your API key"}
		} else if o.DefaultExcludes {
			found = excludedUnder(contexts, p, trackedOf(!isFresh[p]))
		}
		if found == nil {
			continue
		}
		back = append(back, p)
		left[found.Path] = *found
	}
	if len(back) > 0 {
		// Back to the base's version, or out of the index where the base has none.
		input := strings.Join(back, "\x00") + "\x00"
		if _, err := git(&input, "reset", "-q", base, "--pathspec-from-file=-", "--pathspec-file-nul"); err != nil {
			return nil, err
		}
		if tree, err = writeTree(); err != nil {
			return nil, err
		}
		if changed, err = changedIn(tree); err != nil {
			return nil, err
		}
	}
	var patch []byte
	if len(changed) > 0 {
		patch, err = git(nil, "diff-tree", "-r", "-p", "--binary", "--full-index", "--unified=3", "-M", "--no-color",
			"--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", base, tree)
		if err != nil {
			return nil, err
		}
	}
	return &localPatch{Base: base, Tree: tree, Patch: patch, Files: len(changed), Skipped: sortSkipped(left)}, nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// remoteResult is what a command in the sandbox printed.
type remoteResult struct {
	ExitCode       int64
	Stdout, Stderr string
}

// remoteRun runs a command in the sandbox; a failure when it ended for a reason sync has no words for.
func remoteRun(ctx context.Context, client *api.Client, sandboxID, command string, timeoutMs int64) (remoteResult, error) {
	result, err := client.RunCommand(ctx, sandboxID, api.RunCommandBody{Command: command, TimeoutMs: &timeoutMs})
	if err != nil {
		return remoteResult{}, err
	}
	if result.State != api.CommandStateExited || result.ExitCode == nil {
		why := strings.TrimSpace(result.Stderr)
		if why == "" {
			why = "no output"
		}
		return remoteResult{}, cli.Fail(fmt.Sprintf("a command in %s ended %s: %s", sandboxID, result.State, why))
	}
	return remoteResult{ExitCode: *result.ExitCode, Stdout: result.Stdout, Stderr: strings.TrimSpace(result.Stderr)}, nil
}

// probeCheckout is the checkout at p in the sandbox (absolute): its top, HEAD and recorded base.
func probeCheckout(ctx context.Context, client *api.Client, sandboxID, p string) (checkout, error) {
	command := "cd " + ShellQuote(p) + " 2>/dev/null || { echo missing; exit 0; }; " +
		"top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo not-git; exit 0; }; " +
		`echo "top=$top"; echo "head=$(git rev-parse -q --verify HEAD 2>/dev/null)"; ` +
		`echo "recorded=$(head -c 200 "$top"/` + baseFile + ` 2>/dev/null | tr -d '[:space:]')"; ` +
		"command -v gzip >/dev/null && echo gzip=yes; command -v flock >/dev/null && echo flock=yes; true"
	r, err := remoteRun(ctx, client, sandboxID, command, 60_000)
	if err != nil {
		return checkout{}, err
	}
	if r.ExitCode != 0 {
		why := r.Stderr
		if why == "" {
			why = fmt.Sprintf("exit %d", r.ExitCode)
		}
		return checkout{}, cli.Fail(fmt.Sprintf("couldn't look at %s in %s: %s", p, sandboxID, why))
	}
	first, _, _ := strings.Cut(strings.TrimSpace(r.Stdout), "\n")
	switch first {
	case "missing":
		return checkout{}, cli.Fail(fmt.Sprintf("%s isn't in %s: sync --git needs a clone of this repository there (--to names another "+
			"path); kantel push copies the whole tree", p, sandboxID))
	case "not-git":
		return checkout{}, cli.Fail(fmt.Sprintf("%s in %s isn't a git checkout: sync --git needs a clone of this repository there; kantel "+
			"push copies the whole tree", p, sandboxID))
	}
	values := map[string]string{}
	for _, line := range strings.Split(r.Stdout, "\n") {
		if at := strings.Index(line, "="); at > 0 {
			values[line[:at]] = strings.TrimSpace(line[at+1:])
		}
	}
	if values["gzip"] != "yes" {
		return checkout{}, cli.Fail(sandboxID + " has no gzip, which sync --git needs")
	}
	if values["flock"] != "yes" {
		return checkout{}, cli.Fail(sandboxID + " has no flock, which sync --git needs so two syncs into one checkout take turns: install " +
			"util-linux there (apt-get install util-linux)")
	}
	top := values["top"]
	if top == "" {
		top = p
	}
	return checkout{Top: top, Head: values["head"], Recorded: values["recorded"]}, nil
}

// labelledBase is the git.base label on the snapshot sandbox was made from, if it has one. A snapshot that's gone, or
// a key that can't read snapshots, has none to give.
func labelledBase(ctx context.Context, client *api.Client, sandbox *api.Sandbox) (*baseLabelled, error) {
	if sandbox == nil || sandbox.Source == nil || sandbox.Source.SnapshotID == nil {
		return nil, nil
	}
	snapshot, err := client.GetSnapshot(ctx, *sandbox.Source.SnapshotID)
	if err != nil {
		var apiErr *api.Error
		if errors.As(err, &apiErr) && (apiErr.Code == "not_found" || apiErr.Code == "forbidden") {
			return nil, nil
		}
		return nil, err
	}
	commit := strings.TrimSpace(snapshot.Labels[baseLabel])
	if commit == "" {
		return nil, nil
	}
	name := snapshot.ID
	if snapshot.Name != nil {
		name = *snapshot.Name
	}
	return &baseLabelled{Commit: commit, Snapshot: name}, nil
}

// applyScript is the sandbox side: one command that cleans, resets, applies and checks the tree. It holds a lock in
// the checkout's git directory throughout, with flock, so two syncs into one checkout take turns; the lock goes when
// the command ends, however it ends. Without flock it changes nothing. parts is the patch's parts' glob, or "" when
// there is no patch.
func applyScript(top, base, tree, parts, patch string) string {
	cleanUp, apply := "", ""
	if parts != "" {
		cleanUp = "rm -f " + parts + " " + ShellQuote(patch) + "; "
		apply = "cat " + parts + " | gzip -dc > " + ShellQuote(patch) + " && git apply --index --whitespace=nowarn " + ShellQuote(patch) +
			" || " + fmt.Sprintf("{ %sexit %d; }; ", cleanUp, exitApply) + cleanUp
	}
	return "cd " + ShellQuote(top) + " || exit 1; " +
		`lock=$(git rev-parse --git-path kantel-sync.lock) && exec 9>"$lock" || exit 1; ` +
		fmt.Sprintf("command -v flock >/dev/null || { %sexit %d; }; ", cleanUp, exitNoLock) +
		fmt.Sprintf("flock -w %d 9 || { %sexit %d; }; ", lockWaitSeconds, cleanUp, exitBusy) +
		fmt.Sprintf("git cat-file -e %s^{commit} 2>/dev/null || { %sexit %d; }; ", base, cleanUp, exitNoBase) +
		// Clean first, by the ignore rules the checkout has now: after the reset the base's would count, and a file
		// ignored by a rule added since would go. A fork's files have new inodes, so reset reads them all again.
		fmt.Sprintf("git clean -fdq -e /%s && git reset -q --hard %s || { %sexit %d; }; ", baseFile, base, cleanUp, exitReset) +
		apply +
		fmt.Sprintf(`t=$(git write-tree) || exit %d; echo "tree=$t"; `, exitTree) +
		fmt.Sprintf(`[ "$t" = %s ] || { git status --short | head -20 >&2; exit %d; }; `, tree, exitTree) +
		fmt.Sprintf("git diff --quiet || { git diff --stat | tail -20 >&2; exit %d; }", exitWorktree)
}

// sendParts sends content to the sandbox in parts under prefix, a few at a time, and answers how many. After a part
// fails no more start, and every one under way lands or fails before it answers, so a clean-up after it removes the
// lot.
func sendParts(ctx context.Context, client *api.Client, sandboxID, prefix string, content []byte) (int, error) {
	var parts []int
	for offset := 0; offset < len(content); offset += partSize {
		parts = append(parts, offset)
	}
	err := eachLimited(indices(len(parts)), transferConcurrency, func(at int) error {
		offset := parts[at]
		_, err := client.WriteFile(ctx, sandboxID, api.WriteFileBody{
			Path:     fmt.Sprintf("%s-%06d", prefix, at),
			Content:  base64.StdEncoding.EncodeToString(content[offset:min(offset+partSize, len(content))]),
			Encoding: api.Ptr(api.FileEncodingBase64),
		})
		return err
	})
	return len(parts), err
}

func indices(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

// synced is what a sync did, as --json prints it.
type synced struct {
	SandboxID string `json:"sandboxId"`
	// Path is the checkout in the sandbox.
	Path       string     `json:"path"`
	Base       string     `json:"base"`
	BaseSource baseSource `json:"baseSource"`
	// Tree is the tree both sides have now.
	Tree  string `json:"tree"`
	Files int    `json:"files"`
	// PatchBytes is the patch's size, and SentBytes the gzipped patch's, as it went over.
	PatchBytes int       `json:"patchBytes"`
	SentBytes  int       `json:"sentBytes"`
	Skipped    []skipped `json:"skipped"`
	Timings    struct {
		// ProbeMs is looking at the sandbox and its snapshot; PatchMs making the patch here; ApplyMs the reset,
		// clean, apply and tree check in the sandbox.
		ProbeMs  int64 `json:"probeMs"`
		PatchMs  int64 `json:"patchMs"`
		UploadMs int64 `json:"uploadMs"`
		ApplyMs  int64 `json:"applyMs"`
		TotalMs  int64 `json:"totalMs"`
	} `json:"timings"`
}

// syncOptions say what to sync where.
type syncOptions struct {
	// Top is the local repository's top.
	Top string
	// To is the checkout in the sandbox, absolute.
	To string
	// Base is --base, or "".
	Base            string
	DefaultExcludes bool
	// Keep are directories whose files stay at the base's version whatever the excludes, such as Kantel's config.
	Keep     []string
	Contexts []string
}

// syncGit brings the checkout at To in the sandbox to the working tree Top is the top of, through a patch against its
// base, and proves the two trees match.
func syncGit(ctx context.Context, client *api.Client, sandboxID string, o syncOptions) (*synced, error) {
	started := time.Now()
	ms := func(d time.Duration) int64 { return int64(math.Round(float64(d) / float64(time.Millisecond))) }
	// Both at once; an isolate is refused before what its probe says, which is no shell.
	probeCtx, cancelProbe := context.WithCancel(ctx)
	defer cancelProbe()
	var co checkout
	var probeErr error
	var probing sync.WaitGroup
	probing.Go(func() { co, probeErr = probeCheckout(probeCtx, client, sandboxID, o.To) })
	sandbox, err := client.GetSandbox(ctx, sandboxID)
	if err != nil {
		// A key that may run commands but not read the sandbox still syncs, with no label to go on.
		var apiErr *api.Error
		if !errors.As(err, &apiErr) || apiErr.Code != "forbidden" {
			cancelProbe()
			probing.Wait()
			return nil, err
		}
		sandbox = nil
	}
	if sandbox != nil && sandbox.Type != api.SandboxTypeMicrovm {
		cancelProbe()
		probing.Wait()
		return nil, cli.Fail(sandboxID + " is an isolate: sync --git needs a microVM, with git")
	}
	probing.Wait()
	if probeErr != nil {
		return nil, probeErr
	}
	var label *baseLabelled
	if o.Base == "" && co.Recorded == "" {
		if label, err = labelledBase(ctx, client, sandbox); err != nil {
			return nil, err
		}
	}
	chosen, err := chooseBase(o.Base, co, label, sandboxID)
	if err != nil {
		return nil, err
	}
	probed := time.Now()
	base, err := resolveLocalBase(o.Top, chosen)
	if err != nil {
		return nil, err
	}
	local, err := buildPatch(o.Top, base, patchOptions{DefaultExcludes: o.DefaultExcludes, Keep: o.Keep, Contexts: o.Contexts})
	if err != nil {
		return nil, err
	}
	patched := time.Now()
	prefix := "/tmp/.kantel-sync-" + randomID()
	parts := prefix + "-*"
	var gz []byte
	if len(local.Patch) > 0 {
		var b bytes.Buffer
		w, _ := gzip.NewWriterLevel(&b, 6)
		_, _ = w.Write(local.Patch)
		_ = w.Close()
		gz = b.Bytes()
	}
	uploaded := time.Now()
	result, err := func() (remoteResult, error) {
		if len(gz) > 0 {
			if _, err := sendParts(ctx, client, sandboxID, prefix, gz); err != nil {
				return remoteResult{}, err
			}
		}
		uploaded = time.Now()
		globbed := ""
		if len(gz) > 0 {
			globbed = parts
		}
		return remoteRun(ctx, client, sandboxID, applyScript(co.Top, base, local.Tree, globbed, prefix+".patch"), applyTimeoutMs)
	}()
	if err != nil {
		if len(gz) > 0 {
			_, _ = client.RunCommand(ctx, sandboxID, api.RunCommandBody{
				Command: "rm -f " + parts + " " + prefix + ".patch; true", TimeoutMs: api.Ptr(int64(30_000)),
			})
		}
		return nil, err
	}
	applied := time.Now()
	where := co.Top + " in " + sandboxID
	why := ""
	if result.Stderr != "" {
		why = ": " + result.Stderr
	}
	switch result.ExitCode {
	case 0:
	case exitNoBase:
		return nil, cli.Fail(fmt.Sprintf("the base commit %s (%s) isn't in %s: fetch it there, give another with "+
			"--base, or copy the whole tree with kantel push", short(base), chosen.From, where))
	case exitReset:
		return nil, cli.Fail(fmt.Sprintf("couldn't reset %s to %s%s", where, short(base), why))
	case exitNoLock:
		return nil, cli.Fail(sandboxID + " has no flock, which sync --git needs: install util-linux there")
	case exitBusy:
		return nil, cli.Fail(fmt.Sprintf("another sync into %s has been running for %d minutes: try again once it ends", where, lockWaitSeconds/60))
	case exitApply:
		return nil, cli.Fail(fmt.Sprintf("the patch didn't apply to %s%s. It's left at %s, with nothing applied", where, why, short(base)))
	case exitTree:
		theirs := "unknown"
		if m := regexp.MustCompile(`tree=([0-9a-f]+)`).FindStringSubmatch(result.Stdout); m != nil {
			theirs = m[1]
		}
		return nil, cli.Fail(fmt.Sprintf("after the patch %s has tree %s, not this working tree's %s%s", where, short(theirs), short(local.Tree), why))
	case exitWorktree:
		return nil, cli.Fail(fmt.Sprintf("after the patch the files in %s don't match its index%s", where, why))
	default:
		if why == "" {
			why = fmt.Sprintf(" with exit %d", result.ExitCode)
		}
		return nil, cli.Fail(fmt.Sprintf("a command in %s failed%s", sandboxID, why))
	}
	s := &synced{
		SandboxID: sandboxID, Path: co.Top, Base: base, BaseSource: chosen.Source, Tree: local.Tree, Files: local.Files,
		PatchBytes: len(local.Patch), SentBytes: len(gz), Skipped: local.Skipped,
	}
	s.Timings.ProbeMs = ms(probed.Sub(started))
	s.Timings.PatchMs = ms(patched.Sub(probed))
	s.Timings.UploadMs = ms(uploaded.Sub(patched))
	s.Timings.ApplyMs = ms(applied.Sub(uploaded))
	s.Timings.TotalMs = ms(applied.Sub(started))
	return s, nil
}

// defaultCheckout is where sync puts a checkout by default, as push does a directory: /home/user/<the repository's
// name>.
func defaultCheckout(top string) string {
	return path.Join("/home/user", path.Base(strings.ReplaceAll(top, `\`, "/")))
}

// checkoutPath is a --to path as the sandbox's shell takes it: relative ones under the sandbox user's home.
func checkoutPath(to string) string {
	switch {
	case to == "~":
		to = "."
	case strings.HasPrefix(to, "~/"):
		to = to[2:]
	}
	if strings.HasPrefix(to, "/") {
		return path.Clean(to)
	}
	return path.Join("/home/user", to)
}
