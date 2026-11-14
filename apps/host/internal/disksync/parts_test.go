package disksync

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// partedStore is a host's versions of object sdk_1 of kind "snap" in a directory, each two parts (disk and mem:
// <version>.<part>.img and <version>.<part>.map) and a small file, state (<version>.state).
type partedStore struct{ *dirStore }

var testParts = []string{"disk", "mem"}

func (s partedStore) Parts(kind string) []string {
	if kind != "snap" {
		return nil
	}
	return testParts
}

func (s partedStore) part(v, part string) string { return filepath.Join(s.dir, v+"."+part+".img") }
func (s partedStore) partMap(v, part string) string {
	return filepath.Join(s.dir, v+"."+part+".map")
}

func (s partedStore) OpenPart(r Ref, part string, withMap bool) (*os.File, []byte, error) {
	if r.Kind != "snap" || !slices.Contains(testParts, part) {
		return nil, nil, fs.ErrNotExist
	}
	raw, err := os.ReadFile(s.partMap(r.Version, part))
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(s.part(r.Version, part))
	return f, raw, err
}

func (s partedStore) Held(r Ref) bool {
	_, err := os.Stat(filepath.Join(s.dir, r.Version+".state"))
	return err == nil
}

func (s partedStore) PartPartial(r Ref, part string) (string, error) {
	return filepath.Join(s.dir, r.Version+"."+part+".partial"), nil
}

