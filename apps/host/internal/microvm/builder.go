package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A template's custom image (proto.TemplateImage: a Dockerfile, or an image reference) is built in a build microVM,
// never on the host. The host's Docker daemon does its own network I/O after any check the host could make (a name
// resolved again, a registry's redirect, an ONBUILD ADD in a pulled image), so nothing account-supplied goes near it:
// the build microVM boots the host's own sandbox image (Config.Rootfs, which runs Docker), on a network link like any
// sandbox's, whose only way out is the host's egress proxy (package network: forwarding from a sandbox's device is
// dropped, and it reaches the proxy's port on its gateway and nothing else). The proxy checks every connection's
// address after DNS, as it connects (egress.Destinations), so a pull, a redirect it follows, a RUN step's fetch or an
// ONBUILD trigger reaches a public address the build's rules allow, or nothing; never the host, the LAN, cloud
// metadata or another sandbox. Its rules are the template's (its grants and the account's proxy settings), with every
// other host refused, plus the registries the host's operator allows (TemplateBuilderConfig.Registries).
//
// The image becomes a root filesystem inside the microVM: the host makes an empty ext4 file (mkfs of nothing the
// account gave) and attaches it as a third drive; the build exports the image's files into it. The host never mounts,
// reads or repairs that file: it is only ever a guest's read-only root device, as a pulled base's is, booted through
// Kantel's initramfs, which puts the guest agent in (Config.Initrd). It is kept as images/templates/<key>.ext4, keyed
// by the account, the build's scope (its template, version and rebuild) and the image, so no other account or
// template shares what a build fetched with its grants, and a rebuild pulls or builds again.

// TemplateBuilderConfig switches the template builder on: custom images built in a build microVM. Nil: off, and the
// host reports no FeatureTemplateImageBuild.
type TemplateBuilderConfig struct {
	// Registries are the host patterns (`registry-1.docker.io`, `*.docker.io`, `ghcr.io`) a build may reach besides
	// the template's own grants: the registries, and the hosts their blobs redirect to, the operator allows.
	Registries []string
}

// builderTimeout bounds a custom image's build in its microVM (the control plane gives a custom image's whole build
// 100 minutes: this, the snapshot's boot and its setup).
const builderTimeout = 45 * time.Minute

// buildHold is what a template build of machine size holds against the host's budget: the machine, and for a custom
// image's build microVM a second drive of its disk size, the output drive (the VM's own disk is unchanged).
func buildHold(size proto.Size, customImage bool) proto.Size {
	if customImage {
		size.DiskGiB *= 2
	}
	return size
}

// builderOutputDrive is the build microVM's third drive (/dev/vdc), the image's root filesystem being made.
const builderOutputDrive = "out.ext4"

// builderResultPrefix marks the build script's last line: what it made.
const builderResultPrefix = "KANTEL-RESULT "

// templateImageRef is an image reference as the control plane takes it (TEMPLATE_IMAGE_REF_PATTERN).
var templateImageRef = regexp.MustCompile(`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]{1,5})?/)?` +
	`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*` +
	`(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`)

// templateImageScope is a custom image's scope: `<templateId>@<version>` and its rebuild, as the control plane names it.
var templateImageScope = regexp.MustCompile(`^[A-Za-z0-9_.@#:-]{1,200}$`)

// maxDockerfileBytes is the largest Dockerfile taken, as the API's.
const maxDockerfileBytes = 65536

// validateTemplateImage refuses a custom image that isn't one.
func validateTemplateImage(img *proto.TemplateImage) error {
	bad := func(why string) error {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad template image: " + why}
	}
	if !templateImageScope.MatchString(img.Scope) {
		return bad("its scope isn't one")
	}
	switch img.Kind {
	case proto.TemplateImageDockerfile:
		if strings.TrimSpace(img.Dockerfile) == "" || len(img.Dockerfile) > maxDockerfileBytes || img.Ref != "" {
			return bad("a dockerfile image has a Dockerfile of at most 64 KiB, and no ref")
		}
	case proto.TemplateImageRef:
		if !templateImageRef.MatchString(img.Ref) || len(img.Ref) > 512 || img.Dockerfile != "" {
			return bad(fmt.Sprintf("%q isn't an image reference such as python:3.13-slim", img.Ref))
		}
	default:
		return bad(fmt.Sprintf("unknown kind %q", img.Kind))
	}
	return nil
}

