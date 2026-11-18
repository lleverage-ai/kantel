#!/usr/bin/env bash
# Writes deno_core and serde_v8 with Kantel's V8-sandbox patches into <dir>, for the isolate runtime's
# [patch.crates-io] (see README.md):
#
#   apps/host/isolate-runtime/v8/vendor-patched.sh apps/host/isolate-runtime/vendor
#
# The crates come from crates.io, checked against the SHA-256 in Cargo.lock; the patches are patches/*-sandbox.patch.
# Run it again after bumping deno_core (and refresh the patches: they are `diff -ruN orig/<crate> patched/<crate>`).
set -euo pipefail

CRATES=(
	"deno_core 0.412.0 580cb2e0d797d75ff3dfc4a8f2b14aa7470f0fa31654a09a83d4cbb42b5eb9b4"
	"serde_v8 0.321.0 fd3b6f6140192f569b88997e2ea7afeef6aa38b64374e84784ea1d1ea35679d3"
)

out=${1:?usage: vendor-patched.sh <dir>}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
dl=$(mktemp -d)
trap 'rm -rf "$dl"' EXIT
for entry in "${CRATES[@]}"; do
	read -r name version sha <<<"$entry"
	curl -fsSL -o "$dl/$name.crate" "https://static.crates.io/crates/$name/$name-$version.crate"
	echo "$sha  $dl/$name.crate" | sha256sum -c --quiet -
	rm -rf "${out:?}/$name-$version"
	tar -xzf "$dl/$name.crate" -C "$out"
	patch -s -p2 -d "$out/$name-$version" <"$here/patches/$name-$version-sandbox.patch"
	echo "vendor-patched: $out/$name-$version"
done
