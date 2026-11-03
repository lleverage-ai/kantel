#!/bin/sh
# Installs kantel-host from Kantel's GitHub Release and joins this machine to Kantel, with one command:
#
#   curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_...
#
# The same line works in bash, zsh and fish: the script runs under sh whatever your shell is. It
#   1. picks the binary for this machine (Linux x86_64 or arm64);
#   2. downloads it and SHA256SUMS from the release this script came from, and checks the binary's SHA-256;
#   3. runs `kantel-host install` with your options, which checks /dev/kvm, copies the binary to
#      /usr/local/bin/kantel-host, fetches Firecracker and the images, registers with Kantel and starts the service.
#
# Every option goes on to `kantel-host install` (`kantel-host install -h` lists them), except these, which come first:
#   --version V   install release V (such as 0.1.0) rather than this script's own
#   --no-join     only put the binary in /usr/local/bin (KANTEL_BIN_DIR), without installing the service
# KANTEL_RELEASE_URL downloads from elsewhere: a directory URL holding the release's files, for a mirror or a test.
#
# tools/release/pack.sh stamps the release's version below. The whole script is read before anything runs (see the
# last line), so a download cut short does nothing.
set -eu

KANTEL_RELEASE_VERSION="__KANTEL_VERSION__"
REPO="lleverage-ai/kantel"

say() { printf '%s\n' "$*" >&2; }
die() {
	say "kantel-host install.sh: $*"
	exit 1
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "needs sha256sum (coreutils) or shasum to check the download"
	fi
}

main() {
	version=$KANTEL_RELEASE_VERSION
	join=1
	while [ $# -gt 0 ]; do
		case "$1" in
		--version)
			[ $# -ge 2 ] || die "--version needs a value, such as 0.1.0"
			version=${2#v}
			shift 2
			;;
		--version=*)
			version=${1#--version=}
			version=${version#v}
			shift
			;;
		--no-join)
			join=0
			shift
			;;
		*) break ;;
		esac
	done

	[ "$(uname -s)" = Linux ] || die "kantel-host runs on Linux (x86_64 or arm64), not $(uname -s)"
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die "kantel-host runs on x86_64 or arm64, not $(uname -m)" ;;
	esac
	command -v curl >/dev/null 2>&1 || die "needs curl"

	if [ -n "${KANTEL_RELEASE_URL:-}" ]; then
		base=${KANTEL_RELEASE_URL%/}
	elif [ "$version" = "__KANTEL_""VERSION__" ] || [ "$version" = latest ]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		base="https://github.com/$REPO/releases/download/v$version"
	fi
	asset="kantel-host-linux-$arch"

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT INT TERM
	say "Downloading $asset from $base"
	curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "couldn't download $base/$asset"
	curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"
	want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
	[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
	got=$(sha256 "$work/$asset")
	[ "$got" = "$want" ] || die "$asset's SHA-256 is $got, but SHA256SUMS says $want; not installing it"
	chmod 0755 "$work/$asset"
	say "Checked $asset ($("$work/$asset" version))"

	if [ "$join" = 0 ]; then
		dir=${KANTEL_BIN_DIR:-/usr/local/bin}
		mkdir -p "$dir"
		cp "$work/$asset" "$dir/kantel-host.new"
		mv "$dir/kantel-host.new" "$dir/kantel-host"
		say "Installed $dir/kantel-host. Join with: sudo kantel-host install --url <kantel> --token <kth_...>"
		return 0
	fi
	[ "$(id -u)" = 0 ] || die "joining installs a system service, so it needs root: put sudo before sh, as in: curl -fsSL $base/install.sh | sudo sh -s -- --url ... --token ..."
	"$work/$asset" install "$@"
}

main "$@"
