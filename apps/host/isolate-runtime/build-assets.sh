#!/usr/bin/env bash
# Builds kantel-isolate's --assets directory: the guest bundle, the pinned Pyodide distribution (checked against the
# SHA-256 values in assets.lock), the numpy wheel, and the Pyodide memory snapshot (made by running the binary).
#
#   build-assets.sh <out-dir> [--bin <kantel-isolate>] [--cache <dir>]
#
# Offline once a download cache is present: pass --cache <dir> (or KANTEL_ISOLATE_CACHE=<dir>) and every download is
# read from, and written to, that directory. With no cache and no network the download step fails with a clear note.
#
# W3 (Docker image build) runs this inside a rust:1.91-bookworm-based image with bun and curl available. The Pyodide
# memory snapshot is a WebAssembly linear-memory dump and is architecture-independent, so it may be made once on the
# builder's own architecture and shipped for every target (a cross-built arm64 image can use an amd64-built snapshot).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out=""
bin=""
cache="${KANTEL_ISOLATE_CACHE:-}"
while [ $# -gt 0 ]; do
	case "$1" in
	--bin) bin="$2"; shift 2 ;;
	--cache) cache="$2"; shift 2 ;;
	-*) echo "unknown flag $1" >&2; exit 2 ;;
	*) out="$1"; shift ;;
	esac
done
[ -n "$out" ] || { echo "usage: build-assets.sh <out-dir> [--bin <kantel-isolate>] [--cache <dir>]" >&2; exit 2; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
cache="${cache:-$out/.cache}"
mkdir -p "$cache"

PYODIDE_VERSION="314.0.7"   # Pyodide 314.0.7 (Python 3.14.2), npm and jsDelivr alike; its files are pinned in assets.lock
PYODIDE_NPM="pyodide@${PYODIDE_VERSION}"

log() { echo "build-assets: $*" >&2; }

# 1. The guest bundle. A frozen install only (never a plain install that could change the lockfile); offline uses the
# install cache or fails (review finding M11).
log "bundling the guest"
if [ -n "${KANTEL_ISOLATE_OFFLINE:-}" ]; then
	( cd "$here" && bun install --frozen-lockfile --offline >/dev/null )
else
	( cd "$here" && bun install --frozen-lockfile >/dev/null )
fi
mkdir -p "$out/guest"
( cd "$here" && bun run guest/build.ts "$out/guest" )

# 2. Pyodide distribution + numpy wheel, verified against assets.lock.
lock="$here/assets.lock"
fetch() { # <url> <dest>
	local url="$1" dest="$2" name
	name="$(basename "$dest")"
	if [ ! -f "$cache/$name" ]; then
		[ -n "${KANTEL_ISOLATE_OFFLINE:-}" ] && { log "offline and $name not in cache ($cache)"; exit 1; }
		log "downloading $name"
		curl -fsSL "$url" -o "$cache/$name"
	fi
	cp "$cache/$name" "$dest"
}

py="$out/pyodide"
mkdir -p "$py"
# The Pyodide package is distributed on npm; fetch the tarball once into the cache, then extract the files we need.
tarball="$cache/pyodide-${PYODIDE_VERSION}.tgz"
if [ ! -f "$tarball" ]; then
	[ -n "${KANTEL_ISOLATE_OFFLINE:-}" ] && { log "offline and pyodide tarball not in cache"; exit 1; }
	log "downloading $PYODIDE_NPM"
	url="$(npm view "$PYODIDE_NPM" dist.tarball 2>/dev/null || true)"
	[ -n "$url" ] || url="https://registry.npmjs.org/pyodide/-/pyodide-${PYODIDE_VERSION}.tgz"
	curl -fsSL "$url" -o "$tarball"
fi
# Verify the tarball against its pinned SHA-256 BEFORE extracting it (review finding M11): the per-file checks below
# only see files already unpacked from it.
tarball_sha="$(awk '/^tarball /{print $2}' "$lock")"
[ -n "$tarball_sha" ] || { log "assets.lock has no tarball digest"; exit 1; }
got="$(sha256sum "$tarball" | cut -d' ' -f1)"
[ "$got" = "$tarball_sha" ] || { log "pyodide tarball DIGEST MISMATCH: got $got want $tarball_sha"; rm -f "$tarball"; exit 1; }
tmp="$(mktemp -d)"
tar -xzf "$tarball" -C "$tmp"
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
	cp "$tmp/package/$f" "$py/$f"
done
rm -rf "$tmp"

# numpy wheel (the lock names its exact file and digest); copied next to the pyodide files so it can be loaded.
numpy_whl="$(awk '/^numpy /{print $2}' "$lock")"
numpy_sha="$(awk '/^numpy /{print $3}' "$lock")"
if [ -n "$numpy_whl" ]; then
	fetch "https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/${numpy_whl}" "$py/$numpy_whl"
	got="$(sha256sum "$py/$numpy_whl" | cut -d' ' -f1)"
	[ "$got" = "$numpy_sha" ] || { log "DIGEST MISMATCH $numpy_whl: got $got want $numpy_sha"; exit 1; }
fi

# 3. Verify every file against assets.lock (sha256  path, path relative to the pyodide dir).
log "verifying SHA-256 digests"
missing=0
while read -r sha rel; do
	[ -z "$sha" ] && continue
	case "$sha" in \#*) continue ;; esac
	f="$py/$rel"
	[ -f "$f" ] || { log "MISSING $rel"; missing=1; continue; }
	got="$(sha256sum "$f" | cut -d' ' -f1)"
	[ "$got" = "$sha" ] || { log "DIGEST MISMATCH $rel: got $got want $sha"; missing=1; }
done < <(grep -vE '^(numpy |tarball |#|$)' "$lock" || true)
[ "$missing" = 0 ] || { log "asset verification failed"; exit 1; }

# 4. The Pyodide memory snapshot: boot Pyodide once and dump its linear memory.
if [ -z "$bin" ]; then
	bin="$(command -v kantel-isolate || true)"
	[ -n "$bin" ] || bin="$here/target/release/kantel-isolate"
fi
[ -x "$bin" ] || { log "kantel-isolate binary not found (pass --bin); looked at '$bin'"; exit 1; }
log "making the Pyodide memory snapshot with $bin"
"$bin" python-snapshot --assets "$out" --out "$out/python.snapshot"

log "done: $out"
ls -la "$out" "$py" >&2
