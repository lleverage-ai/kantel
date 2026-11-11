#!/usr/bin/env bash
# Downloads Kantel's sandboxed rusty_v8 build (made by build-v8-sandbox.sh, published as release assets), checks
# both files against the SHA-256s pinned here, and prints the two variables cargo's v8 build script reads:
#
#   eval "$(apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh --export ~/.cache/kantel-v8)"   # a shell: exports to cargo
#   apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh ~/.cache/kantel-v8 >> "$GITHUB_ENV"     # GitHub Actions
#
# Without --export it prints `KEY=value` lines (the `$GITHUB_ENV` form); with --export it prefixes `export ` so that
# `eval` in a shell puts the variables in the environment cargo inherits (plain `eval` of `KEY=value` sets shell
# variables, not environment ones, and cargo wouldn't see them).
#
# A file already in <dir> with the right SHA-256 isn't downloaded again (so an actions/cache of <dir> keyed on this
# file's hash skips the download). KANTEL_V8_BASE overrides where the assets come from (a mirror, or file:// for a
# local build's out dir). KANTEL_V8_TARGET picks the target (x86_64- or aarch64-unknown-linux-gnu) for a cross build;
# the default is this machine's.
set -euo pipefail

prefix=
if [ "${1:-}" = "--export" ]; then
	prefix="export "
	shift
fi

V8_CRATE_VERSION=150.4.0
# The release that carries the assets: a prerelease of github.com/lleverage-ai/kantel, one per V8 crate version and
# patch revision, made by uploading build-v8-sandbox.sh's out dir (gh release upload <tag> out/*).
TAG=rusty-v8-sandbox-v$V8_CRATE_VERSION-1
BASE=${KANTEL_V8_BASE:-https://github.com/lleverage-ai/kantel/releases/download/$TAG}

case $(uname -m) in
x86_64) host=x86_64-unknown-linux-gnu ;;
aarch64 | arm64) host=aarch64-unknown-linux-gnu ;;
*) host=$(uname -m) ;;
esac
target=${KANTEL_V8_TARGET:-$host}
case $target in
x86_64-unknown-linux-gnu)
	lib_sha=21ebfc94b834a0e1aa0b034916f76106fd44e6ffee9e1f796b8d7f7374944361
	binding_sha=35f9f49c552786714c814f66925bc9ebfb255194f2b66790f01bfad70a1f7e78
	;;
aarch64-unknown-linux-gnu)
	lib_sha=5bed3d0be9534f264eece2b9f3417d7aec4b9a44eaac3db700220e0248848026
	binding_sha=35f9f49c552786714c814f66925bc9ebfb255194f2b66790f01bfad70a1f7e78
	;;
*) echo "fetch-v8-sandbox: no sandboxed V8 build for $target" >&2 && exit 1 ;;
esac

dir=${1:?usage: fetch-v8-sandbox.sh <cache-dir>}
mkdir -p "$dir"
name=ptrcomp_sandbox_simdutf_release_$target
lib=librusty_v8_$name.a.gz
binding=src_binding_$name.rs

fetch() { # <file> <sha256>
	local f=$1 sha=$2
	if echo "$sha  $dir/$f" | sha256sum -c --status - 2>/dev/null; then
		return
	fi
	# A unique temp file, so concurrent runs (several jobs sharing a cache) don't race on one .part; verify it, then
	# rename atomically into place. Clean up only our own temp.
	local tmp
	tmp=$(mktemp "$dir/.$f.XXXXXX")
	trap 'rm -f "$tmp"' RETURN
	curl -fsSL --retry 3 -o "$tmp" "$BASE/$f"
	echo "$sha  $tmp" | sha256sum -c --status - || { echo "fetch-v8-sandbox: $f: SHA-256 mismatch" >&2; return 1; }
	mv -f "$tmp" "$dir/$f"
}
fetch "$lib" "$lib_sha"
fetch "$binding" "$binding_sha"
# v8's build.rs takes a .gz archive in RUSTY_V8_ARCHIVE as is (it checks the gzip magic).
echo "${prefix}RUSTY_V8_ARCHIVE=$(cd "$dir" && pwd)/$lib"
echo "${prefix}RUSTY_V8_SRC_BINDING_PATH=$(cd "$dir" && pwd)/$binding"
