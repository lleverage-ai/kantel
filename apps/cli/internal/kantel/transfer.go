package kantel

// Copying files between this computer and a sandbox for kantel scp and kantel push, over the files API only (no SSH,
// so it works on isolates as well as microVMs). The API reads and writes at most 1 MiB a call. A larger file comes
// down in 1 MiB ranged reads, and goes up in 768 KiB parts that one command joins, which needs a microVM's shell. A
// directory is copied file by file, a few at a time, into an isolate; into a microVM it goes as one gzipped tar.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

const (
	// maxFile is the most the files API takes or gives in one call.
	maxFile = 1024 * 1024
	// partSize is a part of a larger file: 768 KiB, which is 1 MiB in base64.
	partSize = 768 * 1024
	// downloadPart is a part of a larger file coming down through a command, from a control plane before ranged
	// reads: 512 KiB, whose base64 fits well inside a command's 1 MiB of output.
	downloadPart = 512 * 1024
	// transferConcurrency is how many files go at once.
	transferConcurrency = 6
)

// remoteSpec is a sandbox and a path in it, as scp names one: sbx_123:/home/user/x.
type remoteSpec struct{ SandboxID, Path string }

var remoteSpecPattern = regexp.MustCompile(`^([A-Za-z][\w-]*):(.*)$`)

// parseRemote is `sbx_123:/home/user/x` as its sandbox and path; false for a local path.
func parseRemote(spec string) (remoteSpec, bool) {
	m := remoteSpecPattern.FindStringSubmatch(spec)
	// `C:\…` is a Windows drive, not a sandbox.
	if m == nil || len(m[1]) == 1 {
		return remoteSpec{}, false
	}
	return remoteSpec{SandboxID: m[1], Path: m[2]}, true
}

// remotePath is a sandbox path as the API takes it: `~/x` and `x` are under the sandbox user's home, as is an empty
// path.
func remotePath(p string) string {
	if p == "" || p == "~" {
		return ""
	}
	return strings.TrimPrefix(p, "~/")
}

// orHome is a sandbox path for a call that defaults to the home when it has none.
func orHome(p string) *string {
	if p == "" {
		return nil
	}
	return &p
}

// remoteJoin joins a sandbox path and a relative local one, with /.
func remoteJoin(base, rel string) string {
	rel = filepath.ToSlash(rel)
	if base == "" {
		return rel
	}
	return path.Join(base, rel)
}

// shellPath is a path in the sandbox as a shell names it, relative ones under the home.
func shellPath(p string) string {
	if strings.HasPrefix(p, "/") {
		return ShellQuote(p)
	}
	return `"$HOME"/` + ShellQuote(p)
}

// textOf is content as text when it is UTF-8 with no NUL.
func textOf(content []byte) (string, bool) {
	if bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return "", false
	}
	return string(content), true
}

// writeBody is a file's write: as text where it is, else base64.
func writeBody(p string, content []byte, mode string) api.WriteFileBody {
	body := api.WriteFileBody{Path: p}
	if text, ok := textOf(content); ok {
		body.Content, body.Encoding = text, api.Ptr(api.FileEncodingUtf8)
	} else {
		body.Content, body.Encoding = base64.StdEncoding.EncodeToString(content), api.Ptr(api.FileEncodingBase64)
	}
	if mode != "" {
		body.Mode = &mode
	}
	return body
}

// resolvePath is p made absolute against dir, and cleaned, as Node's path.resolve(dir, p).
func resolvePath(dir, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(dir, p)
}

