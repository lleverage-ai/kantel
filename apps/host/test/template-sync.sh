#!/usr/bin/env bash
# Template snapshots from peers (docs/design/disk-store.md, "Phase 3 notes"): local-stack.sh --hosts 2 starts the
# self-hosted control plane, with templates on, and two kantel-host processes from this branch, each in a container of
# its own on Docker's bridge, both in the deployment's default pool, which gets sync on. Each host's `docker` is a
# stand-in that answers `docker version` (so the host builds templates) and fails anything else. Then, over the API:
#
#   1. a template on a published Kantel base builds on one host (A), whose root filesystem for that base is put in place
#      first (a copy of the sandbox image, as a pull would have made it), the other (B) draining; A maps the snapshot's
#      disk and memory and reports it. (A template on the hosts' own image here would have no portable runtime: the
#      stack's image is a plain file with no recorded digest, so its snapshot's memory goes to no other host.)
#   2. B, back, is asked for a copy: it fetches the root filesystem and then A's snapshot (the same disk and memory,
#      byte for byte) and boots no build VM; a sandbox made from the template with A draining starts on B from that
#      snapshot, with what the setup left;
#   3. B's runtime made another (free page reporting on), a second template builds on A: asked for a copy, B finds no
#      peer whose copy restores on its runtime, never fetches A's, and builds its own, which a sandbox on B starts from.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/template-sync.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_DIR is ignored); the guest
# image must have sticky drives (KANTEL_STACK_SANDBOX_IMAGE). The stack is named tsync-<pid>, with its own state
# directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=tsync-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_TEMPLATES=experimental "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
snapshots=/var/lib/kantel-host/microvm/template-snapshots

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|template|mesh|peer' | tail -40 >&2 || true
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
# The ready snapshot of template $1, which host $2 built.
ready_on() {
	api GET "/templates/$1/snapshots" | jq -r --arg h "$2" '[.items[] | select(.state == "ready" and .hostId == $h)][0].id // empty'
}
mapped() { docker exec "$1" test -f "$snapshots/$2/mem.map" -a -f "$snapshots/$2/disk.map"; }
whole() { docker exec "$1" test -f "$snapshots/$2/meta.json"; }
sum() { docker exec "$1" sha256sum "$snapshots/$2/$3" | cut -d' ' -f1; }
# Makes a sandbox from template $1 and answers it, once it runs.
from_template() {
	api POST /sandboxes -d "{\"template\":\"$1\",\"wait\":true}"
}
run() {
	api POST "/sandboxes/$1/commands" -d "{\"command\":\"$2\"}" | jq -r .stdout
}

h1=$(cat "$dir/h1/host-id")
h2=$(cat "$dir/h2/host-id")
a=kantel-stack-$name-h1
b=kantel-stack-$name-h2

for h in h1 h2; do
	container=kantel-stack-$name-$h
	docker exec -i "$container" sh -c 'cat >/usr/local/bin/docker && chmod +x /usr/local/bin/docker' <<'EOF'
#!/bin/sh
echo "$*" >>/var/lib/kantel-host/docker.log
[ "$1" = version ] && { echo 27.0.0; exit 0; }
echo "no Docker here: $*" >&2
exit 1
EOF
	docker restart "$container" >/dev/null
done
until_ok online "$h1" || fail "$a didn't come back"
until_ok online "$h2" || fail "$b didn't come back"
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"

echo "== 1. A builds a template on a published base, B draining, and maps its snapshot"
digest=sha256:$(printf 'template-sync %s' "$name" | sha256sum | cut -d' ' -f1)
api POST /template-bases -d "{\"image\":\"kantel/sandbox\",\"channel\":\"stable\",\"digest\":\"$digest\"}" |
	jq -e .digest >/dev/null || fail "publish the base"
rootfs_key=$(printf 'kantel-base\0kantel/sandbox@%s' "$digest" | sha256sum | cut -d' ' -f1)
templates=/var/lib/kantel-host/microvm/images/templates
docker exec "$a" sh -c "mkdir -p $templates && cp --sparse=always /images/sandbox.ext4 $templates/$rootfs_key.ext4.tmp && mv $templates/$rootfs_key.ext4.tmp $templates/$rootfs_key.ext4"
drain "$h2" true
base="\"base\":{\"image\":\"kantel/sandbox\",\"digest\":\"$digest\"}"
template=$(api POST /templates -d "{\"name\":\"synced\",\"spec\":{$base,\"setup\":\"echo built > /etc/built\"}}" | jq -r .id)
[ -n "$template" ] && [ "$template" != null ] || fail "create the template"
built_on_a() { [ -n "$(ready_on "$template" "$h1")" ]; }
wait=600 until_ok built_on_a || fail "the template didn't build on A: $(api GET "/templates/$template/snapshots" | jq -c .)"
snap=$(ready_on "$template" "$h1")
wait=300 until_ok mapped "$a" "$snap" || fail "A made no maps of $snap"
echo "A built $snap and mapped its disk and memory"

