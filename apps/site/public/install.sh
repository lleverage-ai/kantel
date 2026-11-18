#!/bin/sh
# Kantel, by Lleverage: install it on this machine and start it, with one command.
#
#   curl -fsSL https://kantel.dev/install.sh | sh
#
# The same line works in bash, zsh and fish: the script runs under sh whatever your shell is. Options go after
# `sh -s --`, as in `curl -fsSL https://kantel.dev/install.sh | sh -s -- --no-open`. Run with --help for the list.
#
# What it does:
#   1. checks for what it needs (Docker with Compose v2 and a running daemon, curl and tar) and says how to get
#      anything that's missing. Node.js and pnpm aren't needed: everything builds and runs in containers;
#   2. downloads Kantel's source from GitHub (a tarball of main, or --ref);
#   3. if that source has its own installer at its root (install.sh), hands over to it with your options, so this
#      command always installs the way the version you download expects;
#   4. otherwise keeps the source in ~/.kantel/src and starts the self-hosted Docker Compose stack in deploy/compose,
#      the path the docs describe (https://kantel.dev/docs/self-hosting/install/), waits for the console
#      and opens it. The stack is the gateway (the console and the compute plane's API), Postgres and Mailpit;
#      sandboxes run on the hosts you add from the console. With --upgrade, the new source replaces the old, keeping
#      deploy/compose/.env (your settings), and the stack is rebuilt and restarted with it; its data stays. Services
#      the new version no longer has (an older version's agent plane: session hosts, browsers, MinIO, the vault
#      proxy) are stopped and removed, but not their volumes. With --database-url (or KANTEL_DATABASE_URL in
#      deploy/compose/.env), the stack uses that Postgres, such as a managed one, instead of starting its own.
#
# The whole script is read before anything runs (see `main` at the end), so a download cut short does nothing.
# Nothing is interactive and no credentials are asked for.

set -eu

DEFAULT_REPO="lleverage-ai/kantel"
DEFAULT_REF="main"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() {
	printf '\nerror: %s\n' "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
	cat <<'EOF'
Install Kantel on this machine and start it.

  curl -fsSL https://kantel.dev/install.sh | sh
  curl -fsSL https://kantel.dev/install.sh | sh -s -- [options]

Options (each also reads an environment variable, for `| env NAME=value sh`):
  --repo OWNER/NAME  the GitHub repository (KANTEL_REPO, default lleverage-ai/kantel)
  --ref REF          the branch, tag or commit (KANTEL_REF, default main)
  --tarball PATH|URL install from this .tar.gz instead of GitHub (KANTEL_TARBALL)
  --home DIR         where Kantel lives (KANTEL_HOME, default ~/.kantel)
  --upgrade          download the source again even when it's already there, and rebuild the stack with it
                     (deploy/compose/.env, where your settings go, is kept)
  --email ADDRESS    the first admin, who signs in (KANTEL_ADMIN_EMAIL)
  --database-url URL a Postgres of your own, such as a managed one, instead of the bundled one
                     (KANTEL_DATABASE_URL; saved in deploy/compose/.env, so upgrades keep it)
  --database-ca FILE the CA certificate (PEM) that Postgres's TLS certificate is checked with, for a URL with
                     sslrootcert=/etc/kantel/database-ca.pem (KANTEL_DATABASE_CA_FILE; saved in .env too)
  --no-open          don't open the console in a browser (KANTEL_NO_OPEN=1)
  -h, --help         this help

When the downloaded source has its own install.sh, every option is passed on to it, and its --help lists more.
EOF
}

# Prints how to install Docker on this OS.
docker_hint() {
	case "$(uname -s)" in
	Darwin) say "Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack (https://orbstack.dev), then start it." ;;
	Linux) say "Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/" ;;
	*) say "Install Docker with Compose v2: https://docs.docker.com/get-started/get-docker/" ;;
	esac
}

