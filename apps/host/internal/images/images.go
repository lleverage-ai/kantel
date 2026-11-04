// Package images is the host images a host boots sandboxes on (the guest kernel and root filesystems): fetching them
// from a manifest, checking the manifest's signature, and keeping each version side by side, so an update changes
// what new sandboxes boot on and never the image under a sandbox that exists.
//
// On disk (Store.Dir, default Root/images):
//
//	v/<version>/{vmlinux,sandbox.ext4,isolate.ext4,manifest.json}   one version's files
//	current -> v/<version>                                          the version new sandboxes start on
//	vmlinux, sandbox.ext4, isolate.ext4 -> current/...              the config's default paths, once linked
package images

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Manifest is <images>/manifest.json: the files a host needs, by name, for this architecture.
type Manifest struct {
	Version string          `json:"version"`
	Files   map[string]File `json:"files"`
}

// File is one file a manifest lists.
type File struct {
	// Path is relative to the manifest (or a full URL).
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	// Gzip: the file is gzip-compressed and is unpacked as it is fetched.
	Gzip bool `json:"gzip,omitempty"`
}

// Arch is this machine's architecture as manifests name it.
func Arch() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}

func isURL(s string) bool {
	return strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "http://")
}

// Open reads a file from a URL or a directory. A URL's request is made with ctx, so its end (an update's deadline)
// stops the connection and every read of the body, not only the connect.
func Open(ctx context.Context, base, rel string) (io.ReadCloser, error) {
	if isURL(rel) {
		return httpGet(ctx, rel)
	}
	if isURL(base) {
		u, err := url.JoinPath(base, rel)
		if err != nil {
			return nil, err
		}
		return httpGet(ctx, u)
	}
	return os.Open(filepath.Join(strings.TrimPrefix(base, "file://"), rel))
}

// httpGet has no timeout of its own (a root filesystem takes a while): ctx bounds it.
func httpGet(ctx context.Context, u string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("GET %s: %s", u, res.Status)
	}
	return res.Body, nil
}

