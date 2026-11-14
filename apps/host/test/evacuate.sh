#!/usr/bin/env bash
# Moving every sandbox off a draining host (docs/design/disk-store.md, "Draining a host"): local-stack.sh --hosts 3
# starts the self-hosted control plane over a Postgres of its own (so its records outlast a restart) and three
# kantel-host processes from this branch, each in a container of its own on Docker's bridge, in the deployment's default
# pool, which gets sync on. The hosts are the same machine with the same Firecracker, guest kernel and image
# (KANTEL_STACK_IMAGE_DIGEST), memory snapshots written to disk, and peer sync held to 80 Mbit/s so the moves take a
# while. Three running microVMs and two stopped ones are made on h1, each with a marker file and 48 MiB of random bytes
# on its disk, and a ticker (a process writing the time every 0.2 s) in each running one. Then:
#
#   1. POST /admin/hosts/{h1}/evacuation drains h1 and begins moving its five sandboxes off, at most two at a time;
#   2. once the first has moved, the control plane is killed (SIGKILL) and started again: the evacuation is still
#      running, and the new process's sweep carries it on once the dead one's hold on it runs out, the moves it cut
#      short settled first;
#   3. it ends done, every sandbox moved: h1 has none left, each runs on h2 or h3 with its marker and its random bytes,
#      and the running ones' tickers still run (their memory went with them).
#
# It stops and removes the stack and its Postgres at the end, whatever happened.
#
#   apps/host/test/evacuate.sh
#
# Needs what local-stack.sh needs, and the postgres:17-alpine image. The stack is named evac-<pid>, with its own state
# directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=evac-$$
pg=kantel-stack-$name-pg
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true; docker rm -f "$pg" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$pg" -e POSTGRES_PASSWORD=kantel -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
pg_port=$(docker port "$pg" 5432/tcp | head -1 | sed 's/.*://')
for _ in $(seq 60); do
	docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break
	sleep 1