// baseName is the last part of a path as Node's path.basename names it: "" for the root.
func baseName(p string) string {
	p = strings.TrimRight(p, "/"+string(filepath.Separator))
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

// isDirectory says whether p is a directory here, following links.
func isDirectory(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// randomID is 12 hex digits.
func randomID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// runIn runs a command in the sandbox and answers its stdout, or a failure with its stderr.
func runIn(ctx context.Context, client *api.Client, sandboxID, command string, timeoutMs int64) (string, error) {
	result, err := client.RunCommand(ctx, sandboxID, api.RunCommandBody{Command: command, TimeoutMs: &timeoutMs})
	if err != nil {
		return "", err
	}
	if result.State != api.CommandStateExited || result.ExitCode == nil || *result.ExitCode != 0 {
		why := strings.TrimSpace(result.Stderr)
		if why == "" {
			why = "it ended " + string(result.State)
			if result.ExitCode != nil {
				why += fmt.Sprintf(" %d", *result.ExitCode)
			}
		}
		return "", cli.Fail("a command in " + sandboxID + " failed: " + why)
	}
	return result.Stdout, nil
}

// putBytes writes content to p in the sandbox, in parts when it is over 1 MiB.
func putBytes(ctx context.Context, client *api.Client, sandboxID, p string, content []byte, mode string) error {
	if len(content) <= maxFile {
		_, err := client.WriteFile(ctx, sandboxID, writeBody(p, content, mode))
		return err
	}
	var parts []string
	// Each upload's parts have names of their own, so they never take the place of a file beside the target, nor of
	// another upload's parts.
	upload := randomSuffix()
	for offset := 0; offset < len(content); offset += partSize {
		name := fmt.Sprintf("%s.kantel-part-%s-%d", p, upload, len(parts))
		chunk := content[offset:min(offset+partSize, len(content))]
		if _, err := client.WriteFile(ctx, sandboxID, api.WriteFileBody{
			Path: name, Content: base64.StdEncoding.EncodeToString(chunk), Encoding: api.Ptr(api.FileEncodingBase64),
		}); err != nil {
			return err
		}
		parts = append(parts, name)
	}
	target := shellPath(p)
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = shellPath(part)
	}
	joined := strings.Join(quoted, " ")
	chmod := ""
	if mode != "" {
		chmod = " && chmod " + mode + " " + target
	}
	_, err := runIn(ctx, client, sandboxID, "cat "+joined+" > "+target+" && rm -f "+joined+chmod, 120_000)
	return err
}

var largerThan = regexp.MustCompile(`larger than`)

// getFile is the file at p in the sandbox: its absolute path, as the API answers it, and its bytes, in 1 MiB ranged
// reads when it is larger.
func getFile(ctx context.Context, client *api.Client, sandboxID, p string) (string, []byte, error) {
	read := func(offset int64) (*api.FileContent, error) {
		return client.ReadFile(ctx, sandboxID, &api.ReadFileQuery{
			Path: &p, Encoding: api.Ptr(api.FileEncodingBase64), Offset: &offset, Length: api.Ptr(int64(maxFile)),
		})
	}
	first, err := read(0)
	if err != nil {
		var apiErr *api.Error
		if !errors.As(err, &apiErr) || apiErr.Code != "invalid" || !largerThan.MatchString(apiErr.Message) {
			return "", nil, err
		}
		// A control plane from before ranged reads refuses a file over 1 MiB: read it with commands.
		content, err := getBytesWithCommands(ctx, client, sandboxID, p)
		return p, content, err
	}
	head, err := base64.StdEncoding.DecodeString(first.Content)
	if err != nil {
		return "", nil, err
	}
	// One from before ranged reads answers the whole file, with no offset.
	if first.Offset == nil || int64(len(head)) >= first.Size {
		return first.Path, head, nil
	}
	size := first.Size
	out := make([]byte, size)
	copy(out, head)
	for offset := int64(len(head)); offset < size; {
		part, err := read(offset)
		if err != nil {
			return "", nil, err
		}
		chunk, err := base64.StdEncoding.DecodeString(part.Content)
		if err != nil {
			return "", nil, err
		}
		if part.Size != size {
			return "", nil, cli.Fail(p + " changed size while it was copied")
		}
		if len(chunk) == 0 {
			return "", nil, cli.Fail(fmt.Sprintf("%s came back short at byte %d", p, offset))
		}
		copy(out[offset:], chunk[:min(int64(len(chunk)), size-offset)])
		offset += int64(len(chunk))
	}
	return first.Path, out, nil
}

// getBytes is the bytes of p in the sandbox.
func getBytes(ctx context.Context, client *api.Client, sandboxID, p string) ([]byte, error) {
	_, content, err := getFile(ctx, client, sandboxID, p)
	return content, err
}

// getBytesWithCommands is the bytes of a file over 1 MiB, read in parts by commands: needs a microVM, with tail,
// head and base64.
func getBytesWithCommands(ctx context.Context, client *api.Client, sandboxID, p string) ([]byte, error) {
	out, err := runIn(ctx, client, sandboxID, "stat -c %s "+shellPath(p), 120_000)
	if err != nil {
		return nil, err
	}
	size, err := strconv.ParseInt(strings.TrimSpace(out), 10, 64)
	if err != nil || size < 0 {
		return nil, cli.Fail("couldn't read the size of " + p)
	}
	content := make([]byte, size)
	for offset := int64(0); offset < size; offset += downloadPart {
		encoded, err := runIn(ctx, client, sandboxID,
			fmt.Sprintf("tail -c +%d %s | head -c %d | base64 -w0", offset+1, shellPath(p), downloadPart), 120_000)
		if err != nil {
			return nil, err
		}
		part, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
		if int64(len(part)) != min(downloadPart, size-offset) {
			return nil, cli.Fail(fmt.Sprintf("%s came back short at byte %d: it needs tail, head and base64 in the sandbox", p, offset))
		}
		copy(content[offset:], part)
	}
	return content, nil
}

// executableMode is a local file's mode for the API when it is executable, such as 0755; else "".
func executableMode(p string) (string, error) {
	info, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	perm := info.Mode().Perm()
	if perm&0o111 == 0 {
		return "", nil
	}
	return fmt.Sprintf("%04o", uint32(perm)), nil
}

// uploadFile copies a local file into the sandbox, answering its size.
func uploadFile(ctx context.Context, client *api.Client, sandboxID, local, remote string) (int, error) {
	content, err := os.ReadFile(local)
	if err != nil {
		return 0, err
	}
	mode, err := executableMode(local)
	if err != nil {
		return 0, err
	}
	return len(content), putBytes(ctx, client, sandboxID, remote, content, mode)
}

// walk is the files under root, relative to it, leaving out .git. Links are neither files nor directories here.
func walk(root string) ([]string, error) {
	var found []string
	var visit func(dir string) error
	visit = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.Name() == ".git" {
				continue
			}
			p := filepath.Join(dir, e.Name())
			switch {
			case e.IsDir():
				if err := visit(p); err != nil {
					return err
				}
			case e.Type().IsRegular():
				rel, _ := filepath.Rel(root, p)
				found = append(found, rel)
			}
		}
		return nil
	}
	if err := visit(root); err != nil {
		return nil, err
	}
	sort.Strings(found)
	return found, nil
}

