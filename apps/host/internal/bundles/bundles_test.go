package bundles

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type entry struct {
	name, body, link string
	mode             int64
	typ              byte
}

func makeTar(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		hdr := &tar.Header{Name: e.name, Mode: mode, Typeflag: typ, Linkname: e.link, ModTime: time.Unix(1_700_000_000, 0)}
		if typ == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// fakeCache is a cache whose images are the tar itself (no mkfs.erofs), padded to a size the test sets.
func fakeCache(t *testing.T, maxBytes int64, build func(ctx context.Context) error) *Cache {
	t.Helper()
	c, err := New(Config{Dir: t.TempDir(), MaxBytes: maxBytes, Mkfs: "/bin/true"})
	if err != nil {
		t.Fatal(err)
	}
	c.buildImage = func(ctx context.Context, tarPath, out, _ string) error {
		if build != nil {
			if err := build(ctx); err != nil {
				return err
			}
		}
		raw, err := os.ReadFile(tarPath)
		if err != nil {
			return err
		}
		return os.WriteFile(out, raw, 0o600)
	}
	return c
}

func serve(raw []byte, calls *atomic.Int32) Fetch {
	return func(ctx context.Context, digest string) (io.ReadCloser, error) {
		if calls != nil {
			calls.Add(1)
		}
		return io.NopCloser(bytes.NewReader(raw)), nil
	}
}

func TestGetChecksTheDigest(t *testing.T) {
	c := fakeCache(t, 1<<30, nil)
	raw := makeTar(t, entry{name: "a.txt", body: "hello"})
	other := digestOf([]byte("something else"))
	_, err := c.Get(context.Background(), other, serve(raw, nil))
	if err == nil || !strings.Contains(err.Error(), "not "+other) {
		t.Fatalf("a tar that isn't the digest's must fail, got %v", err)
	}
	if c.Has(other) {
		t.Fatal("nothing is kept for a tar that isn't the digest's")
	}
	if left, _ := os.ReadDir(c.tmpDir()); len(left) != 0 {
		t.Fatalf("the failed download is cleaned up, left %v", left)
	}
	if _, err := c.Get(context.Background(), "sha256:nothex", serve(raw, nil)); err == nil {
		t.Fatal("a malformed digest is refused")
	}
}

func TestGetBuildsOnceForConcurrentCallers(t *testing.T) {
	var builds atomic.Int32
	release := make(chan struct{})
	c := fakeCache(t, 1<<30, func(ctx context.Context) error {
		builds.Add(1)
		<-release
		return nil
	})
	raw := makeTar(t, entry{name: "run.sh", body: "#!/bin/sh\necho hi\n", mode: 0o755})
	d := digestOf(raw)
	var fetches atomic.Int32
	var wg sync.WaitGroup
	errs := make([]error, 10)
	cached := make([]bool, 10)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cached[i], errs[i] = c.Get(context.Background(), d, serve(raw, &fetches))
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d: %v", i, err)
		}
		if cached[i] {
			t.Fatalf("caller %d says cached, but it was built for it", i)
		}
	}
	if builds.Load() != 1 || fetches.Load() != 1 {
		t.Fatalf("one fetch and one build for ten callers, got %d fetches and %d builds", fetches.Load(), builds.Load())
	}
	if was, err := c.Get(context.Background(), d, serve(raw, &fetches)); err != nil || !was || fetches.Load() != 1 {
		t.Fatalf("a cached bundle isn't fetched again: cached=%v err=%v fetches=%d", was, err, fetches.Load())
	}
}

func TestBuildCarriesOnWhenTheCallerGivesUp(t *testing.T) {
	release := make(chan struct{})
	c := fakeCache(t, 1<<30, func(ctx context.Context) error { <-release; return nil })
	raw := makeTar(t, entry{name: "a", body: "a"})
	d := digestOf(raw)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.Get(ctx, d, serve(raw, nil)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the caller's wait ends with its context, got %v", err)
	}
	close(release)
	if _, err := c.Get(context.Background(), d, serve(raw, nil)); err != nil {
		t.Fatal(err)
	}
	if !c.Has(d) {
		t.Fatal("the build finished for the next caller")
	}
}

