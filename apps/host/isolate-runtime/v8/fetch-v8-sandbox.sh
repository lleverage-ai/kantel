#!/usr/bin/env bash
# Downloads Kantel's sandboxed rusty_v8 build (made by build-v8-sandbox.sh, published as release assets), checks
# both files against the SHA-256s pinned here, and prints the two variables cargo's v8 build script reads:
#
#   eval "$(apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh ~/.cache/kantel-v8)"     # a shell
#   apps/host/isolate-runtime/v8/fetch-v8-sandbox.sh "$RUNNER_TOOL_CACHE/kantel-v8" >> "$GITHUB_ENV"   # Actions
#
# A file already in <dir> with the right SHA-256 isn't downloaded again (so an actions/cache of <dir> keyed on this
# file's hash skips the download). KANTEL_V8_BASE overrides where the assets come from (a mirror, or file:// for a
# local build's out dir).
set -euo pipefail

V8_CRATE_VERSION=150.4.0
# The release that carries the assets: a prerelease of github.com/lleverage-ai/kantel, one per V8 crate version and
# patch revision, made by uploading build-v8-sandbox.sh's out dir (gh release upload <tag> out/*).
TAG=rusty-v8-sandbox-v$V8_CRATE_VERSION-1
BASE=${KANTEL_V8_BASE:-https://github.com/lleverage-ai/kantel/releases/download/$TAG}

case $(uname -m) in
x86_64)
	target=x86_64-unknown-linux-gnu
	lib_sha=21ebfc94b834a0e1aa0b034916f76106fd44e6ffee9e1f796b8d7f7374944361
	binding_sha=35f9f49c552786714c814f66925bc9ebfb255194f2b66790f01bfad70a1f7e78
	;;
*) echo "fetch-v8-sandbox: no sandboxed V8 build for $(uname -m) yet (run build-v8-sandbox.sh there)" >&2 && exit 1 ;;
esac

dir=${1:?usage: fetch-v8-sandbox.sh <cache-dir>}
mkdir -p "$dir"
name=ptrcomp_sandbox_simdutf_release_$target
lib=librusty_v8_$name.a.gz
binding=src_binding_$name.rs

fetch() { # <file> <sha256>
	local f=$1 sha=$2
	if ! echo "$sha  $dir/$f" | sha256sum -c --status - 2>/dev/null; then
		curl -fsSL --retry 3 -o "$dir/$f.part" "$BASE/$f"
		echo "$sha  $dir/$f.part" | sha256sum -c --status - || { echo "fetch-v8-sandbox: $f: SHA-256 mismatch" >&2; rm -f "$dir/$f.part"; exit 1; }
		mv "$dir/$f.part" "$dir/$f"
	fi
}
fetch "$lib" "$lib_sha"
fetch "$binding" "$binding_sha"
# v8's build.rs takes a .gz archive in RUSTY_V8_ARCHIVE as is (it checks the gzip magic).
echo "RUSTY_V8_ARCHIVE=$(cd "$dir" && pwd)/$lib"
echo "RUSTY_V8_SRC_BINDING_PATH=$(cd "$dir" && pwd)/$binding"
