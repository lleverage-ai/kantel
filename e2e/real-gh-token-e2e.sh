#!/usr/bin/env bash
# The real-token E2E for protected environment variables: a GitHub token, protected and bound to api.github.com,
# works with `gh` inside a Firecracker microVM while the token itself never appears there.
#
# It stands up a throwaway Kantel on this machine, built from lleverage-ai/kantel's source: the gateway (records in memory, with a
# KANTEL_SECRETS_KEY of its own) and one kantel-host with Firecracker in a privileged container, all named kantel-rte-*.
# Then, in a microVM made from an environment holding the token and in a fork of it, it checks that:
#   - the sandbox's GH_TOKEN is a kph_ placeholder, and `gh api user` answers as the token's owner (GitHub's 401 with a
#     fake token), with the egress log saying GH_TOKEN was swapped;
#   - the placeholder sent to another host is refused with 403 placeholder-unbound;
#   - a rotation reaches the running sandbox at once with the same placeholder (real token: real, fake, real again);
#   - kantel-doctor, built from the same source, says the CA is trusted and GH_TOKEN would be swapped;
#   - a live fork has a placeholder of its own that works, and the parent's placeholder isn't swapped there;
#   - a pause (memory kept) and resume keeps the placeholder working;
#   - the token is in no sandbox's environment or /proc, nowhere in the host's state (the sandboxes' disks, the
#     snapshots, the memory files, the fork, the RAM spool; a canary the sandbox writes proves the scan reads them),
#     and in no log or API answer.
# At the end it tears the test Kantel down; the token goes with it.
#
#   bash e2e/real-gh-token-e2e.sh
# or, with no checkout:
#   bash <(gh api -H 'Accept: application/vnd.github.raw' 'repos/lleverage-ai/kantel/contents/e2e/real-gh-token-e2e.sh')
#
# Settings, all optional:
#   KANTEL_REF         the lleverage-ai/kantel commit to build (downloaded with `gh`); default main's newest commit
#                      on the first run, kept for the re-runs until the E2E passes (or E2E_FRESH=1)
#   KANTEL_SRC         build from this directory instead of downloading
#   E2E_TOKEN_FROM     `gh` (default): `gh auth token`; `prompt`: typed, not shown
#   E2E_DUMMY_TOKEN=1  a random fake token instead of a real one: GitHub answers 401, everything else is checked
#   E2E_YES=1          answer yes to both questions
#   E2E_FRESH=1        forget an earlier run's progress and start again
#   E2E_KEEP=1         don't ask at the end, and leave the test Kantel running
#   E2E_HOME           progress, logs and the source; default ~/.local/state/kantel-real-token-e2e
#   E2E_GATEWAY_PORT   the test gateway's port on 127.0.0.1; default 18826
#   WIZ_DRY_RUN=1      the checks before any change only
#
# A re-run carries on where the last one stopped: finished steps are skipped while what they made still exists.
# Exit: 0 every check passed; 1 a check failed (the reason is above it); 3 you answered No.
# It never prints, logs or passes the token on a command line: it stays in this shell and goes down pipes.
# shellcheck disable=SC2016 # Commands sent into the sandbox are single-quoted on purpose: they expand there.
set -Eeuo pipefail
umask 077

# Sal's office runbook helpers, when they are defined; plain output otherwise (as a child process, they aren't).
type rb_step >/dev/null 2>&1 || rb_step() { printf '\n==> %s\n' "$2"; }
type rb_skip >/dev/null 2>&1 || rb_skip() { printf '    already done: %s\n' "${1:-}"; }
type rb_skipping >/dev/null 2>&1 || rb_skipping() { return 1; }

