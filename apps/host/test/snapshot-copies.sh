#!/usr/bin/env bash
# Two copies of each saved snapshot (docs/design/disk-store.md, "Phase 3 notes", Two copies): local-stack.sh --hosts 3
# starts the self-hosted control plane, with sticky disks on (so it signs fetch grants), and three kantel-host
# processes from this branch, each in a container of its own on Docker's bridge, all in the deployment's default pool,
# which gets sync on, as snapshot-sync.sh does. Then:
#
#   1. a sandbox on one host (A) writes a file to its disk and is saved with its memory: within minutes a second host
#      (B, whichever the control plane picks) holds a copy, with its memory (the hosts share a CPU and runtime), and the
#      snapshot's details list both;
#   2. A is revoked: the third host (C) gets a copy from B, and the details list B and C;
#   3. a create from the snapshot runs on B or C, with the file on its disk;
#   4. that sandbox's stops on its host prune its own automatic snapshots there: both copies are still on their hosts,
#      and still listed, after the host's pruning and the control plane's passes.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/snapshot-copies.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images, and the guest image must take sticky
# drives; KANTEL_STACK_DIR, KANTEL_STACK_IMAGE_DIGEST and KANTEL_STACK_HOST_FLAGS are set here). The stack is named
# copies-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=copies-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_STICKY_DISKS=experimental KANTEL_STACK_IMAGE_DIGEST=$(printf 'snapshot-copies %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 3 --name "$name" >/dev/null

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
		sleep 2
	done
}
online() { api GET "/admin/hosts/$1" | jq -e '.state == "online"' >/dev/null; }
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
# The snapshot's hosts as its details list them: `<hostId>:<state>:<memory>`, one a line, in their order.
hosts_of() { api GET "/snapshots/$snap" | jq -r '(.hosts // [])[] | "\(.hostId):\(.state):\(.memory)"'; }
# The IDs of the hosts holding the snapshot, sorted, one a line.
holding() { hosts_of | awk -F: '$2 == "held" {print $1}' | sort; }
# Whether the snapshot's holders are exactly the host IDs given.
held_by() { [ "$(holding)" = "$(printf '%s\n' "$@" | sort)" ]; }
container_of() {
	local h
	for h in h1 h2 h3; do
		[ "$(cat "$dir/$h/host-id")" = "$1" ] && echo "kantel-stack-$name-$h"
	done
}
# Whether host container $1 has the saved snapshot $on_a published (its record and disk).
has_copy() { docker exec "$1" test -f "$snapshots/$on_a/meta.json" -a -f "$snapshots/$on_a/disk.ext4"; }

ids=()
for h in h1 h2 h3; do ids+=("$(cat "$dir/$h/host-id")"); done
a_id=${ids[0]}
a=kantel-stack-$name-h1
# Memory goes straight to the disk: a container's /dev/shm (64 MiB) has no room to spool it. The settings file is
# mounted, so it is written in place, then the host restarted.
for h in h1 h2 h3; do
	jq '.spoolMaxMiB = -1' "$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "kantel-stack-$name-$h" >/dev/null
done
for id in "${ids[@]}"; do until_ok online "$id" || fail "$id didn't come back"; done
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
for h in h1 h2 h3; do
	c=kantel-stack-$name-$h
	until_ok mesh_up "$c" || fail "$c brought no mesh up"
	docker exec "$c" curl -sS http://127.0.0.1:7070/facts | jq -e '.features | index("snapshot-sync")' >/dev/null ||
		fail "$c doesn't report snapshot-sync"
done
api GET /accounts | jq -e '.items[0].snapshotCopies == true' >/dev/null || fail "the account's copies aren't on"