// dockerfileDigest is a Dockerfile's SHA-256, as provenance records it.
func dockerfileDigest(dockerfile string) string {
	sum := sha256.Sum256([]byte(dockerfile))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// customImageKey names a custom image's root filesystem: the account, the build's scope, the image, and the Kantel
// base a Dockerfile's `FROM $KANTEL_BASE` starts from.
func customImageKey(owner string, img *proto.TemplateImage, base templateImage) string {
	source := img.Ref
	if img.Kind == proto.TemplateImageDockerfile {
		source = dockerfileDigest(img.Dockerfile)
	}
	// Only a Dockerfile builds on the template's base; an image reference's key is the same whatever base it names, so
	// a Kantel base release never pulls it again.
	baseRef := ""
	if img.Kind == proto.TemplateImageDockerfile {
		baseRef = base.BaseImage + "@" + base.BaseDigest
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{"custom", owner, img.Scope, img.Kind, source, baseRef}, "\x00")))
	return hex.EncodeToString(sum[:])
}

// builderEgress is the build microVM's way out: the template's egress (its grants and the account's proxy settings)
// through the host's proxy ("proxy", never "open", which would drop the rules), refusing every host no rule allows,
// with the operator's registries allowed too, and that of the operator's templateRegistry when the build starts from
// a pulled Kantel base.
func (m *Manager) builderEgress(e *proto.Egress, base templateImage) *proto.Egress {
	return BuilderEgress(e, m.cfg.TemplateBuilder, m.cfg.TemplateRegistry, base.BaseDigest != "")
}

// BuilderEgress is a build microVM's egress (Manager.builderEgress): e as "proxy" with every host no rule allows
// refused, the builder's registries allowed, and templateRegistry's host when the build pulls a Kantel base.
func BuilderEgress(e *proto.Egress, builder *TemplateBuilderConfig, templateRegistry string, pulledBase bool) *proto.Egress {
	out := proto.Egress{}
	if e != nil {
		out = *e
		out.Allow = slices.Clone(e.Allow)
		out.Deny = slices.Clone(e.Deny)
		out.Grants = slices.Clone(e.Grants)
	}
	out.Mode, out.DefaultDeny = network.EgressProxy, true
	// Public addresses only, for every connection the proxy makes for it (egressAllowCIDRs is for ordinary sandboxes).
	out.PublicOnly = true
	if builder != nil {
		out.Allow = append(out.Allow, builder.Registries...)
	}
	if pulledBase && templateRegistry != "" {
		out.Allow = append(out.Allow, registryHost(templateRegistry))
	}
	return &out
}

// registryHost is a registry reference's host: ghcr.io of ghcr.io/lleverage-ai.
func registryHost(registry string) string {
	host, _, _ := strings.Cut(registry, "/")
	if h, _, ok := strings.Cut(host, ":"); ok {
		return h
	}
	return host
}

// builderJob is one custom image to build in a build microVM.
type builderJob struct {
	// dir is the build's working directory (images/templates/<key>.builder); its vm directory holds the drives.
	dir string
	// id names the build microVM to the egress proxy and the log.
	id    string
	owner string
	image *proto.TemplateImage
	// baseRef is what a Dockerfile's KANTEL_BASE is: the Kantel base pulled from the operator's registry by digest,
	// or "" for the builder's own image (the host's), imported in the microVM.
	baseRef string
	size    proto.Size
	egress  *proto.Egress
	env     map[string]string
}

// builderOutput is what a build microVM made: its output drive (the image's root filesystem) and its image's digest.
type builderOutput struct {
	rootfs      string
	imageDigest string
}