info() { printf '    %s\n' "$*"; }
ok() { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die() {
	printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2
	exit 1
}

E2E_HOME=${E2E_HOME:-$HOME/.local/state/kantel-real-token-e2e}
PORT=${E2E_GATEWAY_PORT:-18826}
GW_URL="http://127.0.0.1:$PORT"
NET=kantel-rte
GW=kantel-rte-gw
HOST=kantel-rte-host
ENV_NAME=real-token-e2e
GH_VERSION=2.83.1
declare -A GH_SHA256=(
	[amd64]=1c5252d4ce3db07b51c01ff0b909583da6364ff3fdc06d0c2e75e62dc0380a34
	[arm64]=36af472f8e96fd67253f813f71d9610624cc4e3c7a5b148459e42ffa1a933f64
)

mkdir -p "$E2E_HOME/logs" "$E2E_HOME/progress"
LOG="$E2E_HOME/logs/real-gh-token-e2e.$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
TMP=$(mktemp -d)
cleanup_tmp() { rm -rf "$TMP"; }
trap cleanup_tmp EXIT
# An unexpected failure: said once, by this shell (not by the subshells, nor for commands whose failure is handled).
trap 'status=$?; if [[ $BASHPID == "$$" && $- == *e* ]]; then printf "\n\033[31mFAILED\033[0m at line %s: %s (exit %s). The log is %s\n" "$LINENO" "$BASH_COMMAND" "$status" "$LOG" >&2; fi' ERR
echo "Real-token E2E for Kantel's protected variables. Log: $LOG"

# confirm QUESTION: yes or no, No by default. From the terminal when there is one, else stdin; E2E_YES=1 says yes.
confirm() {
	local answer=""
	if [[ "${E2E_YES:-}" == 1 ]]; then
		printf '%s [y/N] y (E2E_YES)\n' "$1"
		return 0
	fi
	printf '%s [y/N] ' "$1"
	if { : </dev/tty; } 2>/dev/null; then
		read -r answer </dev/tty || answer=""
	else
		read -r answer || answer=""
	fi
	printf '%s\n' "$answer" >>"$LOG"
	[[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}
stop_no() {
	printf '\nStopped: you answered No. Nothing more was changed; run the same command again to carry on.\n'
	exit 3
}

progress() { cat "$E2E_HOME/progress/$1" 2>/dev/null || true; }
# reset_progress: forget every step's progress, but not the commit being tested.
reset_progress() {
	local f
	for f in "$E2E_HOME"/progress/*; do
		[[ "${f##*/}" == ref ]] || rm -f "$f"
	done
}
set_progress() { printf '%s\n' "$2" >"$E2E_HOME/progress/$1"; }

# --- the token: in this shell only ---------------------------------------------------------------------------------
TOKEN=""
MODE=""
random_token() { printf 'ghp_%s' "$(openssl rand -hex 18)"; }
# hits NAME: how often the token (or the rotation's stand-in) is in stdin. Counts lines; prints the count.
hits() {
	local n
	n=$(grep -caF -f <(printf '%s\n%s\n' "$TOKEN" "$ROTATED")) || true
	printf '%s' "${n:-0}"
}

# --- the API -------------------------------------------------------------------------------------------------------
HDR="$TMP/auth-header"
# api METHOD PATH [BODY]: the test gateway's answer, or die with its error (never a value: the API answers none).
# The body goes through a file, as it can be larger than one argument may be.
api() {
	local method=$1 path=$2 body=${3-} out="$TMP/api.$BASHPID.out" in="$TMP/api.$BASHPID.in" code
	if [[ -n "$body" ]]; then
		printf '%s' "$body" >"$in"
		code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H @"$HDR" -H 'content-type: application/json' \
			--data-binary @"$in" "$GW_URL$path") || die "$method $path: the gateway didn't answer"
	else
		code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H @"$HDR" "$GW_URL$path") ||
			die "$method $path: the gateway didn't answer"
	fi
	[[ "$code" == 2?? ]] || die "$method $path answered $code: $(head -c 600 "$out")"
	cat "$out"
	rm -f "$out" "$in"
}
# set_token VALUE_FROM_STDIN: GH_TOKEN in the environment, protected and bound to api.github.com. The value goes from
# stdin into jq into curl's stdin, so it's on no command line.
set_token() {
	local code
	code=$(jq -Rs '{protected: true, value: ., bindings: [{host: "api.github.com"}]}' |
		curl -sS -o "$TMP/set.out" -w '%{http_code}' -X PUT -H @"$HDR" -H 'content-type: application/json' \
			--data-binary @- "$GW_URL/v1/environments/$ENV_ID/variables/GH_TOKEN") || die "setting GH_TOKEN failed"
	[[ "$code" == 2?? ]] || die "setting GH_TOKEN answered $code: $(head -c 600 "$TMP/set.out")"
}
# sx SANDBOX COMMAND [TIMEOUT_MS]: runs COMMAND in the sandbox; the Command as JSON.
sx() {
	api POST "/v1/sandboxes/$1/commands" "$(jq -nc --arg c "$2" --argjson t "${3:-60000}" '{command: $c, timeoutMs: $t}')"
}
# sx_ok SANDBOX COMMAND [TIMEOUT_MS]: its stdout, or die with its stderr.
sx_ok() {
	local out
	out=$(sx "$@")
	[[ "$(jq -r '.exitCode' <<<"$out")" == 0 ]] ||
		die "in $1, \`$2\` failed ($(jq -r '.state + " " + (.exitCode|tostring)' <<<"$out")): $(jq -r '.stderr' <<<"$out" | tail -5)"
	jq -r '.stdout' <<<"$out"
}
sandbox_state() { api GET "/v1/sandboxes/$1" | jq -r '.state'; }
running() { [[ -n "${1:-}" ]] && [[ "$(curl -sS -H @"$HDR" "$GW_URL/v1/sandboxes/$1" 2>/dev/null | jq -r '.state' 2>/dev/null)" == running ]]; }
# egress_swapped SANDBOX PATH: waits for a request to api.github.com PATH with GH_TOKEN swapped in the egress log.
egress_swapped() {
	local i
	for i in $(seq 1 20); do
		if api GET "/v1/sandboxes/$1/egress" | jq -e --arg p "$2" \
			'any(.entries[]; .host == "api.github.com" and .path == $p and (.swapped | index("GH_TOKEN")))' >/dev/null; then
			return 0
		fi
		sleep 1
	done
	return 1
}

# --- the stack -----------------------------------------------------------------------------------------------------
container_id() { docker inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" == true ]]; }
read_key() {
	local key
	key=$(docker exec "$GW" sh -c 'cat /var/lib/harbour/bootstrap.json' 2>/dev/null | jq -r '.computeKey // empty') || true
	[[ -n "$key" ]] || return 1
	printf 'authorization: Bearer %s\n' "$key" >"$HDR"
}
host_online() {
	[[ -s "$HDR" ]] || return 1
	curl -sS -H @"$HDR" "$GW_URL/v1/admin/hosts" 2>/dev/null |
		jq -e '[.items[] | select(.name == "kantel-rte" and .state == "online")] | length == 1' >/dev/null 2>&1
}
# The stack's fingerprint: the containers' IDs. A new gateway (records in memory) or host starts the steps after again.
stack_print() { printf '%s %s %s' "$REF" "$(container_id "$GW")" "$(container_id "$HOST")"; }
stack_up() {
	container_running "$GW" && container_running "$HOST" && read_key && host_online &&
		[[ "$(progress stack)" == "$(stack_print)" ]]
}

# ===================================================================================================================
rb_step rte-preflight "Check this machine and the token"
for tool in docker curl jq openssl tar gzip base64 grep sha256sum split; do
	command -v "$tool" >/dev/null 2>&1 || die "needs $tool on the PATH"
done
docker info >/dev/null 2>&1 || die "can't reach Docker: is it running, and are you in the docker group?"
[[ -r /dev/kvm && -w /dev/kvm ]] || die "needs /dev/kvm, readable and writable, for Firecracker"
case "$(uname -m)" in
	x86_64) ARCH=amd64 ;;
	aarch64) ARCH=arm64 ;;
	*) die "runs on x86_64 or arm64, not $(uname -m)" ;;
