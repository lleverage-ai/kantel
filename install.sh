#!/bin/sh
# Partan, by Lleverage: install and run it on this machine with one command.
#
#   curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh
#
# Options go after `sh -s --`, as in `curl -fsSL <url> | sh -s -- --port 9000 --no-open`, or in the environment, as in
# `curl -fsSL <url> | env PARTAN_PORT=9000 sh`. Both forms work in bash, zsh and fish. Run with --help for the list.
#
# What it does, each step skipped when it is already done, so running it again is safe:
#   1. checks for what it needs: Docker with Compose v2, curl and tar (no Node.js, pnpm or Bun: everything builds and
#      runs in containers) and says how to get anything missing;
#   2. puts the source in ~/.partan/src (a GitHub tarball, or a checkout with --source);
#   3. writes ~/.partan/partan.env, readable by you only, with this install's settings and freshly generated passwords
#      and keys (kept on later runs, since the data is sealed with them);
#   4. builds the images and starts the compose project `partan` (deploy/local/compose.yaml and browser.yaml): the
#      gateway and console, Postgres, MinIO, Mailpit and Harbour's own browsers. Docker restarts them with the daemon;
#   5. waits for the console, prints its URL and opens it in a browser when there is one.
#
# It installs ~/.partan/bin/partan to manage it afterwards: status, stop, start, logs, upgrade and uninstall.
# No credentials are asked for or stored here: models and connectors are set up in the console's onboarding, and their
# credentials go to Partan's vault.

set -eu

# Where the source comes from by default. While the repository is private, see --help for installing with gh.
DEFAULT_REPO="tvdavies/harbour"
DEFAULT_REF="main"
DEFAULT_PORT=8470

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
warn() { printf '    warning: %s\n' "$*" >&2; }
die() {
	printf '\nerror: %s\n' "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit 1
}

usage() {
	cat <<'EOF'
Install and run Partan locally.

  curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh -s -- [options]
  sh install.sh [options]                  from a checkout: installs that checkout

Options (each has an environment variable, for `| env NAME=value sh`):
  --home DIR        where Partan lives (PARTAN_HOME, default ~/.partan)
  --port N          the console's port on 127.0.0.1 (PARTAN_PORT, default 8470)
  --mail-port N     the local mailbox's port on 127.0.0.1 (PARTAN_MAIL_PORT, default the console's port + 1)
  --email ADDRESS   the first admin, who signs in (PARTAN_ADMIN_EMAIL, default admin@partan.localhost)
  --ref REF         the branch, tag or commit to install (PARTAN_REF, default main)
  --repo OWNER/NAME the GitHub repository (PARTAN_REPO, default tvdavies/harbour)
  --source DIR      install a local checkout instead of downloading (PARTAN_SOURCE)
  --tarball URL     install from this .tar.gz (a URL or a file) instead of GitHub (PARTAN_TARBALL)
  --upgrade         download the source again even if it is already there (PARTAN_UPGRADE=1)
  --no-browser      leave out Harbour's own browsers (PARTAN_BROWSER=off; --with-browser puts them back)
  --no-start        set everything up but don't build or start (PARTAN_NO_START=1)
  --no-open         don't open the console in a browser (PARTAN_NO_OPEN=1)
  -h, --help        this help

Nothing is interactive: the same command works on a headless machine or in CI.

While the repository is private, the GitHub CLI can fetch both the script and the source with your login:

  gh api -H 'Accept: application/vnd.github.raw' repos/tvdavies/harbour/contents/install.sh | sh
EOF
}

# Settings: flags win over the environment, which wins over what an earlier install saved in partan.env.
PARTAN_HOME="${PARTAN_HOME:-$HOME/.partan}"
opt_port="${PARTAN_PORT:-}"
opt_mail_port="${PARTAN_MAIL_PORT:-}"
opt_email="${PARTAN_ADMIN_EMAIL:-}"
opt_ref="${PARTAN_REF:-}"
opt_repo="${PARTAN_REPO:-}"
opt_source="${PARTAN_SOURCE:-}"
opt_tarball="${PARTAN_TARBALL:-}"
opt_browser="${PARTAN_BROWSER:-}"
opt_upgrade="${PARTAN_UPGRADE:-}"
opt_no_start="${PARTAN_NO_START:-}"
opt_no_open="${PARTAN_NO_OPEN:-}"

