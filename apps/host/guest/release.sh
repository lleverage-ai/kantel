#!/bin/sh
# Builds Kantel's host images and, with --publish, publishes them as a GitHub Release on lleverage-ai/kantel, where
# the gateway's default KANTEL_COMPUTE_IMAGES (DEFAULT_HOST_IMAGES in apps/selfhosted/src/gateway/compute.ts) points.
#
#   apps/host/guest/release.sh <out-dir> <tag> [--publish]
#
# <tag> is host-images-<yyyymmdd>[.<n>]. Writes to <out-dir>: vmlinux-<arch> and its .config, sandbox-<arch>.ext4.gz,
# isolate-<arch>.ext4.gz, manifest.json (kantel-host manifest: each file's SHA-256, which install checks as it
# downloads), THIRD-PARTY-NOTICES.md, the exact source of the GPL and LGPL libraries the sandbox image bundles
# outside a distro package (Selkies' libx264, x265 and libde265: gpl-sources.sh, read off each built sandbox image),
# as source-*.tar.gz with SOURCES.md and SOURCES.sha256, and SHA256SUMS over every asset (sha256sum -c format).
#
# ARCHES (default "amd64 arm64") picks the architectures. arm64 is cross-built on an x86_64 machine: its kernel with
# a cross compiler, its images under QEMU user emulation, which Docker needs registered first
# (docker run --privileged --rm tonistiigi/binfmt --install arm64); that makes the build about an hour longer.
# boot-check-arm64.sh boots the arm64 images in QEMU before they're published.
#
# --publish makes the release (gh, with push access to the repo) at the current commit, which must be on origin; a
# release is never replaced: a new image is a new tag, and DEFAULT_HOST_IMAGES moves to it in a pull request. When
# <out-dir> already holds a build of the same tag and ARCHES from a clean apps/host at the same tree as this commit's
# (its BUILD file says so), --publish publishes that build instead of building again: build, check, merge, publish.
#
# Needs Docker, Go, bun, gzip, git, curl, jq and debugfs (e2fsprogs). About 15 minutes for amd64 on 48 cores from
# cold; each architecture's images are about 1 GB gzipped. Each asset has to stay under GitHub's 2 GiB limit per
# release asset; the script checks.
set -eu

OUT=${1:?usage: release.sh <out-dir> <tag> [--publish]}
TAG=${2:?usage: release.sh <out-dir> <tag> [--publish]}
PUBLISH=${3:-}
ARCHES=${ARCHES:-amd64 arm64}
case "$TAG" in host-images-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) ;; *) echo "tag: host-images-<yyyymmdd>[.<n>]" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$HERE/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# What this build is of: the tag, the architectures and apps/host's git tree, or "dirty" when apps/host has changes
# that aren't committed (a build of those is never published without building again).
tree=$(git -C "$MODULE" rev-parse HEAD:apps/host)
[ -z "$(git -C "$MODULE" status --porcelain -- .)" ] || tree=dirty
build="tag=$TAG
arches=$ARCHES
tree=$tree"

if [ "$PUBLISH" = --publish ] && [ "$tree" != dirty ] && [ -f "$OUT/BUILD" ] && [ "$(cat "$OUT/BUILD")" = "$build" ]; then
	echo "publishing the build already in $OUT (apps/host tree $tree)"
else
	rm -f "$OUT/BUILD" "$OUT/SHA256SUMS"
	for arch in $ARCHES; do
		case "$arch" in amd64) karch=x86_64 ;; arm64) karch=aarch64 ;; *) echo "unknown arch $arch" >&2; exit 2 ;; esac
		"$HERE/kernel/build.sh" "$OUT" "$karch"
		for kind in sandbox isolate; do
			KANTEL_HOST_VERSION=$TAG "$HERE/rootfs.sh" "$OUT" "$kind" "$arch"
		done
	done
	# The GPL sources come from the images as built, so they're read before the images are gzipped.
	set --
	for arch in $ARCHES; do set -- "$@" "$OUT/sandbox-$arch.ext4"; done
	"$HERE/gpl-sources.sh" "$OUT" "$@"
	for arch in $ARCHES; do
		for kind in sandbox isolate; do
			if command -v pigz >/dev/null; then pigz -n -f -6 "$OUT/$kind-$arch.ext4"; else gzip -n -f -6 "$OUT/$kind-$arch.ext4"; fi
		done
	done
	cp "$HERE/rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md" "$OUT/"
	(cd "$MODULE" && go run -ldflags "-X main.version=$TAG" ./cmd/kantel-host manifest "$OUT")
	printf '%s\n' "$build" >"$OUT/BUILD"
fi

# The assets, for this build's architectures only (a directory reused across builds may hold others).
set -- manifest.json THIRD-PARTY-NOTICES.md SOURCES.md SOURCES.sha256
for arch in $ARCHES; do
	case "$arch" in amd64) karch=x86_64 ;; arm64) karch=aarch64 ;; esac
	set -- "$@" "vmlinux-$karch" "vmlinux-$karch.config" "sandbox-$arch.ext4.gz" "isolate-$arch.ext4.gz"
done
for f in "$OUT"/source-*.tar.gz; do set -- "$@" "$(basename "$f")"; done
limit=$((2 * 1024 * 1024 * 1024))
for f in "$@"; do
	[ -f "$OUT/$f" ] || { echo "$OUT/$f is missing" >&2; exit 1; }
	size=$(wc -c <"$OUT/$f")
	[ "$size" -lt "$limit" ] || { echo "$OUT/$f is $size bytes, over GitHub's 2 GiB asset limit" >&2; exit 1; }
done
(cd "$OUT" && sha256sum "$@" >SHA256SUMS)
set -- "$@" SHA256SUMS

[ "$PUBLISH" = --publish ] || { echo "built in $OUT; publish with: $0 $OUT $TAG --publish"; exit 0; }
commit=$(git -C "$MODULE" rev-parse HEAD)
git -C "$MODULE" branch -r --contains "$commit" | grep -q . || { echo "commit $commit isn't on origin" >&2; exit 1; }
arm64_note=
case " $ARCHES " in *" arm64 "*) arm64_note="

The arm64 (aarch64) images are cross-built on x86_64 and boot-checked in QEMU's aarch64 emulation
(apps/host/guest/boot-check-arm64.sh): the kernel, kantel-init, systemd, Docker, the desktop, Chromium's CDP and
Selkies come up. They have not been verified on arm64 hardware, and an arm64 sandbox has no /dev/kvm: Firecracker
doesn't offer nested virtualisation on arm64." ;;
esac
notes="Kantel's host images ($ARCHES), built by apps/host/guest/release.sh at $commit. \`kantel-host install\` fetches
them through the gateway's /v1/hosts/images (KANTEL_COMPUTE_IMAGES, which defaults here), picks its own architecture's
files and checks each against manifest.json. SHA256SUMS lists every asset (\`sha256sum -c SHA256SUMS\`).
What they contain and under which licences: THIRD-PARTY-NOTICES.md. The exact source of the GPL and LGPL libraries the
sandbox image bundles outside a distro package (libx264, x265 and libde265, in Selkies' pixelflux) is attached here:
SOURCES.md lists it, and \`sha256sum -c SOURCES.sha256\` checks it.$arm64_note"
(cd "$OUT" && gh release create "$TAG" --repo lleverage-ai/kantel --target "$commit" --title "Host images $TAG" \
	--notes "$notes" --latest=false "$@")
echo "https://github.com/lleverage-ai/kantel/releases/download/$TAG"
