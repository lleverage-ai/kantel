#!/bin/sh
# Installs kantel-host from Kantel's GitHub Release and joins this machine to Kantel, with one command:
#
#   curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_...
#
# The same line works in bash, zsh and fish: the script runs under sh whatever your shell is. It
#   1. picks the binary for this machine (Linux x86_64 or arm64);
#   2. downloads it and SHA256SUMS from the release this script came from, and checks the binary's SHA-256;
#   3. puts it at /usr/local/bin/kantel-host, and runs its `install` with your options, which checks /dev/kvm,
#      fetches Firecracker and the images, registers with Kantel and starts the service.
#
# Every option goes on to `kantel-host install` (`kantel-host install -h` lists them), except these, which come first:
#   --version V   install release V (such as 0.1.0) rather than this script's own
#   --no-join     only put the binary in /usr/local/bin (KANTEL_BIN_DIR), without installing the service
#   --check       only check this machine: run the downloaded binary's `doctor` from a temporary directory, and exit
#                 with its status (0 only when every required check passes). Nothing is installed
# --dry-run, anywhere in the options, downloads and checks the binary into a temporary directory and runs its
# `install --dry-run`, which prints every download, file, directory, unit, command and registration the install would
# make, and changes nothing (the token isn't used).
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
	check=0
	dry_run=0
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
		--check)
			check=1
			shift
			;;
		*) break ;;
		esac
	done
	# --dry-run can come anywhere, and stays in the options for `kantel-host install --dry-run`.
	for arg in "$@"; do
		case "$arg" in
		--dry-run | -dry-run | --dry-run=true | -dry-run=true) dry_run=1 ;;
		--check) check=1 ;;
		esac
	done

	[ "$(uname -s)" = Linux ] || die "kantel-host runs on Linux (x86_64 or arm64), not $(uname -s)"
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die "kantel-host runs on x86_64 or arm64, not $(uname -m)" ;;
	esac
	command -v curl >/dev/null 2>&1 || die "needs curl"
	command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
		die "needs sha256sum (coreutils) or shasum to check the download"

	if [ -n "${KANTEL_RELEASE_URL:-}" ]; then
		base=${KANTEL_RELEASE_URL%/}
	elif [ "$version" = "__KANTEL_""VERSION__" ] || [ "$version" = latest ]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		base="https://github.com/$REPO/releases/download/v$version"
	fi
	asset="kantel-host-linux-$arch"

	if [ "$check" = 1 ] && [ "$(id -u)" != 0 ]; then
		die "--check runs kantel-host doctor, which checks this machine as the service will run, as root, so it needs root: put sudo before sh, as in: curl -fsSL $base/install.sh | sudo sh -s -- --check"
	fi
	if [ "$join" = 1 ] && [ "$(id -u)" != 0 ]; then
		if [ "$dry_run" = 1 ]; then
			die "--dry-run reads this machine as the install would, as root, so it needs root too (it changes nothing): put sudo before sh, as in: curl -fsSL $base/install.sh | sudo sh -s -- --dry-run --url ... --token ..."
		fi
		die "joining installs a system service, so it needs root: put sudo before sh, as in: curl -fsSL $base/install.sh | sudo sh -s -- --url ... --token ..."
	fi

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	trap 'rm -rf "$work"; exit 130' INT
	trap 'rm -rf "$work"; exit 143' TERM
	say "Downloading $asset from $base"
	curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "couldn't download $base/$asset"
	curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"
	want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
	[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
	got=$(sha256 "$work/$asset")
	[ "$got" = "$want" ] || die "$asset's SHA-256 is $got, but SHA256SUMS says $want; not installing it"
	say "Checked $asset against SHA256SUMS"
	dir=${KANTEL_BIN_DIR:-/usr/local/bin}

	# --check and --dry-run change nothing: they run the binary from the temporary directory.
	if [ "$check" = 1 ] || [ "$dry_run" = 1 ]; then
		chmod 0755 "$work/$asset"
		if [ "$check" = 1 ] || [ "$join" = 1 ]; then
			"$work/$asset" version >/dev/null 2>&1 ||
				die "couldn't run $asset from $work: if its filesystem is mounted noexec, set TMPDIR to a directory on another one"
		fi
	fi
	if [ "$check" = 1 ]; then
		# doctor takes the install options that change what's checked: --root, --config and --isolate-runtime.
		n=$#
		while [ "$n" -gt 0 ]; do
			arg=$1
			shift
			n=$((n - 1))
			case "$arg" in
			--root | --config | --isolate-runtime)
				if [ "$n" -gt 0 ]; then
					set -- "$@" "$arg" "$1"
					shift
					n=$((n - 1))
				fi
				;;
			--root=* | --config=* | --isolate-runtime=* | --json) set -- "$@" "$arg" ;;
			esac
		done
		status=0
		"$work/$asset" doctor "$@" || status=$?
		exit "$status"
	fi
	if [ "$dry_run" = 1 ]; then
		echo "==> Download kantel-host"
		echo "  get    $base/$asset (sha256 $want, from $base/SHA256SUMS): downloaded and checked now, into a temporary directory"
		if [ "$join" = 0 ]; then
			echo "  write  $dir/kantel-host (mode 0755)"
			echo
			echo "Dry run: nothing has been changed. Run the same command without --dry-run to install."
			return 0
		fi
		# Its plan has the rest, from putting the binary in place to starting the service.
		"$work/$asset" install "$@"
		return
	fi

	# Into place first, and run from there: /tmp may be mounted noexec. A rename, so a running kantel-host keeps its
	# file; `kantel-host install` doesn't copy a binary that is already at /usr/local/bin/kantel-host.
	mkdir -p "$dir"
	cp "$work/$asset" "$dir/kantel-host.new"
	chmod 0755 "$dir/kantel-host.new"
	mv -f "$dir/kantel-host.new" "$dir/kantel-host"
	say "Installed $dir/kantel-host $("$dir/kantel-host" version)"

	if [ "$join" = 0 ]; then
		say "Join with: sudo kantel-host install --url <kantel> --token <kth_...>"
		return 0
	fi
	"$dir/kantel-host" install "$@"
}

main "$@"
