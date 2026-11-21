package mounts

// Manifest mounts: a read-only mount of files the account lists itself, rather than a prefix the host lists. The
// account writes a manifest (ManifestFile) as an object in its own bucket source and names it, with its digest, in the
// sandbox's create; the host reads it with the source's credentials, checks it against the digest, and serves it the
// way it serves a bucket mount's listing: the guest's FUSE file system answers lookups, listings and stat from it, and
// each file's bytes come through the host's read cache, chunk by chunk, as the sandbox reads them.
//
// Each entry names the object holding its bytes and that object's version (its GCS generation, its ETag or both), so
// what a file reads is pinned: an object that changed since the manifest was written fails the read (ESTALE in the
// sandbox), and never shows other bytes under the entry. A manifest never changes (its digest is the mount's), so a
// manifest mount is never listed again: another set of files is another manifest.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bucket"
)

// ManifestFormat is the only version of ManifestFile there is.
const ManifestFormat = 1

// MaxManifestBytes bounds a manifest object: about 200,000 entries of typical paths and keys, the most a mount holds
// (DefaultMaxObjects), fit well within it.
const MaxManifestBytes = 64 << 20

// ManifestFile is a manifest mount's manifest, as the account writes it (JSON).
type ManifestFile struct {
	// Version is ManifestFormat.
	Version int `json:"version"`
	// Entries are the mount's files, and any directories it should have that hold none.
	Entries []ManifestFileEntry `json:"entries"`
}

// ManifestFileEntry is one file (or empty directory) of a manifest mount.
type ManifestFileEntry struct {
	// Path is where it appears, relative to the mount ("docs/a.md"): no leading slash, no empty or dot segment.
	Path string `json:"path"`
	// Dir makes a directory (with no Key): only needed for one that holds no file.
	Dir bool `json:"dir,omitempty"`
	// Key is the object in the bucket source holding the file's bytes.
	Key string `json:"key,omitempty"`
	// Size is the object's size in bytes: required for a file (0 for an empty one), and checked against the store's.
	Size int64 `json:"size"`
	// Generation is the object's GCS generation: that generation is read, and a read fails once it is gone.
	Generation string `json:"generation,omitempty"`
	// ETag is the object's ETag (no quotes): a read fails when the object's ETag is another. One of Generation and
	// ETag is required, so a file's bytes are never another version's.
	ETag string `json:"etag,omitempty"`
	// MTimeMs is the file's modification time (unix milliseconds); 0 shows the epoch.
	MTimeMs int64 `json:"mtimeMs,omitempty"`
}

// errManifest is a manifest the account wrote that can't be mounted as it is.
var errManifest = errors.New("the manifest can't be mounted")

// wireEntry is a ManifestFileEntry as decoded: a file's size is required, and null or missing isn't zero.
type wireEntry struct {
	Path       string `json:"path"`
	Dir        bool   `json:"dir"`
	Key        string `json:"key"`
	Size       *int64 `json:"size"`
	Generation string `json:"generation"`
	ETag       string `json:"etag"`
	MTimeMs    int64  `json:"mtimeMs"`
}

