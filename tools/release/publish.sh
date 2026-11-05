#!/usr/bin/env bash
# publish.sh [--dry-run] [out]: publishes the npm tarball pack.sh wrote to out/npm (default dist/release/npm): the
# user CLI, `kantel`, the only package Kantel puts on npm. A version already on npm is skipped, so a release that
# stopped part way can be run again. A prerelease (1.2.3-rc.1) goes out under the `next` dist-tag, anything else as
# `latest`.
#
# In .github/workflows/release.yml this authenticates with npm trusted publishing (OIDC): no token, and npm adds
# provenance itself. --dry-run runs `npm publish --dry-run` instead, which needs no npm login.
set -euo pipefail

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
	dry_run=1
	shift
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${1:-$root/dist/release}

shopt -s nullglob
tarballs=("$out"/npm/*.tgz)
[[ ${#tarballs[@]} == 1 ]] || {
	echo "publish.sh: want one tarball in $out/npm, found ${#tarballs[@]}; run pack.sh first" >&2
	exit 1
}
tarball=${tarballs[0]}

manifest=$(tar -xOzf "$tarball" package/package.json)
name=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$manifest")
version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$manifest")
[[ "$name" == kantel ]] || {
	echo "publish.sh: $tarball is $name, not kantel" >&2
	exit 1
}
tag=latest
[[ "$version" == *-* ]] && tag=next

if [[ "$(npm view "$name@$version" version 2>/dev/null || true)" == "$version" ]]; then
	echo "skip    $name@$version: already on npm"
	exit 0
fi
if [[ "$dry_run" == 1 ]]; then
	echo "dry run $name@$version ($tag)"
	npm publish "$tarball" --access public --tag "$tag" --dry-run
else
	echo "publish $name@$version ($tag)"
	npm publish "$tarball" --access public --tag "$tag" --provenance
fi
