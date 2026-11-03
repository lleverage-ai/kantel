#!/bin/sh
# Builds Kantel's host images and, with --publish, publishes them as a GitHub Release on lleverage-ai/kantel, where
# the gateway's default KANTEL_COMPUTE_IMAGES (DEFAULT_HOST_IMAGES in apps/selfhosted/src/gateway/compute.ts) points.
#
#   apps/host/guest/release.sh <out-dir> <tag> [--publish]
#
# <tag> is host-images-<yyyymmdd>[.<n>]. Writes to <out-dir>: vmlinux-<arch> and its .config, sandbox-<arch>.ext4.gz,
# isolate-<arch>.ext4.gz, manifest.json (kantel-host manifest: each file's SHA-256, which install checks as it
# downloads) and THIRD-PARTY-NOTICES.md. ARCHES (default amd64) picks the architectures. --publish makes the release
# (gh, with push access to the repo) at the current commit, which must be on origin; a release is never replaced:
# a new image is a new tag, and DEFAULT_HOST_IMAGES moves to it in a pull request.
#
# Needs Docker, Go, bun and gzip. About 15 minutes on 48 cores from cold; the images are about 1 GB gzipped. Each
# asset has to stay under GitHub's 2 GiB limit per release asset; the script checks.
set -eu

OUT=${1:?usage: release.sh <out-dir> <tag> [--publish]}
TAG=${2:?usage: release.sh <out-dir> <tag> [--publish]}
PUBLISH=${3:-}
case "$TAG" in host-images-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) ;; *) echo "tag: host-images-<yyyymmdd>[.<n>]" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$HERE/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

for arch in ${ARCHES:-amd64}; do
	case "$arch" in amd64) karch=x86_64 ;; arm64) karch=aarch64 ;; *) echo "unknown arch $arch" >&2; exit 2 ;; esac
	"$HERE/kernel/build.sh" "$OUT" "$karch"
	for kind in sandbox isolate; do
		KANTEL_HOST_VERSION=$TAG "$HERE/rootfs.sh" "$OUT" "$kind" "$arch"
		if command -v pigz >/dev/null; then pigz -n -f -6 "$OUT/$kind-$arch.ext4"; else gzip -n -f -6 "$OUT/$kind-$arch.ext4"; fi
	done
done
cp "$HERE/rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md" "$OUT/"
(cd "$MODULE" && go run -ldflags "-X main.version=$TAG" ./cmd/kantel-host manifest "$OUT")

limit=$((2 * 1024 * 1024 * 1024))
for f in "$OUT"/*; do
	size=$(wc -c <"$f")
	[ "$size" -lt "$limit" ] || { echo "$f is $size bytes, over GitHub's 2 GiB asset limit" >&2; exit 1; }
done

[ "$PUBLISH" = --publish ] || { echo "built in $OUT; publish with: $0 $OUT $TAG --publish"; exit 0; }
commit=$(git -C "$MODULE" rev-parse HEAD)
git -C "$MODULE" branch -r --contains "$commit" | grep -q . || { echo "commit $commit isn't on origin" >&2; exit 1; }
notes="Kantel's host images, built by apps/host/guest/release.sh at $commit. \`kantel-host install\` fetches them through
the gateway's /v1/hosts/images (KANTEL_COMPUTE_IMAGES, which defaults here) and checks each against manifest.json.
What they contain and under which licences: THIRD-PARTY-NOTICES.md."
gh release create "$TAG" --repo lleverage-ai/kantel --target "$commit" --title "Host images $TAG" --notes "$notes" \
	--latest=false "$OUT"/manifest.json "$OUT"/THIRD-PARTY-NOTICES.md "$OUT"/vmlinux-* "$OUT"/*.ext4.gz
echo "https://github.com/lleverage-ai/kantel/releases/download/$TAG"
