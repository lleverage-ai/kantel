#!/usr/bin/env bash
# Writes a copy of the isolate runtime's crate that builds against the sandboxed V8, into <out-dir>:
#
#   apps/host/isolate-runtime/v8/sandbox-crate.sh <out-dir>
#   cd <out-dir> && RUSTY_V8_ARCHIVE=… RUSTY_V8_SRC_BINDING_PATH=… cargo build --locked --release --features v8-sandbox
#
# The sandboxed build needs deno_core and serde_v8 with Kantel's patches (patches/), and those link against symbols
# only the patched V8 (build-v8-sandbox.sh) has, so the crate itself can't carry the [patch.crates-io] that points at
# them: a stock build would fail to link. The copy gets them: vendor-patched.sh writes the two crates (from crates.io,
# checked against their SHA-256) into <out-dir>/vendor, Cargo.toml gains the [patch.crates-io], and Cargo.lock is the
# crate's own with the two packages' registry source and checksum dropped, which is exactly what the patch changes in
# it. So the copy builds with --locked against the same versions as the stock build, and can't drift from it.
#
# Run guest/build.ts first: the guest bundle (guest/dist) is compiled into the binary.
set -euo pipefail

out=${1:?usage: sandbox-crate.sh <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
crate=$(cd "$here/.." && pwd)
[ -f "$crate/guest/dist/guest.js" ] || { echo "sandbox-crate: no guest/dist/guest.js: run bun run guest/build.ts first" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
# The crate's files, without build output and dependencies.
tar -C "$crate" --exclude=./target --exclude=./node_modules --exclude=./vendor -cf - . | tar -C "$out" -xf -
"$here/vendor-patched.sh" "$out/vendor" >&2

cat >>"$out/Cargo.toml" <<'EOF'

# Added by v8/sandbox-crate.sh: deno_core and serde_v8 with the V8-sandbox patches.
[patch.crates-io]
deno_core = { path = "vendor/deno_core-0.412.0" }
serde_v8 = { path = "vendor/serde_v8-0.321.0" }
EOF

# A path dependency has no registry source or checksum: drop those two lines from the two packages' entries, and
# fail if either entry isn't where it should be (a bumped version needs this script and vendor-patched.sh updated).
awk '
	/^\[\[package\]\]/ { pkg = ""; ver = "" }
	/^name = / { pkg = $3 }
	/^version = / { ver = $3 }
	(pkg == "\"deno_core\"" && ver == "\"0.412.0\"") || (pkg == "\"serde_v8\"" && ver == "\"0.321.0\"") {
		if ($1 == "source" || $1 == "checksum") { dropped++; next }
	}
	{ print }
	END { if (dropped != 4) { print "sandbox-crate: expected deno_core 0.412.0 and serde_v8 0.321.0 in Cargo.lock" > "/dev/stderr"; exit 1 } }
' "$crate/Cargo.lock" >"$out/Cargo.lock"
echo "sandbox-crate: $out" >&2