check_prerequisites() {
	step "Checking what Kantel needs"
	have curl || die "curl is missing" "Install curl with your package manager and run this again."
	have tar || die "tar is missing" "Install tar with your package manager and run this again."
	have docker || die "Docker is missing" "$(docker_hint)"
	docker compose version >/dev/null 2>&1 ||
		die "Docker Compose v2 is missing (the \`docker compose\` plugin)" "$(docker_hint)"
	if ! docker info >/dev/null 2>&1; then
		if docker info 2>&1 | grep -qi "permission denied"; then
			die "Docker is running, but you're not allowed to use it" \
				"Add yourself to the docker group (sudo usermod -aG docker \"\$USER\"), sign in again, then run this again."
		fi
		case "$(uname -s)" in
		Darwin) die "Docker isn't running" "Start Docker Desktop or OrbStack, then run this again." ;;
		*) die "Docker isn't running" "Start it (sudo systemctl start docker), then run this again." ;;
		esac
	fi
	ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(version unknown)'), $(docker compose version --short 2>/dev/null || echo 'Compose v2')"
}

# Downloads the source tarball to $1: from --tarball, else GitHub's codeload, else (for a private repository) the
# GitHub CLI with your login.
download_source() {
	out="$1"
	if [ -n "$opt_tarball" ]; then
		case "$opt_tarball" in
		http://* | https://*) curl -fsSL "$opt_tarball" -o "$out" || die "couldn't download $opt_tarball" ;;
		*) cp "$opt_tarball" "$out" || die "couldn't read $opt_tarball" ;;
		esac
		ok "source from $opt_tarball"
		return
	fi
	if curl -fsSL "https://codeload.github.com/$opt_repo/tar.gz/$opt_ref" -o "$out" 2>/dev/null; then
		ok "source from github.com/$opt_repo at $opt_ref"
		return
	fi
	if have gh && gh api "repos/$opt_repo/tarball/$opt_ref" >"$out" 2>/dev/null; then
		ok "source from github.com/$opt_repo at $opt_ref (with your gh login)"
		return
	fi
	die "couldn't download github.com/$opt_repo at $opt_ref" \
		"Check the repository and ref (--repo, --ref). For a private repository, sign in with the GitHub CLI" \
		"(gh auth login) and run this again, or pass a tarball with --tarball."
}

# Downloads and unpacks the source into $tmp/src, a new directory under $KANTEL_HOME.
fetch_source() {
	step "Getting Kantel's source"
	mkdir -p "$KANTEL_HOME"
	tmp="$(mktemp -d "$KANTEL_HOME/.download.XXXXXX")"
	trap 'rm -rf "$tmp"' EXIT
	trap 'exit 130' INT TERM
	download_source "$tmp/source.tar.gz"
	mkdir "$tmp/src"
	tar -xzf "$tmp/source.tar.gz" -C "$tmp/src" --strip-components=1 || die "the download isn't a .tar.gz of the source"
	[ -d "$tmp/src/deploy" ] || die "the download doesn't look like Kantel's source (it has no deploy directory)"
	# Docker builds read the context as other users: keep it readable whatever the umask.
	chmod -R go+rX "$tmp/src"
}

# Moves the download into $SRC for the Compose stack, unless a copy is there already and --upgrade wasn't given.
keep_source() {
	[ -f "$tmp/src/deploy/compose/compose.yaml" ] || die "the download has no deploy/compose/compose.yaml to start"
	if [ -f "$SRC/deploy/compose/compose.yaml" ] && [ -z "$opt_upgrade" ]; then
		ok "keeping the copy already in $SRC (--upgrade replaces it)"
		# An older copy runs without what the download has: say how to move to it.
		if ! cmp -s "$tmp/src/deploy/compose/compose.yaml" "$SRC/deploy/compose/compose.yaml"; then
			say "    note: the download differs from that copy; run again with --upgrade to move to it (your data stays)"
		fi
		return
	fi
	rm -rf "$SRC.old"
	[ ! -e "$SRC" ] || mv "$SRC" "$SRC.old"
	mv "$tmp/src" "$SRC"
	# Your settings for the stack, kept across upgrades.
	if [ -f "$SRC.old/deploy/compose/.env" ] && [ ! -e "$SRC/deploy/compose/.env" ]; then
		cp -p "$SRC.old/deploy/compose/.env" "$SRC/deploy/compose/.env"
		ok "kept your settings in deploy/compose/.env"
	fi
	rm -rf "$SRC.old"
	ok "unpacked into $SRC"
}

