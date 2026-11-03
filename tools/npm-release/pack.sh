#!/usr/bin/env bash
# pack.sh <version> [out]: builds and packs every npm package Kantel publishes, all at <version>, into out (default
# dist/npm-release), and writes out/publish-order.txt, the tarballs in the order they must be published:
#   - the kantel-host binaries, one package per platform (apps/host/npm/platform);
#   - the kantel-host launcher, which depends on them as optional dependencies (apps/host/npm/host);
#   - the operator CLI, kantel-admin (packages/admin), which runs the launcher with npx;
#   - the user CLI, kantel (packages/cli).
# The package names come from the manifests, so this script doesn't name them. It never publishes: publish.sh does,
# and .github/workflows/release.yml runs both. It needs Node 22.14+, pnpm with the workspace installed (at least
# `pnpm install --filter "@kantel/admin..."`), and Go (apps/host/go.mod's version).
set -euo pipefail

version=${1:?usage: pack.sh <version> [out]}
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${2:-$root/dist/npm-release}

# npm's semver, without build metadata: 1.2.3 or 1.2.3-rc.1.
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
mkdir -p "$out"
order=()

# kantel-host: the platform packages first, then the launcher (npm-pack.sh builds both into apps/host/dist/npm).
rm -rf "$root/apps/host/dist/npm"
"$root/apps/host/scripts/npm-pack.sh" "$version" >/dev/null
for tarball in "$root"/apps/host/dist/npm/*-linux-*.tgz "$root"/apps/host/dist/npm/*-host-"$version".tgz; do
	[[ -f "$tarball" ]] || { echo "pack.sh: npm-pack.sh didn't write $tarball" >&2; exit 1; }
	mv "$tarball" "$out/"
	order+=("$(basename "$tarball")")
done

# The CLIs: admin before kantel, so a host join's packages are all out before the CLI that points at them.
for pkg in admin cli; do
	dir="$root/packages/$pkg"
	cp "$dir/package.json" "$work/$pkg.package.json"
	(cd "$dir" && npm pkg set "version=$version" && node scripts/build.ts >/dev/null)
	tarball=$(cd "$dir/dist" && npm pack --silent --pack-destination "$out")
	order+=("$tarball")
done

printf '%s\n' "${order[@]}" >"$out/publish-order.txt"
(cd "$out" && ls -l -- *.tgz && cat publish-order.txt)
