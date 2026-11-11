#!/bin/sh
# Builds the isolate runtime for one architecture: kantel-isolate (apps/host/isolate-runtime, Rust on deno_core) and
# its assets directory (the guest bundles, the pinned Pyodide and its memory snapshot), for the isolate VM's image
# (rootfs.sh) and for hosts that run isolates natively (release.sh publishes both).
#
#   apps/host/guest/isolate-runtime.sh [amd64|arm64]
#   apps/host/guest/isolate-runtime.sh test
#
# Writes apps/host/dist/kantel-isolate-<arch> and apps/host/dist/isolate-assets-<arch>/. `test` runs the crate's
# checks instead (cargo fmt, clippy and test, for the build machine's architecture), as CI does.
#
# The binary is built in a Rust container (KANTEL_RUST_IMAGE, run on the build machine's architecture, cross-compiling
# for the other). rusty_v8 publishes its V8 static library for x86_64- and aarch64-unknown-linux-gnu only (no musl), so
# the binary is a glibc one, linked against Debian bookworm's glibc (2.36): it runs in the isolate VM (Debian trixie)
# and natively on any host with glibc 2.36 or later. Cargo's registry is cached in a Docker volume
# (kantel-isolate-cargo) and the build, the V8 library with it, in KANTEL_ISOLATE_TARGET (default
# apps/host/dist/.isolate-target).
#
# V8: by default rusty_v8's build script downloads its prebuilt library. RUSTY_V8_ARCHIVE (a path or URL to a
# librusty_v8 .a or .a.gz) or RUSTY_V8_MIRROR (a base URL laid out as rusty_v8's releases) picks another, such as a V8
# built with its sandbox on; a path is mounted into the build container.
#
# Stand-ins, for a build before the runtime's source is here or to try another build of it:
# KANTEL_ISOLATE_BINARY=<file> uses that binary rather than building one, and KANTEL_ISOLATE_ASSETS=<dir> that
# assets directory rather than running isolate-runtime/build-assets.sh. KANTEL_ISOLATE_SOURCE=<dir> builds the runtime
# from another checkout of its crate.
set -eu

ARCH=${1:-amd64}
HERE=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$HERE/.." && pwd)
CRATE=${KANTEL_ISOLATE_SOURCE:-$MODULE/isolate-runtime}
RUST_IMAGE=${KANTEL_RUST_IMAGE:-rust:1.91-bookworm}
TARGET_DIR=${KANTEL_ISOLATE_TARGET:-$MODULE/dist/.isolate-target}
case "$(uname -m)" in x86_64) BUILD_ARCH=amd64 ;; aarch64 | arm64) BUILD_ARCH=arm64 ;; *) BUILD_ARCH=other ;; esac
[ "$ARCH" = test ] && TEST_ARCH=$BUILD_ARCH || TEST_ARCH=$ARCH
case "$TEST_ARCH" in
amd64) TRIPLE=x86_64-unknown-linux-gnu; CROSS_GCC=x86_64-linux-gnu-gcc ;;
arm64) TRIPLE=aarch64-unknown-linux-gnu; CROSS_GCC=aarch64-linux-gnu-gcc ;;
*) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

# cargo runs cargo in the builder: the Rust image with both targets and their C cross-compilers (V8's library is
# C++, linked by the target's gcc), built once and cached by Docker. As the caller's user, so what it leaves behind is
# theirs.
cargo() {
	if [ ! -f "$CRATE/Cargo.toml" ]; then
		echo "no $CRATE/Cargo.toml: the isolate runtime's source isn't here (set KANTEL_ISOLATE_BINARY to use a built one)" >&2
		exit 1
	fi
	docker build -q -t kantel-isolate-builder:local --build-arg BASE="$RUST_IMAGE" - >/dev/null <<-'EOF'
		ARG BASE
		FROM $BASE
		RUN case "$(dpkg --print-architecture)" in \
				amd64) cross="gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross" ;; \
				*) cross="gcc-x86-64-linux-gnu g++-x86-64-linux-gnu libc6-dev-amd64-cross" ;; \
			esac \
			&& apt-get update && apt-get install -y --no-install-recommends $cross && rm -rf /var/lib/apt/lists/* \
			&& rustup component add rustfmt clippy \
			&& rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu && chmod -R a+rwX "$RUSTUP_HOME"
	EOF
	mkdir -p "$TARGET_DIR"
	env=$(echo "$TRIPLE" | tr 'a-z-' 'A-Z_')
	cc=$(echo "$TRIPLE" | tr '-' '_')
	# Without debug info (V8 alone has hundreds of MB of it), keeping symbols for backtraces.
	set -- -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_TARGET="$TRIPLE" -e CARGO_PROFILE_RELEASE_STRIP=debuginfo \
		-e "CARGO_TARGET_${env}_LINKER=$CROSS_GCC" -e "CC_$cc=$CROSS_GCC" -e "CXX_$cc=${CROSS_GCC%gcc}g++" "$@"
	if [ -n "${RUSTY_V8_ARCHIVE:-}" ]; then
		case "$RUSTY_V8_ARCHIVE" in
		http://* | https://*) set -- -e RUSTY_V8_ARCHIVE="$RUSTY_V8_ARCHIVE" "$@" ;;
		*) set -- -v "$(realpath "$RUSTY_V8_ARCHIVE"):/v8/$(basename "$RUSTY_V8_ARCHIVE"):ro" \
			-e RUSTY_V8_ARCHIVE="/v8/$(basename "$RUSTY_V8_ARCHIVE")" "$@" ;;
		esac
	fi
	if [ -n "${RUSTY_V8_MIRROR:-}" ]; then set -- -e RUSTY_V8_MIRROR="$RUSTY_V8_MIRROR" "$@"; fi
	docker volume create kantel-isolate-cargo >/dev/null
	docker run --rm --user 0 -v kantel-isolate-cargo:/cargo kantel-isolate-builder:local chown "$(id -u):$(id -g)" /cargo
	docker run --rm --user "$(id -u):$(id -g)" -v kantel-isolate-cargo:/cargo -e CARGO_HOME=/cargo -e HOME=/tmp \
		-v "$CRATE:/src:ro" -v "$TARGET_DIR:/target" -w /src "$@"
}

if [ "$ARCH" = test ]; then
	cargo kantel-isolate-builder:local sh -euc 'cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked'
	exit 0
fi

mkdir -p "$MODULE/dist"
BIN="$MODULE/dist/kantel-isolate-$ARCH"
ASSETS="$MODULE/dist/isolate-assets-$ARCH"
if [ -n "${KANTEL_ISOLATE_BINARY:-}" ]; then
	cp "$KANTEL_ISOLATE_BINARY" "$BIN"
else
	cargo kantel-isolate-builder:local cargo build --locked --release --bin kantel-isolate
	cp "$TARGET_DIR/$TRIPLE/release/kantel-isolate" "$BIN"
fi
chmod 0755 "$BIN"

rm -rf "$ASSETS"
if [ -n "${KANTEL_ISOLATE_ASSETS:-}" ]; then
	cp -r "$KANTEL_ISOLATE_ASSETS" "$ASSETS"
elif [ -x "$CRATE/build-assets.sh" ]; then
	"$CRATE/build-assets.sh" "$ASSETS"
else
	echo "no $CRATE/build-assets.sh: set KANTEL_ISOLATE_ASSETS to use a built assets directory" >&2
	exit 1
fi
chmod -R u+rwX,go+rX-w "$ASSETS"
echo "$BIN"
echo "$ASSETS"
