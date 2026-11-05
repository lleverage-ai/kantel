package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A template's image is a Kantel base: an image the deployment's super-admin published, by name and digest. One with no
// digest is the host's own sandbox image (Config.Rootfs), which needs no Docker and no root filesystem of its own. One
// with a digest is pulled by that digest from the operator's registry (Config.TemplateRegistry), and its root
// filesystem made as guest/rootfs.sh makes the default one: a container of the image exported, and an ext4 image made
// of its files by mkfs.ext4 -d, as root in a helper container so ownership and modes are kept. Each is kept as
// images/templates/<key>.ext4, keyed by the image and its digest, so template snapshots of one image share it.
//
// Nothing the account sends names a registry, and nothing is built: the host pulls, creates and exports, so no image's
// ONBUILD triggers run on the host's Docker. A template's own work (packages, files) is its setup, which runs in the VM
// behind the sandbox link and the egress proxy with the template's grants. Docker is a prerequisite of template builds
// alone: a host without it runs sandboxes and restores built templates.

// runner runs one host command and answers its output. The template pipeline's commands go through it, so tests see
// them without Docker.
type runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func execRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		sub := name
		if len(args) > 0 {
			sub += " " + args[0]
		}
		return out, fmt.Errorf("%s: %w: %s", sub, err, tailText(string(out), 1500))
	}
	return out, nil
}

// tailText is the last n bytes of s, trimmed.
func tailText(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

// rootfsHelperImage makes the ext4 image (it has e2fsprogs to install, as guest/rootfs.sh's helper does).
const rootfsHelperImage = "debian:trixie"

// rootfsScript runs in the helper with the work directory at /work: the exported container's files (rootfs.tar) become
// rootfs.ext4, sized to its contents plus a little room. Docker leaves /etc/hosts, /etc/resolv.conf and /etc/hostname
// as empty files; the guest agent writes them.
const rootfsScript = `apt-get update -qq && apt-get install -y -qq --no-install-recommends e2fsprogs >/dev/null
mkdir /rootfs && tar -x -C /rootfs --numeric-owner -f /work/rootfs.tar
rm -f /rootfs/.dockerenv
size_mb=$(du -sm /rootfs | cut -f1)
size_mb=$((size_mb + size_mb / 5 + 256))
rm -f /work/rootfs.ext4
mkfs.ext4 -q -L kantel-root -O ^has_journal -d /rootfs /work/rootfs.ext4 "${size_mb}M"`

// templateImage is a template's Kantel base: the image's name and, unless it is the host's own image, its digest.
type templateImage struct {
	BaseImage  string
	BaseDigest string
}

// baseImageName is a base image's name as the control plane takes it (TEMPLATE_BASE_IMAGE_PATTERN): a repository path
// such as kantel/sandbox, with no registry, tag or digest.
var baseImageName = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)

// baseImageDigest is a base image's digest.
var baseImageDigest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// validate refuses a base whose digest, or whose name beside a digest, isn't one: they make the reference pulled. With
// no digest the base is the host's own image, whatever its name.
func (i templateImage) validate() error {
	if i.BaseDigest == "" {
		return nil
	}
	if !baseImageName.MatchString(i.BaseImage) {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("bad template base image name %q: a repository path such as kantel/sandbox, with no registry, tag or digest", i.BaseImage)}
	}
	if !baseImageDigest.MatchString(i.BaseDigest) {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("bad template base image digest %q: sha256: and 64 lowercase hex digits", i.BaseDigest)}
	}
	return nil
}

// key names a pulled base's root filesystem: the SHA-256 of its name and digest.
func (i templateImage) key() string {
	sum := sha256.Sum256([]byte("kantel-base\x00" + i.BaseImage + "@" + i.BaseDigest))
	return hex.EncodeToString(sum[:])
}

