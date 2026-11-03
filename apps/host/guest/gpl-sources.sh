#!/bin/sh
# Writes the exact source of the copyleft libraries the sandbox image bundles outside a distro package, as release
# assets beside the image: libx264 and x265 (GPL-2.0-or-later) and libde265 (LGPL-3.0-or-later), which Selkies'
# pixelflux wheel carries in pixelflux.libs/, and pixelflux itself at the same release, whose pyproject.toml is the
# recipe they were built with (its cibuildwheel before-all). release.sh runs it for every image release.
#
#   apps/host/guest/gpl-sources.sh <out-dir> <site-packages-dir | sandbox-<arch>.ext4>...
#
# Each argument is the image's Selkies site-packages directory (/opt/selkies/lib/python3.*/site-packages, or a copy
# holding at least pixelflux-*.dist-info and pixelflux.libs), or a built sandbox ext4 it's read from with debugfs, so
# the sources of a release already published can be made from its own image.
#
# Nothing is taken on trust from the notices: the wheel in the image has to be one pixelflux published on PyPI (its
# SHA-256, from the dist-info's direct_url.json, among that version's files); the recipe comes from pixelflux's git
# tag for that version; each library is fetched at the commit the recipe names (by tag, checked to resolve to it, or
# by commit) from the URLs the recipe names; and libx264's and libx265's shared-library versions in pixelflux.libs
# have to match the X264_BUILD and X265_BUILD of that source. Each source is `git archive` of that commit, gzipped
# without a timestamp, so the same commit gives the same tarball with the same git and gzip.
#
# Writes to <out-dir>: source-<name>-<version>.tar.gz for each, SOURCES.sha256 (sha256sum -c format) and SOURCES.md
# (what each is, its commit and upstream, and its SHA-256). Several images (one per architecture) share files when
# their versions are the same. Needs git, curl, jq, gzip and sha256sum (and debugfs for an .ext4).
set -eu