need_value() {
	[ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value" "Run with --help for the options."
}
while [ $# -gt 0 ]; do
	case "$1" in
	--home) need_value "$@"; PARTAN_HOME="$2"; shift 2 ;;
	--port) need_value "$@"; opt_port="$2"; shift 2 ;;
	--mail-port) need_value "$@"; opt_mail_port="$2"; shift 2 ;;
	--email) need_value "$@"; opt_email="$2"; shift 2 ;;
	--ref) need_value "$@"; opt_ref="$2"; shift 2 ;;
	--repo) need_value "$@"; opt_repo="$2"; shift 2 ;;
	--source) need_value "$@"; opt_source="$2"; shift 2 ;;
	--tarball) need_value "$@"; opt_tarball="$2"; shift 2 ;;
	--upgrade) opt_upgrade=1; shift ;;
	--no-browser) opt_browser=off; shift ;;
	--with-browser) opt_browser=on; shift ;;
	--no-start) opt_no_start=1; shift ;;
	--no-open) opt_no_open=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "unknown option: $1" "Run with --help for the options." ;;
	esac
done

case "$PARTAN_HOME" in
/*) ;;
*) PARTAN_HOME="$(pwd)/$PARTAN_HOME" ;;
esac
ENV_FILE="$PARTAN_HOME/partan.env"
SRC="$PARTAN_HOME/src"

# Docker builds from the extracted source; a umask like 077 would leave it unreadable to the build (EACCES).
umask 022

say "Partan, by Lleverage: local install into $PARTAN_HOME"

# --- 1. What it needs -----------------------------------------------------------------------------------------------

step "Checking what Partan needs"
os="$(uname -s)"
case "$os" in
Linux | Darwin) ok "$os $(uname -m)" ;;
*) die "Partan installs on Linux and macOS; this is $os." "On Windows, run this in WSL 2 with Docker Desktop's WSL integration." ;;
esac

missing=0
docker_help() {
	if [ "$os" = Darwin ]; then
		say "       Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack"
		say "       (https://orbstack.dev), start it, then run this again."
	else
		say "       Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/"
		say "       (or Docker Desktop: https://docs.docker.com/desktop/setup/install/linux/), then run this again."
	fi
}
if ! command -v docker >/dev/null 2>&1; then
	say "    missing: docker"
	docker_help
	missing=1
elif ! docker compose version >/dev/null 2>&1; then
	say "    missing: Docker Compose v2 (the \`docker compose\` plugin)"
	if [ "$os" = Darwin ]; then
		say "       It comes with Docker Desktop and OrbStack; with Colima, run: brew install docker-compose"
	else
		say "       Install the docker-compose-plugin package: https://docs.docker.com/compose/install/linux/"
	fi
	missing=1
else
	ok "$(docker --version)"
	ok "$(docker compose version)"
	if ! docker_info="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
		case "$docker_info" in
		*"permission denied"*)
			say "    Docker is installed, but you can't use it: permission denied on its socket."
			say "       Add yourself to the docker group with: sudo usermod -aG docker $(id -un)"
			say "       then log out and back in (or run: newgrp docker), and run this again."
			;;
		*)
			say "    Docker is installed, but its daemon isn't answering:"
			say "       $(printf '%s' "$docker_info" | tail -n 1)"
			if [ "$os" = Darwin ]; then
				say "       Start Docker Desktop (or OrbStack, or: colima start), then run this again."
			else
				say "       Start it with: sudo systemctl start docker (or start Docker Desktop), then run this again."
			fi
			;;
		esac
		missing=1
	else
		ok "Docker daemon $docker_info is running"
	fi
fi
if ! command -v curl >/dev/null 2>&1; then
	say "    missing: curl (install it with your package manager, such as: sudo apt-get install curl)"
	missing=1
fi
if ! command -v tar >/dev/null 2>&1; then
	say "    missing: tar (install it with your package manager)"
	missing=1
fi
[ "$missing" -eq 0 ] || die "Install what's missing above, then run the same command again."
ok "Node.js, pnpm and Bun aren't needed here: everything builds and runs in containers"

# --- 2. The source --------------------------------------------------------------------------------------------------

# Saved settings from an earlier install, read without sourcing the file.
saved() {
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# A checkout this script was run from (`sh install.sh`), used when no other source is named. Not the install's own
# downloaded copy in src/, though: `partan upgrade` runs that one.
script_dir=""
case "$0" in
*/install.sh | install.sh) script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)" || script_dir="" ;;
esac
if [ -z "$opt_source" ] && [ -z "$opt_tarball" ] && [ -n "$script_dir" ] && [ -f "$script_dir/deploy/local/compose.yaml" ]; then
	if [ -L "$SRC" ] || [ ! -d "$SRC" ] || [ "$(cd "$SRC" && pwd -P)" != "$script_dir" ]; then
		opt_source="$script_dir"
	fi