// builderResult is the build script's KANTEL-RESULT line.
type builderResult struct {
	ImageID    string `json:"imageId"`
	RepoDigest string `json:"repoDigest"`
}

// digestOnly is a `sha256:` digest as itself, or the digest of a repository digest (`name@sha256:…`); "" for neither.
func digestOnly(s string) string {
	if _, d, ok := strings.Cut(s, "@"); ok {
		s = d
	}
	if baseImageDigest.MatchString(s) {
		return s
	}
	return ""
}

// customRootfs answers a custom image's root filesystem and its digest: made already (by an earlier build of the same
// scope on this host), or built now in a build microVM, which the egress proxy knows as build (the template snapshot's
// ID, as its setup's boot is after it: their CA and rules are the build's). The digest is an image reference's resolved
// repository digest, or a Dockerfile's built image ID.
func (m *Manager) customRootfs(ctx context.Context, build, owner string, img *proto.TemplateImage, base templateImage, size proto.Size, e *proto.Egress, env map[string]string) (string, string, string, error) {
	if err := validateTemplateImage(img); err != nil {
		return "", "", "", err
	}
	b := m.tpl.rootfs
	key := customImageKey(owner, img, base)
	defer b.locks.lock(key)()
	if path, rec, ok := customCached(b, key); ok {
		m.mapRootfsLater(key)
		return path, rec.ImageDigest, key, nil
	}
	// The pool it is made in, as the build starts.
	pool := b.currentPool()
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		return "", "", "", err
	}
	baseRef := ""
	// Only a Dockerfile builds on the template's base (KANTEL_BASE); an image reference's base is unused.
	if img.Kind == proto.TemplateImageDockerfile && base.BaseDigest != "" {
		if m.cfg.TemplateRegistry == "" {
			return "", "", "", &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't build from a published base image: its settings name no templateRegistry"}
		}
		baseRef = strings.TrimSuffix(m.cfg.TemplateRegistry, "/") + "/" + base.BaseImage + "@" + base.BaseDigest
	}
	work := filepath.Join(b.dir, key+".builder")
	_ = os.RemoveAll(work)
	defer os.RemoveAll(work)
	run := m.tpl.runBuilder
	if run == nil {
		run = m.bootBuilder
	}
	out, err := run(ctx, builderJob{
		dir: work, id: build, owner: owner, image: img, baseRef: baseRef, size: size,
		// The operator's templateRegistry is reachable only by a build that pulls a Kantel base from it.
		egress: BuilderEgress(e, m.cfg.TemplateBuilder, m.cfg.TemplateRegistry, baseRef != ""), env: env,
	})
	if err != nil {
		return "", "", "", err
	}
	builtFrom := img.Ref
	if img.Kind == proto.TemplateImageDockerfile {
		builtFrom = "dockerfile " + dockerfileDigest(img.Dockerfile)
	}
	path, err := commitCustomRootfs(b, key, out.rootfs, builtRootfs{ImageDigest: out.imageDigest, BuiltFrom: builtFrom})
	if err != nil {
		return "", "", "", err
	}
	b.stampPool(key, pool)
	// Made once the key's lock is let go, for peers to fetch it.
	m.mapRootfsLater(key)
	return path, out.imageDigest, key, nil
}

// A custom image's cache entry is images/templates/<key>.ext4 and, as its completion record, <key>.json naming the
// digest it was built as. The record is written last, so an entry with no valid record is one whose publication was
// cut short: nothing booted it (customRootfs hadn't answered), so it is thrown away and built again rather than
// served without a digest.

// customCached answers a custom image's committed root filesystem and its record; an incomplete entry is removed.
func customCached(b *rootfsBuilder, key string) (string, builtRootfs, bool) {
	var rec builtRootfs
	path := b.path(key)
	if _, err := os.Stat(path); err != nil {
		return "", rec, false
	}
	raw, err := os.ReadFile(filepath.Join(b.dir, key+".json"))
	if err == nil && json.Unmarshal(raw, &rec) == nil && digestOnly(rec.ImageDigest) != "" && rec.BuiltFrom != "" {
		return path, rec, true
	}
	// Its map first: a peer is served a file only with its map (OpenRootfs).
	_ = os.Remove(b.mapPath(key))
	_ = os.Remove(b.poolPath(key))
	_ = os.Remove(filepath.Join(b.dir, key+".json"))
	_ = os.Remove(path)
	return "", builtRootfs{}, false
}

