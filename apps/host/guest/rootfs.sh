#!/bin/sh
# Builds a sandbox root filesystem image (ext4) from guest/Dockerfile (the microVM tier) or
# guest/isolate.Dockerfile (the isolate tier's VM), with the guest agent built from this module.
#
#   apps/host/guest/rootfs.sh <out-dir> [sandbox|isolate] [amd64|arm64]
#
# Needs Docker and Go, and for the isolate image what guest/isolate-runtime.sh needs. Writes
# <out-dir>/<kind>-<arch>.ext4. The image is read-only to every sandbox, so it's sized to its contents plus a little
# room.
#
# KANTEL_GUEST_DOCKERFILE=<path> builds a custom image instead: a Dockerfile that starts `FROM kantel-guest-sandbox:<arch>`
# (the default image, which this script tags) and adds to it. Build the default image first. See README.md.
#
# KANTEL_SECURITY_REFRESH=<yyyymmdd> re-runs the images' security-upgrade layer (the daily build in
# .github/workflows/sandbox-image.yml passes today's date), and KANTEL_NO_CACHE=1 builds without Docker's cache, so no
# stale apt layer survives.
set -eu

OUT=${1:?usage: rootfs.sh <out-dir> [sandbox|isolate] [amd64|arm64]}
KIND=${2:-sandbox}
ARCH=${3:-amd64}
HERE=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$HERE/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
case "$KIND" in
sandbox) DOCKERFILE=${KANTEL_GUEST_DOCKERFILE:-$HERE/Dockerfile} ;;
isolate) DOCKERFILE="$HERE/isolate.Dockerfile" ;;
*) echo "unknown kind $KIND" >&2; exit 2 ;;
esac

VERSION=${KANTEL_HOST_VERSION:-dev}
mkdir -p "$MODULE/dist"
(cd "$MODULE" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath \
	-ldflags "-s -w -X main.version=$VERSION" -o "dist/kantel-guest-$ARCH" ./cmd/kantel-guest)

if [ "$KIND" = isolate ]; then
	# The isolate runtime and its assets (guest/isolate-runtime.sh says how, and how to stand in for either).
	"$HERE/isolate-runtime.sh" "$ARCH"
fi

TAG="kantel-guest-$KIND:$ARCH"
if [ -n "${KANTEL_GUEST_DOCKERFILE:-}" ]; then TAG="kantel-guest-custom:$ARCH"; IMAGE_NAME=custom; fi
NO_CACHE=
if [ "${KANTEL_NO_CACHE:-}" = 1 ]; then NO_CACHE=--no-cache; fi
# shellcheck disable=SC2086 # NO_CACHE is one option or none.
docker build $NO_CACHE --platform "linux/$ARCH" \
	--build-arg KANTEL_SECURITY_REFRESH="${KANTEL_SECURITY_REFRESH:-unset}" -f "$DOCKERFILE" -t "$TAG" "$MODULE"
CID=$(docker create --platform "linux/$ARCH" "$TAG" /bin/true)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
IMAGE="${IMAGE_NAME:-$KIND}-$ARCH.ext4"
# Export the container's filesystem and make an ext4 image of it, as root in a helper container so ownership and
# modes are kept. Docker leaves /etc/hosts, /etc/resolv.conf and /etc/hostname as empty files; the guest agent
# writes them.
docker export "$CID" | docker run --rm -i -v "$OUT:/out" debian:trixie sh -euc '
	apt-get update -qq && apt-get install -y -qq --no-install-recommends e2fsprogs >/dev/null
	mkdir /rootfs && tar -x -C /rootfs --numeric-owner
	rm -f /rootfs/.dockerenv
	size_mb=$(du -sm /rootfs | cut -f1)
	size_mb=$((size_mb + size_mb / 5 + 256))
	rm -f "/out/'"$IMAGE"'"
	mkfs.ext4 -q -L kantel-root -O ^has_journal -d /rootfs "/out/'"$IMAGE"'" "${size_mb}M"
'
echo "$OUT/$IMAGE"
