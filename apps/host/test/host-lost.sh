#!/usr/bin/env bash
# A host killed mid-run (docs/site/src/content/docs/sandboxes/lifecycle.md, "When its host is lost"): local-stack.sh
# --hosts 2 starts the self-hosted control plane, with a lost-host deadline of KANTEL_HOST_LOST_AFTER_MINUTES (1 here
# unless set) and sticky disks on (so it signs fetch grants), and two kantel-host processes from this branch, each in a
# container of its own on Docker's bridge, in the deployment's default pool, which gets sync on, as
# snapshot-copies.sh does. Three running microVMs are made on h1:
#
#   saved     onHostLost recreate, saved with its memory, and h2's copy of the snapshot awaited (memory too), then a
#             file written after the save;
#   unsaved   onHostLost recreate, never saved;
#   lost      the default (lost).
#
# Then:
#
#   1. h1 is killed as a power cut would: its traffic dropped first (no FIN or RST reaches the control plane, so only
#      LLE-19601's heartbeat deadline, three missed 15 s heartbeats, ends its connection), then its container killed,
#      its microVMs with it;
#   2. within that deadline plus the lost-host one (plus a 5 s loss pass, and the new microVM's boot for saved): saved
#      runs on h2 under the same ID, with a sandbox.recreated event naming the snapshot, the snapshot's files and memory,
#      and not the file written after it; unsaved and lost are `lost`, each with one sandbox.lost event, and refuse a
#      command with sandbox_lost;
#   3. h1 is started again on the disk it had: it deletes its fenced copies before it is used (the sandboxes it held
#      are gone from its disk, no Firecracker of theirs runs), saved still runs on h2 alone, and none of the three is on
#      two hosts;
#   4. the two lost sandboxes are deleted.
#
# It prints each step's time from the kill. It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/host-lost.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_IMAGE_DIGEST and
# KANTEL_STACK_HOST_FLAGS are set here). The stack is named lost-<pid>, with its own state directory,
# kantel-local-stack-lost-<pid> in KANTEL_STACK_ROOT (default /tmp; give another where Docker doesn't see this /tmp,
# as its containers mount from it), so it runs beside other stacks. About 15 minutes, most of it the hosts' templates and the snapshot's copy.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=lost-$$
export KANTEL_STACK_DIR=${KANTEL_STACK_ROOT:-/tmp}/kantel-local-stack-$name
lost_after=${KANTEL_HOST_LOST_AFTER_MINUTES:-1}
# The heartbeat deadline (packages/hosts/src/hub.ts): three of the welcome's 15 s heartbeats.
heartbeat=45
# Past the two deadlines: a loss pass runs every 5 s, and the replacement microVM boots after it.
pass=10
boot=60
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_HOST_LOST_AFTER_MINUTES=$lost_after KANTEL_STICKY_DISKS=experimental \
	KANTEL_STACK_IMAGE_DIGEST=$(printf 'host-lost %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 2 --name "$name" >/dev/null

dir=$KANTEL_STACK_DIR
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
		docker logs "$container" 2>&1 | grep -iE 'fence|delete|create|snapshot|fetch|connect' | tail -30 >&2 || true
	done
	echo "--- gateway" >&2
	grep -iE 'lost|fence|recreat|hosts\]|error' "$dir/gateway.log" | tail -30 >&2 || true
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
	out=$(jq -n --arg c "$2" '{command: $c, timeoutMs: 120000}' | api POST "/sandboxes/$1/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in $1: $2: $out"
	jq -r .stdout <<<"$out"
}
state_of() { api GET "/sandboxes/$1" | jq -r '"\(.state) \(.hostId // "-")"'; }
# Sandbox $1's events of type $2, one JSON object a line.
events() { api GET "/events?sandboxId=$1&limit=100" | jq -c --arg t "$2" '.items[] | select(.type == $t)'; }
# The sandbox directories on host container $1, one a line.
held_on() { docker exec "$1" sh -c "ls $root/sandboxes 2>/dev/null || true"; }
# The snapshot's holders as its details list them, `<hostId>:<state>:<memory>`, one a line.
holders() { api GET "/snapshots/$snap" | jq -r '(.hosts // [])[] | "\(.hostId):\(.state):\(.memory)"'; }

h1=$(cat "$dir/h1/host-id")
h2=$(cat "$dir/h2/host-id")
c1=kantel-stack-$name-h1
c2=kantel-stack-$name-h2
# Memory goes straight to the disk: a container's /dev/shm (64 MiB) has no room to spool it. The settings file is
# mounted, so it is written in place, then the host restarted.
for h in h1 h2; do
	jq '.spoolMaxMiB = -1' "$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "kantel-stack-$name-$h" >/dev/null
done
for id in "$h1" "$h2"; do until_ok online "$id" || fail "$id didn't come back"; done
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
for c in "$c1" "$c2"; do
	until_ok mesh_up "$c" || fail "$c brought no mesh up"
	docker exec "$c" curl -sS http://127.0.0.1:7070/facts | jq -e '.features | index("snapshot-sync")' >/dev/null ||
		fail "$c doesn't report snapshot-sync"
done
api GET /accounts | jq -e '.items[0].snapshotCopies == true' >/dev/null || fail "the account's copies aren't on"

echo "== Three running microVMs on h1: saved (recreate, saved), unsaved (recreate) and lost (the default)"
drain "$h2" true
# Makes a sandbox with body $1, on h1 (h2 drained), answering its ID.
on_h1() {
	local made id
	made=$(api POST /sandboxes -d "$1")
	id=$(jq -r .id <<<"$made")
	[ -n "$id" ] && [ "$id" != null ] || fail "no sandbox: $made"
	[ "$(jq -r .hostId <<<"$made")" = "$h1" ] || fail "$id isn't on h1: $(jq -c '{state, hostId}' <<<"$made")"
	echo "$id"
}
saved=$(on_h1 '{"type":"microvm","wait":true,"onHostLost":"recreate","name":"saved"}')
unsaved=$(on_h1 '{"type":"microvm","wait":true,"onHostLost":"recreate","name":"unsaved"}')
lost=$(on_h1 '{"type":"microvm","wait":true,"name":"lost"}')
drain "$h2" false
api GET "/sandboxes/$saved" | jq -e '.onHostLost == "recreate"' >/dev/null || fail "saved isn't set to recreate"
api GET "/sandboxes/$lost" | jq -e '.onHostLost == null' >/dev/null || fail "lost has a choice: $(api GET "/sandboxes/$lost" | jq -c .onHostLost)"
for id in "$saved" "$unsaved" "$lost"; do run "$id" "echo $id > /home/user/marker && sync" >/dev/null; done
run "$saved" 'echo in-memory > /dev/shm/memory-marker' >/dev/null
out=$(api POST /snapshots -d "{\"name\":\"before-the-kill\",\"sandboxId\":\"$saved\",\"memory\":true}")
snap=$(jq -r .id <<<"$out")
[ -n "$snap" ] && [ "$snap" != null ] || fail "save: $out"
ready() { api GET "/snapshots/$snap" | jq -e '.state == "ready"' >/dev/null; }
wait=300 until_ok ready || fail "the snapshot isn't ready: $(api GET "/snapshots/$snap")"
# Its memory too, as the hosts share a CPU and runtime: the recreate restores it.
on_h2() { holders | grep -qx "$h2:held:true"; }
wait=300 until_ok on_h2 || fail "h2 holds no copy of $snap with its memory: $(holders | tr '\n' ' ')"
echo "saved $snap, held on $(holders | tr '\n' ' ')"
# Written after the save: gone with h1.
run "$saved" 'echo after > /home/user/after-save && sync' >/dev/null
for id in "$saved" "$unsaved" "$lost"; do
	[ "$(state_of "$id")" = "running $h1" ] || fail "$id: $(state_of "$id")"
done
[ "$(held_on "$c1" | sort)" = "$(printf '%s\n' "$saved" "$unsaved" "$lost" | sort)" ] ||
	fail "h1 holds $(held_on "$c1" | tr '\n' ' ')"

echo "== 1. h1 killed: its traffic dropped, then its container killed"
docker exec "$c1" sh -c 'iptables -I INPUT 1 -j DROP && iptables -I OUTPUT 1 -j DROP'
docker kill "$c1" >/dev/null
killed=$SECONDS
killed_ms=$(date +%s%3N)
since() { echo "$((SECONDS - killed)) s"; }

echo "== 2. Within the heartbeat deadline ($heartbeat s) plus the lost-host one ($lost_after min)"
budget=$((heartbeat + lost_after * 60))
declare -A at
# Notes the first time each step is seen, in seconds from the kill; true once the last has been.
seen() { [ -n "${at[$1]:-}" ] || at[$1]=$((SECONDS - killed)); }
watch() {
	local s
	[ -n "${at[unreachable]:-}" ] || ! api GET "/admin/hosts/$h1" | jq -e '.state == "unreachable"' >/dev/null ||
		seen unreachable
	[[ "$(state_of "$unsaved")" != lost* ]] || seen unsaved
	[[ "$(state_of "$lost")" != lost* ]] || seen lost
	s=$(state_of "$saved")
	[ "$s" = "running $h1" ] || seen recreating
	[ "$s" != "running $h2" ] || seen recreated
	[ -n "${at[unsaved]:-}" ] && [ -n "${at[lost]:-}" ] && [ -n "${at[recreated]:-}" ]
}
wait=$((budget + pass + boot + 60)) until_ok watch ||
	fail "after $(since): unsaved $(state_of "$unsaved"), lost $(state_of "$lost"), saved $(state_of "$saved")"
echo "h1 unreachable after ${at[unreachable]:-?} s (its heartbeat deadline is $heartbeat s)"
echo "unsaved lost after ${at[unsaved]} s, lost lost after ${at[lost]} s, saved recreating after ${at[recreating]:-?} s and running on h2 after ${at[recreated]} s"
[ -n "${at[unreachable]:-}" ] && [ "${at[unreachable]}" -ge 15 ] ||
	fail "h1 was unreachable after ${at[unreachable]:-?} s: its connection didn't wait for the heartbeat deadline"
for which in unsaved lost; do
	[ "${at[$which]}" -le $((budget + pass)) ] || fail "$which was lost after ${at[$which]} s, past $((budget + pass)) s"
done
[ "${at[recreated]}" -le $((budget + pass + boot)) ] ||
	fail "saved ran on h2 after ${at[recreated]} s, past $((budget + pass + boot)) s"

for id in "$unsaved" "$lost"; do
	lost_events=$(events "$id" sandbox.lost)
	[ "$(grep -c . <<<"$lost_events")" = 1 ] || fail "$id's sandbox.lost events: $lost_events"
	jq -e '.data.previousState == "running" and (.data.reason | length) > 0' >/dev/null <<<"$lost_events" ||
		fail "$id's sandbox.lost: $lost_events"
	[ -z "$(events "$id" sandbox.recreated)" ] || fail "$id was recreated: $(events "$id" sandbox.recreated)"
	refused=$(jq -n '{command: "true"}' | api POST "/sandboxes/$id/commands" -d @- -w '\n%{http_code}')
	[ "$(tail -1 <<<"$refused")" = 409 ] && head -1 <<<"$refused" | jq -e '.error.details.code == "sandbox_lost"' >/dev/null ||
		fail "a command in lost $id: $refused"
	echo "$id: lost, its event's reason: $(jq -r .data.reason <<<"$lost_events")"
done
recreated=$(events "$saved" sandbox.recreated)
[ "$(grep -c . <<<"$recreated")" = 1 ] || fail "saved's sandbox.recreated events: $recreated"
jq -e --arg s "$snap" '.snapshotId == $s and .data.previousState == "running"' >/dev/null <<<"$recreated" ||
	fail "saved's sandbox.recreated: $recreated"
[ -z "$(events "$saved" sandbox.lost)" ] || fail "saved has a sandbox.lost: $(events "$saved" sandbox.lost)"
[ "$(run "$saved" 'cat /home/user/marker')" = "$saved" ] || fail "saved's marker"
[ "$(run "$saved" 'cat /home/user/after-save 2>/dev/null || echo none')" = none ] ||
	fail "saved has what it wrote after the snapshot"
[ "$(run "$saved" 'cat /dev/shm/memory-marker 2>/dev/null || echo none')" = in-memory ] ||
	fail "saved's memory didn't come back from $snap"
echo "$saved: running on h2 from $snap, its memory restored, without what it wrote after the save"
# The events' own times, in seconds from the kill (the oldest of each type since it).
event_at() {
	events "$1" "$2" | jq -s -r --argjson k "$killed_ms" \
		'[.[] | select(.createdAt >= $k) | .createdAt] | min | if . == null then "none" else ((. - $k) / 100 | round / 10) end'
}
echo "events: unsaved's sandbox.lost at $(event_at "$unsaved" sandbox.lost) s, lost's at $(event_at "$lost" sandbox.lost) s;" \
	"saved's sandbox.running on h2 at $(event_at "$saved" sandbox.running) s, its sandbox.recreated at $(event_at "$saved" sandbox.recreated) s"

echo "== 3. h1 started again: it deletes its fenced copies before it is used, and none runs twice"
docker start "$c1" >/dev/null
returned=$SECONDS
wait=180 until_ok online "$h1" || fail "h1 didn't come back: $(api GET "/admin/hosts/$h1" | jq -c '{state}')"
echo "h1 online $((SECONDS - returned)) s after its start"
emptied() { [ -z "$(held_on "$c1")" ]; }
wait=60 until_ok emptied || fail "h1 still holds $(held_on "$c1" | tr '\n' ' ')"
# Deleted by the fence (packages/hosts/src/service.ts, runFences), saved's as the copy its replacement owed h1.
for id in "$unsaved" "$lost"; do
	grep -qF "sandbox $id deleted on host $h1, which was lost with it" "$dir/gateway.log" ||
		fail "the fence didn't delete $id on h1"
done
grep -qF "sandbox $saved's copy deleted on host $h1, lost with it" "$dir/gateway.log" ||
	fail "the fence didn't delete saved's copy on h1"
# It held only these three: no microVM runs there at all.
[ "$(docker exec "$c1" ps -eo comm | grep -c '^firecracker' || true)" = 0 ] ||
	fail "Firecracker runs on h1: $(docker exec "$c1" ps -eo pid,args | grep firecracker)"
[ "$(held_on "$c2" | grep -cx "$saved")" = 1 ] || fail "h2 doesn't hold saved: $(held_on "$c2" | tr '\n' ' ')"
for id in "$unsaved" "$lost"; do
	! held_on "$c2" | grep -qx "$id" || fail "h2 holds lost $id"
	[[ "$(state_of "$id")" == lost* ]] || fail "$id: $(state_of "$id")"
done
[ "$(state_of "$saved")" = "running $h2" ] || fail "saved: $(state_of "$saved")"
[ "$(run "$saved" 'cat /home/user/marker')" = "$saved" ] || fail "saved's marker after h1's return"
api GET "/admin/hosts/$h1" | jq -e '.allocated.sandboxes == 0' >/dev/null ||
	fail "h1: $(api GET "/admin/hosts/$h1" | jq -c .allocated)"
echo "h1 holds nothing; saved runs on h2 alone"

echo "== 4. The lost ones deleted"
for id in "$unsaved" "$lost"; do
	api DELETE "/sandboxes/$id" -o /dev/null -w '%{http_code}' | grep -qE '^20[024]$' || fail "delete $id"
	gone() { [ "$(api GET "/sandboxes/$id" | jq -r '.state // "gone"')" != lost ]; }
	wait=60 until_ok gone || fail "$id: $(state_of "$id")"
done
echo
echo "PASS: h1's saved sandbox recreated on h2 after ${at[recreated]} s, the other two lost after ${at[unsaved]} s and ${at[lost]} s; h1's return deleted its copies"