# The value of setting $1 in deploy/compose/.env (its last line, quotes taken off), or nothing.
env_setting() {
	[ -f "$SRC/deploy/compose/.env" ] || return 0
	sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" "$SRC/deploy/compose/.env" |
		tail -n 1 | sed "s/[[:space:]]*\$//; s/^'\(.*\)'\$/\1/; s/^\"\(.*\)\"\$/\1/"
}

# Sets $1 to $2 in deploy/compose/.env, in place of any line it had, and keeps the file to its owner: it holds secrets.
# Both it and the copy it's rewritten through are owner-only from the moment they're made (umask 077, in a subshell),
# and a copy an interrupted run left behind is removed first, as writing to it would keep its mode. Each step needs the
# one before it (set -e doesn't hold in a subshell left of ||): .env is replaced only by a copy written in full.
save_setting() {
	env_file="$SRC/deploy/compose/.env"
	case "$2" in
	*"'"* | *"
"*) die "$1 can't contain a single quote or a line break" "Percent-encode them in a URL: ' is %27." ;;
	esac
	rm -f "$env_file.new"
	(
		umask 077
		touch "$env_file" &&
			chmod 600 "$env_file" &&
			{
				# grep exits 1 when it keeps no lines (the setting was the only one), 2 when it fails.
				grep -v "^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=" "$env_file" >"$env_file.new"
				[ $? -le 1 ]
			} &&
			printf "%s='%s'\n" "$1" "$2" >>"$env_file.new" &&
			mv "$env_file.new" "$env_file"
	) || {
		rm -f "$env_file.new"
		die "couldn't save $1 in $env_file" "It's as it was."
	}
}

