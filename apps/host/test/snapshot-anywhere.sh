#!/usr/bin/env bash
# A sandbox made from a saved snapshot on any host of its pool (docs/design/disk-store.md, "Phase 3 notes"):
# local-stack.sh --hosts 2 starts the self-hosted control plane, with sticky disks on (so it signs fetch grants), and
# two kantel-host processes from this branch, each in a container of its own on Docker's bridge, both in the
# deployment's default pool, which gets sync on, as snapshot-sync.sh does. Then:
#
#   1. a sandbox on one host (A) writes a file to its disk and one to /dev/shm, in its memory only, and is saved with
#      its memory, under an ID that is its whole ref (`ssnap_…`). Its record on A is made to say another CPU (its
#      featuresHash changed), as a host of another CPU would have it, so a copy elsewhere is its disk alone;
#   2. A drains, so no holder has room: a create from the snapshot goes to B, which fetches it first, the create's
#      startup saying how long that took (`fetchMs`) and that its memory wasn't restored (`restoredMemory` false), and it
#      boots on the disk: the disk's file is there, the memory's isn't;
#   3. A goes offline: another create from it goes to B, a holder now, with nothing to fetch;
#   4. a stop of that sandbox on B leaves an automatic snapshot, whose ref is `{hostId}/{snapshotId}` as before: a
#      create from it goes on B.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/snapshot-anywhere.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images, and the guest image must take sticky
# drives; KANTEL_STACK_DIR, KANTEL_STACK_IMAGE_DIGEST and KANTEL_STACK_HOST_FLAGS are set here). The stack is named
# anywhere-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=anywhere-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_STICKY_DISKS=experimental KANTEL_STACK_IMAGE_DIGEST=$(printf 'snapshot-anywhere %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
snapshots=/var/lib/kantel-host/microvm/snapshots

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|snapshot|mesh|image' | tail -30 >&2 || true
	done
	echo "--- gateway" >&2
	grep -iE 'snapshot|fetch|error' "$dir"/*.log 2>/dev/null | tail -30 >&2 || true
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
online() { api GET "/admin/hosts/$1" | jq -e '.state == "online"' >/dev/null; }
offline() { api GET "/admin/hosts/$1" | jq -e '.state == "offline"' >/dev/null; }
mesh_up() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | grep -q fd; }
drain() {
	local want=online
	[ "$2" = true ] && want=draining
	api PATCH "/admin/hosts/$1" -d "{\"draining\":$2}" | jq -e --arg s "$want" '.state == $s' >/dev/null || fail "draining $1: $2"
}
# Runs a command in sandbox $1, answering its output.
run() {
	local out
	out=$(jq -n --arg c "$2" '{command: $c, timeoutMs: 120000}' | api POST "/sandboxes/$1/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in $1: $2: $out"
	jq -r .stdout <<<"$out"
}
# What a sandbox's two files hold: the one on its disk, and the one in its memory ("none" once it booted).
markers() {
	local out
	out=$(run "$1" 'cat /home/user/disk-marker; cat /dev/shm/memory-marker 2>/dev/null || echo none')
	tr '\n' ' ' <<<"$out"
}
# The host's own IDs of the saved snapshots on host container $1, one a line.
saved_on() {
	docker exec "$1" sh -c "grep -l '\"kind\": \"saved\"' $snapshots/*/meta.json 2>/dev/null || true" |
		xargs -r -n1 dirname | xargs -r -n1 basename | sort
}

a_id=$(cat "$dir/h1/host-id")
b_id=$(cat "$dir/h2/host-id")
a=kantel-stack-$name-h1
b=kantel-stack-$name-h2
# Memory goes straight to the disk: a container's /dev/shm (64 MiB) has no room to spool it. The settings file is
# mounted, so it is written in place, then the host restarted.
for h in h1 h2; do
	jq '.spoolMaxMiB = -1' "$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "kantel-stack-$name-$h" >/dev/null
done
until_ok online "$a_id" || fail "$a didn't come back"
until_ok online "$b_id" || fail "$b didn't come back"
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"
for c in "$a" "$b"; do
	docker exec "$c" curl -sS http://127.0.0.1:7070/facts | jq -e '.features | index("snapshot-sync")' >/dev/null ||
		fail "$c doesn't report snapshot-sync"
done

