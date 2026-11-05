package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// The guest's half of a sandbox's read-only bucket mounts: a FUSE file system per mount, served by the guest agent
// itself. Its tree is the host's manifest, held in memory, so lookups, listings and stat never leave the guest; an
// object's bytes are fetched from the host (MountPort) as they are first read, and kept in the guest's page cache.
// The mount is read-only (MS_RDONLY): every write fails with EROFS in the kernel.

// MountsStateFile keeps the guest's mounts across a restart of the agent, which takes their FUSE servers with it.
const MountsStateFile = "/run/kantel/mounts.json"

// reservedDirs are directories a mount may not be at or under: the system's own. The same as the API's
// MOUNT_SYSTEM_PATHS (@kantel/contracts/mounts), so a path the API takes is one the guest takes.
var reservedDirs = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run", "/sbin", "/sys", "/usr",
	"/var/lib/docker", "/var/run",
}

// CheckMountPath says whether a mount, a bucket's or a bundle's, may be at p: an absolute, clean path with no control
// characters, not the system's own directories.
func CheckMountPath(p string) error {
	if !strings.HasPrefix(p, "/") || path.Clean(p) != p || p == "/" {
		return fmt.Errorf("a mount's path must be absolute and clean, not %q", p)
	}
	if len(p) > 1024 || strings.ContainsFunc(p, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return fmt.Errorf("bad mount path %q", p)
	}
	for _, dir := range reservedDirs {
		if p == dir || strings.HasPrefix(p, dir+"/") {
			return fmt.Errorf("a mount can't be at or under %s: it is the system's own", dir)
		}
	}
	return nil
}

// overlaps says whether mounts at a and b would meet: the same path, or one inside the other.
func overlaps(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/")
}

// Mounts are the guest's bucket mounts, by path.
type Mounts struct {
	// Dial reaches the host's MountPort (vsock); tests give another.
	Dial func(ctx context.Context) (net.Conn, error)
	// StateFile, when set, keeps the specs across a restart of the agent.
	StateFile string

	mu     sync.Mutex
	byPath map[string]*bucketMount
	client *http.Client
}

func (ms *Mounts) httpClient() *http.Client {
	if ms.client == nil {
		ms.client = &http.Client{Transport: &http.Transport{
			DialContext:         func(ctx context.Context, _, _ string) (net.Conn, error) { return ms.Dial(ctx) },
			MaxIdleConnsPerHost: 32,
			IdleConnTimeout:     30 * time.Second,
			DisableCompression:  true,
		}}
	}
	return ms.client
}

// Apply makes the guest's mounts the specs: a mount the specs don't name (or name with another key) is unmounted,
// one they name is mounted, and one already there is checked against the host's newest manifest.
func (ms *Mounts) Apply(ctx context.Context, specs []MountSpec) []MountResult {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	if ms.byPath == nil {
		ms.byPath = map[string]*bucketMount{}
	}
	want := map[string]MountSpec{}
	for _, s := range specs {
		want[s.Path] = s
	}
	for p, m := range ms.byPath {
		if s, ok := want[p]; !ok || s.Key != m.spec.Key {
			m.unmount()
			delete(ms.byPath, p)
		}
	}
	results := make([]MountResult, 0, len(specs))
	for _, s := range specs {
		r := MountResult{Path: s.Path}
		if m, ok := ms.byPath[s.Path]; ok {
			m.spec.Index, m.spec.TTLSeconds = s.Index, s.TTLSeconds
			if err := m.check(ctx); err != nil {
				log.Printf("mount %s: checking the manifest: %v", s.Path, err)
			}
			r.Version = m.tree.Load().version
		} else if m, err := ms.mount(ctx, s); err != nil {
			r.Error = err.Error()
		} else {
			ms.byPath[s.Path] = m
			r.Version = m.tree.Load().version
		}
		results = append(results, r)
	}
	ms.save()
	return results
}