fi
# An install from a checkout keeps using it (`partan upgrade` included) until a download is asked for.
if [ -z "$opt_source" ] && [ -z "$opt_tarball" ] && [ -z "$opt_ref" ] && [ -z "$opt_repo" ] && [ -L "$SRC" ]; then
	opt_source="$SRC"
fi

repo="${opt_repo:-$(saved PARTAN_REPO)}"
repo="${repo:-$DEFAULT_REPO}"
ref="${opt_ref:-$(saved PARTAN_REF)}"
ref="${ref:-$DEFAULT_REF}"

step "Getting the source"
mkdir -p "$PARTAN_HOME"
chmod 700 "$PARTAN_HOME"

fetch_tarball() { # $1: destination file
	if [ -n "$opt_tarball" ]; then
		case "$opt_tarball" in
		http://* | https://*) curl -fsSL --retry 3 -o "$1" "$opt_tarball" || die "Couldn't download $opt_tarball" ;;
		*) cp "$opt_tarball" "$1" || die "Couldn't read $opt_tarball" ;;
		esac
		return 0
	fi
	if curl -fsSL --retry 3 -o "$1" "https://codeload.github.com/$repo/tar.gz/$ref" 2>/dev/null; then
		return 0
	fi
	# A private repository: GitHub answers 404 without a login. The GitHub CLI has one.
	if command -v gh >/dev/null 2>&1 && gh api "repos/$repo/tarball/$ref" >"$1" 2>/dev/null; then
		return 0
	fi
	die "Couldn't download $repo at $ref from GitHub." \
		"Check the --ref, and your connection. If the repository is private, sign in to the GitHub CLI (gh auth login)" \
		"and run this again, or install from a checkout: sh install.sh --source <checkout>"
}

if [ -n "$opt_source" ]; then
	source_dir="$(cd "$opt_source" 2>/dev/null && pwd -P)" || die "--source $opt_source isn't a directory"
	[ -f "$source_dir/deploy/local/compose.yaml" ] ||
		die "$source_dir isn't a Partan checkout with the local installer (no deploy/local/compose.yaml)"
	if [ -L "$SRC" ] && [ "$(cd "$SRC" && pwd -P)" = "$source_dir" ]; then
		ok "using the checkout at $source_dir"
	else
		rm -rf "$SRC"
		ln -s "$source_dir" "$SRC"
		ok "linked $SRC to the checkout at $source_dir"
	fi
	source_kind=checkout
elif [ -d "$SRC" ] && [ ! -L "$SRC" ] && [ -f "$SRC/deploy/local/compose.yaml" ] && [ -z "$opt_upgrade" ] &&
	[ -z "$opt_tarball" ] && [ "$ref" = "$(saved PARTAN_REF)" ] && [ "$repo" = "$(saved PARTAN_REPO)" ]; then
	ok "already in $SRC ($repo at $ref); --upgrade fetches it again"
	source_kind=tarball
