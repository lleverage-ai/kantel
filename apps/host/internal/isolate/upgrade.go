package isolate

import (
	"archive/tar"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// An isolate's part in an upgrade to a microVM (sandbox.upgrade, agent/upgrade.go): its files as a tar, read from the
// host's blob store, and its going once the microVM runs with them. And whether a command needed a microVM at all.

func beingUpgraded(id string) error {
	return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s is being upgraded to a microVM: its files are held still until that ends", id)}
}

// Freeze holds the sandbox still for upgrade opID: it waits up to wait for a command or file write under way to end
// (refusing the freeze, conflict, if one doesn't), then refuses every later command and file write until Thaw or
// Dispose, so the files an upgrade copies are one version and none written after it is lost. Reads go on. Kept on
// disk. Freezing again for the same opID is a no-op; for another, conflict.
func (m *Manager) Freeze(id, opID string, wait time.Duration) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(wait)
	for !s.exec.TryLock() {
		if time.Now().After(deadline) {
			return conflict("sandbox %s still runs a command after %s; upgrade it once that has ended", id, wait)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer s.exec.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	switch s.meta.Frozen {
	case opID:
		return nil
	case "":
	default:
		return conflict("sandbox %s is held by another upgrade (%s)", id, s.meta.Frozen)
	}
	s.meta.Frozen = opID
	if err := s.saveMeta(); err != nil {
		s.meta.Frozen = ""
		s.unsaved = false
		return err
	}
	return nil
}

// Thaw lets a sandbox frozen for upgrade opID take commands and writes again (the upgrade rolled back). One not frozen
// for opID is left as it is.
func (m *Manager) Thaw(id, opID string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Frozen != opID {
		return nil
	}
	s.meta.Frozen = ""
	s.held, s.heldBy = nil, ""
	return s.saveMeta()
}

// FrozenBy is the upgrade that holds the sandbox still, or "".
func (m *Manager) FrozenBy(id string) string {
	s, err := m.get(id)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta.Frozen
}

// ExportTar writes the sandbox's /workspace to w as a tar: its directories, its files (from the account's blobs, with
// their modes) and its links (one to an absolute path in /workspace made relative, workspaceLink), each named relative
// to /workspace. It is one state: held against the sandbox's
// commands and file writes (exec), which take and leave the manifest, as a snapshot is. A stopped sandbox's files are
// what it stopped with. It answers the entries written and the files' bytes; a blob that is gone fails it.
func (m *Manager) ExportTar(id string, w io.Writer) (entries int, bytes int64, err error) {
	s, err := m.get(id)
	if err != nil {
		return 0, 0, err
	}
	s.exec.Lock()
	defer s.exec.Unlock()
	s.mu.Lock()
	owner := s.meta.Owner
	man, err := readManifest(filepath.Join(s.dir, "manifest.json"))
	s.mu.Unlock()
	if err != nil {
		return 0, 0, err
	}
	keys := make([]string, 0, len(man))
	for k := range man {
		if k == "" || path.IsAbs(k) || path.Clean(k) != k || k == ".." || len(k) >= 3 && k[:3] == "../" {
			continue
		}
		keys = append(keys, k)
	}
	// Parents before children: a directory's entry comes before what is in it.
	sort.Strings(keys)
	tw := tar.NewWriter(w)
	at := time.Now()
	for _, k := range keys {
		e := man[k]
		h := &tar.Header{Name: k, ModTime: at, Format: tar.FormatPAX}
		var data []byte
		switch e.Kind {
		case "dir":
			h.Typeflag, h.Name, h.Mode = tar.TypeDir, k+"/", 0o755
		case "symlink":
			h.Typeflag, h.Linkname, h.Mode = tar.TypeSymlink, exportLink(man, k, e.Target), 0o777
		case "file":
			if data, err = m.readBlob(owner, e.SHA); err != nil {
				return entries, bytes, err
			}
			mode := int64(e.Mode & 0o777)
			if mode == 0 {
				mode = 0o644
			}
			h.Typeflag, h.Mode, h.Size = tar.TypeReg, mode, int64(len(data))
		default:
			continue
		}
		if err := tw.WriteHeader(h); err != nil {
			return entries, bytes, err
		}
		if len(data) > 0 {
			if _, err := tw.Write(data); err != nil {
				return entries, bytes, err
			}
		}
		entries++
		bytes += int64(len(data))
	}
	return entries, bytes, tw.Close()
}

// workspaceLink is the target a link at name (relative to /workspace) gets in an upgrade's tar: one to /workspace or
// a path under it, which the isolate resolves in its workspace, is made relative to the link's directory (the rest of
// the path as it was, ".." and all), so it points at the same file in the microVM, and the guest's extractor, which
// refuses an absolute link, takes it. Any other is left as it was: one out of the workspace is refused there.
func workspaceLink(name, target string) string {
	const top = "/workspace"
	if target != top && !strings.HasPrefix(target, top+"/") {
		return target
	}
	rest := strings.TrimLeft(target[len(top):], "/")
	up := strings.Repeat("../", strings.Count(name, "/"))
	if rest == "" {
		if up == "" {
			return "."
		}
		return strings.TrimSuffix(up, "/")
	}
	return up + rest
}

// exportLink is the target a link at name gets in an upgrade's tar: workspaceLink's, where that stays in the workspace
// as text (the guest's extractor reads a target as text, never through the links it names). One that leaves it as text
// but whose file is in the workspace, through a link it names (jump -> deep/sub, then jump/../../file), is made the
// path to that file, relative to the link's directory, as the isolate resolves it now. Any other is left as it was:
// the extractor refuses it.
func exportLink(man Manifest, name, target string) string {
	t := workspaceLink(name, target)
	if linkStaysInside(name, t) {
		return t
	}
	dir := path.Dir(name)
	if dir == "." {
		dir = ""
	}
	resolved, ok := resolveInWorkspace(man, dir, t)
	if !ok {
		return t
	}
	up := strings.Repeat("../", strings.Count(name, "/"))
	if resolved == "" {
		if up == "" {
			return "."
		}
		return strings.TrimSuffix(up, "/")
	}
	return up + resolved
}

// linkStaysInside says whether target, read as text from a link at name, stays in the workspace: the extractor's test.
func linkStaysInside(name, target string) bool {
	if target == "" || strings.HasPrefix(target, "/") {
		return false
	}
	depth := strings.Count(name, "/")
	for _, part := range strings.Split(target, "/") {
		switch part {
		case "", ".":
		case "..":
			if depth == 0 {
				return false
			}
			depth--
		default:
			depth++
		}
	}
	return true
}

// resolveInWorkspace walks target (relative, or absolute in /workspace) from dir as the isolate does, following the
// links it passes through (not a last one: that is what the link names), at most 40 of them. It answers the path in
// the workspace ("" for its top) it ends at, or false where it leaves the workspace or loops.
func resolveInWorkspace(man Manifest, dir, target string) (string, bool) {
	var cur []string
	if !strings.HasPrefix(target, "/") && dir != "" {
		cur = strings.Split(dir, "/")
	}
	pending := strings.Split(target, "/")
	if strings.HasPrefix(target, "/") {
		if target != "/workspace" && !strings.HasPrefix(target, "/workspace/") {
			return "", false
		}
		pending = strings.Split(strings.TrimPrefix(target, "/workspace"), "/")
	}
	hops := 0
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		switch part {
		case "", ".":
			continue
		case "..":
			if len(cur) == 0 {
				return "", false
			}
			cur = cur[:len(cur)-1]
			continue
		}
		next := strings.Join(append(append([]string{}, cur...), part), "/")
		if e, ok := man[next]; ok && e.Kind == "symlink" && len(pending) > 0 {
			if hops++; hops > 40 {
				return "", false
			}
			linked := e.Target
			if strings.HasPrefix(linked, "/") {
				if linked != "/workspace" && !strings.HasPrefix(linked, "/workspace/") {
					return "", false
				}
				cur = nil
				linked = strings.TrimPrefix(linked, "/workspace")
			}
			pending = append(strings.Split(linked, "/"), pending...)
			continue
		}
		cur = append(cur, part)
	}
	return strings.Join(cur, "/"), true
}

// Dispose lets an upgraded sandbox's isolate go, its files' list and its meta, with no event, since the sandbox lives
// on as a microVM with its ID. Its snapshots stay, automatic ones too, unlike a delete's: Kantel keeps them as the
// sandbox's, an isolate's, to read or make an isolate from, and deletes them (snapshot.delete) when they expire or
// the sandbox is deleted.
func (m *Manager) Dispose(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.exec.Lock()
	defer s.exec.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.RemoveAll(s.dir); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.sandboxes, id)
	m.mu.Unlock()
	return nil
}

