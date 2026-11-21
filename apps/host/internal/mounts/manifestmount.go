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
	// Size is the object's size in bytes.
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

// parseManifest checks a manifest's bytes against the mount's digest and makes its tree. Unlike a listing, which
// skips what has no place in a file tree, a manifest is the account's word on exactly which files the mount has:
// an entry that can't be shown as it says is an error naming it, and so is a manifest of more than maxObjects files.
func parseManifest(raw []byte, digest string, maxObjects int) (*manifest, error) {
	sum := sha256.Sum256(raw)
	if want, ok := strings.CutPrefix(digest, "sha256:"); !ok || hex.EncodeToString(sum[:]) != want {
		return nil, fmt.Errorf("%w: its object doesn't match the mount's digest (it changed since, or the digest is wrong)", errManifest)
	}
	var file ManifestFile
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return nil, fmt.Errorf("%w: it isn't a manifest: %v", errManifest, err)
	}
	if file.Version != ManifestFormat {
		return nil, fmt.Errorf("%w: its version is %d, not %d", errManifest, file.Version, ManifestFormat)
	}
	files := 0
	seen := make(map[string]bool, len(file.Entries))
	items := make([]item, 0, len(file.Entries))
	for i, e := range file.Entries {
		bad := func(why string) error {
			return fmt.Errorf("%w: entry %d (%q) %s", errManifest, i, truncate(e.Path, 200), why)
		}
		if !validRel(e.Path) {
			return nil, bad("isn't a relative path with no empty or dot segment, of names of at most 255 bytes")
		}
		if seen[e.Path] {
			return nil, bad("is listed twice")
		}
		seen[e.Path] = true
		if e.Dir {
			if e.Key != "" || e.Size != 0 || e.Generation != "" || e.ETag != "" {
				return nil, bad("is a directory with an object")
			}
			items = append(items, item{rel: e.Path, dir: true})
			continue
		}
		switch {
		case e.Key == "" || len(e.Key) > maxKey:
			return nil, bad("names no object key (or one over 1024 bytes)")
		case e.Size < 0:
			return nil, bad("has a negative size")
		case e.Generation == "" && e.ETag == "":
			return nil, bad("pins no version: give its generation or its ETag")
		case strings.ContainsAny(e.ETag, `"`) || len(e.ETag) > 256 || !validGeneration(e.Generation):
			return nil, bad("has a bad generation (a GCS generation is a decimal number) or ETag")
		}
		if files++; maxObjects > 0 && files > maxObjects {
			return nil, fmt.Errorf("%w: it lists more than %d files", errManifest, maxObjects)
		}
		tag := "e" + e.ETag
		if e.Generation != "" {
			tag = "g" + e.Generation
			if e.ETag != "" {
				tag += "e" + e.ETag
			}
		}
		items = append(items, item{rel: e.Path, o: object{key: e.Key, etag: e.ETag, generation: e.Generation, tag: tag, size: e.Size}, mtime: time.UnixMilli(e.MTimeMs)})
	}
	m, err := buildTree(items, nil, 2*maxObjects)
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
