#!/usr/bin/env bash
# Builds rusty_v8 (the `v8` crate that deno_core uses) with V8's heap sandbox and pointer compression, and writes
# the files a consumer needs, named as rusty_v8's own release assets are:
#
#   <out>/librusty_v8_ptrcomp_sandbox_simdutf_release_<target>.a.gz   the static library (RUSTY_V8_ARCHIVE)
#   <out>/src_binding_ptrcomp_sandbox_simdutf_release_<target>.rs     its bindgen output (RUSTY_V8_SRC_BINDING_PATH)
#   <out>/args_ptrcomp_sandbox_simdutf_release_<target>.gn            the GN args it was built with (a record)
#   <out>/SHA256SUMS
#
# denoland/rusty_v8 publishes no sandbox build (its releases have `_ptrcomp_` for x86_64 Linux and nothing with
# `_sandbox_`), so Kantel builds one per `v8` crate version and publishes it as a release asset (see README.md).
# `simdutf` is on because deno_core asks for it (through deno_v8), so the Rust side expects its symbols. The library
# also carries patches/rusty_v8-<version>-budget-allocator.patch: an ArrayBuffer allocator with a per-isolate byte
# budget that allocates inside the sandbox (rusty_v8's RustAllocator can't, and is left out of sandbox builds).
#
#   apps/host/isolate-runtime/v8/build-v8-sandbox.sh <out-dir> [work-dir]
#
# env: JOBS (parallel compile jobs, default 16), KEEP_WORK=1 keeps the work dir (its target/ makes a rebuild quick).
# Runs in Docker (the builder image below, pinned by digest), so the host needs only Docker and ~25 GB of disk.
# The source is rusty_v8's git tag with its submodules, checked against the pinned commit (the crates.io package
# can't build from source: it leaves out ICU's data file). The build downloads Chromium's clang, gn, ninja and Rust
# toolchain, as rusty_v8's build.rs always does with V8_FROM_SOURCE; bindgen uses LLVM 19's libclang from
# apt.llvm.org, as rusty_v8's CI does.
set -euo pipefail

# Pinned. When deno_core moves to a new `v8` (`cargo tree -i v8` in the isolate runtime), bump all three together:
# the tag's commit is `gh api repos/denoland/rusty_v8/git/ref/tags/v<version> --jq .object.sha`.
V8_CRATE_VERSION=150.4.0
RUSTY_V8_COMMIT=5c15a6995c9bb4bacd3e341b59fff32c909c80bf
# rusty_v8 150.4.0 pins Rust 1.91.0 in its rust-toolchain.toml; bookworm's glibc (2.36) is older than the isolate
# VM's (trixie, 2.41), so the archive links into binaries for either.
BUILDER_IMAGE=rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33
LLVM_VERSION=19

out=${1:?usage: build-v8-sandbox.sh <out-dir> [work-dir]}
work=${2:-$(mktemp -d /tmp/kt-v8-sandbox.XXXXXX)}
jobs=${JOBS:-16}
mkdir -p "$out" "$work"
out=$(cd "$out" && pwd)
work=$(cd "$work" && pwd)

case $(uname -m) in
x86_64) target=x86_64-unknown-linux-gnu ;;
aarch64 | arm64) target=aarch64-unknown-linux-gnu ;;
*) echo "build-v8-sandbox: unsupported machine $(uname -m)" >&2 && exit 1 ;;
esac

echo "build-v8-sandbox: v8 $V8_CRATE_VERSION ($RUSTY_V8_COMMIT) for $target, $jobs jobs, work dir $work"
here=$(cd "$(dirname "$0")" && pwd)
docker run --rm \
	-v "$work:/work" -v "$out:/out" -v "$here/patches:/patches:ro" \
	-e V8_CRATE_VERSION="$V8_CRATE_VERSION" -e RUSTY_V8_COMMIT="$RUSTY_V8_COMMIT" -e LLVM_VERSION="$LLVM_VERSION" \
	-e TARGET="$target" -e JOBS="$jobs" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	"$BUILDER_IMAGE" bash -euo pipefail -c '
trap "chown -R $HOST_UID:$HOST_GID /work /out" EXIT
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 curl ca-certificates gnupg git xz-utils >/dev/null
curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor > /etc/apt/trusted.gpg.d/llvm-snapshot.gpg
echo "deb http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-$LLVM_VERSION main" > /etc/apt/sources.list.d/llvm.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends "libclang-$LLVM_VERSION-dev" "clang-$LLVM_VERSION" >/dev/null

git config --global core.symlinks true
git config --global --add safe.directory "*"
src=/work/rusty_v8
if [ ! -d "$src/.git" ]; then
	git clone -q --depth 1 --branch "v$V8_CRATE_VERSION" --recurse-submodules --shallow-submodules \
		https://github.com/denoland/rusty_v8.git "$src"
fi
test "$(git -C "$src" rev-parse HEAD)" = "$RUSTY_V8_COMMIT" || { echo "rusty_v8 tag v$V8_CRATE_VERSION is not $RUSTY_V8_COMMIT" >&2; exit 1; }
cd "$src"
git checkout -q -- src/binding.cc
git apply "/patches/rusty_v8-$V8_CRATE_VERSION-budget-allocator.patch"
# Its rust-toolchain.toml asks rustup for every target rusty_v8 ships (Apple, Windows, Android); the image has 1.91.
git checkout -q -- rust-toolchain.toml && mv rust-toolchain.toml /work/rust-toolchain.toml.upstream
export V8_FROM_SOURCE=1 LIBCLANG_PATH=/usr/lib/llvm-$LLVM_VERSION/lib CARGO_TARGET_DIR=/work/target CARGO_HOME=/work/cargo-home
cargo build --release --locked --lib -j "$JOBS" --features v8_enable_sandbox,simdutf
mv /work/rust-toolchain.toml.upstream rust-toolchain.toml

gn_out=/work/target/release/gn_out
grep -Eq "v8_enable_sandbox ?= ?true" "$gn_out/args.gn"
grep -Eq "v8_enable_pointer_compression ?= ?true" "$gn_out/args.gn"
grep -Eq "rusty_v8_enable_simdutf ?= ?true" "$gn_out/args.gn"
name=ptrcomp_sandbox_simdutf_release_$TARGET
gzip -9c "$gn_out/obj/librusty_v8.a" > "/out/librusty_v8_$name.a.gz"
cp "$gn_out/src_binding.rs" "/out/src_binding_$name.rs"
cp "$gn_out/args.gn" "/out/args_$name.gn"
cd /out && sha256sum "librusty_v8_$name.a.gz" "src_binding_$name.rs" "args_$name.gn" > SHA256SUMS
'
cat "$out/SHA256SUMS"
[ "${KEEP_WORK:-}" = 1 ] || rm -rf "$work"
