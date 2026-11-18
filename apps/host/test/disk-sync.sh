#!/usr/bin/env bash
# Peer sync with real hosts (docs/design/disk-store.md, "2c. Peer sync"): local-stack.sh --hosts 2 starts the
# self-hosted control plane, with sticky disks on, and two kantel-host processes from this branch, each in a container of
# its own on Docker's bridge, both in the deployment's default pool, which gets sync on. Then, over the API:
#
#   1. a sandbox on one host (A) writes 1.5 GiB to a sticky disk and commits it; the other (B) is told to fetch the
#      version (POST /admin/hosts/{B}/sticky-disk-fetches) and ends with a byte-identical file;
#   2. a second commit changes 1 GiB: B fetches about that much, not the whole disk;
#   3. a third commit changes 2 GiB, fetched by B at a slow --sync-rate; B is killed half-way, and once it is back it
#      goes on from where it stopped, fetching what it hadn't;
#   4. A's peer sync server refuses a request with no grant, or with one that isn't a grant.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/disk-sync.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_DIR is ignored). The stack
# is named sync-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=sync-$$
# Its own state directory, from its name: one set for another stack must never be the one this test's cleanup takes
# down.
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_STICKY_DISKS=experimental "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
gib=$((1 << 30))

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|sticky|mesh' | tail -30 >&2 || true
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
run() {
	local out
	out=$(jq -n --arg c "$1" '{command: $c, timeoutMs: 600000}' | api POST "/sandboxes/$sandbox/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in the sandbox: $1: $out"
}
container_of() {
	local h
	for h in h1 h2; do
		if [ "$(cat "$dir/$h/host-id")" = "$1" ]; then
			echo "kantel-stack-$name-$h"
			return
		fi
	done
}
version_file() { echo "/var/lib/kantel-host/microvm/sticky/$disk/$1.img"; }
holds() { docker exec "$1" test -f "$(version_file "$2")"; }
sum() { docker exec "$1" sha256sum "$(version_file "$2")" | cut -d' ' -f1; }
online() { api GET "/admin/hosts/$1" | jq -e '.state == "online"' >/dev/null; }
mesh_up() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | grep -q fd; }
# The bytes the last fetch of a version B logged moving.
fetched_bytes() {
	docker logs "$b" 2>&1 | grep 'disk version fetched' | grep "$1" | tail -1 | sed -E 's/.*fetchedBytes=([0-9]+).*/\1/'
}
fetch() {
	local out
	out=$(api POST "/admin/hosts/$b_id/sticky-disk-fetches" -d "{\"stickyDiskId\":\"$disk\",\"version\":\"$1\"}" -w '%{http_code}')
	[ "$out" = 204 ] || fail "fetch $1: $out"
}
commit() { api POST "/sandboxes/$sandbox/sticky-disks/$disk/commit" | jq -r .id; }

api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
disk=$(api POST /sticky-disks -d '{"name":"cache","sizeGb":6}' | jq -r .id)
sandbox=$(api POST /sandboxes -d '{"type":"microvm","wait":true,"stickyDisks":[{"disk":"cache","path":"/cache"}]}' | jq -r .id)
a_id=$(api GET "/sandboxes/$sandbox" | jq -r .hostId)
a=$(container_of "$a_id")
for h in h1 h2; do
	[ "$(cat "$dir/$h/host-id")" = "$a_id" ] || {
		b_id=$(cat "$dir/$h/host-id")
		b_dir=$dir/$h
	}
done
b=$(container_of "$b_id")
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"
echo "sandbox $sandbox on $a ($a_id); fetching onto $b ($b_id)"

echo "== 1. A commits 1.5 GiB; B fetches it"
run 'head -c 1536M /dev/urandom > /cache/a && sync'
v1=$(commit)
[ -n "$v1" ] && [ "$v1" != null ] || fail "commit"
fetch "$v1"
until_ok holds "$b" "$v1" || fail "$b doesn't hold $v1"
[ "$(sum "$a" "$v1")" = "$(sum "$b" "$v1")" ] || fail "$v1 differs between the hosts"
echo "B holds $v1, byte-identical; fetched $(fetched_bytes "$v1") bytes"

