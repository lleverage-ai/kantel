#!/bin/sh
# Builds a sandbox root filesystem image (ext4) from guest/Dockerfile (the microVM tier) or
# guest/isolate.Dockerfile (the isolate tier's VM), with the guest agent built from this module.
#
#   apps/host/guest/rootfs.sh <out-dir> [sandbox|isolate] [amd64|arm64]
#
# Needs Docker and Go. Writes <out-dir>/<kind>-<arch>.ext4. The image is read-only to every sandbox, so it's sized
# to its contents plus a little room.
set -eu

OUT=${1:?usage: rootfs.sh <out-dir> [sandbox|isolate] [amd64|arm64]}
KIND=${2:-sandbox}
ARCH=${3:-amd64}
HERE=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$HERE/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
case "$KIND" in
sandbox) DOCKERFILE="$HERE/Dockerfile" ;;
isolate) DOCKERFILE="$HERE/isolate.Dockerfile" ;;
*) echo "unknown kind $KIND" >&2; exit 2 ;;
esac

VERSION=${KANTEL_HOST_VERSION:-dev}
mkdir -p "$MODULE/dist"
(cd "$MODULE" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath \
	-ldflags "-s -w -X main.version=$VERSION" -o "dist/kantel-guest-$ARCH" ./cmd/kantel-guest)

if [ "$KIND" = isolate ]; then
	# The isolate worker, and workerd's own binary from npm (the same version the worker is built against).
	(cd "$MODULE/isolate" && bun install --frozen-lockfile && bun run build.ts)
	case "$ARCH" in amd64) WORKERD_PKG=workerd-linux-64 ;; arm64) WORKERD_PKG=workerd-linux-arm64 ;; esac
	WORKERD_VERSION=$(node -p 'require(process.argv[1]).version' "$MODULE/isolate/node_modules/workerd/package.json")
	curl -fsSL "https://registry.npmjs.org/@cloudflare/$WORKERD_PKG/-/$WORKERD_PKG-$WORKERD_VERSION.tgz" |
		tar -xzO package/bin/workerd >"$MODULE/dist/workerd-$ARCH"
	chmod 0755 "$MODULE/dist/workerd-$ARCH"
fi

TAG="kantel-guest-$KIND:$ARCH"
docker build --platform "linux/$ARCH" -f "$DOCKERFILE" -t "$TAG" "$MODULE"
CID=$(docker create --platform "linux/$ARCH" "$TAG" /bin/true)
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
IMAGE="$KIND-$ARCH.ext4"
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