// parseManifest checks a manifest's bytes against the mount's digest and makes its tree. Unlike a listing, which
// skips what has no place in a file tree, a manifest is the account's word on exactly which files the mount has:
// an entry that can't be shown as it says is an error naming it, and so is a manifest of more than maxObjects files.
// Entries are decoded one at a time and counted as they come, so a manifest within MaxManifestBytes of tiny entries
// is refused before it takes more memory than a mount of maxObjects files.
func parseManifest(raw []byte, digest string, maxObjects int) (*manifest, error) {
	sum := sha256.Sum256(raw)
	if want, ok := strings.CutPrefix(digest, "sha256:"); !ok || hex.EncodeToString(sum[:]) != want {
		return nil, fmt.Errorf("%w: its object doesn't match the mount's digest (it changed since, or the digest is wrong)", errManifest)
	}
	notManifest := func(why string) error { return fmt.Errorf("%w: it isn't a manifest: %s", errManifest, why) }
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	delim := func(want json.Delim) error {
		tok, err := dec.Token()
		if d, ok := tok.(json.Delim); err != nil || !ok || d != want {
			return notManifest(fmt.Sprintf("expected %q", want))
		}
		return nil
	}
	// Files and the directories they need: as a listing of maxObjects objects may hold.
	maxEntries := 2 * maxObjects
	version, sawVersion, sawEntries := 0, false, false
	files := 0
	seen := map[string]bool{}
	var items []item
	entry := func(i int, e wireEntry) error {
		bad := func(why string) error {
			return fmt.Errorf("%w: entry %d (%q) %s", errManifest, i, truncate(e.Path, 200), why)
		}
		if !validRel(e.Path) {
			return bad("isn't a relative path with no empty or dot segment, of names of at most 255 bytes")
		}
		if seen[e.Path] {
			return bad("is listed twice")
		}
		seen[e.Path] = true
		if e.Dir {
			if e.Key != "" || (e.Size != nil && *e.Size != 0) || e.Generation != "" || e.ETag != "" {
				return bad("is a directory with an object")
			}
			items = append(items, item{rel: e.Path, dir: true})
			return nil
		}
		switch {
		case e.Key == "" || len(e.Key) > maxKey:
			return bad("names no object key (or one over 1024 bytes)")
		case e.Size == nil:
			return bad("has no size")
		case *e.Size < 0:
			return bad("has a negative size")
		case e.Generation == "" && e.ETag == "":
			return bad("pins no version: give its generation or its ETag")
		case strings.ContainsAny(e.ETag, `"`) || len(e.ETag) > 256 || !validGeneration(e.Generation):
			return bad("has a bad generation (a GCS generation is a decimal number) or ETag")
		}
		if files++; maxObjects > 0 && files > maxObjects {
			return fmt.Errorf("%w: it lists more than %d files", errManifest, maxObjects)
		}
		tag := "e" + e.ETag
		if e.Generation != "" {
			tag = "g" + e.Generation
			if e.ETag != "" {
				tag += "e" + e.ETag
			}
		}
		items = append(items, item{rel: e.Path, o: object{key: e.Key, etag: e.ETag, generation: e.Generation, tag: tag, size: *e.Size}, mtime: time.UnixMilli(e.MTimeMs)})
		return nil
	}
	if err := delim('{'); err != nil {
		return nil, err
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, notManifest(err.Error())
		}
		switch tok {
		case "version":
			if sawVersion {
				return nil, notManifest("version is given twice")
			}
			sawVersion = true
			if err := dec.Decode(&version); err != nil {
				return nil, notManifest("version: " + err.Error())
			}
		case "entries":
			if sawEntries {
				return nil, notManifest("entries are given twice")
			}
			sawEntries = true
			if err := delim('['); err != nil {
				return nil, err
			}
			for i := 0; dec.More(); i++ {
				if maxEntries > 0 && i >= maxEntries {
					return nil, fmt.Errorf("%w: it has more than %d entries", errManifest, maxEntries)
				}
				var e wireEntry
				if err := dec.Decode(&e); err != nil {
					return nil, notManifest(fmt.Sprintf("entry %d: %v", i, err))
				}
				if err := entry(i, e); err != nil {
					return nil, err
				}
			}
			if err := delim(']'); err != nil {
				return nil, err
			}
		default:
			return nil, notManifest(fmt.Sprintf("unknown field %v", tok))
		}
	}
	if err := delim('}'); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, notManifest("something follows it")
	}
	if version != ManifestFormat {
		return nil, fmt.Errorf("%w: its version is %d, not %d", errManifest, version, ManifestFormat)
	}
	m, err := buildTree(items, nil, maxEntries)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errManifest, err)
	}
	if m.skipped > 0 {
		// Every path was checked above: only a file where another entry makes a directory is left.
		return nil, fmt.Errorf("%w: a file's path is also a directory of another entry's", errManifest)
	}
	return m, nil
}

// fetchManifest reads the mount's manifest object from its bucket source, whole, and makes its tree.
func (mt *mount) fetchManifest(ctx context.Context) (*manifest, error) {
	src, err := mt.s.m.client(ctx, mt.s.id, mt.spec.BucketSourceID, false)
	if err != nil {
		return nil, err
	}
	raw, err := readManifestObject(ctx, src.client, mt.spec.ManifestKey)
	mt.lists.Add(1)
	if errors.Is(err, bucket.ErrDenied) {
		// Credentials rotated (or expired) since: ask again, once.
		if src, err = mt.s.m.client(ctx, mt.s.id, mt.spec.BucketSourceID, true); err != nil {
			return nil, err
		}
		raw, err = readManifestObject(ctx, src.client, mt.spec.ManifestKey)
		mt.lists.Add(1)
	}
	if err != nil {
		return nil, fmt.Errorf("reading the manifest: %w", err)
	}
	return parseManifest(raw, mt.spec.Digest, mt.s.m.cfg.MaxObjects)
}

func readManifestObject(ctx context.Context, c *bucket.Client, key string) ([]byte, error) {
	body, err := c.Get(ctx, key, bucket.Pin{}, 0, 0)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, MaxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxManifestBytes {
		return nil, fmt.Errorf("%w: it is over %d MiB", errManifest, MaxManifestBytes>>20)
	}
	return raw, nil
}

// validGeneration is a GCS generation (a positive decimal number of at most 20 digits), or none. Only digits, so a
// version tag made of it and an ETag ("g<generation>e<etag>") names one pin only.
func validGeneration(g string) bool {
	if len(g) > 20 || strings.HasPrefix(g, "0") {
		return false
	}
	for _, r := range g {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