echo "== 2. A second commit changes 1 GiB; B fetches about that much"
run 'head -c 1G /dev/urandom > /cache/b && sync'
v2=$(commit)
fetch "$v2"
until_ok holds "$b" "$v2" || fail "$b doesn't hold $v2"
[ "$(sum "$a" "$v2")" = "$(sum "$b" "$v2")" ] || fail "$v2 differs between the hosts"
moved=$(fetched_bytes "$v2")
[ "$moved" -ge $((gib * 9 / 10)) ] && [ "$moved" -le $((gib * 13 / 10)) ] || fail "$v2 moved $moved bytes, want about 1 GiB"
echo "B holds $v2, byte-identical, having fetched $moved bytes"

echo "== 3. B killed half-way through a fetch goes on where it stopped"
# 200 Mbit/s: 2 GiB takes about 90 seconds. The settings file is mounted, so it is written in place.
jq '.syncRateMbit = 200' "$b_dir/config.json" >"$b_dir/config.new" && cat "$b_dir/config.new" >"$b_dir/config.json"
docker restart "$b" >/dev/null
until_ok online "$b_id" || fail "$b didn't come back"
until_ok mesh_up "$b" || fail "$b brought no mesh up again"
run 'head -c 2G /dev/urandom > /cache/c && sync'
v3=$(commit)
fetch "$v3"
bitmap=$(version_file "$v3" | sed 's/\.img$/.partial.done/')
# The blocks B's bitmap records as in place: those it had from its nearest version, then those fetched.
in_place() {
	docker exec "$b" python3 -c '
import sys
d = open(sys.argv[1], "rb").read()
print(sum(bin(x).count("1") for x in d[d.index(b"\n") + 1:]))' "$bitmap" 2>/dev/null
}
has_bitmap() { [ -n "$(in_place)" ]; }
until_ok has_bitmap || fail "$b started no fetch of $v3"
first=$(in_place)
# At least 64 blocks (256 MiB) fetched and recorded before the kill.
progressed() { [ "$(in_place)" -ge $((first + 64)) ]; }
until_ok progressed || fail "$b's fetch of $v3 made no progress"
holds "$b" "$v3" && fail "$b fetched $v3 before it was killed"
before=$(in_place)
docker kill "$b" >/dev/null
restarted=$(date +%s)
docker start "$b" >/dev/null
until_ok holds "$b" "$v3" || fail "$b doesn't hold $v3 after its restart"
[ "$(sum "$a" "$v3")" = "$(sum "$b" "$v3")" ] || fail "$v3 differs between the hosts"
line=$(docker logs --since "$restarted" "$b" 2>&1 | grep 'disk version fetched' | grep "$v3" | tail -1)
grep -q 'resumed=true' <<<"$line" || fail "$b fetched $v3 afresh: $line"
fetched=$(sed -E 's/.* fetched=([0-9]+) .*/\1/' <<<"$line")
total=$(sed -E 's/.* blocks=([0-9]+) .*/\1/' <<<"$line")
# What it fetched after the restart is what the bitmap didn't have.
[ "$fetched" -le $((total - before)) ] && [ "$fetched" -gt 0 ] ||
	fail "after the restart $b fetched $fetched blocks of $v3; $before of $total were in place before"
echo "B holds $v3, byte-identical; $((before - first)) blocks fetched before the kill, $fetched after it, none twice"

echo "== 4. A's peer sync server refuses a fetch without a grant"
a_addr=$(docker exec "$a" ip -6 -o addr show dev kmesh0 | awk '/fd/ {sub("/128", "", $4); print $4; exit}')
status() { docker exec "$b" curl -s -o /dev/null -w '%{http_code}' --http2-prior-knowledge "$@" "http://[$a_addr]:7480/v1/objects/sticky/$disk/$v1/map"; }
[ "$(status)" = 401 ] || fail "a request without a grant: $(status)"
[ "$(status -H 'Authorization: Bearer e30.AAAA')" = 401 ] || fail "a request with a forged grant"
echo "refused (401) without a grant, and with one the control plane didn't sign"
echo
echo "PASS"