# A Postgres of your own (--database-url, --database-ca): saved in deploy/compose/.env, so later upgrades keep using it.
save_database_settings() {
	if [ -n "$opt_database_ca" ]; then
		case "$opt_database_ca" in
		/*) ;;
		*) opt_database_ca="$(pwd)/$opt_database_ca" ;;
		esac
		[ -r "$opt_database_ca" ] || die "can't read the database's CA certificate at $opt_database_ca"
		save_setting KANTEL_DATABASE_CA_FILE "$opt_database_ca"
		# Compose reads the environment before .env: the value just saved, not an older one there.
		KANTEL_DATABASE_CA_FILE="$opt_database_ca"
		export KANTEL_DATABASE_CA_FILE
		ok "saved KANTEL_DATABASE_CA_FILE in deploy/compose/.env"
	fi
	if [ -n "$opt_database_url" ]; then
		case "$opt_database_url" in
		postgres://* | postgresql://*) ;;
		*) die "--database-url must be a postgres:// URL" ;;
		esac
		save_setting KANTEL_DATABASE_URL "$opt_database_url"
		KANTEL_DATABASE_URL="$opt_database_url"
		export KANTEL_DATABASE_URL
		ok "saved KANTEL_DATABASE_URL in deploy/compose/.env"
	fi
}

open_url() {
	[ -z "$opt_no_open" ] || return 0
	if [ "$(uname -s)" = Darwin ] && have open; then
		open "$1" >/dev/null 2>&1 || true
	elif { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && have xdg-open; then
		xdg-open "$1" >/dev/null 2>&1 || true
	fi
}

# docker compose on the stack's files: compose.yaml, and external-postgres.yaml with a Postgres of your own.
stack() {
	if [ -n "$external_file" ]; then
		docker compose -f "$compose_file" -f "$external_file" "$@"
	else
		docker compose -f "$compose_file" "$@"
	fi
}

# The self-hosted Compose stack, as the install docs run it, for a source that has no installer of its own.
run_compose() {
	compose_file="$SRC/deploy/compose/compose.yaml"
	external_file=""
	# A Postgres of your own, in .env (or the environment, which Compose reads first): the stack doesn't start its own.
	database_url="${KANTEL_DATABASE_URL:-$(env_setting KANTEL_DATABASE_URL)}"
	if [ -n "$database_url" ]; then
		external_file="$SRC/deploy/compose/external-postgres.yaml"
		[ -f "$external_file" ] ||
			die "KANTEL_DATABASE_URL is set, but this version of Kantel can't use a Postgres of its own" \
				"Install a newer one, or remove KANTEL_DATABASE_URL from $SRC/deploy/compose/.env."
		database_ca="${KANTEL_DATABASE_CA_FILE:-$(env_setting KANTEL_DATABASE_CA_FILE)}"
		[ -z "$database_ca" ] || [ -r "$database_ca" ] ||
			die "can't read the database's CA certificate at $database_ca (KANTEL_DATABASE_CA_FILE)"
		ok "using your Postgres (KANTEL_DATABASE_URL), not the bundled one"
	fi
	# The same, as a command to show.
	compose="docker compose -f $compose_file${external_file:+ -f $external_file}"
	port="${KANTEL_GATEWAY_PORT:-${HARBOUR_GATEWAY_PORT:-58090}}"
	mail_port="${KANTEL_MAILPIT_PORT:-${HARBOUR_MAILPIT_PORT:-58025}}"
	if [ -n "$opt_email" ]; then
		KANTEL_ADMIN_EMAIL="$opt_email"
		export KANTEL_ADMIN_EMAIL
	fi

	if [ -n "$opt_upgrade" ]; then
		step "Rebuilding and restarting Kantel with the new source (your data stays)"
	else
		step "Building and starting Kantel (the first build takes a few minutes)"
	fi
	# --remove-orphans: an upgrade from a version with more services (the agent plane's session hosts, browsers,
	# MinIO and vault proxy) stops and removes their containers. Named volumes, and so the data, stay.
	(cd "$SRC" && stack up -d --build --wait --remove-orphans) ||
		die "the stack didn't start" "See what went wrong with: $compose logs"

	console="http://127.0.0.1:$port/"
	tries=0
	until curl -fsS "${console}healthz" >/dev/null 2>&1; do
		tries=$((tries + 1))
		[ "$tries" -lt 60 ] || die "the console didn't answer on $console" "See: $compose logs gateway"
		sleep 2
	done
	ok "the console answers on $console"

	admin="$(cd "$SRC" && stack exec -T gateway printenv KANTEL_ADMIN_EMAIL 2>/dev/null || true)"
	[ -n "$admin" ] || admin="${KANTEL_ADMIN_EMAIL:-the admin address}"

	cat <<EOF

Kantel is running.

  Console   $console
  Mailbox   http://127.0.0.1:$mail_port/   (your sign-in codes arrive here)

Sign in as $admin: enter the address, select "Email me a code", and copy the code from the mailbox.
On another machine over SSH, forward the ports first: ssh -L $port:127.0.0.1:$port -L $mail_port:127.0.0.1:$mail_port <host>

Your API key and project are in the gateway's bootstrap file:
  $compose exec -T gateway sh -c 'cat /var/lib/*/bootstrap.json'

Sandboxes run on hosts: Linux machines running the Kantel host agent. Once you're signed in, select
"Add a host" in the console and run the command it shows on the machine. A host on this machine joins at
$console; for hosts elsewhere, set KANTEL_PUBLIC_URL in deploy/compose/.env to the address they reach it at
(or run kantel-admin compute enable --public-url <url> --apply). See https://kantel.dev/docs/self-hosting/install/

Upgrade it:         curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade
Stop it:            $compose down
Stop and delete it: $compose down -v
EOF
	if [ -n "$database_url" ]; then
		say ""
		say "Kantel's data is in your Postgres (KANTEL_DATABASE_URL): its backups are yours to keep, and down -v doesn't"
		say "touch it. See https://kantel.dev/docs/self-hosting/database/"
	fi
	open_url "$console"
}

