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
# V8: by default rusty_v8's build script downloads its prebuilt library. KANTEL_V8_SANDBOX=1 links Kantel's build of
# V8 with its sandbox on instead (amd64 for now), fetched and checked against the SHA-256s pinned in the crate's
# v8/fetch-v8-sandbox.sh (or the RUSTY_V8_ARCHIVE given, checked as below), with the patched deno_core and serde_v8
# (v8/sandbox-crate.sh) and the crate's v8-sandbox feature. RUSTY_V8_ARCHIVE (a path or URL to a librusty_v8 .a or .a.gz) picks any other, checked
# against RUSTY_V8_ARCHIVE_SHA256, which it then needs, with RUSTY_V8_SRC_BINDING_PATH (and its _SHA256) where that
# build has its own bindings. Each is mounted read-only into the build container.
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
# Pinned by digest, so a build is of the toolchain it was checked with.
RUST_IMAGE=${KANTEL_RUST_IMAGE:-rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33}
TARGET_DIR=${KANTEL_ISOLATE_TARGET:-$MODULE/dist/.isolate-target}
case "$(uname -m)" in x86_64) BUILD_ARCH=amd64 ;; aarch64 | arm64) BUILD_ARCH=arm64 ;; *) BUILD_ARCH=other ;; esac
[ "$ARCH" = test ] && TEST_ARCH=$BUILD_ARCH || TEST_ARCH=$ARCH
case "$TEST_ARCH" in
amd64) TRIPLE=x86_64-unknown-linux-gnu; CROSS_GCC=x86_64-linux-gnu-gcc ;;
arm64) TRIPLE=aarch64-unknown-linux-gnu; CROSS_GCC=aarch64-linux-gnu-gcc ;;
*) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

# v8 checks the V8 the build is to link, as the header says, leaving RUSTY_V8_ARCHIVE (and RUSTY_V8_SRC_BINDING_PATH)
# naming checked local files, or neither for rusty_v8's own.
v8() {
	cache="$MODULE/dist/.v8"
	if [ "${KANTEL_V8_SANDBOX:-}" = 1 ] && [ -z "${RUSTY_V8_ARCHIVE:-}" ]; then
		[ "$TRIPLE" = x86_64-unknown-linux-gnu ] || { echo "KANTEL_V8_SANDBOX: no sandboxed V8 for $TRIPLE yet" >&2; exit 1; }
		[ -x "$CRATE/v8/fetch-v8-sandbox.sh" ] || { echo "KANTEL_V8_SANDBOX: no $CRATE/v8/fetch-v8-sandbox.sh" >&2; exit 1; }
		out=$("$CRATE/v8/fetch-v8-sandbox.sh" "$cache")
		RUSTY_V8_ARCHIVE=$(printf '%s\n' "$out" | sed -n 's/^RUSTY_V8_ARCHIVE=//p')
		RUSTY_V8_SRC_BINDING_PATH=$(printf '%s\n' "$out" | sed -n 's/^RUSTY_V8_SRC_BINDING_PATH=//p')
		[ -f "$RUSTY_V8_ARCHIVE" ] && [ -f "$RUSTY_V8_SRC_BINDING_PATH" ] || { echo "fetch-v8-sandbox.sh said: $out" >&2; exit 1; }
		return
	fi
	[ -n "${RUSTY_V8_ARCHIVE:-}" ] || return 0
	checked() { # <path or URL> <sha256> <name>
		[ -n "$2" ] || { echo "$3 is set, so ${3}_SHA256 must be too: a V8 build is linked only once checked" >&2; exit 1; }
		f=$1
		case "$1" in
		http://* | https://*)
			mkdir -p "$cache"
			f="$cache/$(basename "$1")"
			echo "$2  $f" | sha256sum -c --status - 2>/dev/null || curl -fsSL --retry 3 -o "$f" "$1"
			;;
		esac
		echo "$2  $f" | sha256sum -c --status - || { echo "$3: $1 isn't SHA-256 $2" >&2; exit 1; }
		echo "$f"
	}
	RUSTY_V8_ARCHIVE=$(checked "$RUSTY_V8_ARCHIVE" "${RUSTY_V8_ARCHIVE_SHA256:-}" RUSTY_V8_ARCHIVE)
	if [ -n "${RUSTY_V8_SRC_BINDING_PATH:-}" ]; then
		RUSTY_V8_SRC_BINDING_PATH=$(checked "$RUSTY_V8_SRC_BINDING_PATH" "${RUSTY_V8_SRC_BINDING_SHA256:-}" RUSTY_V8_SRC_BINDING)
	fi
}