esac

# The source: KANTEL_SRC; else KANTEL_REF, the commit an earlier run pinned, or main's newest, downloaded.
if [[ "${E2E_FRESH:-}" == 1 ]]; then
	rm -f "$E2E_HOME"/progress/*
	info "E2E_FRESH=1: starting again"
fi
if [[ -n "${KANTEL_SRC:-}" ]]; then
	SRC=$(cd "$KANTEL_SRC" && pwd)
	REF=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo local)
else
	if [[ -n "${KANTEL_REF:-}" ]]; then
		REF=$KANTEL_REF
	elif [[ -n "$(progress ref)" ]]; then
		REF=$(progress ref)
	else
		command -v gh >/dev/null 2>&1 || die "needs gh to find and download lleverage-ai/kantel's main"
		REF=$(gh api repos/lleverage-ai/kantel/commits/main --jq .sha) || die "couldn't read lleverage-ai/kantel's main with gh"
		set_progress ref "$REF"
	fi
	[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "KANTEL_REF must be a full commit SHA, not '$REF'"
	SRC="$E2E_HOME/src/$REF"
fi
TAG=${REF:0:12}
if [[ "${E2E_DUMMY_TOKEN:-}" == 1 ]]; then MODE=dummy; else MODE=real; fi
info "Kantel at $REF, with a $MODE token"

# A pass counts only for the same commit and the same kind of token: a pass with a fake one never stands in for a real one.
if [[ -n "$(progress complete)" && "$(progress complete | head -1)" != "$REF $MODE" ]]; then
	reset_progress
fi
if [[ -n "$(progress complete)" ]]; then
	ok "this E2E already passed; nothing to do. Its result:"
	progress complete | tail -n +2 | sed 's/^/      /'
	for step in rte-source:"Get the source" rte-build:"Build the gateway and kantel-host" \
		rte-stack:"Start the test Kantel" rte-token:"Protect the token" rte-sandbox:"Use it in a microVM and a fork" \
		rte-scan:"Look for the token everywhere" rte-cleanup:"Tear the test Kantel down"; do
		rb_step "${step%%:*}" "${step#*:}"
		rb_skip "passed in an earlier run (E2E_FRESH=1 runs it again)"
	done
	echo
	echo "Passed earlier. Log: $LOG"
	exit 0
fi

# The fake values (a dummy token, the rotation's stand-in) are kept between runs, so a re-run looks for the same ones.
if [[ ! -s "$E2E_HOME/progress/fakes" ]]; then
	printf '%s %s\n' "$(random_token)" "$(random_token)" >"$E2E_HOME/progress/fakes"
fi
read -r DUMMY ROTATED <"$E2E_HOME/progress/fakes"
CANARY="kantel-e2e-canary-${ROTATED:4:16}"
if [[ "$MODE" == dummy ]]; then
	TOKEN=$DUMMY
	info "E2E_DUMMY_TOKEN=1: a random fake token, which GitHub refuses with 401"
elif [[ "${E2E_TOKEN_FROM:-gh}" == prompt ]]; then
	printf 'Paste the GitHub token (not shown): '
	if { : </dev/tty; } 2>/dev/null; then IFS= read -rs TOKEN </dev/tty || true; else IFS= read -rs TOKEN || true; fi
	echo
else
	command -v gh >/dev/null 2>&1 || die "needs gh, signed in, for its token (or E2E_TOKEN_FROM=prompt)"
	TOKEN=$(gh auth token 2>/dev/null) || die "gh has no token: run \`gh auth login\`, or set E2E_TOKEN_FROM=prompt"
fi
[[ "$TOKEN" =~ ^[A-Za-z0-9_]{20,255}$ ]] || die "that doesn't look like a GitHub token (letters, digits and _ only)"

code=$(printf 'Authorization: Bearer %s\n' "$TOKEN" |
	curl -sS -o "$TMP/user.json" -w '%{http_code}' -H @- -H 'accept: application/vnd.github+json' \
		https://api.github.com/user) || die "can't reach api.github.com from this machine"
if [[ "$MODE" == real ]]; then
	[[ "$code" == 200 ]] || die "GitHub refused the token from this machine ($code), so it can't be tested"
	LOGIN=$(jq -r '.login' "$TMP/user.json")
	ok "the token is $LOGIN's (checked from this machine)"
else
	[[ "$code" == 401 ]] || die "GitHub answered $code for the fake token, not 401"
	LOGIN=""
	ok "GitHub refuses the fake token from this machine (401)"
fi

if ! container_running "$GW"; then
	if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
		die "port $PORT is taken: set E2E_GATEWAY_PORT to a free one"
	fi
fi
ok "Docker, /dev/kvm and port $PORT"

echo
info "Next: build Kantel at ${REF:0:12} (a few minutes the first time), start it as Docker containers named kantel-rte-*,"
info "put the token in its environment '$ENV_NAME' as a protected variable bound to api.github.com, and test it"
info "in a Firecracker microVM and a fork. The token stays in this shell, the test gateway's memory (sealed) and the"
info "test host's memory, and goes when the test Kantel is torn down at the end. About 10-15 minutes."
if [[ "${WIZ_DRY_RUN:-}" == 1 ]]; then
	echo
	echo "WIZ_DRY_RUN=1: stopping before any change."
	exit 0
fi
confirm "Go ahead?" || stop_no

# ===================================================================================================================
rb_step rte-source "Get the source"
if [[ -n "${KANTEL_SRC:-}" || "$SRC" != "$E2E_HOME/src/$REF" ]]; then
	rb_skip "building from $SRC"
elif [[ -f "$SRC/.complete" ]]; then
	rb_skip "$SRC"
else
	command -v gh >/dev/null 2>&1 || die "needs gh to download lleverage-ai/kantel at $REF"
	rm -rf "$SRC" "$SRC.part"
	mkdir -p "$SRC.part"
	gh api "repos/lleverage-ai/kantel/tarball/$REF" >"$TMP/src.tar.gz" || die "couldn't download lleverage-ai/kantel at $REF"
	(umask 022 && tar -xzf "$TMP/src.tar.gz" -C "$SRC.part" --strip-components=1)
	[[ -f "$SRC.part/apps/host/go.mod" && -f "$SRC.part/apps/selfhosted/Dockerfile" ]] || die "the download isn't Kantel's source"
	touch "$SRC.part/.complete"
	mv "$SRC.part" "$SRC"
	ok "lleverage-ai/kantel@$REF in $SRC"
fi

# ===================================================================================================================
rb_step rte-build "Build the gateway and kantel-host"
GW_IMAGE="kantel-rte-gateway:$TAG"
HOST_IMAGE="kantel-rte-host:$TAG"
if docker image inspect "$GW_IMAGE" >/dev/null 2>&1 && docker image inspect "$HOST_IMAGE" >/dev/null 2>&1; then
	rb_skip "$GW_IMAGE and $HOST_IMAGE"
else
	BUILD_LOG="$E2E_HOME/logs/build-$TAG.log"
	info "building; Docker's output goes to $BUILD_LOG"
	if ! docker image inspect "$GW_IMAGE" >/dev/null 2>&1; then
		DOCKER_BUILDKIT=1 docker build -t "$GW_IMAGE" -f "$SRC/apps/selfhosted/Dockerfile" "$SRC" >>"$BUILD_LOG" 2>&1 ||
			die "building the gateway failed: see $BUILD_LOG"
	fi
	ok "$GW_IMAGE (apps/selfhosted/Dockerfile)"
	# apps/host's own .dockerignore is for the guest images, so the host is built from a copy without it.
	mkdir "$TMP/host"
	cp -R "$SRC/apps/host/go.mod" "$SRC/apps/host/go.sum" "$SRC/apps/host/cmd" "$SRC/apps/host/internal" "$TMP/host/"
	cat >"$TMP/host/Dockerfile" <<'EOF'
FROM golang:1.26-trixie AS build
ARG VERSION
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/kantel-host ./cmd/kantel-host \
	&& CGO_ENABLED=0 go build -ldflags "-s -w" -o /out/kantel-guest ./cmd/kantel-guest
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables ca-certificates curl e2fsprogs \
	procps hostname kmod && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/ /usr/local/bin/
EOF
	DOCKER_BUILDKIT=1 docker build -t "$HOST_IMAGE" --build-arg "VERSION=e2e-$TAG" "$TMP/host" >>"$BUILD_LOG" 2>&1 ||
		die "building kantel-host failed: see $BUILD_LOG"
	ok "$HOST_IMAGE (kantel-host and kantel-guest, from apps/host)"
fi

# ===================================================================================================================
rb_step rte-stack "Start the test Kantel"
if stack_up; then
	rb_skip "gateway $GW and host $HOST are up"
else
	docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
	if ! container_running "$GW" || [[ "$(docker inspect -f '{{.Config.Image}}' "$GW" 2>/dev/null)" != "$GW_IMAGE" ]]; then
		docker rm -f "$GW" "$HOST" >/dev/null 2>&1 || true
		printf 'KANTEL_SECRETS_KEY=%s\n' "$(openssl rand -base64 32)" >"$TMP/gw.env"
		docker run -d --name "$GW" --network "$NET" -p "127.0.0.1:$PORT:8080" --env-file "$TMP/gw.env" \
			-e KANTEL_COMPUTE_PUBLIC_URL="http://$GW:8080" -e KANTEL_COMPUTE_BACKEND=hosts \
			-e KANTEL_BOOTSTRAP_FILE=/var/lib/harbour/bootstrap.json -e KANTEL_COMPUTE_POOLS='{}' \
			--label kantel-rte=1 "$GW_IMAGE" >/dev/null
		rm -f "$TMP/gw.env"
		info "gateway $GW started (records in memory)"
	fi
	for _ in $(seq 1 60); do
		curl -sf "$GW_URL/healthz" >/dev/null 2>&1 && read_key && break
		sleep 1
	done
	read_key || die "the gateway didn't come up: docker logs $GW"
	ok "gateway on $GW_URL"

	if ! container_running "$HOST" || ! host_online; then
		docker rm -f "$HOST" >/dev/null 2>&1 || true
		# A volume of its own for each host joined (an earlier one's config would name a host this gateway doesn't
		# know); the clean-up at the end removes them all.
		host_volume=$(docker volume create --label kantel-rte=1 "kantel-rte-host-$(date +%Y%m%d%H%M%S)")
		join=$(api POST /v1/admin/hosts/join-tokens '{"name":"kantel-rte","expiresInMinutes":30}' | jq -r '.token')
		# --shm-size: kantel-host spools memory snapshots in /dev/shm, which Docker otherwise caps at 64 MB.
		docker run -d --name "$HOST" --network "$NET" --privileged --device /dev/kvm --device /dev/net/tun --shm-size 8g \
			-v "$host_volume:/var/lib/kantel-host" -e KANTEL_HOST_TOKEN="$join" --label kantel-rte=1 \
			"$HOST_IMAGE" sh -c '
				c=/var/lib/kantel-host/config.json
				[ -s "$c" ] || kantel-host install --url http://kantel-rte-gw:8080 --name kantel-rte --tiers microvm \
					--config "$c" --root /var/lib/kantel-host --no-start || exit 1
				while :; do kantel-host run --config "$c"; sleep 2; done' >/dev/null
		info "host $HOST joining; it fetches Firecracker and the sandbox image (about 1 GB) the first time"
		for i in $(seq 1 120); do
			host_online && break
			container_running "$HOST" || die "kantel-host stopped: $(docker logs --tail 20 "$HOST" 2>&1)"
			((i % 12 == 0)) && info "$(docker logs --tail 1 "$HOST" 2>&1 | cut -c1-150)"
			sleep 5
		done
		host_online || die "the host didn't come online in 10 minutes: docker logs $HOST"
	fi
	ok "host $HOST online with microVMs"
	rm -f "$E2E_HOME"/progress/{stack,token,sandbox,scan,complete}
	set_progress stack "$(stack_print)"
fi
read_key || die "no key from the gateway"

# ===================================================================================================================
rb_step rte-token "Protect the token"
ENV_ID=$(api GET /v1/environments | jq -r --arg n "$ENV_NAME" '.items[] | select(.name == $n) | .id' | head -1)
var_updated() { api GET "/v1/environments/$ENV_ID" | jq -r '.variables[] | select(.name == "GH_TOKEN" and .protected) | .updatedAt'; }
if [[ -n "$ENV_ID" && -n "$(progress token)" && "$(progress token)" == "$(progress stack) $MODE $(var_updated)" ]]; then
	rb_skip "GH_TOKEN in $ENV_NAME ($MODE)"
else
	if [[ -z "$ENV_ID" ]]; then
		ENV_ID=$(api POST /v1/environments "$(jq -nc --arg n "$ENV_NAME" '{name: $n, description: "The real-token E2E"}')" |
			jq -r '.id')
	fi
	printf '%s' "$TOKEN" | set_token
	env_json=$(api GET "/v1/environments/$ENV_ID")
	jq -e '.variables[] | select(.name == "GH_TOKEN") | .protected and (has("value") | not) and
		(.bindings == [{host: "api.github.com"}] or (.bindings | length == 1 and .[0].host == "api.github.com"))' \
		<<<"$env_json" >/dev/null || die "GH_TOKEN isn't protected and bound to api.github.com: $env_json"
	[[ "$(hits <<<"$env_json")" == 0 ]] || die "the environment's answer holds the token"
	ok "GH_TOKEN in $ENV_NAME ($ENV_ID): protected, bound to api.github.com, and its value isn't answered"
	rm -f "$E2E_HOME/progress/sandbox" "$E2E_HOME/progress/scan"
	set_progress token "$(progress stack) $MODE $(var_updated)"
fi

# ===================================================================================================================
rb_step rte-sandbox "Use it in a microVM and a fork"
read -r PARENT FORK SNAPSHOT <<<"$(progress sandbox | head -1) "
if [[ -n "$(progress sandbox)" && "$(progress sandbox | sed -n 2p)" == "$(progress token)" ]] && running "$PARENT" && running "$FORK"; then
	rb_skip "parent $PARENT, snapshot $SNAPSHOT, fork $FORK"
	progress sandbox | tail -n +3 | sed 's/^/    /'
else
	results=()
	for id in $(api GET /v1/sandboxes | jq -r '.items[] | select(.name == "rte-parent" or .name == "rte-fork") | .id'); do
		api DELETE "/v1/sandboxes/$id" >/dev/null || true
	done
	sbx=$(api POST /v1/sandboxes "$(jq -nc --arg e "$ENV_NAME" \
		'{type: "microvm", environment: $e, name: "rte-parent", autoStopMinutes: 180, wait: true}')")
	PARENT=$(jq -r '.id' <<<"$sbx")
	[[ "$(jq -r '.state' <<<"$sbx")" == running ]] || die "the microVM didn't start: $(jq -c '{state, error}' <<<"$sbx")"
	ok "microVM $PARENT from $ENV_NAME"

	placeholder=$(sx_ok "$PARENT" 'printf %s "$GH_TOKEN"')
	[[ "$placeholder" =~ ^kph_[A-Za-z0-9]{40}$ ]] || die "GH_TOKEN in the sandbox isn't a kph_ placeholder"
	ok "GH_TOKEN in the sandbox is a placeholder (${placeholder:0:8}…)"
	results+=("GH_TOKEN in the sandbox: a placeholder, ${placeholder:0:8}…")

	sx_ok "$PARENT" "set -e; cd /tmp; curl -fsSLo gh.tgz https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_$ARCH.tar.gz
		echo '${GH_SHA256[$ARCH]}  gh.tgz' | sha256sum -c - >/dev/null; tar -xzf gh.tgz
		sudo install -m 0755 gh_${GH_VERSION}_linux_$ARCH/bin/gh /usr/local/bin/gh; rm -rf gh.tgz gh_$GH_VERSION*; gh --version | head -1" 300000 |
		sed 's/^/    /'

	# gh_user SANDBOX real|dummy [TRIES]: `gh api user` there, tried every 2 s. With the real token it must answer the
	# login; with a fake one, GitHub's 401.
	gh_user() {
		local out got i
		for i in $(seq 1 "${3:-1}"); do
			out=$(sx "$1" 'gh api user --jq .login')
			if [[ "$2" == real ]]; then
				got="$(jq -r '.stdout' <<<"$out" | tr -d '\n') $(jq -r '.stderr' <<<"$out" | tail -2 | tr '\n' ' ')"
				[[ "$(jq -r '.exitCode' <<<"$out")" == 0 && "$(jq -r '.stdout' <<<"$out" | tr -d '\n')" == "$LOGIN" ]] && return 0
			else
				got=$(jq -r '.stdout + .stderr' <<<"$out" | tail -2 | tr '\n' ' ')
				jq -r '.stderr' <<<"$out" | grep -q 'HTTP 401' && return 0
			fi
			((i < ${3:-1})) && sleep 2
		done
		die "gh api user in $1 should have $([[ "$2" == real ]] && echo "answered $LOGIN" || echo "got GitHub's 401"): $got"
	}
	gh_user "$PARENT" "$MODE"
	egress_swapped "$PARENT" /user || die "the egress log has no GET api.github.com/user with GH_TOKEN swapped"
	if [[ "$MODE" == real ]]; then
		ok "gh api user in the microVM: $LOGIN; the egress log shows GH_TOKEN swapped"
		results+=("gh api user in the microVM: $LOGIN, GH_TOKEN swapped")
	else
		ok "gh api user in the microVM: GitHub's 401 for the fake token; the egress log shows GH_TOKEN swapped"
		results+=("gh api user in the microVM: 401 (fake token), GH_TOKEN swapped")
	fi

	refusal=$(sx_ok "$PARENT" 'curl -sS -o /tmp/refused.txt -D - -H "Authorization: Bearer $GH_TOKEN" http://example.com/; cat /tmp/refused.txt')
	if ! grep -q '^HTTP/[0-9.]* 403' <<<"$refusal" || ! grep -qi '^X-Kantel-Proxy-Error: placeholder-unbound' <<<"$refusal"; then
		die "the placeholder sent to example.com wasn't refused with 403 placeholder-unbound: $(head -c 400 <<<"$refusal")"
	fi
	grep -qi '^X-Kantel-Proxy-Variable: GH_TOKEN' <<<"$refusal" || die "the refusal doesn't name GH_TOKEN"
	ok "the placeholder sent to example.com: 403 placeholder-unbound, naming GH_TOKEN"
	info "$(tail -1 <<<"$refusal" | cut -c1-160)"
	results+=("placeholder to example.com: 403 placeholder-unbound")

	# Rotation, live, with the same placeholder. With the real token: a fake value gets 401, the real one 200 again.
	printf '%s' "$ROTATED" | set_token
	if [[ "$MODE" == real ]]; then
		gh_user "$PARENT" dummy 15
		[[ "$(sx_ok "$PARENT" 'printf %s "$GH_TOKEN"')" == "$placeholder" ]] || die "the placeholder changed on rotation"
		printf '%s' "$TOKEN" | set_token
		gh_user "$PARENT" real 15
		ok "rotation is live: a fake value got 401 and the real one $LOGIN again, with the same placeholder and no restart"
		results+=("rotation: fake value 401, real again $LOGIN, same placeholder")
	else
		[[ "$(sx_ok "$PARENT" 'printf %s "$GH_TOKEN"')" == "$placeholder" ]] || die "the placeholder changed on rotation"
		gh_user "$PARENT" dummy
		printf '%s' "$TOKEN" | set_token
		ok "rotation: same placeholder, the running sandbox kept working (a fake token can't show which value went)"
		results+=("rotation: same placeholder (fake token)")
	fi
	# The token is back; note its new version, so a re-run knows it's still the one this step set.
	set_progress token "$(progress stack) $MODE $(var_updated)"

	# kantel-doctor, built from the same source (the released sandbox image may predate it), sent over in parts.
	docker run --rm --entrypoint cat "$HOST_IMAGE" /usr/local/bin/kantel-guest | gzip -9 >"$TMP/doctor.gz"
	split -b 700000 -d "$TMP/doctor.gz" "$TMP/doctor.part."
	sx_ok "$PARENT" 'rm -rf /tmp/kd && mkdir -p /tmp/kd' >/dev/null
	for part in "$TMP"/doctor.part.*; do
		api PUT "/v1/sandboxes/$PARENT/files" "$(jq -nc --arg p "/tmp/kd/$(basename "$part")" --rawfile c <(base64 -w0 "$part") \
			'{path: $p, content: $c, encoding: "base64"}')" >/dev/null
	done
	doctor=$(sx_ok "$PARENT" 'cat /tmp/kd/doctor.part.* | gunzip >/tmp/kd/kantel-doctor && chmod 755 /tmp/kd/kantel-doctor && /tmp/kd/kantel-doctor')
	printf '%s\n' "$doctor" | sed 's/^/    /'
	for want in '^ok HTTP_PROXY' '^ok HTTPS_PROXY' '^ok egress certificate' '^ok GH_TOKEN api\.github\.com: would be swapped'; do
		grep -q "$want" <<<"$doctor" || die "kantel-doctor didn't say: $want"
	done
	ok "kantel-doctor: proxy set, the sandbox's CA trusted, GH_TOKEN would be swapped for api.github.com"

	# A canary on the sandbox's disk: the host-state scan must find it, or it isn't reading what the sandbox writes.
	sx_ok "$PARENT" "printf '%s\n' '$CANARY' >\$HOME/kantel-e2e-canary && sync" >/dev/null
	results+=("kantel-doctor: ok (proxy, CA, GH_TOKEN would be swapped)")

	# A live fork (before any snapshot, which a fork would start from instead): the microVM copied with its memory.
	FORK=$(api POST "/v1/sandboxes/$PARENT/fork" '{"name": "rte-fork", "wait": true}' | jq -r '.items[0].id')
	running "$FORK" || die "the fork $FORK isn't running"
	fork_uptime=$(sx_ok "$FORK" 'cut -d. -f1 /proc/uptime')
	parent_uptime=$(sx_ok "$PARENT" 'cut -d. -f1 /proc/uptime')
	if ((fork_uptime + 5 >= parent_uptime)); then fork_kind="live, with memory"; else fork_kind="booted from disk"; fi
	fork_placeholder=$(sx_ok "$FORK" 'printf %s "$GH_TOKEN"')
	[[ "$fork_placeholder" =~ ^kph_[A-Za-z0-9]{40}$ && "$fork_placeholder" != "$placeholder" ]] ||
		die "the fork's GH_TOKEN isn't a placeholder of its own"
	gh_user "$FORK" "$MODE"
	egress_swapped "$FORK" /user || die "the fork's egress log has no GET api.github.com/user with GH_TOKEN swapped"
	parent_in_fork=$(sx "$FORK" "curl -sS -o /dev/null -D - -H 'Authorization: Bearer $placeholder' https://api.github.com/user" | jq -r '.stdout + .stderr')
	# The fork's egress log, newest first, must show that second GET /user with nothing swapped.
	parent_note=""
	for _ in $(seq 1 20); do
		if api GET "/v1/sandboxes/$FORK/egress" |
			jq -e '[.entries[] | select(.host == "api.github.com" and .path == "/user")] | length >= 2 and .[0].swapped == []' >/dev/null; then
			parent_note="not swapped (the egress log shows nothing swapped; GitHub answered $(grep -o '^HTTP/[0-9.]* [0-9]*' <<<"$parent_in_fork" | tail -1 | cut -d' ' -f2))"
			break
		fi
		sleep 1
	done
	if [[ -z "$parent_note" ]] && grep -qi 'X-Kantel-Proxy-Error: placeholder-unbound' <<<"$parent_in_fork"; then
		parent_note="refused, 403 placeholder-unbound"
	fi
	[[ -n "$parent_note" ]] ||
		die "the parent's placeholder sent from the fork was neither refused nor left unswapped: $(head -c 300 <<<"$parent_in_fork")"
	if [[ "$MODE" == real ]] && grep -q '^HTTP/[0-9.]* 200' <<<"$parent_in_fork"; then
		die "the parent's placeholder sent from the fork got GitHub's 200: it was swapped"
	fi
	ok "fork $FORK ($fork_kind): its own placeholder (${fork_placeholder:0:8}…) works; the parent's: $parent_note"
	results+=("fork ($fork_kind): own placeholder, gh api user $([[ "$MODE" == real ]] && echo "$LOGIN" || echo 401), parent's placeholder $parent_note")
	sx_ok "$FORK" 'sync' >/dev/null

	sx_ok "$PARENT" 'sync' >/dev/null
	SNAPSHOT=$(api POST "/v1/sandboxes/$PARENT/snapshots" '{"description":"real-token E2E"}' | jq -r '.id')
	for _ in $(seq 1 120); do
		state=$(api GET "/v1/snapshots/$SNAPSHOT" | jq -r '.state')
		[[ "$state" == creating ]] || break
		sleep 2
	done
	[[ "$state" == ready ]] || die "snapshot $SNAPSHOT is $state"
	ok "snapshot $SNAPSHOT of $PARENT ($(api GET "/v1/snapshots/$SNAPSHOT" | jq -r 'if .memory then "with memory" else "its disk" end'))"

	# A pause keeps the parent's memory on the host; after the resume, the same placeholder still works.
	api POST "/v1/sandboxes/$PARENT/stop" '{"keepMemory": true, "wait": true}' >/dev/null
	[[ "$(sandbox_state "$PARENT")" == paused ]] || die "$PARENT didn't pause: $(sandbox_state "$PARENT")"
	api POST "/v1/sandboxes/$PARENT/resume" '{"wait": true}' >/dev/null
	running "$PARENT" || die "$PARENT didn't resume: $(sandbox_state "$PARENT")"
	[[ "$(sx_ok "$PARENT" 'printf %s "$GH_TOKEN"')" == "$placeholder" ]] || die "the placeholder changed across the pause"
	gh_user "$PARENT" "$MODE" 15
	memory_snapshots=$(api GET "/v1/snapshots?sandboxId=$PARENT" | jq '[.items[] | select(.memory)] | length')
	ok "paused with its memory ($memory_snapshots memory snapshot(s)) and resumed: same placeholder, gh api user works"
	results+=("pause with memory and resume: same placeholder, gh api user $([[ "$MODE" == real ]] && echo "$LOGIN" || echo 401)")

	rm -f "$E2E_HOME/progress/scan"
	printf '%s %s %s\n%s\n%s\n' "$PARENT" "$FORK" "$SNAPSHOT" "$(progress token)" "$(printf '%s\n' "${results[@]}")" \
		>"$E2E_HOME/progress/sandbox"
fi

# ===================================================================================================================
rb_step rte-scan "Look for the token everywhere"
if [[ -n "$(progress scan)" && "$(progress scan | head -1)" == "$(progress sandbox | head -1)" ]]; then
	rb_skip "no trace of it"
	progress scan | tail -n +2 | sed 's/^/    /'
else
	scans=()
	# check WHAT: stdin must not hold the token (nor the rotation's stand-in).
	check() {
		local n
		n=$(hits)
		[[ "$n" == 0 ]] || die "the token is in $1 ($n lines)"
		ok "not in $1"
	}
	for id in "$PARENT" "$FORK"; do
		# Everything every process there was started with, and what the sandbox user's environment holds now.
		dump=$(sx_ok "$id" 'env; sudo sh -c '\''for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do tr "\0" "\n" <"$f"; echo; done 2>/dev/null'\'' | gzip | base64 -w0' 120000)
		lines=$(base64 -d <<<"${dump##*$'\n'}" | gunzip | wc -l)
		{ head -n -1 <<<"$dump"; base64 -d <<<"${dump##*$'\n'}" | gunzip; } | check "$id's environment and /proc ($lines lines)"
		grep -q 'GH_TOKEN=kph_' <<<"$dump" || die "$id's environment dump has no GH_TOKEN placeholder, so it can't be trusted"
	done
	scans+=("environment and /proc of both sandboxes: 0")

	# The host's state: both sandboxes' disks, the snapshots and memory files, the fork, the host's own files, and the
	# RAM spool memory snapshots go to first.
	state_dirs="/var/lib/kantel-host /dev/shm/kantel-host"
	# shellcheck disable=SC2086 # two paths
	size=$(docker exec "$HOST" sh -c "du -csh --apparent-size $state_dirs 2>/dev/null | tail -1" | cut -f1)
	files=$(docker exec "$HOST" sh -c "find $state_dirs -type f 2>/dev/null | wc -l")
	mems=$(docker exec "$HOST" sh -c "find $state_dirs -type f -name 'mem*' 2>/dev/null | wc -l")
	((mems > 0)) || die "there's no memory file in the host's state, so the scan wouldn't cover memory"
	info "reading all $size of the host's state ($files files, $mems memory files): disks, snapshots, memory, the fork"
	docker exec "$HOST" sh -c "grep -rqaF -D skip -e '$CANARY' $state_dirs 2>/dev/null" ||
		die "the scan of the host's state didn't find the canary the sandbox wrote, so it can't be trusted"
	ok "the scan finds the canary the sandbox wrote to its disk"
	status=0
	found=$(printf '%s\n%s\n' "$TOKEN" "$ROTATED" |
		docker exec -i "$HOST" sh -c "grep -rlaF -D skip -f /dev/stdin $state_dirs 2>/dev/null") || status=$?
	[[ "$status" == 1 ]] || die "the token is in the host's state, or the scan failed ($status): $found"
	ok "not in the host's state: $files files ($mems memory), $size"
	scans+=("host state (disks, snapshots, memory files, fork, RAM spool): $files files ($mems memory), $size, 0")

	docker logs "$GW" 2>&1 | check "the gateway's log"
	docker logs "$HOST" 2>&1 | check "the host's log"
	{
		api GET "/v1/environments/$ENV_ID"
		api GET /v1/sandboxes
		for id in "$PARENT" "$FORK"; do
			api GET "/v1/sandboxes/$id/egress"
			api GET "/v1/sandboxes/$id/commands"
		done
		api GET "/v1/snapshots/$SNAPSHOT"
		api GET "/v1/events"
	} | check "the API's answers (environment, sandboxes, egress logs, commands, snapshot, events)"
	cat "$E2E_HOME"/logs/*.log | check "this E2E's logs"
	scans+=("gateway and host logs, API answers, these logs: 0")

	printf '%s\n%s\n' "$(progress sandbox | head -1)" "$(printf '%s\n' "${scans[@]}")" >"$E2E_HOME/progress/scan"
fi

# ===================================================================================================================
rb_step rte-cleanup "Tear the test Kantel down"
if [[ "${E2E_KEEP:-}" == 1 ]]; then
	info "E2E_KEEP=1: the test Kantel stays up at $GW_URL (its key: computeKey in $GW's /var/lib/harbour/bootstrap.json)"
	info "Run again without E2E_KEEP to tear it down."
	echo
	echo "Every check passed; the test Kantel is still running. Log: $LOG"
	exit 0
fi
volumes=$(docker volume ls -q --filter label=kantel-rte=1 | tr '\n' ' ')
info "This removes $GW, $HOST, the network $NET and the host's state (volumes: ${volumes:-none});"
info "the token goes with them."
confirm "Tear the test Kantel down now?" || stop_no
docker rm -f "$HOST" "$GW" >/dev/null 2>&1 || true
for volume in $volumes; do
	docker volume rm "$volume" >/dev/null || die "couldn't remove the volume $volume"
done
docker network rm "$NET" >/dev/null 2>&1 || true
for thing in "$HOST" "$GW"; do
	[[ -z "$(container_id "$thing")" ]] || die "$thing is still there"
done
[[ -z "$(docker volume ls -q --filter label=kantel-rte=1)" ]] || die "a kantel-rte volume is still there"
ok "torn down; the images $GW_IMAGE and $HOST_IMAGE stay for the next run"

{
	echo "$REF $MODE"
	echo "passed $(date -u +%Y-%m-%dT%H:%M:%SZ) at $REF with a $MODE token${LOGIN:+ ($LOGIN)}"
	progress sandbox | tail -n +3
	progress scan | tail -n +2
} >"$TMP/complete"
reset_progress
cp "$TMP/complete" "$E2E_HOME/progress/complete"

echo
echo "Every check passed:"
tail -n +2 "$E2E_HOME/progress/complete" | sed 's/^/  /'
echo "Log: $LOG"
