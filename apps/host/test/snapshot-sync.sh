#!/usr/bin/env bash
# Saved snapshots from peers (docs/design/disk-store.md, "Phase 3 notes"): local-stack.sh --hosts 2 starts the
# self-hosted control plane, with sticky disks on (so it signs fetch grants), and two kantel-host processes from this
# branch, each in a container of its own on Docker's bridge, both in the deployment's default pool, which gets sync on.
# Both record one digest for their microVM image (KANTEL_STACK_IMAGE_DIGEST), as hosts that downloaded the same image
# do, serve their calls on 127.0.0.1:7070 in their containers (--local), and write memory to the disk without spooling
# it. Then:
#
#   1. a sandbox on one host (A) writes a file to its disk and one to /dev/shm, in its memory only, and is saved with
#      its memory; B is told to fetch the snapshot (POST /admin/hosts/{B}/snapshot-fetches) and fetches its disk, then
#      its memory, the hosts' CPU and runtime being the same; a sandbox.create on B from it (its host protocol, as the
#      control plane would send it) restores the memory: both files are there;
#   2. a second saved snapshot's record on A says another CPU (its featuresHash changed, as a host of another CPU would
#      have it): B fetches its disk alone, its copy marked to cold-boot, and a create from it boots: the disk's file is
#      there, the memory's isn't.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/snapshot-sync.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images, and the guest image must take sticky
# drives; KANTEL_STACK_DIR, KANTEL_STACK_IMAGE_DIGEST and KANTEL_STACK_HOST_FLAGS are set here). The stack is named
# snap-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=snap-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_STICKY_DISKS=experimental KANTEL_STACK_IMAGE_DIGEST=$(printf 'snapshot-sync %s' "$name" | sha256sum | cut -d' ' -f1) \
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
mesh_up() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | grep -q fd; }
drain() {
	local want=online
	[ "$2" = true ] && want=draining
	api PATCH "/admin/hosts/$1" -d "{\"draining\":$2}" | jq -e --arg s "$want" '.state == $s' >/dev/null || fail "draining $1: $2"
}
run() {
	local out
	out=$(jq -n --arg c "$1" '{command: $c, timeoutMs: 120000}' | api POST "/sandboxes/$sandbox/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in the sandbox: $1: $out"
}
# A call to B's host protocol, as the control plane sends it.
on_b() { docker exec -i "$b" curl -sS -X POST "http://127.0.0.1:7070/call/$1" -d @-; }
# The host's own IDs of the saved snapshots on host container $1 (a ref's second half), one a line.
saved_on() {
	docker exec "$1" sh -c "grep -l '\"kind\": \"saved\"' $snapshots/*/meta.json 2>/dev/null || true" |
		xargs -r -n1 dirname | xargs -r -n1 basename | sort
}
meta() { docker exec "$1" python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$snapshots/$2/meta.json" "$3"; }
# Has B fetch saved snapshot $1 (the API's ID), once its host's report of it has reached the catalogue.
fetch() {
	local out
	out=$(api POST "/admin/hosts/$b_id/snapshot-fetches" -d "{\"snapshotId\":\"$1\"}" -w '%{http_code}')
	[ "$out" = 204 ]
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

# Made and run on A.
drain "$b_id" true
sandbox=$(api POST /sandboxes -d '{"type":"microvm","wait":true}' | jq -r .id)
[ "$(api GET "/sandboxes/$sandbox" | jq -r .hostId)" = "$a_id" ] || fail "the sandbox isn't on A"
drain "$b_id" false
run 'echo on-disk > /home/user/disk-marker && sync && echo in-memory > /dev/shm/memory-marker'

# Saves a snapshot of the sandbox with its memory, answering its API ID and its ID on A.
save() {
	local out id before
	before=$(saved_on "$a")
	out=$(api POST /snapshots -d "{\"name\":\"$1\",\"sandboxId\":\"$sandbox\",\"memory\":true}")
	id=$(jq -r .id <<<"$out")
	[ -n "$id" ] && [ "$id" != null ] || fail "save $1: $out"
	ready() { api GET "/snapshots/$id" | jq -e '.state == "ready"' >/dev/null; }
	wait=300 until_ok ready || fail "$1 isn't ready: $(api GET "/snapshots/$id")"
	local made
	made=$(comm -13 <(echo "$before") <(saved_on "$a"))
	[ "$(wc -l <<<"$made")" = 1 ] && [ -n "$made" ] || fail "A has saved $made"
	echo "$id $made"
}
# Its disk's map: B is told to fetch it from then, whether or not A has mapped and reported its memory yet (B asks for
# that again until it has).
mapped() { docker exec "$a" test -f "$snapshots/$1/disk.map"; }
fetched() { docker exec "$b" test -f "$snapshots/$1/meta.json"; }
has_memory() { [ "$(meta "$b" "$1" memory)" = True ]; }
# A create on B from snapshot $1 (its host's ID), answering what its two files hold: the one on its disk, and the one in
# its memory ("none" when it booted, which empties /dev/shm).
create_on_b() {
	local size info files
	size=$(meta "$b" "$1" size)
	info=$(jq -n --arg id "sbx-local-$1" --arg from "$1" --arg size "$size" \
		'{sandboxId: $id, tier: "microvm", size: $size, from: $from}' | on_b sandbox.create)
	jq -e .id >/dev/null <<<"$info" || fail "create on B from $1: $info"
	files=$(jq -n --arg id "sbx-local-$1" \
		'{sandboxId: $id, command: "cat /home/user/disk-marker; cat /dev/shm/memory-marker 2>/dev/null || echo none"}' |
		on_b sandbox.exec | jq -r .stdout)
	jq -n --arg id "sbx-local-$1" '{sandboxId: $id}' | on_b sandbox.delete >/dev/null || true
	tr '\n' ' ' <<<"$files"
}

echo "== 1. Saved with memory on A; B fetches its disk and memory, and a create there restores the memory"
read -r snap1 host1 < <(save matching)
until_ok mapped "$host1" || fail "A made no maps of $host1"
wait=90 until_ok fetch "$snap1" || fail "B's fetch of $snap1 was refused: $(api POST "/admin/hosts/$b_id/snapshot-fetches" -d "{\"snapshotId\":\"$snap1\"}")"
until_ok fetched "$host1" || fail "B has no copy of $host1"
wait=300 until_ok has_memory "$host1" || fail "B's copy of $host1 has no memory: $(docker exec "$b" cat "$snapshots/$host1/meta.json")"
for f in disk.ext4 mem state; do
	[ "$(docker exec "$a" sha256sum "$snapshots/$host1/$f" | cut -d' ' -f1)" = "$(docker exec "$b" sha256sum "$snapshots/$host1/$f" | cut -d' ' -f1)" ] ||
		fail "$f differs between the hosts"
done
got=$(create_on_b "$host1")
[ "$got" = "on-disk in-memory " ] || fail "a create on B from $host1: $got"
echo "B fetched $host1 whole (disk, memory and state byte-identical); a create there restored its memory: $got"

echo "== 2. A snapshot of another CPU: B fetches its disk alone, and a create there boots on it"
read -r snap2 host2 < <(save other-cpu)
until_ok mapped "$host2" || fail "A made no maps of $host2"
docker exec "$a" python3 -c '
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["cpu"]["featuresHash"] = "sha256:0000000000000000"
json.dump(m, open(p, "w"), indent=2)' "$snapshots/$host2/meta.json"
wait=90 until_ok fetch "$snap2" || fail "B's fetch of $snap2 was refused"
until_ok fetched "$host2" || fail "B has no copy of $host2"
sleep 10
[ "$(meta "$b" "$host2" memory)" = False ] && [ "$(meta "$b" "$host2" coldBoot)" = True ] ||
	fail "B's copy of $host2: $(docker exec "$b" cat "$snapshots/$host2/meta.json")"
docker exec "$b" test -e "$snapshots/$host2/mem" && fail "B fetched $host2's memory"
got=$(create_on_b "$host2")
[ "$got" = "on-disk none " ] || fail "a create on B from $host2: $got"
echo "B fetched $host2's disk alone, marked to cold-boot; a create there booted on it: $got"
echo
echo "PASS"