// microvmPrograms are programs a microVM on Kantel's image has and an isolate doesn't: a "command not found" for one of
// them asks for a microVM (packages/compute/src/needs-microvm.ts has the same list).
var microvmPrograms = map[string]bool{}

func init() {
	for _, name := range []string{
		"apt", "apt-get", "bun", "cargo", "cc", "deno", "docker", "dpkg", "g++", "gcc", "gem", "gh", "git", "go",
		"html-to-markdown", "java", "make", "mysql", "node", "npm", "npx", "pip", "pip3", "pnpm", "psql", "python",
		"python3", "rsync", "ruby", "rustc", "scp", "sqlite3", "ssh", "sudo", "systemctl", "tar", "unzip", "uv", "wget",
		"xan", "yarn", "yq", "zip",
	} {
		microvmPrograms[name] = true
	}
}

var (
	notAvailable    = regexp.MustCompile(`(?m)^(?:bash: )?([A-Za-z0-9_.+-]+): (?:command )?not available in (?:an isolate|browser environments)`)
	commandNotFound = regexp.MustCompile(`(?m)^(?:bash: )?(?:line \d+: )?([A-Za-z0-9_.+-]+): command not found`)
)

// needsMicrovm reads, from a command's answer in a runtime that doesn't say, whether it failed for want of a microVM:
// exit 127 and a program the shell says an isolate doesn't have, or one of a microVM's programs it didn't find. A
// typo isn't one.
func needsMicrovm(exitCode int, stderr string) *proto.NeedsMicrovm {
	if exitCode != 127 {
		return nil
	}
	if m := notAvailable.FindStringSubmatch(stderr); m != nil {
		return &proto.NeedsMicrovm{Command: m[1], Reason: "An isolate runs only its shell's own commands, and " + m[1] + " isn't one.", Inferred: true}
	}
	if m := commandNotFound.FindStringSubmatch(stderr); m != nil && microvmPrograms[m[1]] {
		return &proto.NeedsMicrovm{Command: m[1], Reason: "An isolate has no " + m[1] + "; a microVM does.", Inferred: true}
	}
	return nil
}