echo "== 2. B, back, fetches A's snapshot rather than booting it, and a sandbox starts on B from it"
drain "$h2" false
wait=600 until_ok whole "$b" "$snap" || fail "B has no copy of $snap"
for file in disk.ext4 mem state; do
	[ "$(sum "$a" "$snap" "$file")" = "$(sum "$b" "$snap" "$file")" ] || fail "B's $file differs from A's"
done
docker logs "$b" 2>&1 | grep 'template snapshot fetched from a peer' | grep -q "$snap" || fail "B logged no fetch of $snap"
docker logs "$b" 2>&1 | grep 'template snapshot ready' | grep -q "$snap" && fail "B built $snap itself"
# Its meta.json is B's: over B's own copy of the root filesystem, which B fetched from A first.
docker exec "$b" test -f "$templates/$rootfs_key.ext4" || fail "B has no root filesystem"
docker exec "$b" cat "$snapshots/$snap/meta.json" | jq -e --arg p "$templates/$rootfs_key.ext4" '.rootfs == $p' >/dev/null ||
	fail "B's meta.json: $(docker exec "$b" cat "$snapshots/$snap/meta.json")"
calls=$(docker exec "$b" sh -c 'grep -v "^version" /var/lib/kantel-host/docker.log || true')
[ -z "$calls" ] || fail "B ran docker: $calls"
fetched=$(docker logs "$b" 2>&1 | grep 'disk version fetched' | grep "$snap" | tail -1 | grep -oE 'fetchedBytes=[0-9]+' || true)
echo "B fetched $snap from A ($fetched), its disk, memory and state byte-identical, booting nothing"
# Its report reaches the catalogue; then, A draining, a sandbox goes to B and starts from the snapshot there.
sleep 35
drain "$h1" true
sandbox=$(from_template "$template")
[ "$(echo "$sandbox" | jq -r .template.start)" = snapshot ] || fail "the sandbox didn't start from the snapshot: $sandbox"
id=$(echo "$sandbox" | jq -r .id)
[ "$(echo "$sandbox" | jq -r .hostId)" = "$h2" ] || fail "the sandbox isn't on B: $sandbox"
[ "$(run "$id" 'cat /etc/built')" = built ] || fail "the setup's file isn't in the sandbox"
docker logs "$b" 2>&1 | grep "$id" | grep -qi 'booting the template fresh' && fail "B booted the template fresh"
api DELETE "/sandboxes/$id" >/dev/null
drain "$h1" false
echo "a sandbox started on B from the fetched snapshot ($id), with the setup's /etc/built"

echo "== 3. B on another runtime (free page reporting on): B builds a second template's snapshot itself"
jq '.memoryOvercommit = {"enabled": true}' "$dir/h2/config.json" >"$dir/h2/config.new" && cat "$dir/h2/config.new" >"$dir/h2/config.json"
docker restart "$b" >/dev/null
until_ok online "$h2" || fail "$b didn't come back"
until_ok mesh_up "$b" || fail "$b brought no mesh up"
drain "$h2" true
other=$(api POST /templates -d "{\"name\":\"own\",\"spec\":{$base,\"setup\":\"echo own > /etc/own\"}}" | jq -r .id)
built_other() { [ -n "$(ready_on "$other" "$h1")" ]; }
wait=600 until_ok built_other || fail "the second template didn't build on A"
snap2=$(ready_on "$other" "$h1")
wait=300 until_ok mapped "$a" "$snap2" || fail "A made no maps of $snap2"
sleep 35
drain "$h2" false
wait=600 until_ok whole "$b" "$snap2" || fail "B has no snapshot $snap2"
docker logs "$b" 2>&1 | grep 'no peer holds the template snapshot' | grep -q "$snap2" || fail "B didn't find A's copy unusable"
docker logs "$b" 2>&1 | grep 'template snapshot fetched from a peer' | grep -q "$snap2" && fail "B fetched $snap2"
docker logs "$b" 2>&1 | grep 'template snapshot ready' | grep -q "$snap2" || fail "B didn't build $snap2"
docker exec "$b" cat "$snapshots/$snap2/meta.json" | jq -e '.portableRuntime | contains("free-page-reporting")' >/dev/null ||
	fail "B's own snapshot isn't of its runtime"
[ "$(sum "$a" "$snap2" mem)" != "$(sum "$b" "$snap2" mem)" ] || fail "B's memory is A's"
sleep 35
drain "$h1" true
sandbox=$(from_template "$other")
[ "$(echo "$sandbox" | jq -r .template.start)" = snapshot ] || fail "the second sandbox didn't start from a snapshot: $sandbox"
id=$(echo "$sandbox" | jq -r .id)
[ "$(echo "$sandbox" | jq -r .hostId)" = "$h2" ] || fail "the second sandbox isn't on B: $sandbox"
[ "$(run "$id" 'cat /etc/own')" = own ] || fail "the second setup's file isn't in the sandbox"
drain "$h1" false
echo "B built its own $snap2 on its runtime, never fetching A's, and a sandbox started on B from it ($id)"
echo
echo "PASS"
