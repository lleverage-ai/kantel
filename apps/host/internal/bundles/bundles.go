// Package bundles is the host's cache of bundle images, for microVM sandboxes' read-only bundle mounts.
//
// A bundle is a tar an account uploaded to the control plane once, named by its SHA-256 (sha256:<hex>). The first
// time a sandbox on this host mounts one, the host fetches the tar, checks its bytes against the digest, and makes it
// an erofs image (mkfs.erofs) kept under that digest. Every sandbox on the host that mounts it from then on gets that
// same image as a read-only drive, and nothing is fetched again.
//
// On disk (Config.Dir, such as /var/lib/kantel-host/bundles):
//
//	images/<hex>.erofs   the images, each built in tmp/ and renamed in once whole
//	tmp/                 downloads and builds under way (emptied when the host starts)
//
// An image is in use while a sandbox or a snapshot holds a hard link to it in its own directory (its
// drive's file there). So whether an image is in use is its link count, which needs no bookkeeping and survives a
// restart of the host. Eviction removes the least recently used images that aren't in use until the cache is within
// MaxBytes; an image in use is never removed, so the cache is over MaxBytes while sandboxes hold more than that.
package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Defaults.
const (
	// DefaultMaxBytes bounds the cache's images that aren't in use: 10 GiB.
	DefaultMaxBytes = 10 << 30
	// DefaultMaxBundleBytes is the largest tar the host fetches: 4 GiB (the control plane takes 2 GiB by default).
	DefaultMaxBundleBytes = 4 << 30
	// DefaultOwner owns every file in an image: the sandbox's user (uid and gid 1000), so a file is readable in the
	// sandbox whatever owner the tar recorded. Modes, execute bits included, are the tar's.
	DefaultOwner = 1000
	// buildTimeout bounds one fetch and build.
	buildTimeout = 15 * time.Minute
)

// Fetch opens a bundle's tar.
type Fetch func(ctx context.Context, digest string) (io.ReadCloser, error)

// Config is the cache's setup.
type Config struct {
	Dir string
	// MaxBytes bounds the images not in use (default DefaultMaxBytes).
	MaxBytes int64
	// MaxBundleBytes is the largest tar fetched (default DefaultMaxBundleBytes); an image may be at most twice that.
	MaxBundleBytes int64
	// Mkfs is mkfs.erofs (default: found on PATH).
	Mkfs string
	// Owner is the uid and gid every file in an image has (default DefaultOwner).
	Owner int
	Log   *slog.Logger
}

// Cache is the host's bundle images.
type Cache struct {
	cfg  Config
	log  *slog.Logger
	mkfs string
	// tar: this mkfs.erofs builds from a tar itself (--tar, erofs-utils 1.7 and later); without it the tar is
	// extracted to a directory first.
	tar     bool
	version string
	// mu is held while an image is linked or removed, so eviction never removes one between a sandbox finding it and
	// linking it.
	mu     sync.Mutex
	bmu    sync.Mutex
	builds map[string]*build
	// failed remembers a bundle whose fetch or build failed, for FailureTTL, so the sandboxes that mount it are told
	// at once rather than each fetching it again.
	failed map[string]failure
	// buildImage makes out, an erofs image, from the tar at tarPath (scratch is a directory it may use). Tests replace it.
	buildImage func(ctx context.Context, tarPath, out, scratch string) error
}

type build struct {
	done chan struct{}
	err  error
}

type failure struct {
	err error
	at  time.Time
}

// FailureTTL is how long a failed fetch or build is answered before the next Get tries again.
const FailureTTL = 30 * time.Second

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ValidDigest says whether d is sha256: and 64 lower-case hex digits.
func ValidDigest(d string) bool { return digestPattern.MatchString(d) }