# cargo runs cargo in the builder: the Rust image with both targets and their C cross-compilers (V8's library is
# C++, linked by the target's gcc), built once and cached by Docker. As the caller's user, so what it leaves behind is
# theirs.
cargo() {
	if [ ! -f "$BUILD_CRATE/Cargo.toml" ]; then
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
	v8
	if [ -n "${RUSTY_V8_ARCHIVE:-}" ]; then
		set -- -v "$(realpath "$RUSTY_V8_ARCHIVE"):/v8/$(basename "$RUSTY_V8_ARCHIVE"):ro" \
			-e RUSTY_V8_ARCHIVE="/v8/$(basename "$RUSTY_V8_ARCHIVE")" "$@"
	fi
	if [ -n "${RUSTY_V8_SRC_BINDING_PATH:-}" ]; then
		set -- -v "$(realpath "$RUSTY_V8_SRC_BINDING_PATH"):/v8/$(basename "$RUSTY_V8_SRC_BINDING_PATH"):ro" \
			-e RUSTY_V8_SRC_BINDING_PATH="/v8/$(basename "$RUSTY_V8_SRC_BINDING_PATH")" "$@"
	fi
	docker volume create kantel-isolate-cargo >/dev/null
	docker run --rm --user 0 -v kantel-isolate-cargo:/cargo kantel-isolate-builder:local chown "$(id -u):$(id -g)" /cargo
	docker run --rm --user "$(id -u):$(id -g)" -v kantel-isolate-cargo:/cargo -e CARGO_HOME=/cargo -e HOME=/tmp \
		-v "$BUILD_CRATE:/src:ro" -v "$TARGET_DIR:/target" -w /src "$@"
}

# The guest bundle (the shell, node and python guests) is compiled into the binary, so it's built first, here.
BUILD_CRATE=$CRATE
FEATURES=
if [ -z "${KANTEL_ISOLATE_BINARY:-}" ] && [ -f "$CRATE/Cargo.toml" ]; then
	(cd "$CRATE" && bun install --frozen-lockfile >/dev/null && bun run guest/build.ts >&2)
	# The sandboxed V8 needs deno_core and serde_v8 with Kantel's patches, which only link against it: build a copy of
	# the crate that has them (v8/sandbox-crate.sh), with the same lock file but for those two.
	if [ "${KANTEL_V8_SANDBOX:-}" = 1 ]; then
		BUILD_CRATE="$MODULE/dist/.isolate-sandbox-src"
		"$CRATE/v8/sandbox-crate.sh" "$BUILD_CRATE"
		FEATURES="--features v8-sandbox"
	fi
fi

if [ "$ARCH" = test ]; then
	# shellcheck disable=SC2086 # FEATURES is empty or one flag and its value.
	cargo kantel-isolate-builder:local sh -euc "cargo fmt --check && cargo clippy --locked --all-targets $FEATURES -- -D warnings && cargo test --locked $FEATURES"
	exit 0
fi

mkdir -p "$MODULE/dist"
BIN="$MODULE/dist/kantel-isolate-$ARCH"
ASSETS="$MODULE/dist/isolate-assets-$ARCH"
if [ -n "${KANTEL_ISOLATE_BINARY:-}" ]; then
	cp "$KANTEL_ISOLATE_BINARY" "$BIN"
else
	# shellcheck disable=SC2086 # FEATURES is empty or one flag and its value.
	cargo kantel-isolate-builder:local cargo build --locked --release --bin kantel-isolate $FEATURES
	cp "$TARGET_DIR/$TRIPLE/release/kantel-isolate" "$BIN"
fi
chmod 0755 "$BIN"

rm -rf "$ASSETS"
if [ -n "${KANTEL_ISOLATE_ASSETS:-}" ]; then
	cp -r "$KANTEL_ISOLATE_ASSETS" "$ASSETS"
elif [ -x "$CRATE/build-assets.sh" ]; then
	# The Pyodide memory snapshot is made by running the binary, and is the same for every architecture: a binary for
	# this machine makes it (the one just built, or, cross-building, one built for this machine first).
	SNAPSHOT_BIN="$MODULE/dist/kantel-isolate-$BUILD_ARCH"
	[ -x "$SNAPSHOT_BIN" ] || { echo "making $ARCH's assets needs $SNAPSHOT_BIN: build $BUILD_ARCH first" >&2; exit 1; }
	"$CRATE/build-assets.sh" "$ASSETS" --bin "$SNAPSHOT_BIN" --cache "$MODULE/dist/.isolate-assets-cache"
else
	echo "no $CRATE/build-assets.sh: set KANTEL_ISOLATE_ASSETS to use a built assets directory" >&2
	exit 1
fi
chmod -R u+rwX,go+rX-w "$ASSETS"
echo "$BIN"
echo "$ASSETS"
