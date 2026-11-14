package disksync

import (
	"io/fs"
	"os"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
)

// Objects are the versions of one kind of disk store object the host holds, serves and fetches: sticky disks', or
// templates' root filesystems', or template snapshots' (whose versions have parts, Parted).
type Objects interface {
	Source
	Store
}

// Kinds are the kinds of object the host syncs, each with its own Objects, by its name (a Ref's Kind). As a Source and
// a Store it passes each call to its kind's, and answers a kind it doesn't have as a version it doesn't hold.
type Kinds map[string]Objects

var (
	_ Source = Kinds(nil)
	_ Store  = Kinds(nil)
	_ Parted = Kinds(nil)
)

// Parts are the kind's parts, when its Objects has them (Parted).
func (k Kinds) Parts(kind string) []string {
	_, names := partsOf(k[kind], kind)
	return names
}

func (k Kinds) OpenPart(r Ref, part string, withMap bool) (*os.File, []byte, error) {
	p, ok := validPart(k[r.Kind], r.Kind, part)
	if !ok {
		return nil, nil, fs.ErrNotExist
	}
	return p.OpenPart(r, part, withMap)
}

func (k Kinds) PartPartial(r Ref, part string) (string, error) {
	p, ok := validPart(k[r.Kind], r.Kind, part)
	if !ok {
		return "", fs.ErrNotExist
	}
	return p.PartPartial(r, part)
}

func (k Kinds) PublishParts(r Ref, parts map[string]FetchedPart, files map[string][]byte) error {
	p, names := partsOf(k[r.Kind], r.Kind)
	if len(names) == 0 {
		return fs.ErrNotExist
	}
	return p.PublishParts(r, parts, files)
}

func (k Kinds) Open(kind, objectID, version string, withMap bool) (*os.File, []byte, error) {
	o, ok := k[kind]
	if !ok {
		return nil, nil, fs.ErrNotExist
	}
	return o.Open(kind, objectID, version, withMap)
}

func (k Kinds) ReadFile(kind, objectID, version, name string) ([]byte, error) {
	o, ok := k[kind]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return o.ReadFile(kind, objectID, version, name)
}

func (k Kinds) Held(r Ref) bool {
	o, ok := k[r.Kind]
	return ok && o.Held(r)
}

func (k Kinds) Partial(r Ref) (string, error) {
	o, ok := k[r.Kind]
	if !ok {
		return "", fs.ErrNotExist
	}
	return o.Partial(r)
}

func (k Kinds) CloneNearest(r Ref, dst string) (*blockmap.Map, error) {
	o, ok := k[r.Kind]
	if !ok {
		return nil, nil
	}
	return o.CloneNearest(r, dst)
}

func (k Kinds) Files(r Ref) []string {
	o, ok := k[r.Kind]
	if !ok {
		return nil
	}
	return o.Files(r)
}

func (k Kinds) Publish(r Ref, partial *os.File, mapFile []byte, files map[string][]byte) error {
	o, ok := k[r.Kind]
	if !ok {
		return fs.ErrNotExist
	}
	return o.Publish(r, partial, mapFile, files)
}

// Partials are every kind's.
func (k Kinds) Partials() []Ref {
	var out []Ref
	for _, o := range k {
		out = append(out, o.Partials()...)
	}
	return out
}

func (k Kinds) Discard(r Ref) {
	if o, ok := k[r.Kind]; ok {
		o.Discard(r)
	}
}

func (k Kinds) Reserve(r Ref, bytes int64) (func(), error) {
	o, ok := k[r.Kind]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return o.Reserve(r, bytes)
}
