package isolate

import (
	"archive/tar"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// An isolate's part in an upgrade to a microVM (sandbox.upgrade, agent/upgrade.go): its files as a tar, read from the
// host's blob store, and its going once the microVM runs with them. And whether a command needed a microVM at all.

// ExportTar writes the sandbox's /workspace to w as a tar: its directories, its files (from the account's blobs, with
// their modes) and its links, each named relative to /workspace. It is one state: held against the sandbox's
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
			h.Typeflag, h.Linkname, h.Mode = tar.TypeSymlink, e.Target, 0o777
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

// Dispose lets an upgraded sandbox's isolate go: its files' list, its meta and its automatic snapshots, as a delete
// does, but with no event, since the sandbox lives on as a microVM with its ID. Its saved snapshots stay the account's.
func (m *Manager) Dispose(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.exec.Lock()
	defer s.exec.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	m.autoMu.Lock()
	for _, snap := range m.snapshotsOf(id) {
		if snap.Kind == "auto" {
			_ = os.RemoveAll(m.snapshotDir(snap.ID))
		}
	}
	m.autoMu.Unlock()
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
		return &proto.NeedsMicrovm{Command: m[1], Reason: "An isolate runs only its shell's own commands, and " + m[1] + " isn't one."}
	}
	if m := commandNotFound.FindStringSubmatch(stderr); m != nil && microvmPrograms[m[1]] {
		return &proto.NeedsMicrovm{Command: m[1], Reason: "An isolate has no " + m[1] + "; a microVM does."}
	}
	return nil
}