echo "== 1. Saved on A: a second host holds it within minutes"
drain "${ids[1]}" true
drain "${ids[2]}" true
source=$(api POST /sandboxes -d '{"type":"microvm","wait":true}' | jq -r .id)
[ "$(api GET "/sandboxes/$source" | jq -r .hostId)" = "$a_id" ] || fail "the sandbox isn't on A"
drain "${ids[1]}" false
drain "${ids[2]}" false
run "$source" 'echo on-disk > /home/user/disk-marker && sync' >/dev/null
started=$SECONDS
out=$(api POST /snapshots -d "{\"name\":\"copies\",\"sandboxId\":\"$source\",\"memory\":true}")
snap=$(jq -r .id <<<"$out")
[ -n "$snap" ] && [ "$snap" != null ] || fail "save: $out"
ready() { api GET "/snapshots/$snap" | jq -e '.state == "ready"' >/dev/null; }
wait=300 until_ok ready || fail "the snapshot isn't ready: $(api GET "/snapshots/$snap")"
on_a=$(docker exec "$a" sh -c "grep -l '\"kind\": \"saved\"' $snapshots/*/meta.json" | xargs -n1 dirname | xargs -n1 basename)
[[ "$on_a" =~ ^ssnap_[0-9a-f]{32}$ ]] || fail "A's saved snapshot isn't named by a saved snapshot's ID: $on_a"
two_held() { [ "$(holding | wc -l)" -eq 2 ]; }
wait=300 until_ok two_held || fail "no second host holds it: $(hosts_of)"
b_id=$(holding | grep -vx "$a_id")
for id in "${ids[@]}"; do [ "$id" = "$a_id" ] || [ "$id" = "$b_id" ] || c_id=$id; done
b=$(container_of "$b_id")
c=$(container_of "$c_id")
has_copy "$b" || fail "B ($b) has no copy of $on_a"
# B shares A's CPU and runtime, so its memory comes too.
with_memory() { hosts_of | grep -qx "$b_id:held:true"; }
wait=180 until_ok with_memory || fail "B's copy has no memory: $(hosts_of)"
[ "$(hosts_of | head -1)" = "$a_id:held:true" ] || fail "A isn't listed first: $(hosts_of)"
echo "saved on A; held by B ($b_id) with its memory after $((SECONDS - started)) s: $(hosts_of | tr '\n' ' ')"

echo "== 2. A revoked: C gets a copy from B"
api DELETE "/admin/hosts/$a_id" >/dev/null
started=$SECONDS
wait=600 until_ok held_by "$b_id" "$c_id" || fail "C didn't get a copy: $(hosts_of)"
has_copy "$c" || fail "C ($c) has no copy of $on_a"
echo "held by B and C ($c_id) $((SECONDS - started)) s after A's revocation: $(hosts_of | tr '\n' ' ')"

echo "== 3. A create from it works"
created=$(api POST /sandboxes -d "{\"from\":\"$snap\",\"wait\":true}")
made=$(jq -r .id <<<"$created")
on=$(jq -r .hostId <<<"$created")
[ "$(jq -r .state <<<"$created")" = running ] || fail "the create from the snapshot: $created"
[ "$on" = "$b_id" ] || [ "$on" = "$c_id" ] || fail "the sandbox isn't on B or C: $created"
jq -e '.startup | has("fetchMs") | not' >/dev/null <<<"$created" || fail "it fetched again: $(jq .startup <<<"$created")"
got=$(run "$made" 'cat /home/user/disk-marker')
[ "$got" = on-disk ] || fail "the sandbox made from it: $got"
echo "made on $on, its disk's file there: $got"

echo "== 4. The hosts' pruning, and the control plane's passes, free neither copy"
for round in 1 2 3 4; do
	stopped=$(api POST "/sandboxes/$made/stop" -d '{"wait":true}')
	[ "$(jq -r .state <<<"$stopped")" = stopped ] || fail "stop $round: $stopped"
	started=$(api POST "/sandboxes/$made/start" -d '{"wait":true}')
	[ "$(jq -r .state <<<"$started")" = running ] || fail "start $round: $started"
done
# A few of the gateway's passes over copies (every 5 minutes) and the hosts' reports.
sleep 330
has_copy "$b" || fail "B's copy was freed"
has_copy "$c" || fail "C's copy was freed"
held_by "$b_id" "$c_id" || fail "the snapshot's holders changed: $(hosts_of)"
echo "both copies kept: $(hosts_of | tr '\n' ' ')"
echo
echo "PASS"
