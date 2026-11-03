#!/bin/sh
# Installs Kantel's commands, `kantel` and `kantel-admin`, from Kantel's GitHub Release, for you alone and without sudo:
#
#   curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install-cli.sh | sh
#
# The same line works in bash, zsh and fish: the script runs under sh whatever your shell is. It
#   1. checks Node.js 22 or later is installed: both commands are one JavaScript file each, for Linux and macOS alike;
#   2. downloads kantel.js, kantel-admin.js and SHA256SUMS from the release this script came from, and checks each
#      file's SHA-256;
#   3. puts them in ~/.local/share/kantel (KANTEL_HOME) as kantel.mjs and kantel-admin.mjs, links ~/.local/bin/kantel
#      and ~/.local/bin/kantel-admin to them, and says how to put ~/.local/bin on your PATH if it isn't.
# Run it again to update; a running command keeps its file.
#
# Options, after `sh -s --` (as in `curl -fsSL …/install-cli.sh | sh -s -- --dir ~/bin`):
#   --version V   install release V (such as 0.1.0) rather than this script's own
#   --dir DIR     link the commands in DIR rather than ~/.local/bin (KANTEL_BIN_DIR)
#   --no-admin    install `kantel` only
# KANTEL_RELEASE_URL downloads from elsewhere: a directory URL holding the release's files, for a mirror or a test.
#
# tools/release/pack.sh stamps the release's version below. The whole script is read before anything runs (see the
# last line), so a download cut short does nothing.
set -eu

KANTEL_RELEASE_VERSION="__KANTEL_VERSION__"
REPO="lleverage-ai/kantel"

say() { printf '%s\n' "$*" >&2; }
die() {
	say "kantel install-cli.sh: $*"
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
	bin=${KANTEL_BIN_DIR:-}
	admin=1
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
		--no-admin)
			admin=0
			shift
			;;
		-h | --help)
			say "usage: install-cli.sh [--version V] [--dir DIR] [--no-admin]"
			return 0
			;;
		*) die "unknown option $1 (--version, --dir and --no-admin are the options)" ;;
		esac
	done

	[ -n "${HOME:-}" ] || die "HOME isn't set"
	bin=${bin:-$HOME/.local/bin}
	lib=${KANTEL_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/kantel}

	case "$(uname -s)" in
	Linux | Darwin) ;;
	*) say "warning: Kantel's commands are tested on Linux and macOS, not $(uname -s)" ;;
	esac
	command -v curl >/dev/null 2>&1 || die "needs curl"
	command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
		die "needs sha256sum (coreutils) or shasum to check the download"
	command -v node >/dev/null 2>&1 ||
		die "needs Node.js 22 or later (https://nodejs.org/en/download), then run this again"
	node_version=$(node -p 'process.versions.node' 2>/dev/null) || die "couldn't run node to check its version"
	[ "${node_version%%.*}" -ge 22 ] 2>/dev/null ||
		die "needs Node.js 22 or later, and this node ($(command -v node)) is $node_version"

	if [ -n "${KANTEL_RELEASE_URL:-}" ]; then
		base=${KANTEL_RELEASE_URL%/}
	elif [ "$version" = "__KANTEL_""VERSION__" ] || [ "$version" = latest ]; then
		base="https://github.com/$REPO/releases/latest/download"
	else
		base="https://github.com/$REPO/releases/download/v$version"
	fi
	commands="kantel"
	[ "$admin" = 1 ] && commands="kantel kantel-admin"

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	trap 'rm -rf "$work"; exit 130' INT
	trap 'rm -rf "$work"; exit 143' TERM
	curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"
	for command in $commands; do
		asset="$command.js"
		say "Downloading $asset from $base"
		curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "couldn't download $base/$asset"
		want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
		[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
		got=$(sha256 "$work/$asset")
		[ "$got" = "$want" ] || die "$asset's SHA-256 is $got, but SHA256SUMS says $want; not installing it"
	done
	say "Checked the download against SHA256SUMS"

	# Each file goes in as <command>.mjs, so Node runs it as an ES module whatever its version and whatever
	# package.json is above it, and the command on the PATH is a link to it (Node follows the link to the .mjs). A
	# rename into place, so a command that is running keeps its file.
	for command in $commands; do
		if [ -e "$bin/$command" ] && [ ! -L "$bin/$command" ]; then
			die "$bin/$command is already there and isn't a link this script made; remove it, or use --dir for another directory"
		fi
	done
	mkdir -p "$lib" "$bin"
	for command in $commands; do
		cp "$work/$command.js" "$lib/$command.mjs.new"
		chmod 0755 "$lib/$command.mjs.new"
		mv -f "$lib/$command.mjs.new" "$lib/$command.mjs"
		ln -sf "$lib/$command.mjs" "$bin/$command.new"
		mv -f "$bin/$command.new" "$bin/$command"
		say "Installed $bin/$command $("$bin/$command" --version)"
	done

	case ":${PATH:-}:" in
	*":$bin:"*) ;;
	*)
		say ""
		say "$bin isn't on your PATH. To put it there:"
		say "  fish:      fish_add_path $bin"
		say "  bash, zsh: add  export PATH=\"$bin:\$PATH\"  to ~/.bashrc or ~/.zshrc"
		;;
	esac
	say "Next: kantel login --url https://<your Kantel>"
}

main "$@"