// New opens the cache in cfg.Dir, emptying what a previous run left half done.
func New(cfg Config) (*Cache, error) {
	if cfg.MaxBytes == 0 {
		cfg.MaxBytes = DefaultMaxBytes
	}
	if cfg.MaxBundleBytes == 0 {
		cfg.MaxBundleBytes = DefaultMaxBundleBytes
	}
	if cfg.Owner == 0 {
		cfg.Owner = DefaultOwner
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	c := &Cache{cfg: cfg, log: cfg.Log.With("part", "bundles"), builds: map[string]*build{}, failed: map[string]failure{}}
	_ = os.RemoveAll(c.tmpDir())
	for _, dir := range []string{c.imagesDir(), c.tmpDir()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	c.mkfs = cfg.Mkfs
	if c.mkfs == "" {
		c.mkfs, _ = exec.LookPath("mkfs.erofs")
	}
	if c.mkfs != "" {
		// Usage goes to stderr, with a non-zero exit on some versions: only the text matters.
		help, _ := exec.Command(c.mkfs, "--help").CombinedOutput()
		c.tar = strings.Contains(string(help), "--tar")
		if v, err := exec.Command(c.mkfs, "-V").CombinedOutput(); err == nil {
			c.version = strings.TrimSpace(strings.SplitN(string(v), "\n", 2)[0])
		}
	}
	c.buildImage = c.mkfsImage
	return c, nil
}

// Available is nil when the cache can build images: mkfs.erofs (erofs-utils) is installed.
func (c *Cache) Available() error {
	if c == nil {
		return errors.New("this host has no bundle cache")
	}
	if c.mkfs == "" {
		return errors.New("this host can't make bundle images: install erofs-utils (mkfs.erofs)")
	}
	return nil
}

// Tool says which mkfs.erofs builds the images, and how.
func (c *Cache) Tool() string {
	if c.mkfs == "" {
		return "none"
	}
	mode := "extract"
	if c.tar {
		mode = "tar"
	}
	return fmt.Sprintf("%s (%s, %s)", c.mkfs, c.version, mode)
}

func (c *Cache) imagesDir() string { return filepath.Join(c.cfg.Dir, "images") }
func (c *Cache) tmpDir() string    { return filepath.Join(c.cfg.Dir, "tmp") }

// Image is where a bundle's image is kept.
func (c *Cache) Image(digest string) string {
	return filepath.Join(c.imagesDir(), strings.TrimPrefix(digest, "sha256:")+".erofs")
}

// Has says whether a bundle's image is in the cache now.
func (c *Cache) Has(digest string) bool {
	_, err := os.Stat(c.Image(digest))
	return err == nil
}

// Get makes sure a bundle's image is in the cache, fetching its tar and building the image when it isn't, and says
// whether it was there already. Concurrent calls for one bundle share one fetch and build, which carries on (for the
// others) when the caller that started it gives up.
func (c *Cache) Get(ctx context.Context, digest string, fetch Fetch) (cached bool, err error) {
	if !ValidDigest(digest) {
		return false, fmt.Errorf("%q isn't a bundle digest (sha256:<64 hex digits>)", digest)
	}
	if c.Has(digest) {
		return true, nil
	}
	if err := c.Available(); err != nil {
		return false, err
	}
	c.bmu.Lock()
	b, ok := c.builds[digest]
	if !ok {
		if c.Has(digest) {
			c.bmu.Unlock()
			return true, nil
		}
		if f, ok := c.failed[digest]; ok && time.Since(f.at) < FailureTTL {
			c.bmu.Unlock()
			return false, f.err
		}
		delete(c.failed, digest)
		b = &build{done: make(chan struct{})}
		c.builds[digest] = b
		go c.run(digest, fetch, b)
	}
	c.bmu.Unlock()
	select {
	case <-b.done:
		return false, b.err
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func (c *Cache) run(digest string, fetch Fetch, b *build) {
	ctx, cancel := context.WithTimeout(context.Background(), buildTimeout)
	defer cancel()
	b.err = c.make(ctx, digest, fetch)
	if b.err != nil {
		c.log.Warn("bundle image failed", "digest", digest, "error", b.err)
	}
	c.bmu.Lock()
	delete(c.builds, digest)
	if b.err != nil {
		c.failed[digest] = failure{err: b.err, at: time.Now()}
	}
	c.bmu.Unlock()
	close(b.done)
}

// make fetches a bundle's tar, checks it, builds its image and puts it in the cache.
func (c *Cache) make(ctx context.Context, digest string, fetch Fetch) error {
	started := time.Now()
	scratch, err := os.MkdirTemp(c.tmpDir(), strings.TrimPrefix(digest, "sha256:")[:12]+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	tarPath := filepath.Join(scratch, "bundle.tar")
	size, err := c.download(ctx, digest, fetch, tarPath)
	if err != nil {
		return err
	}
	fetched := time.Since(started)
	out := filepath.Join(scratch, "image.erofs")
	if err := c.buildImage(ctx, tarPath, out, scratch); err != nil {
		return err
	}
	info, err := os.Stat(out)
	if err != nil {
		return err
	}
	if info.Size() > 2*c.cfg.MaxBundleBytes {
		return fmt.Errorf("the bundle's image is %d bytes, more than this host takes (%d)", info.Size(), 2*c.cfg.MaxBundleBytes)
	}
	if err := syncFile(out); err != nil {
		return err
	}
	if err := os.Rename(out, c.Image(digest)); err != nil {
		return err
	}
	_ = syncFile(c.imagesDir())
	c.log.Info("bundle image built", "digest", digest, "tarBytes", size, "imageBytes", info.Size(),
		"fetchMs", fetched.Milliseconds(), "buildMs", (time.Since(started) - fetched).Milliseconds(), "tool", c.Tool())
	c.Evict()
	return nil
}

// download writes the bundle's tar to path, hashing it as it comes, and fails unless its bytes are the digest's.
func (c *Cache) download(ctx context.Context, digest string, fetch Fetch, path string) (int64, error) {
	body, err := fetch(ctx, digest)
	if err != nil {
		return 0, err
	}
	defer body.Close()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(body, c.cfg.MaxBundleBytes+1))
	if err != nil {
		return n, fmt.Errorf("fetching the bundle: %w", err)
	}
	if n > c.cfg.MaxBundleBytes {
		return n, fmt.Errorf("the bundle is more than %d bytes, the most this host takes", c.cfg.MaxBundleBytes)
	}
	if got := "sha256:" + hex.EncodeToString(h.Sum(nil)); got != digest {
		return n, fmt.Errorf("the bundle's bytes are %s, not %s", got, digest)
	}
	return n, f.Close()
}

// mkfsImage builds an uncompressed erofs image from a tar: with mkfs.erofs --tar when it has it, else from the tar
// extracted into scratch.
func (c *Cache) mkfsImage(ctx context.Context, tarPath, out, scratch string) error {
	owner := fmt.Sprint(c.cfg.Owner)
	args := []string{"--force-uid=" + owner, "--force-gid=" + owner}
	if c.tar {
		args = append(args, "--tar=f", out, tarPath)
	} else {
		root := filepath.Join(scratch, "root")
		if err := Extract(tarPath, root, 2*c.cfg.MaxBundleBytes); err != nil {
			return err
		}
		args = append(args, out, root)
	}
	raw, err := exec.CommandContext(ctx, c.mkfs, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return fmt.Errorf("mkfs.erofs: %v: %s", err, msg)
	}
	return nil
}

// Link puts a hard link to a bundle's image at dst (replacing what is there), getting the image first if the cache
// hasn't it. The image is in use, and never evicted, while dst exists. It answers whether the image was cached and
// its size.
func (c *Cache) Link(ctx context.Context, digest, dst string, fetch Fetch) (cached bool, size int64, err error) {
	for attempt := 0; ; attempt++ {
		was, err := c.Get(ctx, digest, fetch)
		if err != nil {
			return false, 0, err
		}
		cached = cached || (attempt == 0 && was)
		c.mu.Lock()
		size, err = c.linkLocked(c.Image(digest), dst)
		c.mu.Unlock()
		// Evicted between Get and here (it wasn't in use yet): get it again.
		if errors.Is(err, fs.ErrNotExist) && attempt < 2 {
			cached = false
			continue
		}
		return cached, size, err
	}
}

func (c *Cache) linkLocked(image, dst string) (int64, error) {
	info, err := os.Stat(image)
	if err != nil {
		return 0, err
	}
	tmp := dst + ".new"
	_ = os.Remove(tmp)
	if err := os.Link(image, tmp); err != nil {
		if !errors.Is(err, syscall.EXDEV) {
			return 0, err
		}
		// Another file system than the cache's: a copy (a reflink where it can be) the sandbox keeps to itself.
		if out, err := exec.Command("cp", "--reflink=auto", image, tmp).CombinedOutput(); err != nil {
			return 0, fmt.Errorf("copy the bundle image: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	// Last used now: eviction goes by modification time.
	now := time.Now()
	_ = os.Chtimes(image, now, now)
	return info.Size(), nil
}

// Usage is the bytes the cache's images take and how many there are, and of those, the bytes not in use.
func (c *Cache) Usage() (total int64, images int, idle int64) {
	for _, im := range c.list() {
		total += im.bytes
		images++
		if im.links <= 1 {
			idle += im.bytes
		}
	}
	return
}

type image struct {
	path  string
	bytes int64
	used  time.Time
	links uint64
}

func (c *Cache) list() []image {
	entries, _ := os.ReadDir(c.imagesDir())
	var out []image
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".erofs") {
			continue
		}
		path := filepath.Join(c.imagesDir(), e.Name())
		var st syscall.Stat_t
		if syscall.Stat(path, &st) != nil {
			continue
		}
		out = append(out, image{path: path, bytes: st.Blocks * 512, used: time.Unix(st.Mtim.Unix()), links: uint64(st.Nlink)})
	}
	return out
}

// Evict removes the least recently used images that no sandbox or snapshot links to, until the cache's
// images take at most MaxBytes (or none is left that may go).
func (c *Cache) Evict() {
	c.mu.Lock()
	defer c.mu.Unlock()
	list := c.list()
	var total int64
	for _, im := range list {
		total += im.bytes
	}
	if total <= c.cfg.MaxBytes {
		return
	}
	sort.Slice(list, func(i, j int) bool { return list[i].used.Before(list[j].used) })
	for _, im := range list {
		if total <= c.cfg.MaxBytes {
			break
		}
		if im.links > 1 {
			continue
		}
		if err := os.Remove(im.path); err == nil {
			total -= im.bytes
			c.log.Info("bundle image evicted", "image", filepath.Base(im.path), "bytes", im.bytes)
		}
	}
}

func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
