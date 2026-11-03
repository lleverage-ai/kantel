#!/usr/bin/env bash
# smoke.sh <version> [out]: checks the tarballs pack.sh wrote before anything is published. Each one is unpacked into
# a node_modules of its own, laid out as npm installs them, and its command must print <version>:
#   - the kantel-host launcher, finding this machine's platform package (as `npx <host package>` would);
#   - kantel-admin and kantel.
# Runs on Linux x64 or arm64, such as the release workflow's runner.
set -euo pipefail

version=${1:?usage: smoke.sh <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/npm-release}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# unpack TARBALL: into $work/node_modules/<its name>; prints the name.
unpack() {
	local manifest name
	manifest=$(tar -xOzf "$out/$1" package/package.json)
	name=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$manifest")
	mkdir -p "$work/node_modules/$name"
	tar -xzf "$out/$1" -C "$work/node_modules/$name" --strip-components 1
	printf '%s' "$name"
}

# expect WHAT COMMAND...: COMMAND must print exactly $version.
expect() {
	local what=$1 got
	shift
	got=$("$@") || { echo "smoke: $what failed" >&2; exit 1; }
	[[ "$got" == "$version" ]] || { echo "smoke: $what printed '$got', not '$version'" >&2; exit 1; }
	echo "ok      $what $got"
}

arch=$(node -p process.arch)
host="" admin="" cli=""
while read -r tarball; do
	[[ -n "$tarball" ]] || continue
	name=$(unpack "$tarball")
	case "$name" in
		*-linux-*) ;;
		*host) host=$name ;;
		*admin) admin=$name ;;
		*) cli=$name ;;
	esac
done <"$out/publish-order.txt"
[[ -n "$host" && -n "$admin" && -n "$cli" ]] || { echo "smoke: publish-order.txt is missing a package" >&2; exit 1; }

expect "$host (launcher, linux-$arch)" node "$work/node_modules/$host/bin/kantel-host.js" version
expect "$admin" node "$work/node_modules/$admin/kantel-admin.js" version
expect "$cli" node "$work/node_modules/$cli/kantel.js" --version