echo "== 1. Saved with memory on A, under an ID that is its whole ref"
drain "$b_id" true
source=$(api POST /sandboxes -d '{"type":"microvm","wait":true}' | jq -r .id)
[ "$(api GET "/sandboxes/$source" | jq -r .hostId)" = "$a_id" ] || fail "the sandbox isn't on A"
drain "$b_id" false
run "$source" 'echo on-disk > /home/user/disk-marker && sync && echo in-memory > /dev/shm/memory-marker' >/dev/null
out=$(api POST /snapshots -d "{\"name\":\"anywhere\",\"sandboxId\":\"$source\",\"memory\":true}")
snap=$(jq -r .id <<<"$out")
[ -n "$snap" ] && [ "$snap" != null ] || fail "save: $out"
ready() { api GET "/snapshots/$snap" | jq -e '.state == "ready"' >/dev/null; }
wait=300 until_ok ready || fail "the snapshot isn't ready: $(api GET "/snapshots/$snap")"
on_a=$(saved_on "$a")
[[ "$on_a" =~ ^ssnap_[0-9a-f]{32}$ ]] || fail "A's saved snapshot isn't named by a saved snapshot's ID: $on_a"
# Made on another CPU, as far as a copy can tell: B fetches its disk alone.
docker exec "$a" python3 -c '
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["cpu"]["featuresHash"] = "sha256:0000000000000000"
json.dump(m, open(p, "w"), indent=2)' "$snapshots/$on_a/meta.json"
# Mapped, and reported on A's next heartbeat, so there is a holder to fetch it from.
mapped() { docker exec "$a" test -f "$snapshots/$on_a/disk.map"; }
until_ok mapped || fail "A made no map of $on_a"
sleep 20
echo "A saved $on_a, mapped and reported"

echo "== 2. No holder has room (A drains): B fetches it first, and the sandbox boots on its disk there"
drain "$a_id" true
created=$(api POST /sandboxes -d "{\"from\":\"$snap\",\"wait\":true}")
fetched=$(jq -r .id <<<"$created")
[ "$(jq -r .state <<<"$created")" = running ] || fail "the create from the snapshot: $created"
[ "$(jq -r .hostId <<<"$created")" = "$b_id" ] || fail "the sandbox isn't on B: $created"
jq -e '.startup.fetchMs > 0 and .startup.restoredMemory == false' >/dev/null <<<"$created" ||
	fail "its startup doesn't say it fetched the snapshot and booted: $(jq .startup <<<"$created")"
docker exec "$b" test -f "$snapshots/$on_a/meta.json" || fail "B has no copy of $on_a"
[ "$(docker exec "$b" python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("coldBoot"))' "$snapshots/$on_a/meta.json")" = True ] ||
	fail "B's copy isn't marked to cold-boot: $(docker exec "$b" cat "$snapshots/$on_a/meta.json")"
got=$(markers "$fetched")
[ "$got" = "on-disk none " ] || fail "the sandbox made on B: $got"
echo "made on B after its fetch ($(jq .startup.fetchMs <<<"$created") ms), booted on the disk: $got"

echo "== 3. A goes offline: a create from it goes on B, which holds it now"
drain "$a_id" false
docker stop "$a" >/dev/null
until_ok offline "$a_id" || fail "A isn't offline"
created=$(api POST /sandboxes -d "{\"from\":\"$snap\",\"wait\":true}")
held=$(jq -r .id <<<"$created")
[ "$(jq -r .state <<<"$created")" = running ] && [ "$(jq -r .hostId <<<"$created")" = "$b_id" ] ||
	fail "the create with A offline: $created"
jq -e '.startup | has("fetchMs") | not' >/dev/null <<<"$created" || fail "it fetched again: $(jq .startup <<<"$created")"
got=$(markers "$held")
[ "$got" = "on-disk none " ] || fail "the sandbox made on B's copy: $got"
echo "made on B's copy with A offline: $got"

echo "== 4. An automatic snapshot's ref, {hostId}/{snapshotId} as before: a create from it goes on its host"
stopped=$(api POST "/sandboxes/$held/stop" -d '{"wait":true}')
[ "$(jq -r .state <<<"$stopped")" = stopped ] || fail "the stop: $stopped"
latest=$(api GET "/snapshots?sandboxId=$held&kind=automatic" | jq -r '.items[0].id')
[ -n "$latest" ] && [ "$latest" != null ] || fail "no automatic snapshot of $held"
created=$(api POST /sandboxes -d "{\"from\":\"$latest\",\"wait\":true}")
[ "$(jq -r .state <<<"$created")" = running ] && [ "$(jq -r .hostId <<<"$created")" = "$b_id" ] ||
	fail "the create from the automatic snapshot: $created"
got=$(markers "$(jq -r .id <<<"$created")")
[ "$got" = "on-disk none " ] || fail "the sandbox made from the automatic snapshot: $got"
echo "made from B's automatic snapshot on B: $got"
echo
echo "PASS"