// Release unmounts the bucket mounts at, above or under any of paths: a sandbox made from a snapshot may have one
// where it now has a bundle (the same path, a parent of it, or a folder in it), which goes before the bundle is
// mounted, so its unmount can never take the bundle instead, and the bundle never mounts on the old bucket's
// read-only view (POST /bundles). A sandbox's own mounts never overlap, so every bucket mount that meets a bundle's
// path is a snapshot's the sandbox no longer has. Deepest first, should two of those be nested.
func (ms *Mounts) Release(paths []string) {
	if ms == nil {
		return
	}
	ms.mu.Lock()
	defer ms.mu.Unlock()
	var gone []string
	for p := range ms.byPath {
		for _, q := range paths {
			if overlaps(p, q) {
				gone = append(gone, p)
				break
			}
		}
	}
	if len(gone) == 0 {
		return
	}
	sort.Slice(gone, func(i, j int) bool { return len(gone[i]) > len(gone[j]) })
	for _, p := range gone {
		ms.byPath[p].unmount()
		delete(ms.byPath, p)
	}
	ms.save()
}

func (ms *Mounts) save() {
	if ms.StateFile == "" {
		return
	}
	specs := make([]MountSpec, 0, len(ms.byPath))
	for _, m := range ms.byPath {
		specs = append(specs, m.spec)
	}
	raw, _ := json.Marshal(specs)
	_ = os.MkdirAll(path.Dir(ms.StateFile), 0o700)
	_ = os.WriteFile(ms.StateFile, raw, 0o600)
}

// Restore mounts again what a previous run of the agent had mounted (their FUSE servers ended with it).
func (ms *Mounts) Restore(ctx context.Context) {
	if ms.StateFile == "" {
		return
	}
	raw, err := os.ReadFile(ms.StateFile)
	if err != nil {
		return
	}
	var specs []MountSpec
	if json.Unmarshal(raw, &specs) != nil || len(specs) == 0 {
		return
	}
	for _, r := range ms.Apply(ctx, specs) {
		if r.Error != "" {
			log.Printf("mount %s again: %s", r.Path, r.Error)
		}
	}
}

// tree is one manifest, indexed.
type tree struct {
	version  int64
	entries  map[string]ManifestEntry
	children map[string][]string
	bytes    int64
	files    uint64
	at       time.Time
}

func newTree(m Manifest) *tree {
	t := &tree{version: m.Version, entries: make(map[string]ManifestEntry, len(m.Entries)+1), children: map[string][]string{}, at: time.Now()}
	t.entries[""] = ManifestEntry{Dir: true}
	for _, e := range m.Entries {
		if e.Path == "" || strings.HasPrefix(e.Path, "/") {
			continue
		}
		t.entries[e.Path] = e
		if !e.Dir {
			t.bytes += e.Size
			t.files++
		}
	}
	for p := range t.entries {
		if p == "" {
			continue
		}
		parent := path.Dir(p)
		if parent == "." {
			parent = ""
		}
		if pe, ok := t.entries[parent]; !ok || !pe.Dir {
			// An orphan (the host always sends the directories): leave it out.
			delete(t.entries, p)
			continue
		}
		t.children[parent] = append(t.children[parent], path.Base(p))
	}
	for _, names := range t.children {
		sort.Strings(names)
	}
	return t
}

type bucketMount struct {
	ms     *Mounts
	spec   MountSpec
	tree   atomic.Pointer[tree]
	root   *dirNode
	server *fuse.Server
	// checked is when the guest last asked the host about the manifest (unix ns); checking is one at a time.
	checked  atomic.Int64
	checking atomic.Bool
	// updating orders update's fetch and publish, whoever calls it (a TTL check, the refresh xattr, Apply): a
	// manifest asked for earlier never replaces one asked for later.
	updating sync.Mutex
}

