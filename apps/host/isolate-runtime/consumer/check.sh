#!/usr/bin/env bash
# Builds and runs the minimal external consumer (this directory) against kantel-isolate at a pinned git revision, as
# a program outside this repository would depend on it:
#
#   apps/host/isolate-runtime/consumer/check.sh stock|sandbox <out-dir>
#
# The dependency is `{ git = <repository>, rev = <commit> }`: by default this checkout's own repository (file://) at
# HEAD, so only committed files take part (KANTEL_CONSUMER_GIT and KANTEL_CONSUMER_REV pick another). `sandbox` builds
# with the v8-sandbox feature against the sandboxed V8 (RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH must be set, as
# fetch-v8-sandbox.sh prints them) and the patched deno_core and serde_v8 from v8/vendor-patched.sh, given to the
# consumer with [patch.crates-io], which is how any embedder builds against that V8. The consumer starts from the
# library's Cargo.lock, so it resolves the versions the library is tested with.
#
# apps/host/guest/isolate-runtime.sh consumer runs this in the build container, as CI does.
set -euo pipefail

mode=${1:?usage: check.sh stock|sandbox <out-dir>}
out=${2:?usage: check.sh stock|sandbox <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
crate=$(cd "$here/.." && pwd)
repo=$(git -C "$crate" rev-parse --show-toplevel)
url=${KANTEL_CONSUMER_GIT:-file://$repo}
rev=${KANTEL_CONSUMER_REV:-$(git -C "$repo" rev-parse HEAD)}
case $mode in
stock) features= ;;
sandbox)
	features=', features = ["v8-sandbox"]'
	[ -n "${RUSTY_V8_ARCHIVE:-}" ] && [ -n "${RUSTY_V8_SRC_BINDING_PATH:-}" ] ||
		{ echo "check.sh sandbox: set RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH (fetch-v8-sandbox.sh)" >&2; exit 1; }
	;;
*) echo "check.sh: mode is stock or sandbox, not $mode" >&2; exit 2 ;;
esac
if [ -n "$(git -C "$repo" status --porcelain -- "$crate")" ]; then
	echo "check.sh: the crate has uncommitted changes, which the consumer doesn't see (it builds $rev)" >&2
fi

rm -rf "$out"
mkdir -p "$out"
cp -r "$here/src" "$out/"
sed -E "s|^kantel-isolate = \{ path = \"\.\.\"(.*) \}$|kantel-isolate = { git = \"$url\", rev = \"$rev\"\1 }|" \
	"$here/Cargo.toml" >"$out/Cargo.toml"
grep -q "^kantel-isolate = { git = \"$url\", rev = \"$rev\"" "$out/Cargo.toml" ||
	{ echo "check.sh: couldn't point the consumer at $url $rev" >&2; exit 1; }
cp "$crate/Cargo.lock" "$out/Cargo.lock"
if [ "$mode" = sandbox ]; then
	"$crate/v8/vendor-patched.sh" "$out/vendor" >&2
	cat >>"$out/Cargo.toml" <<'PATCH'

[patch.crates-io]
deno_core = { path = "vendor/deno_core-0.412.0" }
serde_v8 = { path = "vendor/serde_v8-0.321.0" }
PATCH
fi
echo "check.sh: consumer ($mode) against $url at $rev" >&2
cd "$out"
# shellcheck disable=SC2086 # features is empty or one flag.
cargo run --release ${features:+--features v8-sandbox}