main() {
	KANTEL_HOME="${KANTEL_HOME:-$HOME/.kantel}"
	opt_repo="${KANTEL_REPO:-$DEFAULT_REPO}"
	opt_ref="${KANTEL_REF:-$DEFAULT_REF}"
	opt_tarball="${KANTEL_TARBALL:-}"
	opt_email=""
	opt_database_url="${KANTEL_DATABASE_URL:-}"
	opt_database_ca="${KANTEL_DATABASE_CA_FILE:-}"
	opt_upgrade=""
	opt_no_open="${KANTEL_NO_OPEN:-}"
	wants_help=""

	# Read our own options; keep every argument as given, to pass on to a newer installer.
	n=$#
	while [ "$n" -gt 0 ]; do
		arg="$1"
		shift
		n=$((n - 1))
		case "$arg" in
		--repo | --ref | --tarball | --home | --email | --database-url | --database-ca)
			[ "$n" -gt 0 ] && [ -n "$1" ] || die "$arg needs a value" "Run with --help for the options."
			case "$arg" in
			--repo) opt_repo="$1" ;;
			--ref) opt_ref="$1" ;;
			--tarball) opt_tarball="$1" ;;
			--home) KANTEL_HOME="$1" ;;
			--email) opt_email="$1" ;;
			--database-url) opt_database_url="$1" ;;
			--database-ca) opt_database_ca="$1" ;;
			esac
			set -- "$@" "$arg" "$1"
			shift
			n=$((n - 1))
			;;
		--upgrade) opt_upgrade=1; set -- "$@" "$arg" ;;
		--no-open) opt_no_open=1; set -- "$@" "$arg" ;;
		-h | --help) wants_help=1; set -- "$@" "$arg" ;;
		*) set -- "$@" "$arg" ;;
		esac
	done

	case "$KANTEL_HOME" in
	/*) ;;
	*) KANTEL_HOME="$(pwd)/$KANTEL_HOME" ;;
	esac
	case "$opt_tarball" in
	'' | /* | http://* | https://*) ;;
	*) opt_tarball="$(pwd)/$opt_tarball" ;;
	esac
	SRC="$KANTEL_HOME/src"

	if [ -n "$wants_help" ]; then
		usage
		exit 0
	fi

	say "Installing Kantel, by Lleverage, into $KANTEL_HOME"
	check_prerequisites
	fetch_source

	if [ -f "$tmp/src/install.sh" ]; then
		# Run from the download, and name the source explicitly, so that installer fetches its own copy into its home
		# rather than treating the download as a checkout to link to.
		step "Handing over to the installer that came with this version of Kantel"
		if [ -n "$opt_tarball" ]; then
			set -- --tarball "$opt_tarball" "$@"
		else
			set -- --repo "$opt_repo" --ref "$opt_ref" "$@"
		fi
		status=0
		sh "$tmp/src/install.sh" "$@" </dev/null || status=$?
		exit "$status"
	fi
	keep_source

	for arg in "$@"; do
		case "$arg" in
		--repo | --ref | --tarball | --home | --email | --database-url | --database-ca | --upgrade | --no-open) ;;
		-*) die "unknown option: $arg" "Run with --help for the options." ;;
		esac
	done
	save_database_settings
	run_compose
}

main "$@"