func (ms *Mounts) mount(ctx context.Context, s MountSpec) (*bucketMount, error) {
	if err := CheckMountPath(s.Path); err != nil {
		return nil, err
	}
	m := &bucketMount{ms: ms, spec: s}
	man, err := m.fetch(ctx, http.MethodGet, "manifest", 0)
	if err != nil {
		return nil, err
	}
	m.tree.Store(newTree(*man))
	m.checked.Store(time.Now().UnixNano())
	// A bundle still mounted here, above or under here (a snapshot's, which POST /bundles couldn't unmount: something
	// in the sandbox uses it) stays, as a bundle replaced by another does: never detached or hidden under its users, so
	// its drive stays held. The sandbox's own bundles never overlap its buckets, so one that does is a snapshot's.
	for p := range readBundleState() {
		if overlaps(p, s.Path) {
			return nil, fmt.Errorf("the bundle mounted at %s before is still in use in the sandbox", p)
		}
	}
	// Something left at the path (a mount of a previous run of the agent, its server gone) goes first.
	_ = syscall.Unmount(s.Path, syscall.MNT_DETACH)
	if err := os.MkdirAll(s.Path, 0o755); err != nil {
		return nil, err
	}
	m.root = &dirNode{m: m, path: ""}
	second := time.Second
	server, err := fs.Mount(s.Path, m.root, &fs.Options{
		MountOptions: fuse.MountOptions{
			AllowOther: true, FsName: "kantel-bucket", Name: "kantel",
			DirectMountStrict: true, DirectMountFlags: syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV,
			Options:  []string{"default_permissions"},
			MaxWrite: 1 << 20, MaxReadAhead: 1 << 20, MaxBackground: 32,
		},
		EntryTimeout: &second, AttrTimeout: &second, NegativeTimeout: &second,
	})
	if err != nil {
		return nil, fmt.Errorf("fuse mount at %s: %w", s.Path, err)
	}
	m.server = server
	return m, nil
}

func (m *bucketMount) unmount() {
	if m.server == nil {
		return
	}
	if err := m.server.Unmount(); err != nil {
		// Busy (a shell in it): detach it, so it goes once nothing uses it.
		_ = syscall.Unmount(m.spec.Path, syscall.MNT_DETACH)
	}
}

// fetch asks the host for the mount's manifest (method GET, "manifest") or a refresh (POST, "refresh"); a 304 to
// "have" answers nil.
func (m *bucketMount) fetch(ctx context.Context, method, what string, have int64) (*Manifest, error) {
	u := fmt.Sprintf("http://host/mounts/%d/%s", m.spec.Index, what)
	if have != 0 {
		u += "?have=" + strconv.FormatInt(have, 10)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.ms.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("the host answered %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var man Manifest
	if err := json.NewDecoder(resp.Body).Decode(&man); err != nil {
		return nil, fmt.Errorf("the host's manifest: %w", err)
	}
	return &man, nil
}

// check asks the host whether the manifest changed, and takes the new one.
func (m *bucketMount) check(ctx context.Context) error {
	return m.update(ctx, http.MethodGet, "manifest")
}

func (m *bucketMount) update(ctx context.Context, method, what string) error {
	m.updating.Lock()
	defer m.updating.Unlock()
	old := m.tree.Load()
	man, err := m.fetch(ctx, method, what, old.version)
	m.checked.Store(time.Now().UnixNano())
	if err != nil || man == nil {
		return err
	}
	next := newTree(*man)
	m.tree.Store(next)
	go m.invalidate(old, next)
	return nil
}

// touch is a look at the mount: once the TTL has passed since the last check, it checks again, in the background.
func (m *bucketMount) touch() {
	ttl := time.Duration(m.spec.TTLSeconds) * time.Second
	if ttl <= 0 || time.Since(time.Unix(0, m.checked.Load())) < ttl {
		return
	}
	if !m.checking.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer m.checking.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := m.check(ctx); err != nil {
			log.Printf("mount %s: checking the manifest: %v", m.spec.Path, err)
		}
	}()
}

// invalidate tells the kernel to forget the names that changed between two trees, so the next lookup sees the new
// one at once rather than after the entry timeout.
func (m *bucketMount) invalidate(old, next *tree) {
	if m.root == nil {
		return
	}
	changed := map[string]bool{}
	for p, e := range old.entries {
		if n, ok := next.entries[p]; !ok || n.Dir != e.Dir || fileVersion(n) != fileVersion(e) {
			changed[p] = true
		}
	}
	for p := range next.entries {
		if _, ok := old.entries[p]; !ok {
			changed[p] = true
		}
	}
	for p := range changed {
		if p == "" {
			continue
		}
		parent := m.root.EmbeddedInode()
		dir := path.Dir(p)
		if dir != "." {
			for _, seg := range strings.Split(dir, "/") {
				if parent = parent.GetChild(seg); parent == nil {
					break
				}
			}
		}
		if parent != nil {
			_ = parent.NotifyEntry(path.Base(p))
		}
	}
}

// fileVersion is what a file's inode is of: its version and the metadata the manifest shows with it, so a refresh
// that changes only a file's modification time (the same bytes written again) gives fresh lookups a new node, while a
// file opened before keeps its own.
func fileVersion(e ManifestEntry) string {
	if e.Dir {
		return ""
	}
	return e.Tag + "\x00" + strconv.FormatInt(e.Size, 10) + "\x00" + strconv.FormatInt(e.MTimeMs, 10)
}

func inoFor(kind, p, tag string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(kind + "\x00" + p + "\x00" + tag))
	ino := h.Sum64()
	if ino <= fuse.FUSE_ROOT_ID || ino == ^uint64(0) {
		ino = 2
	}
	return ino
}