// Fetch writes one file, checking its digest; a file already there with the right digest is kept. ctx bounds the
// download (Open).
func Fetch(ctx context.Context, base string, f File, dst string, mode os.FileMode) error {
	if f.SHA256 != "" {
		if sum, err := recordedSHA256(dst); err == nil && sum == f.SHA256 {
			if _, err := os.Stat(dst); err == nil {
				fmt.Printf("  %s: up to date\n", filepath.Base(dst))
				return nil
			}
		}
	}
	in, err := Open(ctx, base, f.Path)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	hash := sha256.New()
	var reader io.Reader = io.TeeReader(in, hash)
	if f.Gzip {
		gz, err := gzip.NewReader(reader)
		if err != nil {
			return err
		}
		reader = gz
	}
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	started := time.Now()
	n, err := io.Copy(out, reader)
	if err != nil {
		out.Close()
		return fmt.Errorf("%s: %w", f.Path, err)
	}
	_, _ = io.Copy(io.Discard, in)
	if err := out.Close(); err != nil {
		return err
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	if f.SHA256 != "" && sum != f.SHA256 {
		os.Remove(tmp)
		return fmt.Errorf("%s: digest %s, want %s", f.Path, sum, f.SHA256)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	_ = os.WriteFile(dst+".sha256-source", []byte(sum), 0o644)
	fmt.Printf("  %s: %d MB in %s\n", filepath.Base(dst), n>>20, time.Since(started).Round(100*time.Millisecond))
	return nil
}

// recordedSHA256 is the digest Fetch recorded beside dst when it downloaded it.
func recordedSHA256(dst string) (string, error) {
	raw, err := os.ReadFile(dst + ".sha256-source")
	return strings.TrimSpace(string(raw)), err
}

// ValidVersion says whether a version can name a directory: it comes from the control plane and from manifests, so
// nothing in it may climb out of v/.
func ValidVersion(v string) bool {
	if v == "" || v == "." || v == ".." || len(v) > 128 || strings.HasSuffix(v, ".part") {
		return false
	}
	for _, r := range v {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

// VersionOf is the version a path to a versioned image names (<dir>/v/<version>/<file>), or "" for any other path.
func VersionOf(p string) string {
	if p == "" {
		return ""
	}
	dir := filepath.Dir(filepath.Clean(p))
	v := filepath.Base(dir)
	if filepath.Base(filepath.Dir(dir)) != "v" || !ValidVersion(v) {
		return ""
	}
	return v
}

// Store is the versioned images under Dir.
type Store struct {
	Dir string
}

const manifestFile = "manifest.json"

// imageFile is one file of a version: its name in the manifest, its name in the version's directory (the names
// the config's default paths have), and whether a microVM host needs it.
type imageFile struct {
	name, local string
	required    bool
}

func versionFiles(arch string) []imageFile {
	return []imageFile{
		{name: "vmlinux-" + arch, local: "vmlinux", required: true},
		{name: "sandbox-" + arch + ".ext4", local: "sandbox.ext4", required: true},
		{name: "isolate-" + arch + ".ext4", local: "isolate.ext4"},
	}
}

func (s Store) versionDir(version string) string { return filepath.Join(s.Dir, "v", version) }

// installed says whether a version is whole: its manifest is written last, and the directory renamed into place.
func (s Store) installed(version string) bool {
	_, err := os.Stat(filepath.Join(s.versionDir(version), manifestFile))
	return err == nil
}

// Current is the version new sandboxes start on.
func (s Store) Current() (version string, ok bool) {
	target, err := os.Readlink(filepath.Join(s.Dir, "current"))
	if err != nil {
		return "", false
	}
	v := filepath.Base(target)
	if filepath.Dir(target) != "v" || !ValidVersion(v) {
		return "", false
	}
	return v, true
}

// Version is the version a resolved image path is under in this store, or "".
func (s Store) Version(p string) string {
	v := VersionOf(p)
	if v == "" {
		return ""
	}
	got := filepath.Dir(filepath.Clean(p))
	if got == s.versionDir(v) {
		return v
	}
	// Dir may itself be under a link (Root on another disk), and a resolved path is past it.
	if real, err := filepath.EvalSymlinks(s.Dir); err == nil && got == filepath.Join(real, "v", v) {
		return v
	}
	return ""
}

// Install fetches a version's files for arch (none without KVM: they are the microVMs' and isolate VMs') into
// v/<m.Version>, each checked against the manifest's digest. A version already installed is kept as it is; one
// half-fetched carries on from what it has.
func (s Store) Install(ctx context.Context, base string, m Manifest, arch string, kvm bool) (dir string, err error) {
	if !ValidVersion(m.Version) {
		return "", fmt.Errorf("images manifest: bad version %q", m.Version)
	}
	dir = s.versionDir(m.Version)
	if s.installed(m.Version) {
		return dir, nil
	}
	var files []imageFile
	if kvm {
		files = versionFiles(arch)
		// Before anything is downloaded.
		for _, f := range files {
			if _, ok := m.Files[f.name]; !ok && f.required {
				return "", fmt.Errorf("images %s have no %s", m.Version, f.name)
			}
		}
	}
	part := dir + ".part"
	if err := os.MkdirAll(part, 0o755); err != nil {
		return "", err
	}
	for _, f := range files {
		mf, ok := m.Files[f.name]
		if !ok {
			continue
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		dst := filepath.Join(part, f.local)
		s.reuse(mf.SHA256, f.local, dst)
		if err := Fetch(ctx, base, mf, dst, 0o644); err != nil {
			return "", fmt.Errorf("images %s: %w", m.Version, err)
		}
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(part, manifestFile), append(raw, '\n'), 0o644); err != nil {
		return "", err
	}
	// A directory there without a manifest never finished.
	_ = os.RemoveAll(dir)
	if err := os.Rename(part, dir); err != nil {
		return "", err
	}
	return dir, nil
}

// reuse links into dst a file another version already has with the same digest, so a version that changes one file
// downloads only that one (Fetch then finds dst up to date). The images are never written once fetched, so sharing
// the inode is safe.
func (s Store) reuse(sum, local, dst string) {
	if sum == "" {
		return
	}
	if _, err := os.Lstat(dst); err == nil {
		return
	}
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "v"))
	for _, e := range entries {
		if !e.IsDir() || !ValidVersion(e.Name()) {
			continue
		}
		src := filepath.Join(s.Dir, "v", e.Name(), local)
		if got, err := recordedSHA256(src); err != nil || got != sum {
			continue
		}
		if os.Link(src, dst) != nil {
			continue
		}
		_ = os.WriteFile(dst+".sha256-source", []byte(sum), 0o644)
		return
	}
}

// Activate makes version current: the link is replaced in one rename, so a reader sees the old version or the new.
func (s Store) Activate(version string) error {
	if !ValidVersion(version) {
		return fmt.Errorf("bad images version %q", version)
	}
	if !s.installed(version) {
		return fmt.Errorf("images %s aren't installed", version)
	}
	tmp := filepath.Join(s.Dir, "current.tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join("v", version), tmp); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.Dir, "current"))
}

// Paths are the config's image paths, which Link turns into links to the current version when they are the
// defaults.
type Paths struct {
	Kernel, SandboxImage, IsolateImage string
}

// Link turns the config's image paths into links to current/<file>, only where they are the defaults under Dir and a
// plain file or missing: a custom path is never touched. Plain files (from an install before images were versioned)
// first go, once, into a version of their own, which becomes current, so what the host runs now doesn't change; a
// migration that was stopped part-way is finished by the next Link (migrate).
func (s Store) Link(p Paths) error {
	type entry struct{ path, local string }
	var defaults, plain []entry
	for _, e := range []entry{{p.Kernel, "vmlinux"}, {p.SandboxImage, "sandbox.ext4"}, {p.IsolateImage, "isolate.ext4"}} {
		if e.path == "" || filepath.Clean(e.path) != filepath.Join(s.Dir, e.local) {
			continue
		}
		defaults = append(defaults, e)
		if info, err := os.Lstat(e.path); err == nil && info.Mode().IsRegular() {
			plain = append(plain, e)
		}
	}
	if len(plain) > 0 {
		locals := make([]string, len(plain))
		for i, e := range plain {
			locals[i] = e.local
		}
		if err := s.migrate(locals); err != nil {
			return fmt.Errorf("putting the images into %s: %w", filepath.Join(s.Dir, "v"), err)
		}
	}
	if _, ok := s.Current(); !ok {
		return nil
	}
	for _, e := range defaults {
		if _, err := os.Lstat(e.path); !errors.Is(err, os.ErrNotExist) {
			continue // a link already, or something of the operator's
		}
		// Only to a file the current version has: a link to nothing would make a missing image look present.
		if _, err := os.Stat(filepath.Join(s.Dir, "current", e.local)); err != nil {
			continue
		}
		if err := os.Symlink(filepath.Join("current", e.local), e.path); err != nil {
			return err
		}
	}
	return nil
}

// migrationStep is called between the steps of a migration; a test makes it fail to stop one there, as a crash would.
var migrationStep = func(step string) error { return nil }

// migrate puts plain files at Dir/<local> into a version of their own, makes it current, and replaces them with links
// to it. The version is the installed manifest's (Dir/manifest.json), else "initial"; one that exists already gets a
// suffix. No step moves or removes the only copy of an image: the originals are linked (or copied) into the staging
// directory, which is renamed into place whole; then the version is activated; and only then is each default path
// replaced, in one rename, by a link to the same file under current. So a migration stopped anywhere is started
// again by the next Link: a staging directory holds only second names, and a version already committed with these
// very files is finished rather than made again.
func (s Store) migrate(locals []string) error {
	version := "initial"
	if raw, err := os.ReadFile(filepath.Join(s.Dir, manifestFile)); err == nil {
		var m Manifest
		if json.Unmarshal(raw, &m) == nil && ValidVersion(m.Version) {
			version = m.Version
		}
	}
	if held, ok := s.holding(version, locals); ok {
		return s.finishMigration(held, locals)
	}
	if _, err := os.Stat(s.versionDir(version)); err == nil {
		version += "." + strconv.FormatInt(time.Now().Unix(), 10)
	}
	dir := s.versionDir(version)
	part := dir + ".part"
	// Only second names (links or copies) are ever in it.
	_ = os.RemoveAll(part)
	if err := os.MkdirAll(part, 0o755); err != nil {
		return err
	}
	moving := map[string]bool{}
	for _, local := range locals {
		moving[local] = true
	}
	// The current version's other files come along (linked), so the new version is whole.
	if current, ok := s.Current(); ok {
		entries, _ := os.ReadDir(s.versionDir(current))
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || name == manifestFile || moving[strings.TrimSuffix(name, ".sha256-source")] {
				continue
			}
			_ = os.Link(filepath.Join(s.versionDir(current), name), filepath.Join(part, name))
		}
	}
	for _, local := range locals {
		src := filepath.Join(s.Dir, local)
		if err := stage(src, filepath.Join(part, local)); err != nil {
			return err
		}
		if _, err := os.Stat(src + ".sha256-source"); err == nil {
			_ = stage(src+".sha256-source", filepath.Join(part, local+".sha256-source"))
		}
		if err := migrationStep("staging"); err != nil {
			return err
		}
	}
	raw, _ := json.MarshalIndent(Manifest{Version: version, Files: map[string]File{}}, "", "  ")
	if err := os.WriteFile(filepath.Join(part, manifestFile), append(raw, '\n'), 0o644); err != nil {
		return err
	}
	if err := migrationStep("staged"); err != nil {
		return err
	}
	if err := os.Rename(part, dir); err != nil {
		return err
	}
	if err := migrationStep("committed"); err != nil {
		return err
	}
	return s.finishMigration(version, locals)
}

// finishMigration makes a version migrate committed current, then replaces each plain file at Dir/<local> (the
// same file as the version's) with a link to current/<local>, in one rename: the default path names the image
// throughout. The digest recorded beside it went into the version with it.
func (s Store) finishMigration(version string, locals []string) error {
	if err := s.Activate(version); err != nil {
		return err
	}
	if err := migrationStep("activated"); err != nil {
		return err
	}
	for _, local := range locals {
		p := filepath.Join(s.Dir, local)
		if _, err := os.Stat(filepath.Join(s.versionDir(version), local+".sha256-source")); err == nil {
			_ = os.Remove(p + ".sha256-source")
		}
		tmp := p + ".link"
		_ = os.Remove(tmp)
		if err := os.Symlink(filepath.Join("current", local), tmp); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		if err := migrationStep("replacing"); err != nil {
			return err
		}
	}
	return nil
}

// holding is the installed version (version, or one migrate named after it with a suffix) that already has the plain
// files at Dir/<locals> as its own: one a migration committed before it was stopped, which a retry finishes.
func (s Store) holding(version string, locals []string) (string, bool) {
	candidates := []string{version}
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "v"))
	for _, e := range entries {
		if e.IsDir() && ValidVersion(e.Name()) && strings.HasPrefix(e.Name(), version+".") {
			candidates = append(candidates, e.Name())
		}
	}
	for _, v := range candidates {
		if s.installed(v) && s.holds(v, locals) {
			return v, true
		}
	}
	return "", false
}

// holds says whether version's files at <locals> are the plain files at Dir/<locals>: the same inode (linked when it
// was staged), or a copy of the same size and time (staged across filesystems).
func (s Store) holds(version string, locals []string) bool {
	for _, local := range locals {
		have, err := os.Stat(filepath.Join(s.Dir, local))
		if err != nil {
			return false
		}
		staged, err := os.Stat(filepath.Join(s.versionDir(version), local))
		if err != nil {
			return false
		}
		if !os.SameFile(have, staged) && (have.Size() != staged.Size() || !have.ModTime().Equal(staged.ModTime())) {
			return false
		}
	}
	return true
}

// stage gives src a second name at dst, leaving src as it is: a hard link, or where that can't be made (dst on
// another filesystem) a copy with src's mode and time.
func stage(src, dst string) error {
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	_ = os.Remove(dst)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// PruneStaging removes the staging directories (v/<version>.part) of installs that didn't finish, all but the newest:
// that one is kept for a retry to reuse what it had fetched, and each older one's version has been superseded. The
// caller makes sure no install is running (Updater.Prune holds the updater's lock). It answers what it removed.
func (s Store) PruneStaging() []string {
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "v"))
	type staging struct {
		name string
		at   time.Time
	}
	var parts []staging
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".part")
		if !e.IsDir() || !ok || !ValidVersion(name) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		parts = append(parts, staging{name: e.Name(), at: info.ModTime()})
	}
	sort.Slice(parts, func(i, j int) bool { return parts[i].at.After(parts[j].at) })
	var removed []string
	for _, p := range parts[min(1, len(parts)):] {
		if err := os.RemoveAll(filepath.Join(s.Dir, "v", p.name)); err == nil {
			removed = append(removed, p.name)
		}
	}
	return removed
}

// Prune removes the versions that aren't current, aren't among the newest keepNewest, and that keep doesn't want
// (the microVM tier's sandboxes, snapshots and templates still on them). It answers what it removed.
func (s Store) Prune(keep func(version string) bool, keepNewest int) []string {
	entries, _ := os.ReadDir(filepath.Join(s.Dir, "v"))
	current, _ := s.Current()
	type version struct {
		name string
		at   time.Time
	}
	var versions []version
	for _, e := range entries {
		// A .part directory is a version still being fetched.
		if !e.IsDir() || !ValidVersion(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		versions = append(versions, version{name: e.Name(), at: info.ModTime()})
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].at.After(versions[j].at) })
	var removed []string
	for i, v := range versions {
		if v.name == current || i < keepNewest || (keep != nil && keep(v.name)) {
			continue
		}
		if err := os.RemoveAll(s.versionDir(v.name)); err == nil {
			removed = append(removed, v.name)
		}
	}
	return removed
}