else
	work="$(mktemp -d "${TMPDIR:-/tmp}/partan.XXXXXX")"
	trap 'rm -rf "$work"' EXIT INT TERM
	if [ -n "$opt_tarball" ]; then say "    downloading $opt_tarball"; else say "    downloading $repo at $ref"; fi
	fetch_tarball "$work/source.tar.gz"
	mkdir "$work/x"
	tar -xzf "$work/source.tar.gz" -C "$work/x" || die "The download isn't a .tar.gz archive."
	top="$(find "$work/x" -mindepth 1 -maxdepth 1)"
	[ "$(printf '%s\n' "$top" | wc -l | tr -d ' ')" = 1 ] && [ -d "$top" ] || top="$work/x"
	[ -f "$top/deploy/local/compose.yaml" ] ||
		die "That source has no deploy/local/compose.yaml: is --ref a version with the local installer?"
	rm -rf "$SRC.new"
	mv "$top" "$SRC.new"
	if [ -L "$SRC" ]; then rm -f "$SRC"; else rm -rf "$SRC"; fi
	mv "$SRC.new" "$SRC"
	ok "unpacked into $SRC"
	source_kind=tarball
fi

# --- 3. Settings and keys -------------------------------------------------------------------------------------------

step "Settings and keys"
random_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
random_base64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

if [ ! -f "$ENV_FILE" ]; then
	(
		umask 077
		cat >"$ENV_FILE" <<EOF
# Partan's local install. Written by install.sh; keep it private. The passwords and keys were generated for this
# install: Postgres was created with them and the vault, browser profiles and recordings are sealed with them, so
# changing one loses that data. Settings (port, email, browser) can be changed by running install.sh with new flags.
PARTAN_POSTGRES_PASSWORD=$(random_hex)
PARTAN_S3_SECRET=$(random_hex)
PARTAN_VAULT_CIPHER_KEY=$(random_base64)
PARTAN_BROWSER_HOST_TOKEN=$(random_hex)
PARTAN_BROWSER_VIEW_KEY=$(random_hex)
PARTAN_BROWSER_SEAL_KEY=$(random_hex)
EOF
	)
	ok "generated this install's passwords and keys in $ENV_FILE"
else
	ok "keeping the passwords and keys in $ENV_FILE"
fi
chmod 600 "$ENV_FILE"

# Sets NAME=value in the env file, replacing any earlier line for it.
set_setting() {
	tmp="$ENV_FILE.tmp"
	(umask 077 && grep -v "^$1=" "$ENV_FILE" >"$tmp" || true)
	printf '%s=%s\n' "$1" "$2" >>"$tmp"
	mv "$tmp" "$ENV_FILE"
}

port="${opt_port:-$(saved PARTAN_PORT)}"
port="${port:-$DEFAULT_PORT}"
mail_port="${opt_mail_port:-$(saved PARTAN_MAIL_PORT)}"
mail_port="${mail_port:-$((port + 1))}"
email="${opt_email:-$(saved PARTAN_ADMIN_EMAIL)}"
email="${email:-admin@partan.localhost}"
browser="${opt_browser:-$(saved PARTAN_BROWSER)}"
browser="${browser:-on}"
for value in "$port" "$mail_port"; do
	case "$value" in
	'' | *[!0-9]*) die "Ports are numbers; got '$value'." ;;
	esac
done
case "$email" in
*@*.* | *@localhost) ;;
*) die "--email needs an email address; got '$email'." ;;
esac
case "$browser" in
on | off) ;;
*) die "PARTAN_BROWSER is on or off; got '$browser'." ;;
esac

