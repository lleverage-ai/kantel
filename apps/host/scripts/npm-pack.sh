#!/bin/sh
# npm-pack.sh <version>: builds kantel-host for linux/amd64 and linux/arm64 (static, CGO off) and packs the npm
# packages into apps/host/dist/npm: @kantel/host (the launcher) and @kantel/host-linux-{x64,arm64} (the binaries).
# It never publishes; publishing is `npm publish dist/npm/<tarball> --access public` for each, platforms first.
set -eu
version=${1:?usage: npm-pack.sh <version>}
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/dist/npm"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

for pair in x64:amd64 arm64:arm64; do
	npm_arch=${pair%%:*}
	go_arch=${pair##*:}
	dir="$work/linux-$npm_arch"
	mkdir -p "$dir/bin"
	(cd "$here" && CGO_ENABLED=0 GOOS=linux GOARCH="$go_arch" go build -trimpath \
		-ldflags "-s -w -X main.version=$version" -o "$dir/bin/kantel-host" ./cmd/kantel-host)
	sed -e "s/ARCH/$npm_arch/g" -e "s/\"version\": \"0.0.0\"/\"version\": \"$version\"/" \
		"$here/npm/platform/package.json" > "$dir/package.json"
	(cd "$dir" && npm pack --silent --pack-destination "$out" > /dev/null)
done

mkdir -p "$work/host"
cp -R "$here/npm/host/." "$work/host/"
sed -i -e "s/\"0.0.0\"/\"$version\"/g" "$work/host/package.json"
(cd "$work/host" && npm pack --silent --pack-destination "$out" > /dev/null)
ls -l "$out"