// commitCustomRootfs publishes a built root filesystem as key's entry: the file in place and synced, then its record
// (written to a temporary file, synced and renamed), so the entry is complete or, after a failure, absent.
func commitCustomRootfs(b *rootfsBuilder, key, built string, rec builtRootfs) (string, error) {
	if digestOnly(rec.ImageDigest) == "" {
		return "", fmt.Errorf("the build microVM didn't say what it built")
	}
	raw, err := json.Marshal(rec)
	if err != nil {
		return "", err
	}
	path := b.path(key)
	record := filepath.Join(b.dir, key+".json")
	fail := func(err error) (string, error) {
		_ = os.Remove(b.mapPath(key))
		_ = os.Remove(record)
		_ = os.Remove(path)
		return "", fmt.Errorf("keeping the template's built image: %w", err)
	}
	if err := syncFile(built); err != nil {
		return fail(err)
	}
	// A map left of a fetch cut short describes other bytes: this file gets its own (mapRootfsLater).
	_ = os.Remove(b.mapPath(key))
	if err := os.Rename(built, path); err != nil {
		return fail(err)
	}
	tmp := record + ".tmp"
	if err := writeSynced(tmp, raw); err != nil {
		_ = os.Remove(tmp)
		return fail(err)
	}
	if err := os.Rename(tmp, record); err != nil {
		_ = os.Remove(tmp)
		return fail(err)
	}
	if err := syncFile(b.dir); err != nil {
		return fail(err)
	}
	return path, nil
}

// syncFile flushes a file or directory to disk.
func syncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

// writeSynced writes data to path (0600) and flushes it.
func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// builderScript runs as root in the build microVM, once Docker is up (its proxy is the guest agent's forwarder to the
// host's egress proxy, guest.LocalProxyAddr). It builds the Dockerfile with no build context (so ADD and COPY reach
// only URLs, through the proxy) or pulls the reference, exports the image's files into the output drive (/dev/vdc,
// made empty by the host), and prints what it made on its last line. A RUN step shares the microVM's network, whose
// only way out is the same proxy, and is given it, and the microVM's trust store as the BuildKit secret kantel-ca:
// the public roots and, where the build's grants intercept HTTPS, its egress CA (SetIdentity installed it), which a
// stage on any base mounts for a download (RUN --mount=type=secret,id=kantel-ca,mode=0444 curl --cacert /run/secrets/kantel-ca)
// without it ending up in a layer.
const builderScript = `set -eu
out=/mnt/kantel-out
mkdir -p "$out"
mount -t ext4 /dev/vdc "$out"
proxy=http://127.0.0.1:3128
i=0
until docker info >/dev/null 2>&1; do
	i=$((i + 1)); [ "$i" -lt 120 ] || { echo "Docker didn't start in the build microVM" >&2; exit 1; }
	sleep 1
done
case "$KANTEL_IMAGE_KIND" in
dockerfile)
	printf '%s' "$KANTEL_DOCKERFILE" | base64 -d > /tmp/kantel.Dockerfile
	base="$KANTEL_BASE_REF"
	if [ -z "$base" ]; then
		# The Kantel base is this microVM's own image (the host's): imported, not pulled, without what's live in it
		# (mounts, temporary files, the agent, Docker's own storage), then its standard directories put back empty.
		tar -C / --one-file-system --numeric-owner \
			--exclude='./proc/*' --exclude='./sys/*' --exclude='./dev/*' --exclude='./run/*' --exclude='./tmp/*' \
			--exclude=./disk --exclude='./mnt/*' --exclude=./.kantel \
			--exclude='./var/lib/docker/*' --exclude='./var/lib/containerd/*' -c . \
			| docker import - kantel-base:raw >/dev/null
		printf '%s\n' 'FROM kantel-base:raw' \
			'RUN mkdir -p /proc /sys /dev /run /tmp /mnt /var/lib/docker /var/lib/containerd && chmod 1777 /tmp' \
			| docker build --network=none -q -t kantel-base:local - >/dev/null
		base=kantel-base:local
	fi
	DOCKER_BUILDKIT=1 docker build --network=host --build-arg "KANTEL_BASE=$base" \
		--secret id=kantel-ca,src=` + systemCABundle + ` \
		--build-arg "HTTP_PROXY=$proxy" --build-arg "HTTPS_PROXY=$proxy" \
		--build-arg "http_proxy=$proxy" --build-arg "https_proxy=$proxy" \
		-t kantel-template:build - < /tmp/kantel.Dockerfile
	tag=kantel-template:build
	;;
image)
	docker pull "$KANTEL_IMAGE_REF"
	tag="$KANTEL_IMAGE_REF"
	;;
*)
	echo "unknown image kind" >&2; exit 2
	;;
esac
id=$(docker image inspect -f '{{.Id}}' "$tag")
repo=$(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$tag")
c=$(docker create "$tag" /bin/true)
docker export "$c" | tar -x -C "$out" --numeric-owner
docker rm -f "$c" >/dev/null
rm -f "$out/.dockerenv"
for d in proc sys dev run tmp; do mkdir -p "$out/$d"; done
chmod 1777 "$out/tmp"
sync
umount "$out"
printf '` + builderResultPrefix + `{"imageId":"%s","repoDigest":"%s"}\n' "$id" "$repo"
`