func (s partedStore) PublishParts(r Ref, parts map[string]FetchedPart, files map[string][]byte) error {
	for _, name := range testParts {
		part, ok := parts[name]
		if !ok {
			return errors.New("a part is missing")
		}
		path, _ := s.PartPartial(r, name)
		mine, _ := part.File.Stat()
		if now, err := os.Stat(path); err != nil || !os.SameFile(mine, now) {
			return errors.New("a partial was removed")
		}
		if err := os.WriteFile(s.partMap(r.Version, name), part.Map, 0o600); err != nil {
			return err
		}
		if err := os.Rename(path, s.part(r.Version, name)); err != nil {
			return err
		}
	}
	for name, raw := range files {
		if err := os.WriteFile(filepath.Join(s.dir, r.Version+"."+name), raw, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (s partedStore) Files(Ref) []string { return []string{"state"} }

func (s partedStore) ReadFile(kind, _, version, name string) ([]byte, error) {
	if kind != "snap" || name != "state" {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.dir, version+"."+name))
}

func (s partedStore) Discard(r Ref) {
	for _, name := range testParts {
		p, _ := s.PartPartial(r, name)
		_ = os.Remove(p)
		_ = os.Remove(p + ".done")
	}
}

// putParts makes version v with these parts and state on the store, and answers its manifest's digest.
func (s partedStore) putParts(t *testing.T, v string, disk, mem []byte) string {
	t.Helper()
	var digests []PartDigest
	for _, p := range []struct {
		name string
		data []byte
	}{{"disk", disk}, {"mem", mem}} {
		if err := os.WriteFile(s.part(v, p.name), p.data, 0o600); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(s.part(v, p.name))
		if err != nil {
			t.Fatal(err)
		}
		m, _, err := blockmap.Make(context.Background(), f, nil)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		digest, err := blockmap.WriteFile(s.partMap(v, p.name), m)
		if err != nil {
			t.Fatal(err)
		}
		digests = append(digests, PartDigest{Part: p.name, Digest: digest})
	}
	if err := os.WriteFile(filepath.Join(s.dir, v+".state"), []byte("state of "+v), 0o600); err != nil {
		t.Fatal(err)
	}
	return blockmap.Digest(Manifest(digests))
}

// partedFixture is newFixture with every store a partedStore of kind snap.
func partedFixture(t *testing.T, holders int) (*fixture, partedStore, []partedStore) {
	t.Helper()
	f := newFixture(t, holders)
	f.kind = "snap"
	local := partedStore{f.local}
	var remote []partedStore
	for _, h := range f.holders {
		p := partedStore{h.store}
		h.srv.Source = p
		remote = append(remote, p)
	}
	return f, local, remote
}

func (f *fixture) partedFetcher(local partedStore) *Fetcher {
	fetcher := f.fetcher()
	fetcher.Store = local
	return fetcher
}

var snapRef = Ref{Kind: "snap", ObjectID: "sdk_1", Version: "v2"}

// A version with parts is fetched part by part, against the manifest its map digest vouches for, with its small files,
// and published together: the blocks of zeros (most of a memory file) aren't fetched.
func TestFetchParts(t *testing.T) {
	f, local, remote := partedFixture(t, 2)
	diskData := disk(t, 3, 100)
	mem := make([]byte, 6*block)
	copy(mem[2*block:], disk(t, 1, 0))
	for _, r := range remote {
		f.digest = r.putParts(t, "v2", diskData, mem)
	}
	st, err := wait(t, f.partedFetcher(local).Start(Request{Ref: snapRef}))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []struct {
		name string
		want []byte
	}{{"disk", diskData}, {"mem", mem}} {
		got, err := os.ReadFile(local.part("v2", p.name))
		if err != nil || !bytes.Equal(got, p.want) {
			t.Fatalf("the fetched %s differs (%v)", p.name, err)
		}
	}
	if state, err := os.ReadFile(filepath.Join(local.dir, "v2.state")); err != nil || string(state) != "state of v2" {
		t.Fatalf("state %q, %v", state, err)
	}
	manifest, err := ManifestOf(local, snapRef)
	if err != nil || blockmap.Digest(manifest) != f.digest {
		t.Fatalf("the fetched version's manifest: %v", err)
	}
	// 4 blocks of the disk and 6 of the memory, of which 5 are zeros.
	if st.Blocks != 10 || st.Fetched != 5 || st.FetchedBytes != int64(4*block+100) {
		t.Fatalf("stats %+v", st)
	}
	if left, _ := filepath.Glob(filepath.Join(local.dir, "*.partial*")); len(left) != 0 {
		t.Fatalf("left behind: %v", left)
	}
}

// A fetch cut short goes on where it stopped, part by part, fetching only what it hadn't.
func TestFetchPartsResumes(t *testing.T) {
	f, local, remote := partedFixture(t, 1)
	diskData := disk(t, 2, 0)
	mem := disk(t, 3, 0)
	f.digest = remote[0].putParts(t, "v2", diskData, mem)
	h := f.holders[0]
	// The memory's data is refused until let through: the disk is fetched, the memory isn't.
	refuse := true
	h.fail = func(w http.ResponseWriter, r *http.Request) bool {
		if refuse && strings.Contains(r.URL.Path, "/parts/mem/") {
			http.Error(w, "not now", http.StatusServiceUnavailable)
			return true
		}
		return false
	}
	retryWait = time.Millisecond
	t.Cleanup(func() { retryWait = time.Second })
	fetcher := f.partedFetcher(local)
	if _, err := wait(t, fetcher.Start(Request{Ref: snapRef})); err == nil {
		t.Fatal("the fetch went through")
	}
	if local.Held(snapRef) {
		t.Fatal("published without its memory")
	}
	// Reported failed with every part's blocks, the disk's in place.
	if p := fetcher.Progress(); len(p) != 1 || p[0].State != proto.FetchFailed || p[0].Blocks != 5 || p[0].InPlace != 2 {
		t.Fatalf("progress %+v", p)
	}
	refuse = false
	st, err := wait(t, f.partedFetcher(local).Start(Request{Ref: snapRef}))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Resumed || st.Fetched != 3 {
		t.Fatalf("stats %+v: only the memory's blocks should be fetched again", st)
	}
	got, _ := os.ReadFile(local.part("v2", "mem"))
	if !bytes.Equal(got, mem) {
		t.Fatal("the memory differs")
	}
}

// A holder whose manifest or part map isn't what the digest vouches for is given up on.
func TestFetchPartsChecksManifest(t *testing.T) {
	f, local, remote := partedFixture(t, 1)
	f.digest = remote[0].putParts(t, "v2", disk(t, 1, 0), disk(t, 1, 0))
	// Its memory changed after its map digest was reported: its manifest no longer has that digest.
	remote[0].putParts(t, "v2", disk(t, 1, 0), disk(t, 1, 0))
	_, err := wait(t, f.partedFetcher(local).Start(Request{Ref: snapRef}))
	if err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("want a digest mismatch, got %v", err)
	}
	if local.Held(snapRef) {
		t.Fatal("published")
	}
}

// The manifest names each part once, in order.
func TestParseManifest(t *testing.T) {
	good := Manifest([]PartDigest{{"disk", "sha256:aa"}, {"mem", "sha256:bb"}})
	if got, err := ParseManifest(good, testParts); err != nil || len(got) != 2 || got[1].Digest != "sha256:bb" {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{
		"KTPARTS1\nmem sha256:bb\ndisk sha256:aa\n",
		"KTPARTS1\ndisk sha256:aa\n",
		"KTPARTS1\ndisk sha256:aa\nmem sha256:bb",
		"KTPARTS2\ndisk sha256:aa\nmem sha256:bb\n",
		"KTPARTS1\ndisk md5:aa\nmem sha256:bb\n",
	} {
		if _, err := ParseManifest([]byte(bad), testParts); err == nil {
			t.Fatalf("took %q", bad)
		}
	}
}

// The server answers a part only of a kind with parts, and only with a grant.
func TestServerParts(t *testing.T) {
	f, _, remote := partedFixture(t, 1)
	f.digest = remote[0].putParts(t, "v2", disk(t, 1, 0), disk(t, 1, 0))
	h := f.holders[0]
	get := func(path, grant string) int {
		req, _ := http.NewRequest(http.MethodGet, "http://"+netip.AddrPortFrom(h.addr, uint16(f.port)).String()+path, nil)
		if grant != "" {
			req.Header.Set("Authorization", "Bearer "+grant)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	grant := f.grant(time.Now().Add(15 * time.Minute))
	for path, want := range map[string]int{
		"/v1/objects/snap/sdk_1/v2/map":               http.StatusOK,
		"/v1/objects/snap/sdk_1/v2/parts/mem/map":     http.StatusOK,
		"/v1/objects/snap/sdk_1/v2/parts/swap/map":    http.StatusNotFound,
		"/v1/objects/snap/sdk_1/v3/parts/mem/map":     http.StatusForbidden,
		"/v1/objects/sticky/sdk_1/v2/parts/mem/map":   http.StatusForbidden,
		"/v1/objects/snap/sdk_1/v2/parts/disk/data":   http.StatusOK,
		"/v1/objects/snap/sdk_1/v2/files/state":       http.StatusOK,
		"/v1/objects/snap/sdk_1/v2/files/../v2.state": http.StatusNotFound,
	} {
		if got := get(path, grant); got != want {
			t.Errorf("%s: %d, want %d", path, got, want)
		}
	}
	if got := get("/v1/objects/snap/sdk_1/v2/parts/mem/map", ""); got != http.StatusUnauthorized {
		t.Errorf("without a grant: %d", got)
	}
}
