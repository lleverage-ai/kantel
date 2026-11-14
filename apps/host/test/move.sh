#!/usr/bin/env bash
# Moving a stopped sandbox to another host (docs/design/disk-store.md, "Moving a sandbox to another host"):
# local-stack.sh --hosts 2 starts the self-hosted control plane, with sticky disks on (so it signs fetch grants), and two
# kantel-host processes from this branch, each in a container of its own on Docker's bridge, both in the deployment's
# default pool, which gets sync on. Their peer sync is held to 40 Mbit/s, so a copy takes long enough to be cut. Then a
# microVM on one host (A), with a sticky disk, writes a file to its disk, one to its sticky disk and 128 MiB of random
# bytes, serves its home directory on port 8080, exposed publicly, and is stopped, and:
#
#   1. its move to B is cut part way (its export on A deleted as B fetches it): the move rolls back, B's copy is gone,
#      A's export too, and the sandbox is stopped on A and starts there with its files;
#   2. it is stopped again and moved to B for real (POST /sandboxes/{id}/move): it runs on B with the same ID, its files
#      and its sticky disk's file, the random bytes the same; A's copy is deleted; and its port, exposed again, has the
#      same URL as on A and serves its files from B.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/move.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images, and the guest image must take sticky
# drives; KANTEL_STACK_DIR, KANTEL_STACK_IMAGE_DIGEST and KANTEL_STACK_HOST_FLAGS are set here). The stack is named
# move-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=move-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_COMPUTE_PORTS_DOMAIN=kantel-ports.test KANTEL_STICKY_DISKS=experimental KANTEL_STACK_IMAGE_DIGEST=$(printf 'move %s' "$name" | sha256sum | cut -d' ' -f1) \
	KANTEL_STACK_HOST_FLAGS="--local 127.0.0.1:7070" "$stack" up --hosts 2 --name "$name" >/dev/null

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
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|move|import|export|mesh|image' | tail -30 >&2 || true
	done
	echo "--- gateway" >&2
	grep -iE 'move|hosts\]' "$dir/gateway.log" | tail -30 >&2 || true
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
# Runs a command in the sandbox, answering what it printed.
run() {
	local out
	out=$(jq -n --arg c "$1" '{command: $c, timeoutMs: 300000}' | api POST "/sandboxes/$sandbox/commands" -d @-)
	jq -e '.exitCode == 0' >/dev/null <<<"$out" || fail "in the sandbox: $1: $out"
	jq -r .stdout <<<"$out"
}
state_is() { api GET "/sandboxes/$sandbox" | jq -e --arg s "$1" --arg h "$2" '.state == $s and .hostId == $h' >/dev/null; }
stop() {
	api POST "/sandboxes/$sandbox/stop" -d '{"wait":true}' | jq -e '.state == "stopped"' >/dev/null || fail "stop"
}
on() { docker exec "$1" sh -c "$2"; }
# What its disk's and its sticky disk's files hold (its sticky disk is mounted again as it boots, a moment after).
files() { run 'cat /home/user/disk-marker; cat /mnt/cache/sticky-marker 2>&1 || true' | tr '\n' ' '; }
files_there() { [ "$(files)" = "on-disk on-sticky " ]; }
# The sandbox's port 8080, exposed publicly, by its URL: what it serves of `$1`, asked of the gateway by the URL's name
# (the ports' domain, kantel-ports.test, has no DNS here).
served() { curl -sS -f --max-time 20 "$url/$1" -H "host: $(sed -E 's|^[a-z]+://([^/:]+).*|\1|' <<<"$port_url")"; }

a_id=$(cat "$dir/h1/host-id")
b_id=$(cat "$dir/h2/host-id")
a=kantel-stack-$name-h1
b=kantel-stack-$name-h2
# Peer sync held to 40 Mbit/s (5 MB/s), so the 128 MiB copy takes long enough to be cut. The settings file is
# mounted, so it is written in place, then the host restarted.
for h in h1 h2; do
	jq '.syncRateMbit = 40' "$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "kantel-stack-$name-$h" >/dev/null
done
until_ok online "$a_id" || fail "$a didn't come back"
until_ok online "$b_id" || fail "$b didn't come back"
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"
for c in "$a" "$b"; do
	docker exec "$c" curl -sS http://127.0.0.1:7070/facts | jq -e '.features | index("sandbox-move")' >/dev/null ||
		fail "$c doesn't report sandbox-move"
done