// builderEnv is the build script's environment.
func builderEnv(job builderJob) map[string]string {
	env := map[string]string{}
	for k, v := range job.env {
		env[k] = v
	}
	env["KANTEL_IMAGE_KIND"] = job.image.Kind
	env["KANTEL_DOCKERFILE"] = base64.StdEncoding.EncodeToString([]byte(job.image.Dockerfile))
	env["KANTEL_IMAGE_REF"] = job.image.Ref
	env["KANTEL_BASE_REF"] = job.baseRef
	return env
}

// parseBuilderResult is the build's digest from its output's last KANTEL-RESULT line: an image reference's repository
// digest, else (a Dockerfile's, or a reference with none) its image ID. The microVM's word, checked to be a digest.
func parseBuilderResult(image *proto.TemplateImage, stdout string) (string, error) {
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		raw, ok := strings.CutPrefix(line, builderResultPrefix)
		if !ok {
			continue
		}
		var res builderResult
		if err := json.Unmarshal([]byte(raw), &res); err != nil {
			break
		}
		if image.Kind == proto.TemplateImageRef {
			if d := digestOnly(res.RepoDigest); d != "" {
				return d, nil
			}
		}
		if d := digestOnly(res.ImageID); d != "" {
			return d, nil
		}
		break
	}
	return "", fmt.Errorf("the build microVM didn't say what it built")
}