// gitList is what `git ls-files` lists in root with flags, relative to it; false when it isn't in a git repository.
func gitList(root string, flags ...string) ([]string, bool) {
	run, err := runGit(root, append(append([]string{"ls-files"}, flags...), "-z"), nil, nil)
	if err != nil || run.code != 0 {
		return nil, false
	}
	names := nul(run.stdout)
	sort.Strings(names)
	return names, true
}

// gitTop is the top of the working tree root is in.
func gitTop(root string) (string, bool) {
	run, err := runGit(root, []string{"rev-parse", "--show-toplevel"}, nil, nil)
	top := strings.TrimSpace(string(run.stdout))
	if err != nil || run.code != 0 || top == "" {
		return "", false
	}
	return resolvePath(root, top), true
}

// gitTree is what push sends from a git repository.
type gitTree struct {
	// Files are the files git tracks and the new ones .gitignore doesn't leave out.
	Files []string
	// Tracked are those git tracks.
	Tracked map[string]bool
	Top     string
}

// gitFiles is root's files as git would commit them; nil outside a git repository.
func gitFiles(root string) *gitTree {
	var files, tracked []string
	var top string
	var okFiles, okTracked, okTop bool
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); files, okFiles = gitList(root, "--cached", "--others", "--exclude-standard") }()
	go func() { defer wg.Done(); tracked, okTracked = gitList(root, "--cached") }()
	go func() { defer wg.Done(); top, okTop = gitTop(root) }()
	wg.Wait()
	if !okFiles || !okTracked || !okTop {
		return nil
	}
	set := make(map[string]bool, len(tracked))
	for _, t := range tracked {
		set[t] = true
	}
	return &gitTree{Files: files, Tracked: set, Top: top}
}

// realPath is p with its links resolved, or as it is when it doesn't exist.
func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		if abs, err := filepath.Abs(r); err == nil {
			return abs
		}
	}
	abs, _ := filepath.Abs(p)
	return abs
}

