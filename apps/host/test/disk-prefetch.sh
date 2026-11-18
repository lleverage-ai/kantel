#!/usr/bin/env bash
# Prefetch of a sticky disk's new head with real hosts (docs/design/disk-store.md, "2d. Placement and prefetch"):
# local-stack.sh --hosts 2 starts the self-hosted control plane, with sticky disks on, and two kantel-host processes
# from this branch, each in a container of its own on Docker's bridge, both in the deployment's default pool, which gets
# sync on. Then, over the API:
#
#   1. a sandbox on one host (A) writes to a sticky disk and commits it;
#   2. with A drained, a sandbox with the disk starts on the other host (B), so B is one of the disk's hosts, and is
#      deleted; A is undrained;
#   3. A commits again, and B holds the new head within a minute, with no sandbox asking for it and no admin fetch.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/disk-prefetch.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_DIR is ignored). The stack
# is named prefetch-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=prefetch-$$
# Its own state directory, from its name: one set for another stack must never be the one this test's cleanup takes
# down.
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_STICKY_DISKS=experimental "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")

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
mesh_up() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | grep -q fd; }
drain() { api PATCH "/admin/hosts/$1" -d "{\"draining\":$2}" | jq -e ".state == \"$([ "$2" = true ] && echo draining || echo online)\"" >/dev/null; }
commit() { api POST "/sandboxes/$sandbox/sticky-disks/$disk/commit" | jq -r .id; }
create() { api POST /sandboxes -d '{"type":"microvm","wait":true,"stickyDisks":[{"disk":"cache","path":"/cache"}]}' | jq -r .id; }

api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
disk=$(api POST /sticky-disks -d '{"name":"cache","sizeGb":4}' | jq -r .id)
sandbox=$(create)
a_id=$(api GET "/sandboxes/$sandbox" | jq -r .hostId)
a=$(container_of "$a_id")
for h in h1 h2; do
	[ "$(cat "$dir/$h/host-id")" = "$a_id" ] || b_id=$(cat "$dir/$h/host-id")
done
b=$(container_of "$b_id")
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"
echo "sandbox $sandbox on $a ($a_id); $b ($b_id) is the other host"

echo "== 1. A commits"
run 'head -c 256M /dev/urandom > /cache/a && sync'
v1=$(commit)
[ -n "$v1" ] && [ "$v1" != null ] || fail "commit"
echo "A committed $v1"

echo "== 2. A sandbox with the disk runs on B"
drain "$a_id" true || fail "drain $a_id"
other=$(create)
[ "$(api GET "/sandboxes/$other" | jq -r .hostId)" = "$b_id" ] || fail "the second sandbox isn't on $b_id"
api DELETE "/sandboxes/$other" >/dev/null
drain "$a_id" false || fail "undrain $a_id"
echo "sandbox $other ran on B, and is deleted"

echo "== 3. A commits again; B holds the new head within a minute, unasked"
run 'head -c 256M /dev/urandom > /cache/b && sync'
v2=$(commit)
[ -n "$v2" ] && [ "$v2" != null ] && [ "$v2" != "$v1" ] || fail "second commit"
committed=$SECONDS
wait=60 until_ok holds "$b" "$v2" || fail "$b doesn't hold $v2 a minute after its commit"
took=$((SECONDS - committed))
[ "$(sum "$a" "$v2")" = "$(sum "$b" "$v2")" ] || fail "$v2 differs between the hosts"
# Nothing on B asked for it: no sandbox runs there.
[ "$(api GET '/sandboxes?limit=100' | jq --arg b "$b_id" '[.items[] | select(.hostId == $b and .state != "deleted")] | length')" = 0 ] ||
	fail "a sandbox is on $b_id"
echo "B holds $v2, byte-identical, ${took}s after its commit"
echo
echo "PASS"