// validKey is a key as key() makes it, so one sent by the control plane can be joined under images/templates.
func validKey(key string) bool {
	if len(key) != 64 {
		return false
	}
	_, err := hex.DecodeString(key)
	return err == nil
}

// builtRootfs is what images/templates/<key>.json records of a root filesystem.
type builtRootfs struct {
	ImageDigest string `json:"imageDigest,omitempty"`
	BuiltFrom   string `json:"builtFrom"`
}

// keyedLocks is one lock a key: one build of a root filesystem, or one build or delete of a template snapshot, at a
// time. A template snapshot's restores share its lock (tryShare) while they copy and load its files.
type keyedLocks struct {
	mu   sync.Mutex
	keys map[string]*sync.RWMutex
}

func (k *keyedLocks) of(key string) *sync.RWMutex {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.keys == nil {
		k.keys = map[string]*sync.RWMutex{}
	}
	l, ok := k.keys[key]
	if !ok {
		l = &sync.RWMutex{}
		k.keys[key] = l
	}
	return l
}

// lock waits for key's lock, until no one else holds or shares it, and answers its unlock.
func (k *keyedLocks) lock(key string) func() {
	l := k.of(key)
	l.Lock()
	return l.Unlock
}

// tryShare shares key's lock unless it is held, or a lock is waiting for it, and answers its release.
func (k *keyedLocks) tryShare(key string) (func(), bool) {
	l := k.of(key)
	if !l.TryRLock() {
		return nil, false
	}
	return l.RUnlock, true
}

// rootfsBuilder makes pulled bases' root filesystems into dir (images/templates), one of a key at a time.
type rootfsBuilder struct {
	dir  string
	arch string
	run  runner
	// registry is the operator's registry bases are pulled from (Config.TemplateRegistry); empty, none is.
	registry string
	locks    keyedLocks
	docker   dockerCheck
}

func newRootfsBuilder(dir string, run runner, registry string) *rootfsBuilder {
	return &rootfsBuilder{dir: dir, arch: runtime.GOARCH, run: run, registry: strings.TrimSuffix(registry, "/")}
}

// dockerCheckTTL is how long an answer about the host's Docker is kept: facts and every build ask.
const dockerCheckTTL = 30 * time.Second

// dockerCheck is the last answer about the host's Docker.
type dockerCheck struct {
	mu  sync.Mutex
	at  time.Time
	err error
}

// ready says whether the host can build images: the docker CLI is installed and its daemon answers `docker version`
// within a few seconds. The answer is kept for dockerCheckTTL.
func (b *rootfsBuilder) ready(ctx context.Context) error {
	b.docker.mu.Lock()
	defer b.docker.mu.Unlock()
	if !b.docker.at.IsZero() && time.Since(b.docker.at) < dockerCheckTTL {
		return b.docker.err
	}
	// The caller going away isn't Docker's answer, so it isn't kept as one.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := b.run(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	b.docker.at, b.docker.err = time.Now(), noDocker(err)
	return b.docker.err
}

