package mounts

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
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

func validRel(rel string) bool {
	if rel == "" {
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
// object's proof (mount.proof).
func buildManifest(objs []bucket.Object, prefix string, sign func(object) string) *manifest {
	m := &manifest{objects: map[string]object{}}
	dirs := map[string]bool{}
	addDirs := func(rel string) {
		for d := path.Dir(rel); d != "." && d != "/" && !dirs[d]; d = path.Dir(d) {
			dirs[d] = true
		}
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
			dirs[d] = true
			addDirs(d)
			continue
		}
		if !validRel(rel) {
			m.skipped++
			continue
		}
		files[rel] = o
		addDirs(rel)
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
	return m
}
