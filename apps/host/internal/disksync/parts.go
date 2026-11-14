package disksync

// Versions with parts: a kind whose versions are several block-mapped files (a template snapshot's disk and memory,
// docs/design/disk-store.md, "Phase 3 notes") names them its parts (Parted). Such a version's map is its manifest: a
// line `KTPARTS1`, then a line `<part> <map digest>` for each part in order, each line ending in a newline. Its digest
// is the version's map digest, which the holders report and disk.locate answers, so the manifest vouches for each
// part's map, and each part's map for its blocks.
//
//	GET /v1/objects/{kind}/{id}/{version}/map                   the manifest
//	GET /v1/objects/{kind}/{id}/{version}/parts/{part}/map      a part's block map
//	GET /v1/objects/{kind}/{id}/{version}/parts/{part}/data     a part's bytes, a run of blocks with Range
//
// A fetch takes each part into a partial of its own (Parted.PartPartial), from an empty file, with its own bitmap, so it
// goes on where it stopped as a one-file version's does; then the version's small files; then the parts are published
// together (Parted.PublishParts).

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
)

// Parted is what a Store or Source adds for kinds whose versions have parts. A kind with none (Parts empty) is one
// file, as Source and Store have it.
type Parted interface {
	// Parts names the parts of kind's versions, in the order the manifest has them: none for a kind of one file.
	Parts(kind string) []string
	// OpenPart opens one part of a version the host holds, and with withMap its block map's file, as Source.Open opens
	// a version's one file: fs.ErrNotExist when the host doesn't hold the version, or has no map of the part yet.
	OpenPart(r Ref, part string, withMap bool) (*os.File, []byte, error)
	// PartPartial is the path a fetch of one part writes to, beside the version's other parts' (its directory made).
	PartPartial(r Ref, part string) (string, error)
	// PublishParts makes the fetched parts, each written through its file and synced, the version, with each part's map
	// file and the version's small files (those of Store.Files its holder had). A part whose partial was removed
	// meanwhile fails it, and nothing is published.
	PublishParts(r Ref, parts map[string]FetchedPart, files map[string][]byte) error
}

// FetchedPart is one part a fetch wrote: its partial file, and its map's file.
type FetchedPart struct {
	File *os.File
	Map  []byte
}

// PartDigest is one part's map digest, as a manifest lists it.
type PartDigest struct {
	Part   string
	Digest string
}

const manifestMagic = "KTPARTS1"

// Manifest is the manifest of a version whose parts have these map digests, in order.
func Manifest(parts []PartDigest) []byte {
	var b bytes.Buffer
	b.WriteString(manifestMagic + "\n")
	for _, p := range parts {
		b.WriteString(p.Part + " " + p.Digest + "\n")
	}
	return b.Bytes()
}

// ParseManifest reads a manifest: an error unless it is shaped as Manifest writes one, naming each of parts once, in
// that order.
func ParseManifest(raw []byte, parts []string) ([]PartDigest, error) {
	lines := strings.Split(string(raw), "\n")
	if len(lines) != len(parts)+2 || lines[0] != manifestMagic || lines[len(lines)-1] != "" {
		return nil, errors.New("not a manifest of the kind's parts")
	}
	out := make([]PartDigest, 0, len(parts))
	for i, part := range parts {
		name, digest, ok := strings.Cut(lines[i+1], " ")
		if !ok || name != part || !strings.HasPrefix(digest, "sha256:") || strings.Contains(digest, " ") {
			return nil, fmt.Errorf("the manifest's line %d isn't part %s's", i+2, part)
		}
		out = append(out, PartDigest{Part: part, Digest: digest})
	}
	return out, nil
}

// ManifestOf is the manifest of a version the host holds, made from its parts' maps: fs.ErrNotExist when it doesn't
// hold it, or a part has no map yet.
func ManifestOf(p Parted, r Ref) ([]byte, error) {
	names := p.Parts(r.Kind)
	if len(names) == 0 {
		return nil, fs.ErrNotExist
	}
	digests := make([]PartDigest, 0, len(names))
	for _, name := range names {
		f, raw, err := p.OpenPart(r, name, true)
		if err != nil {
			return nil, err
		}
		f.Close()
		digests = append(digests, PartDigest{Part: name, Digest: blockmap.Digest(raw)})
	}
	return Manifest(digests), nil
}

// partsOf is a Source's or Store's parts of kind's versions, and it as Parted: none for a kind of one file.
func partsOf(v any, kind string) (Parted, []string) {
	p, ok := v.(Parted)
	if !ok {
		return nil, nil
	}
	return p, p.Parts(kind)
}

// fetchParts is fetch for a version with parts: its manifest, then each part's map, then every part's blocks not yet
// in place, then its small files, then the parts published together.
func (f *Fetcher) fetchParts(ctx context.Context, r Ref, parted Parted, src *holders) (Stats, error) {
	names := parted.Parts(r.Kind)
	raw, err := src.fetchMap(ctx, "map", "")
	if err != nil {
		return Stats{}, err
	}
	digests, err := ParseManifest(raw, names)
	if err != nil {
		return Stats{}, fmt.Errorf("the version's manifest: %w", err)
	}
	type fetching struct {
		name string
		raw  []byte
		p    *partial
	}
	parts := make([]fetching, 0, len(digests))
	defer func() {
		for _, part := range parts {
			part.p.file.Close()
		}
	}()
	st := Stats{}
	var left int64
	for _, d := range digests {
		base := "parts/" + d.Part + "/"
		mapRaw, err := src.fetchMap(ctx, base+"map", d.Digest)
		if err != nil {
			return st, err
		}
		m := &blockmap.Map{}
		if err := m.UnmarshalBinary(mapRaw); err != nil {
			return st, err
		}
		path, err := parted.PartPartial(r, d.Part)
		if err != nil {
			return st, err
		}
		p, err := f.prepare(r, path, m, d.Digest, base+"data", nil)
		if err != nil {
			return st, err
		}
		parts = append(parts, fetching{name: d.Part, raw: mapRaw, p: p})
		st.Blocks += m.Blocks()
		st.Resumed = st.Resumed || p.resumed
		left += p.left()
	}
	// Room for everything every part's fetch writes from here, before any of it is written.
	release, err := f.Store.Reserve(r, left)
	if err != nil {
		return st, err
	}
	defer release()
	for _, part := range parts {
		if err := part.p.clearZeros(); err != nil {
			return st, err
		}
		runs := part.p.runs()
		for _, run := range runs {
			st.Fetched += run.last - run.first + 1
		}
		fetched, err := f.fetchRuns(ctx, src, part.p, runs)
		st.FetchedBytes += fetched
		if err != nil {
			st.Reused = st.Blocks - st.Fetched
			return st, err
		}
		if err := part.p.file.Sync(); err != nil {
			return st, err
		}
	}
	st.Reused = st.Blocks - st.Fetched
	files, err := src.fetchFiles(ctx, f.Store.Files(r))
	if err != nil {
		return st, err
	}
	published := make(map[string]FetchedPart, len(parts))
	for _, part := range parts {
		published[part.name] = FetchedPart{File: part.p.file, Map: part.raw}
	}
	if err := parted.PublishParts(r, published, files); err != nil {
		return st, err
	}
	for _, part := range parts {
		_ = os.Remove(part.p.bitmapPath)
	}
	return st, nil
}

// validPart says whether part is one of kind's parts on v.
func validPart(v any, kind, part string) (Parted, bool) {
	p, names := partsOf(v, kind)
	return p, p != nil && slices.Contains(names, part)
}
