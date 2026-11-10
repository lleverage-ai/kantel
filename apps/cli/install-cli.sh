#!/bin/sh
# Installs Kantel's CLI, `kantel`, from Kantel's GitHub Release, for you alone and without sudo:
#
#   curl -fsSL https://kantel.dev/cli.sh | sh
#
# kantel.dev serves this file as it is in the repository (apps/site copies it in as it builds), so it installs the
# latest release. Each release has its own copy too, stamped with its version, which installs that release:
#
#   curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install-cli.sh | sh
#
# The same line works in bash, zsh and fish: the script runs under sh whatever your shell is. It
#   1. picks the binary for this machine: kantel-<os>-<arch>, for Linux or macOS on x86_64 or arm64 (one static
#      binary, with nothing else to install);
#   2. downloads it and SHA256SUMS from the release (kantel-admin-<os>-<arch> too, with --admin), and checks its
#      SHA-256 and that it runs;
#   3. puts it in ~/.local/bin (KANTEL_BIN_DIR, or --dir), and says how to put that on your PATH if it isn't.
# Run it again to update (or run `kantel update`); a running command keeps its file. It replaces a kantel installed
# by an older release of this script, when kantel was a Node.js program (a link to ~/.local/share/kantel/kantel.mjs).
#
# `kantel-admin`, the operator CLI that installs and upgrades a self-hosted control plane, comes with --admin. Once
# it's installed, running this again updates it too, unless you say --no-admin.
#
# Options, after `sh -s --` (as in `curl -fsSL https://kantel.dev/cli.sh | sh -s -- --admin`):
#   --version V   install release V (such as 0.1.0) rather than this script's own
#   --dir DIR     install the commands in DIR rather than ~/.local/bin (KANTEL_BIN_DIR)
#   --admin       install `kantel-admin` as well
#   --no-admin    install `kantel` only, even where kantel-admin is installed already
# KANTEL_RELEASE_URL downloads from elsewhere: a directory URL holding the release's files, for a mirror or a test.
#
# tools/release/pack.sh stamps the release's version below; unstamped, as kantel.dev serves it, it installs the latest.
# The whole script is read before anything runs (see the last line), so a download cut short does nothing.
set -eu

KANTEL_RELEASE_VERSION="__KANTEL_VERSION__"
REPO="lleverage-ai/kantel"

say() { printf '%s\n' "$*" >&2; }
die() {
	say "kantel install-cli.sh: $*"
	exit 1
}

# listed FILE: SHA256SUMS's SHA-256 for FILE, or nothing.
listed() {
	awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS"
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

# platform: this machine's part of the binaries' names, such as linux-amd64 or darwin-arm64.
platform() {
	case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) die "Kantel's CLI is for Linux and macOS, not $(uname -s)" ;;
	esac
	case "$(uname -m)" in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) die "Kantel's CLI is for x86_64 and arm64, not $(uname -m)" ;;
	esac
	# A shell under Rosetta says x86_64 on an Apple silicon Mac; the arm64 binary is the one to run there.
	if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
		arch=arm64
	fi
	printf '%s-%s\n' "$os" "$arch"
}

main() {
	version=$KANTEL_RELEASE_VERSION
	bin=${KANTEL_BIN_DIR:-}
	# kantel-admin: 1 asked for, 0 refused, empty for "only if it's installed already".
	admin=
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
		--dir)
			[ $# -ge 2 ] || die "--dir needs a directory"
			bin=$2
			shift 2
			;;
		--dir=*)
			bin=${1#--dir=}
			shift
			;;
		--admin)
			admin=1
			shift
			;;
		--no-admin)
			admin=0
			shift
			;;
		-h | --help)
			say "usage: install-cli.sh [--version V] [--dir DIR] [--admin | --no-admin]"
			return 0
			;;
		*) die "unknown option $1 (--version, --dir, --admin and --no-admin are the options)" ;;
		esac
	done

	[ -n "${HOME:-}" ] || die "HOME isn't set"
	bin=${bin:-$HOME/.local/bin}
	# Where the Node.js releases put kantel.mjs and kantel-admin.mjs, linked from bin: replaced, then removed.
	old=${KANTEL_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/kantel}

	plat=$(platform)
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
	# Neither flag: kantel-admin is updated where it is installed already, by this script (a binary) or an older one
	# (a link to kantel-admin.mjs).
	if [ -z "$admin" ]; then
		admin=0
		if [ -f "$bin/kantel-admin" ] || [ -L "$bin/kantel-admin" ]; then admin=1; fi
	fi
	commands="kantel"
	if [ "$admin" = 1 ]; then commands="kantel kantel-admin"; fi

	# Only a file this script put there is replaced: a binary, or the older script's link to its .mjs.
	for command in $commands; do
		if [ -L "$bin/$command" ]; then
			target=$(readlink "$bin/$command")
			[ "$target" = "$old/$command.mjs" ] ||
				die "$bin/$command is already there, a link to $target that this script didn't make; remove it, or use --dir for another directory"
		elif [ -e "$bin/$command" ] && [ ! -f "$bin/$command" ]; then
			die "$bin/$command is already there and isn't a file; remove it, or use --dir for another directory"
		fi
	done

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	trap 'rm -rf "$work"; exit 130' INT
	trap 'rm -rf "$work"; exit 143' TERM
	curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"
	for command in $commands; do
		asset="$command-$plat"
		say "Downloading $asset from $base"
		want=$(listed "$asset")
		[ -n "$want" ] || die "SHA256SUMS has no line for $asset: the release has no $command for this machine"
		curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "couldn't download $base/$asset"
		got=$(sha256 "$work/$asset")
		[ "$got" = "$want" ] || die "$asset's SHA-256 is $got, but SHA256SUMS says $want; not installing it"
		chmod 0755 "$work/$asset"
		"$work/$asset" --version >/dev/null 2>&1 || die "the downloaded $asset doesn't run on this machine; not installing it"
	done
	say "Checked the download against SHA256SUMS"

	# Copied in beside the old one and renamed over it, so a command that is running keeps its file and an install cut
	# short leaves the old one as it was.
	mkdir -p "$bin"
	for command in $commands; do
		linked=
		if [ -L "$bin/$command" ]; then linked=1; fi
		cp "$work/$command-$plat" "$bin/.$command.new"
		chmod 0755 "$bin/.$command.new"
		mv -f "$bin/.$command.new" "$bin/$command"
		say "Installed $bin/$command $("$bin/$command" --version)"
		# The link this replaced was the Node.js release's: its file goes too.
		if [ -n "$linked" ]; then
			rm -f "$old/$command.mjs"
			rmdir "$old" 2>/dev/null || true
		fi
	done

	case ":${PATH:-}:" in
	*":$bin:"*) ;;
	*)
		say ""
		say "$bin isn't on your PATH. To put it there:"
		say "  fish:      fish_add_path $bin"
		say "  bash, zsh: add  export PATH=\"$bin:\$PATH\"  to ~/.bashrc or ~/.zshrc, then open a new terminal"
		;;
	esac
	# An update (KANTEL_UPDATE, as the Node.js release's `kantel update` set it): someone updating is signed in already.
	[ -z "${KANTEL_UPDATE:-}" ] || return 0
	say "Next: kantel login (or kantel login --url <url> for your own Kantel)"
	if [ "$admin" = 0 ]; then
		say "Self-hosting? Add kantel-admin with: curl -fsSL https://kantel.dev/cli.sh | sh -s -- --admin"
	fi
}

main "$@"
