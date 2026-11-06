#!/usr/bin/env bash
# pack.sh <version> [out]: builds everything a Kantel release ships, all at <version>, into out (default dist/release):
#   out/npm/     the user CLI's npm tarball, `kantel` (packages/cli), the only thing Kantel puts on npm (once the
#                release workflow's publish_npm is on);
#   out/github/  the GitHub Release's files:
#                  kantel-host-linux-amd64, kantel-host-linux-arm64  the host agent (apps/host), static Go binaries
#                  kantel.js                                        the user CLI (packages/cli), for Node 22+
#                  kantel-admin.js                                  the operator CLI (packages/admin), for Node 22+
#                  install.sh                                       the host installer (apps/host/install.sh)
#                  install-cli.sh                                   the CLIs' installer (packages/cli/install-cli.sh)
#                  SHA256SUMS                                       sha256sum's lines for the six files above
# It never publishes: publish.sh puts out/npm on npm and github-release.sh makes the release, and
# .github/workflows/release.yml runs all three. It needs Node 22.14+, pnpm with the workspace installed (at least
# `pnpm install --filter "@kantel/admin..." --filter "@kantel/cli..."`), Go (apps/host/go.mod's version), GNU tar
# and sha256sum.
set -euo pipefail

version=${1:?usage: pack.sh <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/release}

# npm's semver, without build metadata: 1.2.3 or 1.2.3-rc.1. The release's tag is v<version>.
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
	echo "pack.sh: '$version' isn't a version such as 0.1.0 or 0.2.0-rc.1" >&2
	exit 1
fi

work=$(mktemp -d)
# The CLIs bundle their version from their package.json, so the build stamps it there and puts the files back after.
restore() {
	for pkg in cli admin; do
		[[ -f "$work/$pkg.package.json" ]] && cp "$work/$pkg.package.json" "$root/packages/$pkg/package.json"
	done
	rm -rf "$work"
}
trap restore EXIT

rm -rf "$out"
mkdir -p "$out/npm" "$out/github"
github="$out/github"

# stamp PKG: sets packages/PKG's version to $version (restored on exit) and builds it.
stamp() {
	local dir="$root/packages/$1"
	cp "$dir/package.json" "$work/$1.package.json"
	(cd "$dir" && npm pkg set "version=$version" && node scripts/build.ts >/dev/null)
}

# kantel-host, for Linux on x86_64 and arm64: static (CGO off), so one binary runs on any distribution.
for arch in amd64 arm64; do
	(cd "$root/apps/host" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath \
		-ldflags "-s -w -X main.version=$version" -o "$github/kantel-host-linux-$arch" ./cmd/kantel-host)
done

# kantel-admin and kantel: one bundled file each. kantel's dist/ is also the npm package.
stamp admin
cp "$root/packages/admin/dist/kantel-admin.js" "$github/kantel-admin.js"
stamp cli
cp "$root/packages/cli/dist/kantel.js" "$github/kantel.js"
chmod 0755 "$github/kantel-admin.js" "$github/kantel.js"

# The installers, pinned to this release: `curl …/releases/download/v<version>/install.sh` installs this version.
# The copy at releases/latest/download is whichever release is marked latest, so it installs that one.
# script SOURCE NAME: copies SOURCE to $github/NAME with this release's version stamped in.
script() {
	sed "s/^KANTEL_RELEASE_VERSION=\"__KANTEL_VERSION__\"$/KANTEL_RELEASE_VERSION=\"$version\"/" "$1" >"$github/$2"
	grep -q "^KANTEL_RELEASE_VERSION=\"$version\"$" "$github/$2" || {
		echo "pack.sh: couldn't stamp the version into $2" >&2
		exit 1
	}
	chmod 0755 "$github/$2"
}
script "$root/apps/host/install.sh" install.sh
script "$root/packages/cli/install-cli.sh" install-cli.sh

(cd "$github" && sha256sum kantel-host-linux-amd64 kantel-host-linux-arm64 kantel.js kantel-admin.js \
	install.sh install-cli.sh >SHA256SUMS)

# kantel, the npm package.
(cd "$root/packages/cli/dist" && npm pack --silent --pack-destination "$out/npm" >/dev/null)

(cd "$out" && ls -l npm github && cat github/SHA256SUMS)