func join(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

type dirNode struct {
	fs.Inode
	m    *bucketMount
	path string
}

var (
	_ fs.NodeLookuper   = (*dirNode)(nil)
	_ fs.NodeReaddirer  = (*dirNode)(nil)
	_ fs.NodeGetattrer  = (*dirNode)(nil)
	_ fs.NodeGetxattrer = (*dirNode)(nil)
	_ fs.NodeStatfser   = (*dirNode)(nil)
)

func dirAttr(out *fuse.Attr, t *tree) {
	out.Mode = syscall.S_IFDIR | 0o555
	out.Nlink = 2
	out.SetTimes(nil, &t.at, &t.at)
}

func fileAttr(out *fuse.Attr, e ManifestEntry) {
	out.Mode = syscall.S_IFREG | 0o444
	out.Nlink = 1
	out.Size = uint64(e.Size)
	out.Blocks = (out.Size + 511) / 512
	out.Blksize = 4096
	mtime := time.UnixMilli(e.MTimeMs)
	out.SetTimes(nil, &mtime, &mtime)
}

func (d *dirNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	d.m.touch()
	t := d.m.tree.Load()
	p := join(d.path, name)
	e, ok := t.entries[p]
	if !ok {
		return nil, syscall.ENOENT
	}
	if e.Dir {
		dirAttr(&out.Attr, t)
		out.Ino = inoFor("d", p, "")
		return d.NewInode(ctx, &dirNode{m: d.m, path: p}, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: out.Ino}), 0
	}
	fileAttr(&out.Attr, e)
	out.Ino = inoFor("f", p, fileVersion(e))
	return d.NewInode(ctx, &fileNode{m: d.m, entry: e}, fs.StableAttr{Mode: syscall.S_IFREG, Ino: out.Ino}), 0
}

func (d *dirNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	d.m.touch()
	t := d.m.tree.Load()
	names := t.children[d.path]
	list := make([]fuse.DirEntry, 0, len(names))
	for _, name := range names {
		p := join(d.path, name)
		e := t.entries[p]
		if e.Dir {
			list = append(list, fuse.DirEntry{Name: name, Mode: syscall.S_IFDIR, Ino: inoFor("d", p, "")})
		} else {
			list = append(list, fuse.DirEntry{Name: name, Mode: syscall.S_IFREG, Ino: inoFor("f", p, fileVersion(e))})
		}
	}
	return fs.NewListDirStream(list), 0
}

func (d *dirNode) Getattr(ctx context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	dirAttr(&out.Attr, d.m.tree.Load())
	return 0
}

