package disksync

import (
	"io/fs"
	"os"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
)

// Objects are the versions of one kind of disk store object the host holds, serves and fetches: sticky disks', or
// templates' root filesystems'.
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
)

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
