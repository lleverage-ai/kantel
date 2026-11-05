package mounts

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// object is what the host keeps of one listed object to serve its bytes.
type object struct {
	key  string
	etag string
	tag  string
	size int64
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

// buildManifest makes the tree of a prefix's objects. Directories come from the keys' paths, and from "folder"
// objects (keys ending in "/"). Its version is a digest of what it holds, so the same listing has the same version
// on any host, and across a restart of this one (the entries' proofs aren't in it). sign, when set, gives each
// object's proof (mount.proof). A tree of more than maxEntries entries (files and directories) or maxTreeBytes of
// names is refused before it is built further or encoded.
func buildManifest(objs []bucket.Object, prefix string, sign func(object) string, maxEntries int) (*manifest, error) {
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
	files := map[string]bucket.Object{}
	for _, o := range objs {
		if !strings.HasPrefix(o.Key, prefix) {
			m.skipped++
			continue
		}
		rel := o.Key[len(prefix):]
		if strings.HasSuffix(rel, "/") {
			d := strings.TrimSuffix(rel, "/")
			if d == "" {
				continue
			}
			if !validRel(d) {
				m.skipped++
				continue
			}
			if !addDir(d) || !addDirs(d) {
				return nil, errTooBig
			}
			continue
		}
		if !validRel(rel) {
			m.skipped++
			continue
		}
		if _, dup := files[rel]; !dup && !add(rel) {
			return nil, errTooBig
		}
		files[rel] = o
		if !addDirs(rel) {
			return nil, errTooBig
		}
	}
	for rel, o := range files {
		if dirs[rel] {
			// "a" and "a/b" both: the directory wins.
			m.skipped++
			continue
		}
		tag := o.Version()
		m.objects[rel] = object{key: o.Key, etag: o.ETag, tag: tag, size: o.Size}
		m.bytes += o.Size
		m.wire.Entries = append(m.wire.Entries, guest.ManifestEntry{Path: rel, Size: o.Size, MTimeMs: o.LastModified.UnixMilli(), Tag: tag})
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