# Made and run on A, with a sticky disk.
drain "$b_id" true
api POST /sticky-disks -d '{"name":"move-cache","sizeGb":2}' | jq -e .id >/dev/null || fail "no sticky disk"
made=$(api POST /sandboxes -d '{"type":"microvm","wait":true,"stickyDisks":[{"disk":"move-cache","path":"/mnt/cache"}]}')
sandbox=$(jq -r .id <<<"$made")
[ -n "$sandbox" ] && [ "$sandbox" != null ] || fail "no sandbox: $made"
[ "$(api GET "/sandboxes/$sandbox" | jq -r .hostId)" = "$a_id" ] || fail "the sandbox isn't on A"
drain "$b_id" false
run 'echo on-disk > /home/user/disk-marker && echo on-sticky | sudo tee /mnt/cache/sticky-marker >/dev/null && head -c 128M /dev/urandom > /home/user/bulk && sync' >/dev/null
bulk=$(run 'sha256sum /home/user/bulk | cut -d" " -f1')
exposed=$(api POST "/sandboxes/$sandbox/ports" -d '{"port":8080,"public":true}')
port_url=$(jq -r .url <<<"$exposed")
[ -n "$port_url" ] && [ "$port_url" != null ] || fail "the port wasn't exposed: $exposed"
serve='cd /home/user && (setsid python3 -m http.server 8080 >/dev/null 2>&1 &) && sleep 1'
run "$serve" >/dev/null
wait=30 until_ok served disk-marker >/dev/null || fail "the port doesn't serve on A"
[ "$(served disk-marker)" = on-disk ] || fail "the port on A served $(served disk-marker)"
stop

echo "== 1. A move cut part way rolls back: B's copy and A's export go, and it starts on A"
api POST "/sandboxes/$sandbox/move" -d '{"wait":false}' | jq -e '.state == "moving"' >/dev/null || fail "the move didn't begin"
importing() { on "$b" "test -d $root/sandbox-imports/$sandbox"; }
wait=180 until_ok importing || fail "B never began fetching it"
sleep 2
on "$a" "rm -rf $root/sandbox-exports/$sandbox"
wait=300 until_ok state_is stopped "$a_id" || fail "the move didn't roll back: $(api GET "/sandboxes/$sandbox")"
on "$b" "test ! -e $root/sandbox-imports/$sandbox && test ! -e $root/sandboxes/$sandbox" || fail "B kept its copy"
on "$a" "test ! -e $root/sandbox-exports/$sandbox" || fail "A kept its export"
on "$a" "test -d $root/sandboxes/$sandbox" || fail "A lost the sandbox"
api POST "/sandboxes/$sandbox/start" -d '{"wait":true}' | jq -e --arg h "$a_id" '.state == "running" and .hostId == $h' >/dev/null ||
	fail "it didn't start on A: $(api GET "/sandboxes/$sandbox")"
wait=60 until_ok files_there || fail "its files on A: $(files) ($(api GET "/sandboxes/$sandbox" | jq -c .stickyDisks))"
echo "rolled back: stopped on A, B's copy and A's export gone; started on A with its files"
stop

echo "== 2. Moved to B: it runs there with its files and sticky disk, A's copy is deleted, and its port's URL is the same"
moved=$(api POST "/sandboxes/$sandbox/move" -d "{\"hostId\":\"$b_id\"}")
jq -e --arg h "$b_id" '.state == "running" and .hostId == $h and .id != null' >/dev/null <<<"$moved" || fail "the move: $moved"
[ "$(jq -r .id <<<"$moved")" = "$sandbox" ] || fail "it has another ID"
wait=60 until_ok files_there || fail "its files on B: $(files) ($(api GET "/sandboxes/$sandbox" | jq -c .stickyDisks))"
[ "$(run 'sha256sum /home/user/bulk | cut -d" " -f1')" = "$bulk" ] || fail "its random bytes differ on B"
on "$a" "test ! -e $root/sandboxes/$sandbox && test ! -e $root/sandbox-exports/$sandbox" || fail "A kept its copy"
on "$b" "test -d $root/sandboxes/$sandbox" || fail "B has no sandbox"
again=$(api POST "/sandboxes/$sandbox/ports" -d '{"port":8080,"public":true}' | jq -r .url)
[ "$again" = "$port_url" ] || fail "its port's URL is $again on B, $port_url on A"
run "$serve" >/dev/null
wait=30 until_ok served disk-marker >/dev/null || fail "the port doesn't serve on B"
[ "$(served disk-marker)" = on-disk ] || fail "the port on B served $(served disk-marker)"
echo "moved: running on B with its files, sticky disk and bytes; A's copy deleted; its port at the same URL serves from B"
echo
echo "PASS"
