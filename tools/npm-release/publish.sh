#!/usr/bin/env bash
# publish.sh [--dry-run] [out]: publishes the tarballs pack.sh wrote to out (default dist/npm-release), in
# out/publish-order.txt's order, as public packages. A version already on npm is skipped, so a release that stopped
# part way can be run again. A prerelease (1.2.3-rc.1) goes out under the `next` dist-tag, anything else as `latest`.
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
out=${1:-$root/dist/npm-release}
[[ -s "$out/publish-order.txt" ]] || { echo "publish.sh: no $out/publish-order.txt; run pack.sh first" >&2; exit 1; }

while read -r tarball; do
	[[ -n "$tarball" ]] || continue
	manifest=$(tar -xOzf "$out/$tarball" package/package.json)
	name=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$manifest")
	version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$manifest")
	tag=latest
	[[ "$version" == *-* ]] && tag=next

	if [[ "$(npm view "$name@$version" version 2>/dev/null || true)" == "$version" ]]; then
		echo "skip    $name@$version: already on npm"
		continue
	fi
	if [[ "$dry_run" == 1 ]]; then
		echo "dry run $name@$version ($tag)"
		npm publish "$out/$tarball" --access public --tag "$tag" --dry-run
	else
		echo "publish $name@$version ($tag)"
		npm publish "$out/$tarball" --access public --tag "$tag" --provenance
	fi
done <"$out/publish-order.txt"
