#!/usr/bin/env bash
# pack.sh <version> [out]: builds everything a Kantel release ships, all at <version>, into out/github (out defaults
# to dist/release), the GitHub Release's files:
#   kantel-host-linux-amd64, kantel-host-linux-arm64   the host agent (apps/host)
#   kantel-<os>-<arch>                                 the user CLI and MCP server (apps/cli/cmd/kantel)
#   kantel-admin-<os>-<arch>                           the operator CLI (apps/cli/cmd/kantel-admin)
#   install.sh                                         the host installer (apps/host/install.sh)
#   install-cli.sh                                     the CLIs' installer (apps/cli/install-cli.sh)
#   SHA256SUMS                                         sha256sum's line for each file above
# Every binary is a static Go one (CGO off, -trimpath, stripped), with nothing to install first: kantel and
# kantel-admin for linux and darwin on amd64 and arm64, kantel-host for linux. Each has <version> stamped in.
#
# It never publishes: github-release.sh makes the release, and .github/workflows/release.yml runs both. It needs Go
# (apps/cli/go.mod's version or later) and sha256sum, and leaves the repository as it found it.
#
# npm: the user CLI was an npm package (out/npm, for publish.sh) while it was Node.js. Now that it is a Go binary,
# pack.sh builds no npm package, and npm publishing, on hold already, is off (publish.sh is left as it was).
set -euo pipefail

version=${1:?usage: pack.sh <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/release}

# npm's semver, without build metadata: 1.2.3 or 1.2.3-rc.1. The release's tag is v<version>.
if ! [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
	echo "pack.sh: '$version' isn't a version such as 0.1.0 or 0.2.0-rc.1" >&2
	exit 1
fi

# The platforms kantel and kantel-admin are built for. Windows isn't one.
platforms=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64)

rm -rf "$out"
mkdir -p "$out/github"
github="$out/github"

# kantel-host, for Linux on x86_64 and arm64: static (CGO off), so one binary runs on any distribution.
for arch in amd64 arm64; do
	(cd "$root/apps/host" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath \
		-ldflags "-s -w -X main.version=$version" -o "$github/kantel-host-linux-$arch" ./cmd/kantel-host)
done

# kantel and kantel-admin, for each platform. The version goes in each program's version variable:
# internal/kantel.Version for kantel, internal/admin.Version for kantel-admin (the linker ignores a -X for a variable
# a binary doesn't have, so both get the same flags; smoke.sh checks each prints the version).
module=github.com/lleverage-ai/kantel/apps/cli
ldflags="-s -w -X $module/internal/kantel.Version=$version -X $module/internal/admin.Version=$version"
for command in kantel kantel-admin; do
	if [[ ! -d "$root/apps/cli/cmd/$command" ]]; then
		echo "pack.sh: note: apps/cli/cmd/$command isn't there yet, so this release has no $command" >&2
		continue
	fi
	for target in "${platforms[@]}"; do
		os=${target%/*} arch=${target#*/}
		(cd "$root/apps/cli" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$ldflags" \
			-o "$github/$command-$os-$arch" "./cmd/$command")
	done
done

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
script "$root/apps/cli/install-cli.sh" install-cli.sh

sums=$(cd "$github" && find . -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort | xargs sha256sum)
printf '%s\n' "$sums" >"$github/SHA256SUMS"

(cd "$github" && ls -l && cat SHA256SUMS)
