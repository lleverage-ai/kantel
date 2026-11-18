#!/usr/bin/env bash
# A saved snapshot's drives from peers (docs/design/disk-store.md, "Phase 3 notes"): local-stack.sh --hosts 2 starts
# the self-hosted control plane, with sticky disks and mounts on, and two kantel-host processes from this branch, each
# in a container of its own on Docker's bridge, both in the deployment's default pool, which gets sync on. Both record
# one digest for their microVM image (KANTEL_STACK_IMAGE_DIGEST), as hosts that downloaded the same image do, serve
# their calls on 127.0.0.1:7070 in their containers (--local), and write memory to the disk without spooling it. Then:
#
#   1. a sandbox on one host (A) mounts a bundle and a sticky disk, writes a file to the sticky disk and one to
#      /dev/shm, in its memory only, and is saved with its memory; B, which has never mounted the bundle, is told to
#      fetch the snapshot (POST /admin/hosts/{B}/snapshot-fetches) and fetches its disk, its sticky disk's clone and
#      the bundle's image, then its memory, the hosts' CPU and runtime being the same;
#   2. B's copies of the disk, memory, state, sticky disk's clone and bundle image are byte-identical to A's, and a
#      sandbox.create on B from it (its host protocol, as the control plane would send it) restores the memory with the
#      mounts intact: the file in /dev/shm is there, and the bundle's and the sticky disk's files read back.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/snapshot-drives.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; the guest image must take sticky drives
# and its kernel mount erofs; KANTEL_STACK_DIR, KANTEL_STACK_IMAGE_DIGEST and KANTEL_STACK_HOST_FLAGS are set here). The
# stack is named drives-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=drives-$$
unset KANTEL_STACK_DIR
work=$(mktemp -d)
trap '"$stack" down --name "$name" >/dev/null || true; rm -rf "$work"' EXIT
KANTEL_STICKY_DISKS=experimental KANTEL_MOUNTS=experimental \
	KANTEL_STACK_IMAGE_DIGEST=$(printf 'snapshot-drives %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
snapshots=/var/lib/kantel-host/microvm/snapshots
cache=/var/lib/kantel-host/bundles/images

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|snapshot|mesh|bundle|sticky' | tail -40 >&2 || true
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
saved_on() {
	docker exec "$1" sh -c "grep -l '\"kind\": \"saved\"' $snapshots/*/meta.json 2>/dev/null || true" |
		xargs -r -n1 dirname | xargs -r -n1 basename | sort
}
meta() { docker exec "$1" python3 2>/dev/null -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1])).get(sys.argv[2])))' "$snapshots/$2/meta.json" "$3"; }
fetch() {
	local out
	out=$(api POST "/admin/hosts/$b_id/snapshot-fetches" -d "{\"snapshotId\":\"$1\"}" -w '%{http_code}')
	[ "$out" = 204 ]
}
sum() { docker exec "$1" sha256sum "$2" | cut -d' ' -f1; }

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

# A bundle: one file.
mkdir -p "$work/bundle"
echo from-the-bundle >"$work/bundle/hello.txt"
tar -C "$work/bundle" -cf "$work/bundle.tar" hello.txt
digest=$(curl -sS -X POST "$url/v1/bundles" -H "authorization: Bearer $key" -H 'content-type: application/x-tar' \
	--data-binary "@$work/bundle.tar" | jq -r .digest)
[[ $digest == sha256:* ]] || fail "the bundle wasn't uploaded"
api POST /sticky-disks -d '{"name":"cache","sizeGb":2}' | jq -e .id >/dev/null || fail "no sticky disk"

echo "== 1. A sandbox on A with a bundle and a sticky disk, saved with its memory; B fetches it whole"
drain "$b_id" true
sandbox=$(jq -n --arg d "$digest" '{type: "microvm", wait: true,
	mounts: [{path: "/opt/bundle", source: {kind: "bundle", digest: $d}}],
	stickyDisks: [{disk: "cache", path: "/cache"}]}' | api POST /sandboxes -d @- | jq -r .id)