// bootBuilder boots a build microVM of the host's own image as job's machine, with an empty disk for Docker and an
// empty output drive, on a link whose only way out is the egress proxy under job.egress; runs builderScript in it;
// and answers the output drive once the microVM has gone. Nothing of the build runs on the host.
func (m *Manager) bootBuilder(ctx context.Context, job builderJob) (builderOutput, error) {
	vm := filepath.Join(job.dir, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return builderOutput{}, err
	}
	unhold := m.holdBases()
	rootfs := m.pinRootfs(m.cfg.Rootfs)
	err := m.linkRootfs(vm, rootfs)
	unhold()
	if err != nil {
		return builderOutput{}, err
	}
	kernel := m.kernelFor(rootfs)
	if err := newDisk(filepath.Join(vm, fc.DiskFile), job.size.DiskGiB); err != nil {
		return builderOutput{}, err
	}
	output := filepath.Join(vm, builderOutputDrive)
	if err := newDisk(output, job.size.DiskGiB); err != nil {
		return builderOutput{}, err
	}
	link, err := m.cfg.Network.Add(network.EgressProxy)
	if err != nil {
		return builderOutput{}, err
	}
	defer m.cfg.Network.Remove(link)
	// So a host that restarts while it builds can free its link (reapInterruptedBuilds).
	if err := os.WriteFile(filepath.Join(job.dir, buildSlotFile), []byte(strconv.Itoa(link.Slot)), 0o600); err != nil {
		return builderOutput{}, err
	}
	bld := &sandbox{meta: meta{ID: job.id, Egress: job.egress, Owner: job.owner}, link: &link}
	m.attach(bld, link.Slot)
	defer m.detach(link.Slot)
	machine, err := fc.Launch(ctx, m.cfg.Firecracker, vm)
	if err != nil {
		return builderOutput{}, err
	}
	defer func() {
		machine.Kill()
		<-machine.Done()
	}()
	// Never snapshotted or resized: its machine's own memory, none hotpluggable.
	// No bundle drives: its only extra drive is its writable output.
	cfg := m.bootConfig(shape{Size: job.size}, kernel, link.Tap, link.MAC, m.cid(), 0, 0)
	cfg.Drives = []fc.Drive{{ID: "out", Path: builderOutputDrive}}
	if err := machine.Boot(ctx, cfg); err != nil {
		return builderOutput{}, err
	}
	client := guest.NewClient(filepath.Join(vm, fc.VsockSocket))
	defer client.Close()
	bootCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if _, err := client.WaitReady(bootCtx); err != nil {
		return builderOutput{}, fmt.Errorf("build microVM: %w (firecracker log: %s)", err, tail(filepath.Join(vm, fc.LogFile)))
	}
	if err := client.SetIdentity(ctx, m.identity(bld, true)); err != nil {
		return builderOutput{}, fmt.Errorf("build microVM identity: %w", err)
	}
	if _, err := client.WaitExpected(bootCtx, "docker"); err != nil {
		m.log.Warn("build microVM's Docker not reported ready; building anyway", "build", job.id, "error", err)
	}
	res, err := client.Exec(ctx, guest.ExecRequest{Command: builderScript, User: "root", Env: builderEnv(job), TimeoutMs: builderTimeout.Milliseconds(), MaxOutputBytes: 4 << 20})
	if err != nil {
		return builderOutput{}, fmt.Errorf("the template's image build: %w", err)
	}
	if res.ExitCode != 0 || res.TimedOut {
		why := fmt.Sprintf("exited with %d", res.ExitCode)
		if res.TimedOut {
			why = fmt.Sprintf("took longer than %s", builderTimeout)
		}
		return builderOutput{}, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("the template's image build %s: %s", why, tailText(res.Stdout+"\n"+res.Stderr, 2000))}
	}
	digest, err := parseBuilderResult(job.image, res.Stdout)
	if err != nil {
		return builderOutput{}, err
	}
	_ = client.Sync(ctx)
	client.Close()
	machine.Kill()
	<-machine.Done()
	kept := filepath.Join(job.dir, builderOutputDrive)
	if err := os.Rename(output, kept); err != nil {
		return builderOutput{}, err
	}
	return builderOutput{rootfs: kept, imageDigest: digest}, nil
}

// reapInterruptedBuilders ends the build microVMs a previous run of the host left running: each one's Firecracker
// killed, its link removed and its directory with them.
func (m *Manager) reapInterruptedBuilders(adopted map[int]bool) {
	works, _ := filepath.Glob(filepath.Join(m.cfg.Root, "images", "templates", "*.builder"))
	for _, dir := range works {
		fc.KillLeftover(filepath.Join(dir, "vm"))
		raw, err := os.ReadFile(filepath.Join(dir, buildSlotFile))
		slot, convErr := strconv.Atoi(strings.TrimSpace(string(raw)))
		if err == nil && convErr == nil {
			m.removeLeftoverLink(slot, adopted)
		}
		_ = os.RemoveAll(dir)
	}
}