OUT=${1:?usage: gpl-sources.sh <out-dir> <site-packages-dir | sandbox.ext4>...}
shift
[ $# -gt 0 ] || { echo "usage: gpl-sources.sh <out-dir> <site-packages-dir | sandbox.ext4>..." >&2; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
PIXELFLUX_GIT=https://github.com/selkies-project/pixelflux.git
# The copyleft libraries in the GPL build of pixelflux, by the directory name its recipe clones them to.
COPYLEFT="x264 x265 libde265"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
: >"$WORK/rows"

# fetch <dir> <commit> <tag or -> <url>...: a shallow clone of exactly that commit, as pixelflux's recipe does it.
fetch() {
	dir=$1 commit=$2 tag=$3
	shift 3
	want=$commit
	[ "$tag" = - ] || want="refs/tags/$tag:refs/tags/$tag"
	for url in "$@"; do
		rm -rf "$dir"
		git init -q "$dir"
		if git -C "$dir" fetch -q --depth 1 "$url" "$want"; then
			got=$(git -C "$dir" rev-parse 'FETCH_HEAD^{commit}')
			[ "$got" = "$commit" ] || { echo "$url has $tag at $got, not $commit" >&2; exit 1; }
			FETCHED_URL=$url
			return 0
		fi
		echo "couldn't fetch $want from $url; trying the next" >&2
	done
	echo "couldn't fetch $commit from any of: $*" >&2
	exit 1
}

# archive <dir> <commit> <name> <version> <licence> <upstream> <what>: the source tarball, and its row in SOURCES.md.
archive() {
	file="source-$3-$4.tar.gz"
	if [ ! -f "$OUT/$file" ]; then
		git -C "$1" archive --format=tar --prefix="$3-$4/" "$2" | gzip -n -9 >"$OUT/$file.part"
		mv "$OUT/$file.part" "$OUT/$file"
	fi
	sum=$(sha256sum "$OUT/$file" | cut -d' ' -f1)
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$file" "$sum" "$5" "$2" "$6" "$7" "$4" >>"$WORK/rows"
}

n=0
for src in "$@"; do
	n=$((n + 1))
	site="$WORK/site-$n"
	if [ -f "$src" ]; then
		# A built image: copy pixelflux's dist-info and libs out of it, read-only.
		py=$(debugfs -R 'ls /opt/selkies/lib' "$src" 2>/dev/null | tr -s ' ' '\n' | grep '^python3' | head -n1)
		[ -n "$py" ] || { echo "$src: no /opt/selkies/lib/python3.* (not a sandbox image with Selkies?)" >&2; exit 1; }
		mkdir -p "$site"
		for entry in $(debugfs -R "ls /opt/selkies/lib/$py/site-packages" "$src" 2>/dev/null | tr -s ' ' '\n' |
			grep '^pixelflux'); do
			debugfs -R "rdump /opt/selkies/lib/$py/site-packages/$entry $site" "$src" 2>/dev/null
		done
	else
		site=$src
	fi
	info=
	for d in "$site"/pixelflux-*.dist-info; do [ -d "$d" ] && info=$d; done
	[ -n "$info" ] && [ -d "$site/pixelflux.libs" ] || { echo "$src: no pixelflux-*.dist-info and pixelflux.libs" >&2; exit 1; }
	version=$(sed -n 's/^Version: //p' "$info/METADATA")
	wheel_sum=$(jq -r '.archive_info.hashes.sha256 // empty' "$info/direct_url.json" 2>/dev/null || true)
	[ -n "$wheel_sum" ] || { echo "$info has no direct_url.json hash: can't tell which wheel was installed" >&2; exit 1; }
	curl -fsSL "https://pypi.org/pypi/pixelflux/$version/json" |
		jq -e --arg sum "$wheel_sum" '[.urls[].digests.sha256] | index($sum)' >/dev/null ||
		{ echo "pixelflux $version in $src (wheel $wheel_sum) isn't a wheel pixelflux published on PyPI" >&2; exit 1; }

	# pixelflux at its release tag: the extension's own source and the recipe the libraries were built with.
	pf="$WORK/pixelflux-$version"
	if [ ! -d "$pf" ]; then
		git init -q "$pf"
		git -C "$pf" fetch -q --depth 1 "$PIXELFLUX_GIT" "refs/tags/$version:refs/tags/$version"
	fi
	pf_commit=$(git -C "$pf" rev-parse "refs/tags/$version^{commit}")
	archive "$pf" "$pf_commit" pixelflux "$version" MPL-2.0 https://github.com/selkies-project/pixelflux \
		"pixelflux $version, the extension that links them; its \`pyproject.toml\` (cibuildwheel's before-all) builds them"
	git -C "$pf" show "$pf_commit:pyproject.toml" >"$WORK/recipe-$version"

	for name in $COPYLEFT; do
		# `clone_source <commit> <tag|-> <dir> \` then the URLs on the next line.
		line=$(awk -v d="$name" '$1 == "clone_source" && $4 == d { c = $2; t = $3; getline; sub(/&&.*/, ""); print c, t, $0; exit }' \
			"$WORK/recipe-$version")
		[ -n "$line" ] || { echo "pixelflux $version's recipe clones no $name" >&2; exit 1; }
		# shellcheck disable=SC2086 # the commit, the tag and the URLs, split on spaces
		set -- $line
		commit=$1 tag=$2
		shift 2
		lib=
		for f in "$site/pixelflux.libs/lib${name#lib}-"*; do [ -f "$f" ] && lib=${f##*/}; done
		[ -n "$lib" ] || { echo "pixelflux $version in $src bundles no lib${name#lib}" >&2; exit 1; }
		dir="$WORK/$name-$commit"
		[ -d "$dir" ] || fetch "$dir" "$commit" "$tag" "$@"
		case "$name" in
		x264) build=$(git -C "$dir" show "$commit:x264.h" | sed -n 's/^#define X264_BUILD \([0-9]*\).*/\1/p')
			licence=GPL-2.0-or-later ;;
		x265) build=$(git -C "$dir" show "$commit:source/CMakeLists.txt" | sed -n 's/^set(X265_BUILD \([0-9]*\)).*/\1/p')
			licence=GPL-2.0-or-later ;;
		*) build='' licence=LGPL-3.0-or-later ;;
		esac
		if [ -n "$build" ]; then
			[ "${lib##*.so.}" = "$build" ] || { echo "$lib isn't build $build of $name at $commit" >&2; exit 1; }
		fi
		ver=$tag
		[ "$ver" != - ] || ver=$(printf %.12s "$commit")
		# The library's name without auditwheel's per-build hash, so every architecture's image shares the row.
		archive "$dir" "$commit" "$name" "$ver" "$licence" "${FETCHED_URL:-$1}" \
			"\`${lib%%-*}-*.so.${lib##*.so.}\` in pixelflux $version's \`pixelflux.libs/\`"
		FETCHED_URL=
	done
done

sort -u "$WORK/rows" >"$WORK/rows.sorted"
cut -f1,2 "$WORK/rows.sorted" | sort -u | awk -F'\t' '{ print $2 "  " $1 }' >"$OUT/SOURCES.sha256"
{
	cat <<'EOF'
# Corresponding source of the sandbox image's bundled copyleft libraries

The default sandbox image carries Selkies, whose pixelflux wheel bundles libx264 and x265 (GPL-2.0-or-later) and
libde265 (LGPL-3.0-or-later) in `/opt/selkies/lib/python3*/site-packages/pixelflux.libs/`. These are the exact
sources of the versions in this release's image: each is `git archive` of the upstream commit named below, which
pixelflux's own build recipe (`pyproject.toml`, `[tool.cibuildwheel.linux] before-all`, in the pixelflux source here)
checks out and builds. `apps/host/guest/gpl-sources.sh` in lleverage-ai/kantel made them from the image itself. Check
them with `sha256sum -c SOURCES.sha256`. THIRD-PARTY-NOTICES.md covers everything else in the images.

| File | What it is | Licence | Upstream | Commit | SHA-256 |
| --- | --- | --- | --- | --- | --- |
EOF
	awk -F'\t' '{ printf "| `%s` | %s | %s | %s | `%s` | `%s` |\n", $1, $6, $3, $5, $4, $2 }' "$WORK/rows.sorted"
} >"$OUT/SOURCES.md"
cat "$OUT/SOURCES.sha256"
