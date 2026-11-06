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
#   1. checks Node.js 22 or later is installed: each command is one JavaScript file, for Linux and macOS alike;
#   2. downloads kantel.js, kantel-console.tar.gz and SHA256SUMS from the release (kantel-admin.js too, with
#      --admin), and checks each file's SHA-256;
#   3. puts them in ~/.local/share/kantel (KANTEL_HOME) as kantel.mjs and console/ (the files `kantel console`
#      serves), links ~/.local/bin/kantel to it, and says how to put ~/.local/bin on your PATH if it isn't.
# Run it again to update; a running command keeps its file.
#
# `kantel-admin`, the operator CLI that installs and upgrades a self-hosted control plane, comes with --admin. Once
# it's installed, running this again updates it too, unless you say --no-admin.
#
# Options, after `sh -s --` (as in `curl -fsSL https://kantel.dev/cli.sh | sh -s -- --admin`):
#   --version V   install release V (such as 0.1.0) rather than this script's own
#   --dir DIR     link the commands in DIR rather than ~/.local/bin (KANTEL_BIN_DIR)
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
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "needs sha256sum (coreutils) or shasum to check the download"
	fi
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
	lib=${KANTEL_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/kantel}

	case "$(uname -s)" in
	Linux | Darwin) ;;
	*) say "warning: Kantel's commands are tested on Linux and macOS, not $(uname -s)" ;;
	esac
	command -v curl >/dev/null 2>&1 || die "needs curl"
	command -v tar >/dev/null 2>&1 || die "needs tar"
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
	# Neither flag: kantel-admin is updated where this script installed it before (its link in bin points into lib).
	if [ -z "$admin" ]; then
		admin=0
		if [ -L "$bin/kantel-admin" ] && [ -e "$lib/kantel-admin.mjs" ]; then admin=1; fi
	fi
	commands="kantel"
	if [ "$admin" = 1 ]; then commands="kantel kantel-admin"; fi

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	trap 'rm -rf "$work"; exit 130' INT
	trap 'rm -rf "$work"; exit 143' TERM
	curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "couldn't download $base/SHA256SUMS"
	assets=""
	for command in $commands; do assets="$assets $command.js"; done
	# The console's files, which `kantel console` serves: a release from before it had them installs without.
	console=0
	if [ -n "$(listed kantel-console.tar.gz)" ]; then
		console=1
		assets="$assets kantel-console.tar.gz"
	fi
	for asset in $assets; do
		say "Downloading $asset from $base"
		curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" || die "couldn't download $base/$asset"
		want=$(listed "$asset")
		[ -n "$want" ] || die "SHA256SUMS has no line for $asset"
		got=$(sha256 "$work/$asset")
		[ "$got" = "$want" ] || die "$asset's SHA-256 is $got, but SHA256SUMS says $want; not installing it"
	done
	say "Checked the download against SHA256SUMS"
	if [ "$console" = 1 ]; then
		mkdir "$work/unpacked"
		tar -xzf "$work/kantel-console.tar.gz" -C "$work/unpacked" || die "couldn't unpack kantel-console.tar.gz"
		[ -f "$work/unpacked/console/index.html" ] || die "kantel-console.tar.gz has no console/index.html"
	fi

	# Each file goes in as <command>.mjs, so Node runs it as an ES module whatever its version and whatever
	# package.json is above it, and the command on the PATH is a link to it (Node follows the link to the .mjs). A
	# rename into place, so a command that is running keeps its file.
	for command in $commands; do
		if [ -e "$bin/$command" ] && [ ! -L "$bin/$command" ]; then
			die "$bin/$command is already there and isn't a link this script made; remove it, or use --dir for another directory"
		fi
	done
	mkdir -p "$lib" "$bin"
	# The console goes in first, so the kantel that finds it is this release's. A rename into place, as the commands.
	if [ "$console" = 1 ]; then
		rm -rf "$lib/console.new" "$lib/console.old"
		mv "$work/unpacked/console" "$lib/console.new"
		[ -d "$lib/console" ] && mv "$lib/console" "$lib/console.old"
		mv "$lib/console.new" "$lib/console"
		rm -rf "$lib/console.old"
		say "Installed the console in $lib/console, for kantel console"
	else
		say "This release has no console files: kantel console needs --dir"
	fi
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
	say "Next: kantel login (or kantel login --url <url> for your own Kantel)"
	if [ "$admin" = 0 ]; then
		say "Self-hosting? Add kantel-admin with: curl -fsSL https://kantel.dev/cli.sh | sh -s -- --admin"
	fi
}

main "$@"
