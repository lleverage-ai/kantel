#!/usr/bin/env bash
# A pool's mesh with real hosts (docs/design/disk-store.md, "2a. The mesh"; packages/hosts/test/mesh.test.ts tests it
# with fake ones): local-stack.sh --hosts 2 starts the self-hosted control plane and two kantel-host processes from this
# branch, each in a container of its own on Docker's bridge, both in the deployment's default pool. Then, over the API:
#
#   1. with the pool's sync off (the default), neither host has a mesh device;
#   2. sync on: each host brings kmesh0 up with an address in the pool's /48, and reaches the other's mesh address
#      (a TCP connection to its sync port is answered, refused as nothing listens there yet, across WireGuard);
#   3. sync off: both take their mesh down; on again, they reach each other again;
#   4. one host revoked: the other takes it out of its peers at once, and no longer reaches its address.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/mesh.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images). The stack is named mesh-<pid>, so it
# runs beside other named stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=mesh-$$
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
"$stack" up --hosts 2 --name "$name" >/dev/null

dir=${KANTEL_STACK_DIR:-/tmp/kantel-local-stack-$name}
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
host_1=$(sed -n 1p "$dir/containers")
host_2=$(sed -n 2p "$dir/containers")
id_2=$(cat "$dir/h2/host-id")

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in "$host_1" "$host_2"; do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -i mesh | tail -20 >&2 || true
	done
	exit 1
}
# A host's mesh address, or nothing while it has no mesh device.
address() { docker exec "$1" ip -6 -o addr show dev kmesh0 2>/dev/null | awk '/fd/ {sub("/128", "", $4); print $4; exit}'; }
# Waits until `$@` succeeds, for 30 seconds at most.
until_ok() {
	local deadline=$((SECONDS + 30))
	until "$@"; do
		[ $SECONDS -lt $deadline ] || return 1
		sleep 0.5
	done
}
has_mesh() { [ -n "$(address "$1")" ]; }
no_mesh() { ! docker exec "$1" ip link show kmesh0 >/dev/null 2>&1; }
# How a TCP connection from one host to another's mesh address, on the sync port, ends: `answered` (accepted or
# refused, so it crossed the mesh both ways) or `unanswered`.
probe() {
	docker exec "$1" python3 -c '
import socket, sys
s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
s.settimeout(3)
try:
    s.connect((sys.argv[1], 7480))
    print("answered")
except ConnectionRefusedError:
    print("answered")
except OSError:
    print("unanswered")
' "$2"
}
reaches() { [ "$(probe "$1" "$2")" = answered ]; }
sync_pool() { api PATCH /admin/pools/default -d "{\"sync\":$1}" | jq -e ".sync == $1" >/dev/null || fail "sync $1"; }
# Both hosts up in the mesh, each reaching the other's address.
meshed() {
	until_ok has_mesh "$host_1" || fail "$host_1 brought no mesh up"
	until_ok has_mesh "$host_2" || fail "$host_2 brought no mesh up"
	address_1=$(address "$host_1")
	address_2=$(address "$host_2")
	[ "$address_1" != "$address_2" ] || fail "both hosts have $address_1"
	until_ok reaches "$host_1" "$address_2" || fail "$host_1 doesn't reach $host_2 at $address_2"
	until_ok reaches "$host_2" "$address_1" || fail "$host_2 doesn't reach $host_1 at $address_1"
}

echo "== 1. Sync off (the default): no mesh"
[ "$(api GET /admin/pools | jq -r '.items[] | select(.name == "default") | .sync')" = false ] || fail "the pool syncs"
sleep 2
no_mesh "$host_1" || fail "$host_1 has a mesh device"
no_mesh "$host_2" || fail "$host_2 has a mesh device"
echo "neither host has kmesh0"

echo "== 2. Sync on: each reaches the other"
sync_pool true
meshed
first_1=$address_1
first_2=$address_2
echo "$host_1 at $address_1 and $host_2 at $address_2 reach each other"

echo "== 3. Sync off, then on again"
sync_pool false
until_ok no_mesh "$host_1" || fail "$host_1 kept its mesh"
until_ok no_mesh "$host_2" || fail "$host_2 kept its mesh"
echo "both took their mesh down"
sync_pool true
meshed
[ "$address_1" = "$first_1" ] && [ "$address_2" = "$first_2" ] || fail "the addresses changed"
echo "back up, at the same addresses, reaching each other"

echo "== 4. One host revoked"
api DELETE "/admin/hosts/$id_2" >/dev/null
removed() { docker logs "$host_1" 2>&1 | grep 'mesh peer removed' | grep -q "$id_2"; }
until_ok removed || fail "$host_1 kept $id_2 as a peer"
[ "$(probe "$host_1" "$address_2")" = unanswered ] || fail "$host_1 still reaches $address_2"
echo "$host_1 took $id_2 out of its peers and no longer reaches it"
echo
echo "PASS"
