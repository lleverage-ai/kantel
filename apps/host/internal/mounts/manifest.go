package mounts

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// object is what the host keeps of one listed object to serve its bytes.
type object struct {
	key  string
	etag string
	// generation, when set, is the GCS generation a read gets (a manifest mount's entry may pin one); a listed object
	// is read by its ETag.
	generation string
	tag        string
	size       int64
}

// manifest is one listing of a mount's prefix: the guest's tree and the host's index of it.
type manifest struct {
	wire    guest.Manifest
	encoded []byte
	objects map[string]object
	bytes   int64
	// skipped counts objects with no place in a file tree (an empty or dot segment, a name too long, a file where a
	// directory is).
	skipped int
}

// normalPrefix is a mount's prefix as listed: no leading slash, a trailing one unless it is the whole bucket.
func normalPrefix(p string) string {
	p = strings.TrimLeft(p, "/")
	if p != "" && !strings.HasSuffix(p, "/") {
		p += "/"
	}
	return p
}

const maxName = 255

// maxKey is the longest object key S3 and GCS allow (1024 bytes): a store's listing names nothing longer, so a key
// that is longer (a store that isn't one, inflating the tree) has no place in it.
const maxKey = 1024

// maxTreeBytes bounds the names a manifest's tree holds, its directories' included, beside its entries' count
// (twice the objects it may list): a listing within its object limit may still name deep paths whose directories
// multiply, and the tree is built, encoded and sent whole.
const maxTreeBytes = 64 << 20

// errTooBig is a listing whose tree is beyond its bounds.
var errTooBig = errors.New("the prefix's tree is too large for a mount")

func validRel(rel string) bool {
	if rel == "" || len(rel) > maxKey {
		return false
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." || len(seg) > maxName || strings.ContainsRune(seg, 0) {
			return false
		}
	}
	return true
}

// item is one entry of a tree being built: a directory (dir), or a file and the object version holding its bytes.
type item struct {
	rel   string
	dir   bool
	o     object
	mtime time.Time
}

// buildManifest makes the tree of a prefix's objects. Directories come from the keys' paths, and from "folder"
// objects (keys ending in "/"). Its version is a digest of what it holds, so the same listing has the same version
// on any host, and across a restart of this one (the entries' proofs aren't in it). sign, when set, gives each
// object's proof (mount.proof). A tree of more than maxEntries entries (files and directories) or maxTreeBytes of
// names is refused before it is built further or encoded.
func buildManifest(objs []bucket.Object, prefix string, sign func(object) string, maxEntries int) (*manifest, error) {
	items := make([]item, 0, len(objs))
	outside := 0
	for _, o := range objs {
		if !strings.HasPrefix(o.Key, prefix) {
			outside++
			continue
		}
		rel := o.Key[len(prefix):]
		if d, ok := strings.CutSuffix(rel, "/"); ok {
			if d != "" {
				items = append(items, item{rel: d, dir: true})
			}
			continue
		}
		items = append(items, item{rel: rel, o: object{key: o.Key, etag: o.ETag, tag: o.Version(), size: o.Size}, mtime: o.LastModified})
	}
	m, err := buildTree(items, sign, maxEntries)
	if m != nil {
		m.skipped += outside
	}
	return m, err
}

// buildTree makes a manifest of items: a file's directories are made for it, an item with no place in a file tree
// (an empty or dot segment, a name too long, a file where a directory is) is skipped, and a later file at a path
// replaces an earlier one.
func buildTree(items []item, sign func(object) string, maxEntries int) (*manifest, error) {
	m := &manifest{objects: map[string]object{}}
	dirs := map[string]bool{}
	count, names := 0, 0
	add := func(p string) bool {
		count++
		names += len(p)
		return (maxEntries <= 0 || count <= maxEntries) && names <= maxTreeBytes
	}
	addDir := func(d string) bool {
		if dirs[d] {
			return true
		}
		dirs[d] = true
		return add(d)
	}
	addDirs := func(rel string) bool {
		for d := path.Dir(rel); d != "." && d != "/" && !dirs[d]; d = path.Dir(d) {
			if !addDir(d) {
				return false
			}
		}
		return true
	}
	files := map[string]item{}
	for _, it := range items {
		if !validRel(it.rel) {
			m.skipped++
			continue
		}
		if it.dir {
			if !addDir(it.rel) || !addDirs(it.rel) {
				return nil, errTooBig
			}
			continue
		}
		if _, dup := files[it.rel]; !dup && !add(it.rel) {
			return nil, errTooBig
		}
		files[it.rel] = it
		if !addDirs(it.rel) {
			return nil, errTooBig
		}
	}
	for rel, it := range files {
		if dirs[rel] {
			// "a" and "a/b" both: the directory wins.
			m.skipped++
			continue
		}
		o := it.o
		m.objects[rel] = o
		m.bytes += o.size
		m.wire.Entries = append(m.wire.Entries, guest.ManifestEntry{Path: rel, Size: o.size, MTimeMs: it.mtime.UnixMilli(), Tag: o.tag})
	}
	for d := range dirs {
		m.wire.Entries = append(m.wire.Entries, guest.ManifestEntry{Path: d, Dir: true})
	}
	sort.Slice(m.wire.Entries, func(i, j int) bool { return m.wire.Entries[i].Path < m.wire.Entries[j].Path })
	if m.wire.Entries == nil {
		m.wire.Entries = []guest.ManifestEntry{}
	}
	entries, _ := json.Marshal(m.wire.Entries)
	sum := sha256.Sum256(entries)
	// Positive, and never 0 (which is "no manifest" to the guest).
	m.wire.Version = int64(binary.BigEndian.Uint64(sum[:8])>>1) | 1
	if sign != nil {
		for i, e := range m.wire.Entries {
			if !e.Dir {
				m.wire.Entries[i].Proof = sign(m.objects[e.Path])
			}
		}
	}
	m.encoded, _ = json.Marshal(m.wire)
	return m, nil
}