// Getxattr answers RefreshXattr on the mount's root: the host lists the prefix again, and the answer is the new
// manifest version. The kernel asks once for the size and once for the value, so a refresh in the last two seconds
// answers without listing again.
func (d *dirNode) Getxattr(ctx context.Context, attr string, dest []byte) (uint32, syscall.Errno) {
	if d.path != "" || attr != RefreshXattr {
		return 0, syscall.ENODATA
	}
	if time.Since(time.Unix(0, d.m.checked.Load())) > 2*time.Second {
		if err := d.m.update(ctx, http.MethodPost, "refresh"); err != nil {
			log.Printf("mount %s: refresh: %v", d.m.spec.Path, err)
			return 0, syscall.EIO
		}
	}
	value := strconv.FormatInt(d.m.tree.Load().version, 10)
	if len(dest) < len(value) {
		return uint32(len(value)), syscall.ERANGE
	}
	return uint32(copy(dest, value)), 0
}

func (d *dirNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	t := d.m.tree.Load()
	out.Bsize = 4096
	out.Frsize = 4096
	out.Blocks = uint64(t.bytes+4095) / 4096
	out.Files = uint64(len(t.entries))
	out.NameLen = 255
	return 0
}

type fileNode struct {
	fs.Inode
	m     *bucketMount
	entry ManifestEntry
}

var (
	_ fs.NodeGetattrer = (*fileNode)(nil)
	_ fs.NodeOpener    = (*fileNode)(nil)
	_ fs.NodeReader    = (*fileNode)(nil)
)

func (f *fileNode) Getattr(ctx context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	fileAttr(&out.Attr, f.entry)
	return 0
}

func (f *fileNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_TRUNC|syscall.O_APPEND) != 0 {
		return nil, 0, syscall.EROFS
	}
	// An inode is one version of an object, so what the kernel cached of it stays good.
	return nil, fuse.FOPEN_KEEP_CACHE, 0
}

// ErrStaleObject is an object that changed in the bucket since the guest opened it, twice over.
var ErrStaleObject = errors.New("the object changed in the bucket")

func (f *fileNode) Read(ctx context.Context, _ fs.FileHandle, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	size := f.entry.Size
	if off >= size || len(dest) == 0 {
		return fuse.ReadResultData(nil), 0
	}
	end := min(off+int64(len(dest)), size)
	n, err := f.m.readAt(ctx, f.entry, dest[:end-off], off)
	if err != nil {
		log.Printf("mount %s: read %s: %v", f.m.spec.Path, f.entry.Path, err)
		if errors.Is(err, ErrStaleObject) {
			return nil, syscall.ESTALE
		}
		return nil, syscall.EIO
	}
	return fuse.ReadResultData(dest[:n]), 0
}

// readAt reads len(p) bytes of an object at off from the host, retrying once (a connection a snapshot reset, or an
// answer cut short). Read keeps p within the object, so an answer shorter than p is a failed transfer, never the
// object's end: it is an error, not a short read the kernel would keep in its page cache.
func (m *bucketMount) readAt(ctx context.Context, e ManifestEntry, p []byte, off int64) (int, error) {
	u := fmt.Sprintf("http://host/mounts/%d/object?path=%s&tag=%s", m.spec.Index, url.QueryEscape(e.Path), url.QueryEscape(e.Tag))
	if e.Proof != "" {
		u += fmt.Sprintf("&size=%d&k=%s", e.Size, url.QueryEscape(e.Proof))
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+int64(len(p))-1))
		resp, err := m.ms.httpClient().Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode == http.StatusGone {
			resp.Body.Close()
			return 0, ErrStaleObject
		}
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			return 0, fmt.Errorf("the host answered %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		n, err := io.ReadFull(resp.Body, p)
		resp.Body.Close()
		if err == nil {
			return n, nil
		}
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		lastErr = fmt.Errorf("the host's answer ended after %d of %d bytes: %w", n, len(p), err)
	}
	return 0, lastErr
}