[ "$(api GET "/sandboxes/$sandbox" | jq -r .hostId)" = "$a_id" ] || fail "the sandbox isn't on A: $(api GET "/sandboxes/$sandbox")"
drain "$b_id" false
run 'cat /opt/bundle/hello.txt && echo on-sticky > /cache/sticky-marker && sync && echo in-memory > /dev/shm/memory-marker'

before=$(saved_on "$a")
out=$(api POST /snapshots -d "{\"name\":\"drives\",\"sandboxId\":\"$sandbox\",\"memory\":true}")
snap=$(jq -r .id <<<"$out")
[ -n "$snap" ] && [ "$snap" != null ] || fail "save: $out"
ready() { api GET "/snapshots/$snap" | jq -e '.state == "ready"' >/dev/null; }
wait=300 until_ok ready || fail "the snapshot isn't ready: $(api GET "/snapshots/$snap")"
host=$(comm -13 <(echo "$before") <(saved_on "$a"))
[ "$(wc -l <<<"$host")" = 1 ] && [ -n "$host" ] || fail "A has saved $host"
slots=$(meta "$a" "$host" bundleSlots)
slot=$(jq -r --arg d "$digest" 'index($d)' <<<"$slots")
[ "$slot" != null ] || fail "A's record has no bundle on a drive: $slots"
sticky=$(meta "$a" "$host" stickyDisks | jq -r '.[0].slot')
[ "$sticky" != null ] || fail "A's record has no sticky disk: $(meta "$a" "$host" stickyDisks)"
mapped() { docker exec "$a" test -f "$snapshots/$host/bundle$slot.map" -a -f "$snapshots/$host/sticky$sticky.map" -a -f "$snapshots/$host/disk.map"; }
wait=180 until_ok mapped || fail "A made no maps of $host's drives"
docker exec "$b" test -e "$cache/${digest#sha256:}.erofs" && fail "B has the bundle's image already"
wait=90 until_ok fetch "$snap" || fail "B's fetch of $snap was refused"
has_memory() { [ "$(meta "$b" "$host" memory)" = true ]; }
wait=300 until_ok has_memory || fail "B's copy has no memory: $(docker exec "$b" cat "$snapshots/$host/meta.json" 2>&1)"

echo "== 2. B's copy is A's, and a create on B restores its memory with the mounts intact"
for f in disk.ext4 mem state "bundle$slot.erofs" "sticky$sticky.ext4"; do
	[ "$(sum "$a" "$snapshots/$host/$f")" = "$(sum "$b" "$snapshots/$host/$f")" ] || fail "$f differs between the hosts"
done
size=$(meta "$b" "$host" size | jq -r .)
# Its mounts as the control plane sends them: the sandbox's own, which the snapshot's memory has mounted.
info=$(jq -n --arg id "sbx-local-$host" --arg from "$host" --arg size "$size" --arg d "$digest" \
	'{sandboxId: $id, tier: "microvm", size: $size, from: $from, mounts: [{path: "/opt/bundle", kind: "bundle", digest: $d}]}' |
	on_b sandbox.create)
jq -e .id >/dev/null <<<"$info" || fail "create on B: $info"
got=$(jq -n --arg id "sbx-local-$host" \
	'{sandboxId: $id, command: "cat /dev/shm/memory-marker 2>/dev/null || echo none; cat /opt/bundle/hello.txt; cat /cache/sticky-marker"}' |
	on_b sandbox.exec | jq -r .stdout | xargs)
jq -n --arg id "sbx-local-$host" '{sandboxId: $id}' | on_b sandbox.delete >/dev/null || true
[ "$got" = "in-memory from-the-bundle on-sticky" ] || fail "a create on B from $host: $got"
echo "B fetched $host whole (disk, memory, state, bundle image and sticky clone byte-identical); a create there restored its memory with its mounts: $got"
echo
echo "PASS"