// rootContexts is the paths that lead to root, with /, which push puts before each file it classifies, so a root
// inside .cursor or named .docker counts as it would from above. Both the path as named, links and all, and where it
// resolves count. In a repository each starts at its top, named by its own name (.docker when git starts there), so
// a worktree in .claude/worktrees isn't all agent settings. The named path's top is its nearest ancestor that
// resolves to the repository's (top); with none, and outside a repository (top ""), the paths are absolute.
func rootContexts(root, top string) []string {
	named, _ := filepath.Abs(root)
	resolved := realPath(root)
	unique := func(paths ...string) []string {
		var out []string
		seen := map[string]bool{}
		for _, p := range paths {
			p = filepath.ToSlash(p)
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
		return out
	}
	if top == "" {
		return unique(named, resolved)
	}
	realTop := realPath(top)
	fromTop := func(p, at string) string {
		rel, _ := filepath.Rel(at, p)
		return filepath.Join(filepath.Base(at), rel)
	}
	namedTop := ""
	for at := named; ; at = filepath.Dir(at) {
		if realPath(at) == realTop {
			namedTop = at
			break
		}
		if filepath.Dir(at) == at {
			break
		}
	}
	first := named
	if namedTop != "" {
		first = fromTop(named, namedTop)
	}
	return unique(first, fromTop(resolved, realTop))
}

var (
	// credentialNames are left out wherever they are in the tree, even when git tracks them.
	credentialNames = map[string]bool{".ssh": true, ".gnupg": true, ".aws": true, ".azure": true, ".kube": true, ".netrc": true, ".pypirc": true}
	// agentDirs are agents' sign-ins and settings: left out unless git tracks the file, as it does a project's shared
	// settings.
	agentDirs  = map[string]bool{".claude": true, ".codex": true, ".cursor": true}
	envFile    = regexp.MustCompile(`^\.env(\..+)?$`)
	envExample = regexp.MustCompile(`^\.env\.(example|sample|template|dist)$`)
	pathParts  = regexp.MustCompile(`[\\/]`)
)

// skipped is something push left out, and why.
type skipped struct {
	Path string `json:"path"`
	Why  string `json:"why"`
	// ByDefault is a default exclude, which --no-default-excludes sends.
	ByDefault bool `json:"byDefault,omitempty"`
}

// trackedness is whether git tracks a file: unknown outside a repository.
type trackedness int

const (
	trackedUnknown trackedness = iota
	untracked
	tracked
)

func trackedOf(isTracked bool) trackedness {
	if isTracked {
		return tracked
	}
	return untracked
}

// defaultExclude is why push leaves out file (a relative path) by default, and the part of it to name; nil to send
// it.
func defaultExclude(file string, t trackedness) *skipped {
	parts := pathParts.Split(file, -1)
	for i, part := range parts {
		// Lower case: on macOS and Windows .SSH is .ssh.
		name := strings.ToLower(part)
		p := strings.Join(parts[:i+1], "/")
		if credentialNames[name] {
			return &skipped{Path: p, Why: "credentials", ByDefault: true}
		}
		if name == ".docker" && i+1 < len(parts) && strings.ToLower(parts[i+1]) == "config.json" {
			return &skipped{Path: p + "/config.json", Why: "credentials", ByDefault: true}
		}
		if t == tracked {
			continue
		}
		// In a repository git may track some of the directory, which goes, so this names the file.
		if agentDirs[name] {
			named := file
			if t == trackedUnknown {
				named = p
			}
			return &skipped{Path: named, Why: "an agent's sign-in and settings", ByDefault: true}
		}
		// Projects commit theirs too, so a tracked one goes.
		if name == ".npmrc" {
			return &skipped{Path: p, Why: "it can hold a registry token", ByDefault: true}
		}
		if envFile.MatchString(name) && !envExample.MatchString(name) {
			return &skipped{Path: p, Why: "an environment file", ByDefault: true}
		}
	}
	return nil
}

// excludedUnder is why push leaves out rel, a path under a root that contexts lead to (rootContexts), named as it is
// under the root; nil to send it. Each context is tried in front of it, so .cursor/User/auth.json counts when the
// root is .cursor/User, and config.json when it is .docker.
func excludedUnder(contexts []string, rel string, t trackedness) *skipped {
	posixRel := filepath.ToSlash(rel)
	for _, context := range contexts {
		prefix := ""
		if context != "" {
			prefix = strings.TrimRight(context, "/") + "/"
		}
		found := defaultExclude(prefix+posixRel, t)
		if found == nil {
			continue
		}
		under := ""
		if strings.HasPrefix(found.Path, prefix) {
			under = found.Path[len(prefix):]
		}
		if under == "" {
			under = posixRel
		}
		found.Path = under
		return found
	}
	return nil
}

// within says whether p is dir or inside it; both absolute. On macOS, whose file systems ignore case by default,
// case is ignored too, so ~/.config/KANTEL is Kantel's config directory as ~/.config/kantel is.
func within(p, dir string) bool {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		p, dir = strings.ToLower(p), strings.ToLower(dir)
	}
	rel, err := filepath.Rel(dir, p)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func sortSkipped(m map[string]skipped) []skipped {
	out := make([]skipped, 0, len(m))
	for _, s := range m {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// pushOptions say what push leaves out.
type pushOptions struct {
	// Tracked is what git tracks, in a repository; nil outside one.
	Tracked         map[string]bool
	DefaultExcludes bool
	// Keep are absolute directories whose files stay here whatever the excludes, such as Kantel's config.
	Keep []string
	// Contexts lead to the root (rootContexts).
	Contexts []string
}

// pushPlan is the files push sends from files (relative to root): not ones that resolve outside root through a link,
// nor ones in Keep, nor, with DefaultExcludes, credentials, agents' sign-ins and environment files.
func pushPlan(root string, files []string, o pushOptions) ([]string, []skipped) {
	realRoot := realPath(root)
	var keep []string
	for _, k := range o.Keep {
		keep = append(keep, realPath(k))
	}
	contexts := o.Contexts
	if contexts == nil {
		contexts = rootContexts(root, "")
	}
	exclude := func(rel string) *skipped {
		if !o.DefaultExcludes {
			return nil
		}
		t := trackedUnknown
		if o.Tracked != nil {
			t = trackedOf(o.Tracked[filepath.ToSlash(rel)])
		}
		return excludedUnder(contexts, rel, t)
	}
	var sent []string
	left := map[string]skipped{}
	for _, file := range files {
		if named := exclude(file); named != nil {
			left[named.Path] = *named
			continue
		}
		target := realPath(filepath.Join(root, file))
		if !within(target, realRoot) {
			left[file] = skipped{Path: file, Why: "a link to outside the directory"}
			continue
		}
		kept := ""
		for _, k := range keep {
			if within(target, k) {
				kept = k
				break
			}
		}
		if kept != "" {
			rel, _ := filepath.Rel(realRoot, kept)
			p := filepath.ToSlash(rel)
			if p == "." || p == "" {
				p = file
			}
			left[p] = skipped{Path: p, Why: "Kantel's config, with your API key"}
			continue
		}
		rel, _ := filepath.Rel(realRoot, target)
		if linked := exclude(rel); linked != nil {
			left[file] = skipped{Path: file, Why: "a link to " + linked.Path + ", " + linked.Why, ByDefault: true}
			continue
		}
		sent = append(sent, file)
	}
	return sent, sortSkipped(left)
}

// pushRoot is what checkPushRoot needs to know.
type pushRoot struct {
	Home, ConfigDir string
	AllowHome       bool
	DefaultExcludes bool
	InRepository    bool
	// Verb is the command, for its messages: push (the default) or sync.
	Verb string
}

// checkPushRoot refuses to push root when it is in Kantel's config directory; when it is in a directory push leaves
// out, such as .ssh (or .claude outside a repository), unless DefaultExcludes is off; and when it is the home
// directory or holds it or Kantel's config directory, unless AllowHome. With it, it answers the config directory for
// push to leave out.
func checkPushRoot(root string, o pushRoot) (string, error) {
	verb := o.Verb
	if verb == "" {
		verb = "push"
	}
	what := "repository"
	if verb == "push" {
		what = "directory"
	}
	realRoot, home, configDir := realPath(root), realPath(o.Home), realPath(o.ConfigDir)
	if within(realRoot, configDir) {
		return "", cli.Fail(fmt.Sprintf("%s is in Kantel's config directory, %s, which holds your API key", root, configDir))
	}
	if o.DefaultExcludes {
		named, _ := filepath.Abs(root)
		paths := []string{named}
		if realRoot != named {
			paths = append(paths, realRoot)
		}
		for _, p := range paths {
			// In a repository only credentials count: Claude Code keeps worktrees in .claude/worktrees.
			t := trackedUnknown
			if o.InRepository {
				t = tracked
			}
			found := defaultExclude(filepath.ToSlash(p), t)
			if found == nil {
				continue
			}
			where := "is in " + found.Path + ", which is"
			if found.Path == filepath.ToSlash(p) {
				where = "is"
			}
			return "", cli.Fail(fmt.Sprintf("%s %s one %s leaves out (%s): add --no-default-excludes if you mean it", root, where, verb, found.Why))
		}
	}
	if !o.AllowHome && within(home, realRoot) {
		which := "holds your home directory, " + home
		if realRoot == home {
			which = "is your home directory"
		}
		return "", cli.Fail(fmt.Sprintf("%s %s: %s a project %s, or add --allow-home if you mean it", root, which, verb, what))
	}
	if !within(configDir, realRoot) {
		return "", nil
	}
	if !o.AllowHome {
		return "", cli.Fail(fmt.Sprintf("%s holds Kantel's config directory, %s, with your API key: %s a %s that doesn't, "+
			"or add --allow-home to %s the rest", root, configDir, verb, what, verb))
	}
	return configDir, nil
}

// copied is how much went.
type copied struct {
	Files int `json:"files"`
	Bytes int `json:"bytes"`
}

// eachLimited runs work on each item, limit at a time, in order of starting; after one fails no more start, and it
// answers the first failure once those under way have ended.
func eachLimited[T any](items []T, limit int, work func(T) error) error {
	var mu sync.Mutex
	var failure error
	next := 0
	take := func() (T, bool) {
		mu.Lock()
		defer mu.Unlock()
		var zero T
		if failure != nil || next >= len(items) {
			return zero, false
		}
		item := items[next]
		next++
		return item, true
	}
	var wg sync.WaitGroup
	for range min(limit, len(items)) {
		wg.Go(func() {
			for {
				item, ok := take()
				if !ok {
					return
				}
				if err := work(item); err != nil {
					mu.Lock()
					if failure == nil {
						failure = err
					}
					mu.Unlock()
				}
			}
		})
	}
	wg.Wait()
	return failure
}

// uploadTree copies files (relative to root) into target in the sandbox, file by file. Deleted local files are left
// out quietly.
func uploadTree(ctx context.Context, client *api.Client, sandboxID, root string, files []string, target string, onFile func(string)) (copied, error) {
	var mu sync.Mutex
	var done copied
	err := eachLimited(files, transferConcurrency, func(file string) error {
		local := filepath.Join(root, file)
		info, err := os.Stat(local)
		if err != nil || !info.Mode().IsRegular() {
			return nil // Tracked by git but deleted here.
		}
		remote := remoteJoin(target, file)
		size, err := uploadFile(ctx, client, sandboxID, local, remote)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		done.Files++
		done.Bytes += size
		if onFile != nil {
			onFile(remote)
		}
		return nil
	})
	return done, err
}

// placeScript moves an extracted tree's files into place, a directory at a time (see uploadTreeArchive).
const placeScript = `top=$0; id=$1; shift; for d; do mkdir -p "$top/$d" && t="$top/$d/.kantel-in-$id" && mkdir "$t" && { ` +
	`find "$d" -maxdepth 1 ! -type d -print0 | xargs -0 -r mv -f -t "$t" && ` +
	`find "$t" -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r mv -f -t "$top/$d"; s=$?; rm -rf "$t"; [ $s -eq 0 ]; } || exit 1; done`

// archiveTargetPath is a sandbox path as the files API resolves it (under /home/user unless absolute, then cleaned
// as text), for a shell. Cleaned here too, so the shell never walks a .. through a link to somewhere the files API,
// which drops it first, wouldn't: every way in uses this one path.
func archiveTargetPath(target string) string {
	if strings.HasPrefix(target, "/") {
		return path.Clean(target)
	}
	return path.Join("/home/user", target)
}

var errStopPacking = errors.New("stopped")

// uploadTreeArchive copies files (relative to root) into target in a microVM as one gzipped tar: it goes up in 768
// KiB parts, a few at a time, and one command joins and extracts them. A tree of many small files is a handful of
// calls rather than one a file. Needs the microVM's shell and tar, so not for an isolate. Deleted local files are
// left out quietly, as in uploadTree.
func uploadTreeArchive(ctx context.Context, client *api.Client, sandboxID, root string, files []string, target string, onFile func(string)) (result copied, err error) {
	// Flat files in /tmp, not a directory of them: a directory the files API makes is root's, so the sandbox's user
	// couldn't remove the parts from it, while /tmp lets each owner remove their own.
	id := randomID()
	staging := "/tmp/.kantel-push-" + id
	var sent []string
	var done copied

	reader, writer := io.Pipe()
	go func() {
		// The pipe's reader sees the packer's end: EOF when it finished, else its error.
		writer.CloseWithError(func() error {
			gz, _ := gzip.NewWriterLevel(writer, gzip.BestSpeed)
			tw := tar.NewWriter(gz)
			for _, file := range files {
				local := filepath.Join(root, file)
				info, err := os.Stat(local)
				if err != nil || !info.Mode().IsRegular() {
					continue // Tracked by git but deleted here.
				}
				content, err := os.ReadFile(local)
				if err != nil {
					return err
				}
				// The executable bits as they are here; everything else 0644, as a file put one at a time gets.
				mode := int64(0o644)
				if info.Mode().Perm()&0o111 != 0 {
					mode = int64(info.Mode().Perm())
				}
				name := filepath.ToSlash(file)
				if err := tw.WriteHeader(&tar.Header{
					Typeflag: tar.TypeReg, Name: name, Size: int64(len(content)), Mode: mode,
					ModTime: info.ModTime().Truncate(time.Second),
				}); err != nil {
					return err
				}
				if _, err := tw.Write(content); err != nil {
					return err
				}
				sent = append(sent, name)
				done.Files++
				done.Bytes += len(content)
			}
			if err := tw.Close(); err != nil {
				return err
			}
			return gz.Close()
		}())
	}()

	upload := func() (int, error) {
		var mu sync.Mutex
		var failure error
		failed := func() bool { mu.Lock(); defer mu.Unlock(); return failure != nil }
		slots := make(chan struct{}, transferConcurrency)
		var wg sync.WaitGroup
		parts := 0
		buf := make([]byte, partSize)
		var readErr error
		for !failed() {
			n, err := io.ReadFull(reader, buf)
			if n > 0 {
				chunk := append([]byte(nil), buf[:n]...)
				name := fmt.Sprintf("%s-%06d", staging, parts)
				parts++
				slots <- struct{}{}
				wg.Go(func() {
					defer func() { <-slots }()
					if _, err := client.WriteFile(ctx, sandboxID, api.WriteFileBody{
						Path: name, Content: base64.StdEncoding.EncodeToString(chunk), Encoding: api.Ptr(api.FileEncodingBase64),
					}); err != nil {
						mu.Lock()
						if failure == nil {
							failure = err
						}
						mu.Unlock()
					}
				})
			}
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			if err != nil {
				readErr = err
				break
			}
		}
		// Every part started has landed or failed before this answers, so none lands after the clean-up.
		reader.CloseWithError(errStopPacking)
		wg.Wait()
		if readErr != nil {
			return parts, readErr
		}
		return parts, failure
	}

	glob := ShellQuote(staging) + "-*"
	into := ShellQuote(archiveTargetPath(target))
	stage := ShellQuote(path.Join(archiveTargetPath(target), ".kantel-push-"+id))
	placed := false
	defer func() {
		// A command cut short (its timeout, say) never reached its own clean-up: the staging tree and any hidden
		// directory it was moving files through go too. Not after a push that worked, which removed both itself.
		leftovers := ""
		if !placed {
			leftovers = "; rm -rf " + stage + "; find -L " + into + " -name .kantel-in-" + id + " -type d -prune -exec rm -rf {} + 2>/dev/null"
		}
		_, _ = runIn(ctx, client, sandboxID, "rm -f "+glob+leftovers+"; true", 120_000)
	}()
	parts, err := upload()
	if err != nil {
		return copied{}, err
	}
	if parts == 0 {
		return copied{}, nil
	}
	// The parts' names sort in order, so the glob joins them as they were cut. The tar goes into a directory of its
	// own inside the destination first, so one that fails part way (a full disk) leaves the destination as it was.
	// Then, a directory at a time, its files move into a new hidden directory inside that destination directory, and
	// from there into place: source and target are in one directory, so that last move is always a rename, and a file
	// already there is replaced by the whole new one in one step, never missing and never half written. Modes as the
	// files API sets them, whatever the account's umask: each file's own (0644, or its executable bits), and 0755 for
	// each directory made.
	if _, err := runIn(ctx, client, sandboxID,
		"umask 022 && mkdir "+stage+" && cat "+glob+" | tar -xzf - -C "+stage+" --no-same-owner --same-permissions && "+
			"(cd "+stage+" && find . -type d -exec sh -c "+ShellQuote(placeScript)+" "+into+" "+id+" {} +); s=$?; rm -rf "+stage+"; exit $s",
		600_000); err != nil {
		return copied{}, err
	}
	placed = true
	if onFile != nil {
		for _, p := range sent {
			onFile(remoteJoin(target, p))
		}
	}
	return done, nil
}

// archiveFits says whether a tree can go into target as an archive: the command account can make and write it, and
// write /tmp. A key without exec, or a destination under a directory only root may write (which the files API, as
// root, can), goes file by file instead.
func archiveFits(ctx context.Context, client *api.Client, sandboxID, target string) bool {
	into := ShellQuote(archiveTargetPath(target))
	_, err := runIn(ctx, client, sandboxID, "mkdir -p "+into+" && test -w "+into+
		" && test -w /tmp && command -v tar >/dev/null && mv --help 2>&1 | grep -q -- --target-directory", 120_000)
	return err == nil
}

// uploadTreeTo copies files into target as the sandbox takes it best: one tar into a microVM, file by file into an
// isolate.
func uploadTreeTo(c *cli.Context, client *api.Client, sandboxID, root string, files []string, target string, onFile func(string)) (copied, error) {
	ctx := c.Ctx
	microvm := false
	sandbox, err := client.GetSandbox(ctx, sandboxID)
	if err != nil {
		// A key that may write files but not read the sandbox (no sandboxes:read) still pushes, one file at a time.
		var apiErr *api.Error
		if !errors.As(err, &apiErr) || apiErr.Code != "forbidden" {
			return copied{}, err
		}
	} else {
		microvm = sandbox.Type == api.SandboxTypeMicrovm
	}
	if microvm && archiveFits(ctx, client, sandboxID, target) {
		done, err := uploadTreeArchive(ctx, client, sandboxID, root, files, target, onFile)
		if err == nil {
			return done, nil
		}
		// Extracting failed in the sandbox (a directory in the tree only root may write, say): the files API, as root,
		// still can. Anything else, such as the sandbox stopping, fails as it is.
		var cliErr *cli.Error
		if !errors.As(err, &cliErr) || !strings.HasPrefix(cliErr.Message, "a command in ") {
			return copied{}, err
		}
		c.Note("kantel: the archive couldn't be extracted (" + cliErr.Message + "); sending file by file")
	}
	return uploadTree(ctx, client, sandboxID, root, files, target, onFile)
}

// remoteWalk is the files under p in the sandbox, relative to it.
func remoteWalk(ctx context.Context, client *api.Client, sandboxID, p string) ([]string, error) {
	var found []string
	var visit func(dir, prefix string) error
	visit = func(dir, prefix string) error {
		var cursor *string
		for {
			page, err := client.ListFiles(ctx, sandboxID, &api.ListFilesQuery{Path: orHome(dir), Cursor: cursor})
			if err != nil {
				return err
			}
			for _, entry := range page.Items {
				// The names come from the sandbox, and become paths here: none may lead outside the directory.
				if entry.Name == "" || entry.Name == "." || entry.Name == ".." || strings.ContainsAny(entry.Name, `\/`) {
					quoted, _ := json.Marshal(entry.Name)
					return cli.Fail(fmt.Sprintf("%s listed %s in %s, which isn't safe here", sandboxID, string(quoted), dir))
				}
				rel := entry.Name
				if prefix != "" {
					rel = prefix + "/" + entry.Name
				}
				switch entry.Kind {
				case api.FileEntryKindDirectory:
					if err := visit(entry.Path, rel); err != nil {
						return err
					}
				case api.FileEntryKindFile:
					found = append(found, rel)
				}
			}
			if page.NextCursor == nil {
				break
			}
			cursor = page.NextCursor
		}
		return nil
	}
	if err := visit(p, ""); err != nil {
		return nil, err
	}
	sort.Strings(found)
	return found, nil
}

// downloadTree copies the directory p in the sandbox to target here.
func downloadTree(ctx context.Context, client *api.Client, sandboxID, p, target string, onFile func(string)) (copied, error) {
	files, err := remoteWalk(ctx, client, sandboxID, p)
	if err != nil {
		return copied{}, err
	}
	var mu sync.Mutex
	total := 0
	err = eachLimited(files, transferConcurrency, func(file string) error {
		content, err := getBytes(ctx, client, sandboxID, remoteJoin(p, file))
		if err != nil {
			return err
		}
		local := filepath.Join(append([]string{target}, strings.Split(file, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(local), 0o777); err != nil {
			return err
		}
		// Never through a link already here (cache → ~/.ssh): what a sandbox sends stays under the target.
		if err := noLinkBelow(target, local); err != nil {
			return err
		}
		if err := os.WriteFile(local, content, 0o666); err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		total += len(content)
		if onFile != nil {
			onFile(local)
		}
		return nil
	})
	return copied{Files: len(files), Bytes: total}, err
}

// remoteIsDirectory says whether p in the sandbox is a directory: its parent's listing says so.
func remoteIsDirectory(ctx context.Context, client *api.Client, sandboxID, p string) (bool, error) {
	if p == "" || p == "/" || p == "~" {
		return true, nil
	}
	trimmed := strings.TrimRight(p, "/")
	parent, name := path.Dir(trimmed), path.Base(trimmed)
	query := &api.ListFilesQuery{}
	if parent != "." {
		query.Path = &parent
	}
	for {
		page, err := client.ListFiles(ctx, sandboxID, query)
		if err != nil {
			var apiErr *api.Error
			if errors.As(err, &apiErr) && apiErr.Code == "not_found" {
				return false, nil
			}
			return false, err
		}
		for _, item := range page.Items {
			if item.Name == name {
				return item.Kind == api.FileEntryKindDirectory, nil
			}
		}
		if page.NextCursor == nil {
			return false, nil
		}
		query.Cursor = page.NextCursor
	}
}

// gitRun is what one git ran to.
type gitRun struct {
	code   int
	stdout []byte
	stderr string
}

// runGit runs git in cwd, with env added and input on its stdin; an error only when git couldn't run.
func runGit(cwd string, args []string, env []string, input *string) (gitRun, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), env...)
	if input != nil {
		cmd.Stdin = strings.NewReader(*input)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	run := gitRun{stdout: stdout.Bytes(), stderr: strings.TrimSpace(stderr.String())}
	var exit *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exit):
		run.code = exit.ExitCode()
		if run.code < 0 {
			run.code = 1
		}
	default:
		return run, err
	}
	return run, nil
}

// nul is git's -z output as its names.
func nul(out []byte) []string {
	var names []string
	for _, name := range strings.Split(string(out), "\x00") {
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

// randomSuffix is eight hex digits, for names of one operation's own.
func randomSuffix() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// noLinkBelow fails when any part of path below root (root itself aside) is a symbolic link.
func noLinkBelow(root, path string) error {
	rel, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return cli.Fail(path + " isn't under " + root)
	}
	at := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return cli.Fail(at + " is a link, which kantel doesn't write through: move it, or copy to another directory")
		}
	}
	return nil
}