# The Docker socket the browser host starts browsers through, as the daemon sees it. On Linux that's the socket the
# CLI talks to (rootless Docker's is under /run/user); Docker Desktop, OrbStack and Colima on macOS run the daemon in a
# VM, where it is /var/run/docker.sock whatever the Mac's own path.
docker_socket=/var/run/docker.sock
if [ "$os" = Linux ]; then
	endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}"
	case "$endpoint" in
	unix://*) [ -S "${endpoint#unix://}" ] && docker_socket="${endpoint#unix://}" ;;
	esac
fi

set_setting PARTAN_REPO "$repo"
set_setting PARTAN_REF "$ref"
set_setting PARTAN_SOURCE_KIND "$source_kind"
set_setting PARTAN_PORT "$port"
set_setting PARTAN_MAIL_PORT "$mail_port"
set_setting PARTAN_ADMIN_EMAIL "$email"
set_setting PARTAN_BROWSER "$browser"
set_setting PARTAN_DOCKER_SOCKET "$docker_socket"
ok "console on 127.0.0.1:$port, mailbox on 127.0.0.1:$mail_port, admin $email, browsers $browser"

# The management command, copied so it outlives an upgrade's swap of src/.
mkdir -p "$PARTAN_HOME/bin"
cp "$SRC/deploy/local/partan" "$PARTAN_HOME/bin/partan.new"
chmod 755 "$PARTAN_HOME/bin/partan.new"
mv "$PARTAN_HOME/bin/partan.new" "$PARTAN_HOME/bin/partan"
partan="$PARTAN_HOME/bin/partan"
ok "installed $partan"
# Also on PATH when ~/.local/bin is (as on most Linux desktops), for the default home only, and unless something else
# is called partan there. Best effort: a read-only ~/.local/bin just means the full path.
link="$HOME/.local/bin/partan"
if [ "$PARTAN_HOME" = "$HOME/.partan" ] && [ -d "$HOME/.local/bin" ] && { [ ! -e "$link" ] || [ -L "$link" ]; }; then
	case ":$PATH:" in
	*":$HOME/.local/bin:"*)
		if ln -sf "$partan" "$link" 2>/dev/null; then
			partan=partan
			ok "linked $link, so \`partan\` works from any directory"
		fi
		;;
	esac
fi

if [ -n "$opt_no_start" ]; then
	say ""
	say "Set up, not started (--no-start). Start it with: $partan start"
	exit 0
fi

# --- 4. Build and start ---------------------------------------------------------------------------------------------

# A port someone else already has: compose would fail late with a bind error, so say it now.
port_taken() { # $1: port; true when something other than this install's containers answers there
	curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" || return 1
	[ -z "$("$PARTAN_HOME/bin/partan" compose ps -q --status running gateway mailpit 2>/dev/null)" ]
}
for p in "$port" "$mail_port"; do
	if port_taken "$p"; then
		die "Something else is already listening on 127.0.0.1:$p." "Pick other ports with --port (and --mail-port), such as:" \
			"curl -fsSL https://raw.githubusercontent.com/$DEFAULT_REPO/main/install.sh | sh -s -- --port 9470"
	fi
done

step "Building the images (the first time takes a few minutes)"
"$PARTAN_HOME/bin/partan" compose build || die "The image build failed; the output above says why." \
	"Run the same command again once it's fixed: finished steps are skipped."
ok "images built"

step "Starting Partan"
"$PARTAN_HOME/bin/partan" start --no-open || die "Partan didn't start; the output above says why." \
	"See the logs with: $partan logs"

# --- 5. Open it -----------------------------------------------------------------------------------------------------

url="http://127.0.0.1:$port/"
say ""
say "  Console:  $url"
say "  Sign in:  $email (the one-time code arrives in the local mailbox: http://127.0.0.1:$mail_port/)"
say ""
say "  Manage:   $partan status | stop | start | logs | upgrade | uninstall"
say "  Remote:   on a machine you reach over SSH, forward the port first: ssh -L $port:127.0.0.1:$port <host>"
if [ -z "$opt_no_open" ]; then
	"$PARTAN_HOME/bin/partan" open --quiet || true
fi