done
sleep 2
KANTEL_STACK_DATABASE_URL="postgres://postgres:kantel@127.0.0.1:$pg_port/postgres" \
	KANTEL_SECRETS_KEY=$(head -c 32 /dev/urandom | base64) \
	KANTEL_STACK_IMAGE_DIGEST=$(printf 'evacuate %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 3 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
root=/var/lib/kantel-host/microvm

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'move|import|export|fetch' | tail -20 >&2 || true
	done
	echo "--- gateway" >&2
	grep -iE 'move|evacuat|hosts\]|error' "$dir/gateway.log" | tail -30 >&2 || true
	exit 1
}
# Waits until `$@` succeeds, for $wait seconds (default 120) at most.
until_ok() {
	local deadline=$((SECONDS + ${wait:-120}))
	until "$@"; do
		[ $SECONDS -lt $deadline ] || return 1
		sleep 1
	done
}
online() { api GET "/admin/hosts/$1" | jq -e '.state == "online"' >/dev/null 2>&1; }
mesh_up() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | grep -q fd; }
drain() {
	local want=online
	[ "$2" = true ] && want=draining
	api PATCH "/admin/hosts/$1" -d "{\"draining\":$2}" | jq -e --arg s "$want" '.state == $s' >/dev/null || fail "draining $1: $2"
}
# Runs a command in sandbox $1, answering what it printed.
run() {
	local out
	out=$(jq -n --arg c "$2" '{command: $c, timeoutMs: 300000}' | api POST "/sandboxes/$1/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in $1: $2: $out"
	jq -r .stdout <<<"$out"
}

h1=$(cat "$dir/h1/host-id")
h2=$(cat "$dir/h2/host-id")
h3=$(cat "$dir/h3/host-id")
for h in h1 h2 h3; do
	jq '.syncRateMbit = 80 | .spoolMaxMiB = -1' "$dir/$h/config.json" >"$dir/$h/config.new" &&
		cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "kantel-stack-$name-$h" >/dev/null
done
for id in "$h1" "$h2" "$h3"; do until_ok online "$id" || fail "$id didn't come back"; done
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
for h in h1 h2 h3; do
	until_ok mesh_up "kantel-stack-$name-$h" || fail "$h brought no mesh up"
	docker exec "kantel-stack-$name-$h" curl -sS http://127.0.0.1:7070/facts |
		jq -e '.features | index("sandbox-move-memory")' >/dev/null || fail "$h doesn't report sandbox-move-memory"
done

echo "== Five sandboxes on h1: three running, with a ticker each, and two stopped"
drain "$h2" true
drain "$h3" true
ticker='cd /home/user && (setsid sh -c '"'"'echo $$ > ticker.pid; while true; do date +%s.%N >> ticks; sleep 0.2; done'"'"' >/dev/null 2>&1 &) && sleep 1 && cat ticker.pid'
sandboxes=()
declare -A bulk tickers
for i in 1 2 3 4 5; do
	made=$(api POST /sandboxes -d '{"type":"microvm","wait":true}')
	id=$(jq -r .id <<<"$made")
	[ -n "$id" ] && [ "$id" != null ] || fail "no sandbox: $made"
	[ "$(jq -r .hostId <<<"$made")" = "$h1" ] || fail "$id isn't on h1"
	run "$id" "echo marker-$i > /home/user/marker && head -c 48M /dev/urandom > /home/user/bulk && sync" >/dev/null
	bulk[$id]=$(run "$id" 'sha256sum /home/user/bulk | cut -d" " -f1')
	if [ "$i" -le 3 ]; then
		tickers[$id]=$(run "$id" "$ticker" | xargs)
	else
		api POST "/sandboxes/$id/stop" -d '{"wait":true}' | jq -e '.state == "stopped"' >/dev/null || fail "stop $id"
	fi
	sandboxes+=("$id")
done
drain "$h2" false
drain "$h3" false

echo "== 1. Move everything off h1"
began=$SECONDS
evacuation=$(api POST "/admin/hosts/$h1/evacuation")
jq -e '.state == "running" and (.sandboxes | length) == 5' >/dev/null <<<"$evacuation" ||
	fail "it didn't begin: $(jq -c . <<<"$evacuation")"
api GET "/admin/hosts/$h1" | jq -e '.state == "draining"' >/dev/null || fail "h1 isn't draining"
# Never more than two moving at once, as long as it runs.
moving_at_most_two() {
	local read
	read=$(api GET "/admin/hosts/$h1/evacuation")
	[ "$(jq '[.sandboxes[] | select(.state == "moving")] | length' <<<"$read")" -le 2 ] ||
		fail "more than two moving: $(jq -c '[.sandboxes[] | {sandboxId, state}]' <<<"$read")"
	jq -e '.moved >= 1' >/dev/null <<<"$read"
}
wait=600 until_ok moving_at_most_two || fail "nothing moved: $(api GET "/admin/hosts/$h1/evacuation" | jq -c .)"
echo "first moved after $((SECONDS - began)) s: $(api GET "/admin/hosts/$h1/evacuation" | jq -c '{moved, remaining}')"

echo "== 2. The control plane killed part way, and started again"
"$stack" restart --name "$name" >/dev/null
after=$(api GET "/admin/hosts/$h1/evacuation")
jq -e '.state == "running"' >/dev/null <<<"$after" || fail "it didn't outlast the restart: $(jq -c . <<<"$after")"
echo "after the restart: $(jq -c '{state, moved, remaining}' <<<"$after")"
for id in "$h1" "$h2" "$h3"; do wait=180 until_ok online "$id" || fail "$id didn't connect again"; done
ended() { api GET "/admin/hosts/$h1/evacuation" | jq -e '.state != "running"' >/dev/null; }
wait=900 until_ok ended || fail "it didn't end: $(api GET "/admin/hosts/$h1/evacuation" | jq -c .)"
done_=$(api GET "/admin/hosts/$h1/evacuation")
echo "ended after $((SECONDS - began)) s: $(jq -c '{state, moved, skipped, failed}' <<<"$done_")"
jq -e '.state == "done" and .moved == 5 and .failed == 0 and .skipped == 0' >/dev/null <<<"$done_" ||
	fail "it ended as $(jq -c . <<<"$done_")"

echo "== 3. h1 is empty, and each sandbox runs on h2 or h3 with its files"
api GET "/admin/hosts/$h1" | jq -e '.allocated.sandboxes == 0 and .evacuation.state == "done"' >/dev/null ||
	fail "h1: $(api GET "/admin/hosts/$h1" | jq -c '{allocated, evacuation}')"
docker exec "kantel-stack-$name-h1" sh -c "ls $root/sandboxes 2>/dev/null | wc -l" | grep -qx 0 ||
	fail "h1 still has sandboxes: $(docker exec "kantel-stack-$name-h1" ls "$root/sandboxes")"
for i in "${!sandboxes[@]}"; do
	id=${sandboxes[$i]}
	sandbox=$(api GET "/sandboxes/$id")
	jq -e --arg b "$h2" --arg c "$h3" '.state == "running" and (.hostId == $b or .hostId == $c)' >/dev/null <<<"$sandbox" ||
		fail "$id: $(jq -c '{state, hostId}' <<<"$sandbox")"
	[ "$(run "$id" 'cat /home/user/marker')" = "marker-$((i + 1))" ] || fail "$id's marker"
	[ "$(run "$id" 'sha256sum /home/user/bulk | cut -d" " -f1')" = "${bulk[$id]}" ] || fail "$id's random bytes differ"
	if [ -n "${tickers[$id]:-}" ]; then
		[ "$(run "$id" "kill -0 ${tickers[$id]} 2>/dev/null && echo yes || echo no")" = yes ] ||
			fail "$id's ticker isn't running: its memory didn't go with it ($(jq -c .moved <<<"$sandbox"))"
	fi
	echo "$id: running on $(jq -r .hostId <<<"$sandbox"), memory kept: $(jq -r '.moved.keptMemory' <<<"$sandbox")"
done
echo "PASS: everything moved off h1, through a control plane restart"