// noDocker is a failed `docker version` as the reason the host can't build templates.
func noDocker(err error) error {
	if err == nil {
		return nil
	}
	why := fmt.Sprintf("Docker on this host doesn't answer (%v)", err)
	if errors.Is(err, exec.ErrNotFound) {
		why = "Docker isn't installed on this host"
	}
	return &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't build templates' images: " + why + ". Template builds need Docker Engine on the host, installed and running (ordinary sandboxes don't)"}
}

func (b *rootfsBuilder) path(key string) string { return filepath.Join(b.dir, key+".ext4") }

// cached answers a root filesystem already built, and its record.
func (b *rootfsBuilder) cached(key string) (string, builtRootfs, bool) {
	var rec builtRootfs
	path := b.path(key)
	if _, err := os.Stat(path); err != nil {
		return "", rec, false
	}
	if raw, err := os.ReadFile(filepath.Join(b.dir, key+".json")); err == nil {
		_ = json.Unmarshal(raw, &rec)
	}
	return path, rec, true
}

// rootfs answers the root filesystem of a base with a digest (Manager.templateRootfs) and the image's ID, pulling the
// base by its digest from the operator's registry and making it unless it is cached. A host with no registry
// configured refuses it (ErrUnsupported).
func (b *rootfsBuilder) rootfs(ctx context.Context, img templateImage) (string, string, error) {
	if err := img.validate(); err != nil {
		return "", "", err
	}
	key := img.key()
	defer b.locks.lock(key)()
	if path, rec, ok := b.cached(key); ok {
		return path, rec.ImageDigest, nil
	}
	if b.registry == "" {
		return "", "", &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't make templates from a published base image: its settings name no templateRegistry to pull " + img.BaseImage + "@" + img.BaseDigest + " from"}
	}
	if err := b.ready(ctx); err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		return "", "", err
	}
	work := filepath.Join(b.dir, key+".building")
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return "", "", err
	}
	defer os.RemoveAll(work)
	platform := "linux/" + b.arch
	tag := b.registry + "/" + img.BaseImage + "@" + img.BaseDigest
	if _, err := b.run(ctx, "docker", "pull", "--platform", platform, tag); err != nil {
		return "", "", pullFailed(err)
	}
	out, err := b.run(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", tag)
	if err != nil {
		return "", "", err
	}
	digest := lastLine(string(out))
	out, err = b.run(ctx, "docker", "create", "--platform", platform, tag, "/bin/true")
	if err != nil {
		return "", "", err
	}
	container := lastLine(string(out))
	if container == "" {
		return "", "", fmt.Errorf("docker create answered no container")
	}
	defer func() { _, _ = b.run(context.Background(), "docker", "rm", "-f", container) }()
	if _, err := b.run(ctx, "docker", "export", "-o", filepath.Join(work, "rootfs.tar"), container); err != nil {
		return "", "", err
	}
	// Named, so it is ended with the work that started it (and with a host that restarted meanwhile, reap): a docker
	// run whose CLI is killed (its build cancelled) leaves its container running, beyond the build's hold.
	helper := helperContainer(key)
	_, _ = b.run(context.WithoutCancel(ctx), "docker", "rm", "-f", helper)
	defer func() { _, _ = b.run(context.WithoutCancel(ctx), "docker", "rm", "-f", helper) }()
	if _, err := b.run(ctx, "docker", "run", "--rm", "--name", helper, "-v", work+":/work", rootfsHelperImage, "sh", "-euc", rootfsScript); err != nil {
		return "", "", err
	}
	path := b.path(key)
	if err := os.Rename(filepath.Join(work, "rootfs.ext4"), path); err != nil {
		return "", "", err
	}
	raw, _ := json.Marshal(builtRootfs{ImageDigest: digest, BuiltFrom: tag})
	_ = os.WriteFile(filepath.Join(b.dir, key+".json"), raw, 0o600)
	return path, digest, nil
}

// helperContainer names the helper container making key's root filesystem.
func helperContainer(key string) string { return "kantel-rootfs-" + key }

// reap ends the root filesystems a previous run of the host was making when it stopped: each one's helper container
// is removed (Docker keeps running it), then its work directory. A retry makes it again.
func (b *rootfsBuilder) reap() {
	works, _ := filepath.Glob(filepath.Join(b.dir, "*.building"))
	for _, work := range works {
		key := strings.TrimSuffix(filepath.Base(work), ".building")
		if validKey(key) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_, _ = b.run(ctx, "docker", "rm", "-f", helperContainer(key))
			cancel()
		}
		_ = os.RemoveAll(work)
	}
}

// pullFailed is a pull of the template's base that failed, which the control plane reports as the template's.
func pullFailed(err error) error {
	return &proto.Error{Code: proto.ErrInvalid, Message: "the template's base image didn't pull: " + err.Error()}
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