func TestAFailureIsRememberedBriefly(t *testing.T) {
	c := fakeCache(t, 1<<30, nil)
	var calls atomic.Int32
	failing := func(ctx context.Context, digest string) (io.ReadCloser, error) {
		calls.Add(1)
		return nil, errors.New("404 not found")
	}
	d := digestOf([]byte("x"))
	for i := 0; i < 3; i++ {
		if _, err := c.Get(context.Background(), d, failing); err == nil || !strings.Contains(err.Error(), "404") {
			t.Fatalf("got %v", err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("a failed fetch is answered from memory for a while, fetched %d times", calls.Load())
	}
}

func TestLinkAndEvictionKeepImagesInUse(t *testing.T) {
	// Each image is about 10 KiB (a tar with a 9 KiB file); the cache keeps 25 KiB of them.
	c := fakeCache(t, 25<<10, nil)
	vm := t.TempDir()
	var digests []string
	for i := 0; i < 4; i++ {
		raw := makeTar(t, entry{name: "f", body: strings.Repeat(string(rune('a'+i)), 9<<10)})
		d := digestOf(raw)
		digests = append(digests, d)
		if i == 0 {
			// The first is in use (a sandbox's drive links it) the whole time.
			if _, _, err := c.Link(context.Background(), d, filepath.Join(vm, "bundle0.erofs"), serve(raw, nil)); err != nil {
				t.Fatal(err)
			}
		} else if _, err := c.Get(context.Background(), d, serve(raw, nil)); err != nil {
			t.Fatal(err)
		}
		// Distinct modification times, for least-recently-used order.
		old := time.Now().Add(time.Duration(i-10) * time.Minute)
		_ = os.Chtimes(c.Image(d), old, old)
	}
	c.Evict()
	if !c.Has(digests[0]) {
		t.Fatal("an image a sandbox links is never evicted")
	}
	if c.Has(digests[1]) {
		t.Fatal("the least recently used image not in use goes first")
	}
	if !c.Has(digests[3]) {
		t.Fatal("the newest image stays")
	}
	total, _, _ := c.Usage()
	if total > 25<<10+16<<10 {
		t.Fatalf("the cache is trimmed to about its bound, it holds %d bytes", total)
	}
	// Let go of it: now it may go too.
	if err := os.Remove(filepath.Join(vm, "bundle0.erofs")); err != nil {
		t.Fatal(err)
	}
	c.cfg.MaxBytes = 1
	c.Evict()
	if c.Has(digests[0]) {
		t.Fatal("an image no one links any longer may be evicted")
	}
}

// TestLinkSurvivesAFullCache: a new image is never evicted before the sandbox that asked for it has linked it, when
// images in use already fill the cache or the image alone is bigger than the cache's bound.
func TestLinkSurvivesAFullCache(t *testing.T) {
	c := fakeCache(t, 12<<10, nil)
	vm := t.TempDir()
	pinned := makeTar(t, entry{name: "f", body: strings.Repeat("p", 11<<10)})
	if _, _, err := c.Link(context.Background(), digestOf(pinned), filepath.Join(vm, "bundle0.erofs"), serve(pinned, nil)); err != nil {
		t.Fatal(err)
	}
	// The cache is full of images in use; a new one must still be linked, with one fetch.
	fresh := makeTar(t, entry{name: "f", body: strings.Repeat("n", 9<<10)})
	var fetches atomic.Int32
	if _, _, err := c.Link(context.Background(), digestOf(fresh), filepath.Join(vm, "bundle1.erofs"), serve(fresh, &fetches)); err != nil || fetches.Load() != 1 {
		t.Fatalf("with the cache full of images in use: err=%v fetches=%d", err, fetches.Load())
	}
	// One image bigger than the whole bound.
	huge := makeTar(t, entry{name: "f", body: strings.Repeat("h", 20<<10)})
	fetches.Store(0)
	if _, _, err := c.Link(context.Background(), digestOf(huge), filepath.Join(vm, "bundle2.erofs"), serve(huge, &fetches)); err != nil || fetches.Load() != 1 {
		t.Fatalf("an image bigger than the cache: err=%v fetches=%d", err, fetches.Load())
	}
	for i, raw := range [][]byte{pinned, fresh, huge} {
		if !c.Has(digestOf(raw)) {
			t.Fatalf("image %d is linked, so kept", i)
		}
	}

	// A caller that gives up while the image builds: once built, nothing holds it, and it may go.
	release := make(chan struct{})
	slow := fakeCache(t, 1, func(ctx context.Context) error { <-release; return nil })
	abandoned := makeTar(t, entry{name: "f", body: "x"})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := slow.Link(ctx, digestOf(abandoned), filepath.Join(vm, "bundle3.erofs"), serve(abandoned, nil)); err == nil {
		t.Fatal("the caller's wait ends with its context")
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for slow.bmuBuilding(digestOf(abandoned)) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if slow.Has(digestOf(abandoned)) {
		t.Fatal("an image no sandbox took is evicted when the cache is over its bound")
	}
	// Released: once its sandboxes let go, the images may go too.
	for _, n := range []string{"bundle0.erofs", "bundle1.erofs", "bundle2.erofs"} {
		if err := os.Remove(filepath.Join(vm, n)); err != nil {
			t.Fatal(err)
		}
	}
	c.Evict()
	if total, _, _ := c.Usage(); total > 12<<10 {
		t.Fatalf("released images are reclaimed, the cache holds %d bytes", total)
	}
}

// TestAReservationHoldsAnImageFromTheFirstWait: a caller that reserves before it waits (Get) keeps the image a slow
// build makes, in a cache full of images in use, through waits that time out and the build's own trim, until it links
// it: one build. Released without a link, the image is reclaimed.
func TestAReservationHoldsAnImageFromTheFirstWait(t *testing.T) {
	release := make(chan struct{})
	var builds atomic.Int32
	c := fakeCache(t, 12<<10, func(ctx context.Context) error {
		builds.Add(1)
		<-release
		return nil
	})
	vm := t.TempDir()
	pinned := makeTar(t, entry{name: "f", body: strings.Repeat("p", 11<<10)})
	close(release)
	if _, _, err := c.Link(context.Background(), digestOf(pinned), filepath.Join(vm, "bundle0.erofs"), serve(pinned, nil)); err != nil {
		t.Fatal(err)
	}
	release = make(chan struct{})
	builds.Store(0)

	fresh := makeTar(t, entry{name: "f", body: strings.Repeat("n", 9<<10)})
	digest := digestOf(fresh)
	unreserve := c.Reserve(digest)
	if !c.Reserved(digest) {
		t.Fatal("reserved before it is built")
	}
	// A wait that gives up while it builds (as a create's does, leaving the mount pending)...
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	if _, err := c.Get(ctx, digest, serve(fresh, nil)); err == nil {
		t.Fatal("the wait ends with its context")
	}
	cancel()
	// ...then the build finishes, and trims the cache, with no one waiting.
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for c.bmuBuilding(digest) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	c.Evict()
	if !c.Has(digest) {
		t.Fatal("a reserved image survives its build's trim and another")
	}
	// The next wait finds it, and the link needs no other build.
	if cached, err := c.Get(context.Background(), digest, serve(fresh, nil)); err != nil || !cached {
		t.Fatalf("found again: %v %v", cached, err)
	}
	if _, _, err := c.Link(context.Background(), digest, filepath.Join(vm, "bundle1.erofs"), serve(fresh, nil)); err != nil {
		t.Fatal(err)
	}
	unreserve()
	unreserve()
	if c.Reserved(digest) || builds.Load() != 1 {
		t.Fatalf("released once, built once: reserved=%v builds=%d", c.Reserved(digest), builds.Load())
	}
	if !c.Has(digest) {
		t.Fatal("linked, so kept")
	}

	// Abandoned: reserved and built, never linked, then released: reclaimed.
	other := makeTar(t, entry{name: "f", body: strings.Repeat("o", 5<<10)})
	unreserve = c.Reserve(digestOf(other))
	if _, err := c.Get(context.Background(), digestOf(other), serve(other, nil)); err != nil {
		t.Fatal(err)
	}
	c.Evict()
	if !c.Has(digestOf(other)) {
		t.Fatal("kept while reserved")
	}
	unreserve()
	if c.Has(digestOf(other)) {
		t.Fatal("an abandoned image is reclaimed once released")
	}
}

func (c *Cache) bmuBuilding(digest string) bool {
	c.bmu.Lock()
	defer c.bmu.Unlock()
	_, ok := c.builds[digest]
	return ok
}

func TestLinkReplacesTheDrivesFile(t *testing.T) {
	c := fakeCache(t, 1<<30, nil)
	vm := t.TempDir()
	dst := filepath.Join(vm, "bundle0.erofs")
	if err := os.WriteFile(dst, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	raw := makeTar(t, entry{name: "a", body: "a"})
	d := digestOf(raw)
	cached, size, err := c.Link(context.Background(), d, dst, serve(raw, nil))
	if err != nil || cached || size != int64(len(raw)) {
		t.Fatalf("cached=%v size=%d err=%v", cached, size, err)
	}
	a, _ := os.Stat(dst)
	b, _ := os.Stat(c.Image(d))
	if !os.SameFile(a, b) {
		t.Fatal("the drive's file is a hard link to the cached image")
	}
	if cached, _, err := c.Link(context.Background(), d, filepath.Join(vm, "bundle1.erofs"), serve(raw, nil)); err != nil || !cached {
		t.Fatalf("a second sandbox gets the same image from the cache: cached=%v err=%v", cached, err)
	}
	_, images, idle := c.Usage()
	if images != 1 || idle != 0 {
		t.Fatalf("one image, in use: images=%d idle=%d", images, idle)
	}
}

func TestNewEmptiesLeftovers(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "tmp", "half"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{Dir: dir, Mkfs: "/bin/true"}); err != nil {
		t.Fatal(err)
	}
	if left, _ := os.ReadDir(filepath.Join(dir, "tmp")); len(left) != 0 {
		t.Fatalf("a previous run's half-done work is removed, left %v", left)
	}
}

func TestExtractKeepsModesAndStaysInside(t *testing.T) {
	raw := makeTar(t,
		entry{name: "skills/", typ: tar.TypeDir, mode: 0o755},
		entry{name: "skills/run.sh", body: "#!/bin/sh\necho ran\n", mode: 0o755},
		entry{name: "skills/data.txt", body: "data\n", mode: 0o644},
		entry{name: "skills/link", typ: tar.TypeSymlink, link: "data.txt"},
		entry{name: "skills/hard", typ: tar.TypeLink, link: "skills/data.txt"},
		entry{name: "./readonly-dir/", typ: tar.TypeDir, mode: 0o555},
		entry{name: "./readonly-dir/inside", body: "x", mode: 0o444},
	)
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "b.tar")
	if err := os.WriteFile(tarPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "root")
	if err := Extract(tarPath, root, 1<<20); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(root, "skills/run.sh"))
	if err != nil || st.Mode().Perm() != 0o755 {
		t.Fatalf("the script keeps its execute bits: %v %v", st, err)
	}
	if target, err := os.Readlink(filepath.Join(root, "skills/link")); err != nil || target != "data.txt" {
		t.Fatalf("symbolic link: %q %v", target, err)
	}
	a, _ := os.Stat(filepath.Join(root, "skills/hard"))
	b, _ := os.Stat(filepath.Join(root, "skills/data.txt"))
	if !os.SameFile(a, b) {
		t.Fatal("a hard link stays one")
	}
	if st, _ := os.Stat(filepath.Join(root, "readonly-dir")); st.Mode().Perm() != 0o555 {
		t.Fatalf("a directory's mode is set after its entries: %v", st.Mode())
	}
	_ = os.Chmod(filepath.Join(root, "readonly-dir"), 0o755)

	for name, bad := range map[string][]byte{
		"dotdot":         makeTar(t, entry{name: "../escape", body: "x"}),
		"nested dotdot":  makeTar(t, entry{name: "a/../../escape", body: "x"}),
		"through a link": makeTar(t, entry{name: "out", typ: tar.TypeSymlink, link: "/tmp"}, entry{name: "out/escape", body: "x"}),
		"hard link out":  makeTar(t, entry{name: "h", typ: tar.TypeLink, link: "../../etc/passwd"}),
		"too big":        makeTar(t, entry{name: "big", body: strings.Repeat("x", 2<<20)}),
	} {
		p := filepath.Join(dir, "bad.tar")
		if err := os.WriteFile(p, bad, 0o600); err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(dir, "bad-"+strings.ReplaceAll(name, " ", "-"))
		if err := Extract(p, out, 1<<20); err == nil {
			t.Errorf("%s: refused", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "escape")); err == nil {
		t.Fatal("nothing is written outside the root")
	}
}

// TestExtractNeverChmodsThroughALink: a symbolic link to a directory outside the root, then a directory entry of the
// same name, must be refused without touching that directory's mode or times.
func TestExtractNeverChmodsThroughALink(t *testing.T) {
	dir := t.TempDir()
	sentinel := filepath.Join(dir, "sentinel")
	if err := os.Mkdir(sentinel, 0o700); err != nil {
		t.Fatal(err)
	}
	then := time.Unix(1_600_000_000, 0)
	if err := os.Chtimes(sentinel, then, then); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string][]byte{
		"dir entry at a link":        makeTar(t, entry{name: "out", typ: tar.TypeSymlink, link: sentinel}, entry{name: "out/", typ: tar.TypeDir, mode: 0o777}),
		"dir entry at a link (./)":   makeTar(t, entry{name: "./out", typ: tar.TypeSymlink, link: sentinel}, entry{name: "./out", typ: tar.TypeDir, mode: 0o777}),
		"nested dir entry at a link": makeTar(t, entry{name: "a/", typ: tar.TypeDir, mode: 0o755}, entry{name: "a/out", typ: tar.TypeSymlink, link: sentinel}, entry{name: "a/out/", typ: tar.TypeDir, mode: 0o777}),
		"dir entry at a file":        makeTar(t, entry{name: "f", body: "x"}, entry{name: "f/", typ: tar.TypeDir, mode: 0o777}),
	} {
		p := filepath.Join(dir, "bad.tar")
		if err := os.WriteFile(p, bad, 0o600); err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(dir, "bad-"+strings.NewReplacer(" ", "-", "(", "", ")", "", "/", "").Replace(name))
		if err := Extract(p, out, 1<<20); err == nil {
			t.Errorf("%s: refused", name)
		}
		st, err := os.Stat(sentinel)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o700 || !st.ModTime().Equal(then) {
			t.Fatalf("%s: the directory outside the root was changed: %v %v", name, st.Mode(), st.ModTime())
		}
	}
	// A symbolic link to a directory (inside or out) is kept as a link, not followed, when no entry is under it.
	ok := makeTar(t, entry{name: "d/", typ: tar.TypeDir, mode: 0o755}, entry{name: "d/f", body: "x"}, entry{name: "ln", typ: tar.TypeSymlink, link: "d"}, entry{name: "out", typ: tar.TypeSymlink, link: sentinel})
	p := filepath.Join(dir, "ok.tar")
	if err := os.WriteFile(p, ok, 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "ok")
	if err := Extract(p, root, 1<<20); err != nil {
		t.Fatal(err)
	}
	if target, err := os.Readlink(filepath.Join(root, "out")); err != nil || target != sentinel {
		t.Fatalf("the link is kept as it is: %q %v", target, err)
	}
}

// TestMkfsErofs builds a real image when mkfs.erofs is installed, and checks with fsck.erofs (or dump.erofs) that
// the script inside it is executable.
func TestMkfsErofs(t *testing.T) {
	mkfs, err := exec.LookPath("mkfs.erofs")
	if err != nil {
		t.Skip("mkfs.erofs (erofs-utils) isn't installed")
	}
	raw := makeTar(t,
		entry{name: "run.sh", body: "#!/bin/sh\necho ran\n", mode: 0o755},
		entry{name: "data.txt", body: "data\n"},
	)
	for _, tarMode := range []bool{true, false} {
		c, err := New(Config{Dir: t.TempDir(), Mkfs: mkfs})
		if err != nil {
			t.Fatal(err)
		}
		if tarMode && !c.tar {
			continue
		}
		c.tar = tarMode
		d := digestOf(raw)
		if _, err := c.Get(context.Background(), d, serve(raw, nil)); err != nil {
			t.Fatalf("tar=%v: %v", tarMode, err)
		}
		img, err := os.ReadFile(c.Image(d))
		if err != nil {
			t.Fatal(err)
		}
		// The erofs superblock's magic, at 1024.
		if len(img) < 1028 || !bytes.Equal(img[1024:1028], []byte{0xe2, 0xe1, 0xf5, 0xe0}) {
			t.Fatalf("tar=%v: not an erofs image", tarMode)
		}
		if dump, err := exec.LookPath("dump.erofs"); err == nil {
			out, err := exec.Command(dump, "--path=/run.sh", c.Image(d)).CombinedOutput()
			if err != nil {
				t.Fatalf("dump.erofs: %v: %s", err, out)
			}
			if !strings.Contains(string(out), "0755") && !strings.Contains(string(out), "rwxr-xr-x") {
				t.Fatalf("tar=%v: run.sh keeps its execute bits:\n%s", tarMode, out)
			}
		}
	}
}
