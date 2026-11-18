#!/usr/bin/env bash
# Copies of a custom image's template snapshot (docs/design/disk-store.md, "Phase 3 notes"): local-stack.sh --hosts 2
# starts the self-hosted control plane, with templates on, and two kantel-host processes from this branch, each in a
# container of its own on Docker's bridge, both in the deployment's default pool, which gets sync on. Both build
# templates' custom images (templateBuilder, through the injected guest agent), and each host's `docker` is a stand-in
# that answers `docker version` and fails anything else. Then, over the API:
#
#   1. a template on a Dockerfile builds on one host (A), the other (B) draining. Its image's root filesystem is put in
#      place on A first (a copy of the sandbox image with its record, as a build microVM would have left them), so A
#      boots no build microVM. A maps the root filesystem and the snapshot and reports them.
#   2. B, back, is asked for a copy over the entry's image: it fetches the root filesystem (the same bytes, with the
#      digest the entry's key covers) and then A's snapshot, and builds no image and boots no build VM. With A
#      draining, a sandbox made from the template starts on B from that snapshot, with what the setup left, and the
#      template isn't built again.
#   3. A second Dockerfile template builds on A, whose root filesystem is then removed from A: B, asked for a copy,
#      finds no peer with the image and fails the copy, building nothing (no image, no snapshot).
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/custom-template-sync.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_DIR is ignored); the guest
# image must have sticky drives (KANTEL_STACK_SANDBOX_IMAGE). The stack is named csync-<pid>, with its own state
# directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=csync-$$
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_TEMPLATES=experimental "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
snapshots=/var/lib/kantel-host/microvm/template-snapshots
templates=/var/lib/kantel-host/microvm/images/templates

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
fail() {
	echo "FAIL: $*" >&2
	for container in $(cat "$dir/containers"); do
		echo "--- $container" >&2
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|template|mesh|peer|copy|build' | tail -40 >&2 || true
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
sum() { docker exec "$1" sha256sum "$2" | cut -d' ' -f1; }
# Whether host container $1 logged a line with both $2 and $3 (read whole, so no grep -q cuts the pipe short).
logged() {
	local lines
	lines=$(docker logs "$1" 2>&1 | grep -F -- "$2" || true)
	grep -qF -- "$3" <<<"$lines"
}
from_template() {
	api POST /sandboxes -d "{\"template\":\"$1\",\"wait\":true}"
}
run() {
	api POST "/sandboxes/$1/commands" -d "{\"command\":\"$2\"}" | jq -r .stdout
}
# A Dockerfile template named $1 (its Dockerfile's last line $2, its setup's $3), made while both hosts drain so
# nothing builds it yet; answers its ID and its image's root filesystem key (microvm.customImageKey).
dockerfile_template() {
	local dockerfile
	dockerfile=$(printf 'ARG KANTEL_BASE\nFROM $KANTEL_BASE\n%s\n' "$2")
	local made
	made=$(api POST /templates -d "$(jq -n --arg n "$1" --arg d "$dockerfile" --arg s "$3" '{name: $n, spec: {image: {kind: "dockerfile", dockerfile: $d}, setup: $s}}')")
	local id account
	id=$(echo "$made" | jq -r .id)
	account=$(echo "$made" | jq -r .accountId)
	[ -n "$id" ] && [ "$id" != null ] || fail "create the template $1: $made"
	local digest
	digest=sha256:$(printf '%s' "$dockerfile" | sha256sum | cut -d' ' -f1)
	echo "$id $(printf 'custom\0%s\0%s@1#0\0dockerfile\0%s\0kantel/sandbox@' "$account" "$id" "$digest" | sha256sum | cut -d' ' -f1)"
}
# Puts image root filesystem $2 in place on host $1 as a build microVM leaves one (the file, its record naming digest
# $3, and its pool's stamp).
seed() {
	docker exec "$1" sh -c "mkdir -p $templates && cp --sparse=always /images/sandbox.ext4 $templates/$2.ext4.tmp && mv $templates/$2.ext4.tmp $templates/$2.ext4 &&
		printf '{\"imageDigest\":\"%s\",\"builtFrom\":\"dockerfile\"}' $3 >$templates/$2.json && printf %s $pool >$templates/$2.pool"
}

h1=$(cat "$dir/h1/host-id")
h2=$(cat "$dir/h2/host-id")
a=kantel-stack-$name-h1
b=kantel-stack-$name-h2

# Both build custom images (the builder on, through the injected guest agent), and keep memory snapshots off the spool.
(cd "$here/.." && CGO_ENABLED=0 go build -o "$dir/bin/kantel-guest" ./cmd/kantel-guest)
for h in h1 h2; do
	container=kantel-stack-$name-$h
	jq '. + {injectGuestAgent: true, guestAgent: "/opt/kantel/kantel-guest", templateBuilder: {registries: []}, spoolMaxMiB: -1}' \
		"$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
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
pool=$(api PATCH /admin/pools/default -d '{"sync":true}' | jq -r 'select(.sync == true) | .id')
[ -n "$pool" ] || fail "sync on"
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"

echo "== 1. A builds a Dockerfile template, its image in place, B draining, and maps its snapshot"
drain "$h1" true
drain "$h2" true
read -r template rootfs_key <<<"$(dockerfile_template custom 'RUN echo image > /etc/image' 'echo built > /etc/built')"
image_digest=sha256:$(printf 'custom-template-sync %s' "$name" | sha256sum | cut -d' ' -f1)
seed "$a" "$rootfs_key" "$image_digest"
drain "$h1" false
built_on_a() { [ -n "$(ready_on "$template" "$h1")" ]; }
wait=600 until_ok built_on_a || fail "the template didn't build on A: $(api GET "/templates/$template/snapshots" | jq -c .)"
snap=$(ready_on "$template" "$h1")
entry=$(api GET "/templates/$template/snapshots" | jq -c --arg s "$snap" '.items[] | select(.id == $s)')
[ "$(echo "$entry" | jq -r .key.imageDigest)" = "$image_digest" ] || fail "the entry's key isn't over the image put in place: $entry"
# A built no image: its root filesystem is the one put in place.
[ "$(sum "$a" "$templates/$rootfs_key.ext4")" = "$(sum "$a" /images/sandbox.ext4)" ] || fail "A built the image itself"
wait=300 until_ok mapped "$a" "$snap" || fail "A made no maps of $snap"
wait=300 until_ok docker exec "$a" test -f "$templates/$rootfs_key.map" || fail "A made no map of the image's root filesystem"
echo "A built $snap over the image's root filesystem $rootfs_key ($image_digest) and mapped them"

echo "== 2. B, back, copies it over the entry's image, and a sandbox starts on B from it with A draining"
sleep 35
drain "$h2" false
wait=600 until_ok whole "$b" "$snap" || fail "B has no copy of $snap"
logged "$b" 'template root filesystem fetched from a peer' "$rootfs_key" || fail "B fetched no root filesystem"
[ "$(sum "$a" "$templates/$rootfs_key.ext4")" = "$(sum "$b" "$templates/$rootfs_key.ext4")" ] || fail "B's image differs from A's"
# A's record, which no build of B's would have written.
docker exec "$b" cat "$templates/$rootfs_key.json" | jq -e --arg d "$image_digest" '.imageDigest == $d and .builtFrom == "dockerfile"' >/dev/null ||
	fail "B's image record: $(docker exec "$b" cat "$templates/$rootfs_key.json")"
logged "$b" 'template snapshot fetched from a peer' "$snap" || fail "B logged no fetch of $snap"
logged "$b" 'template snapshot ready' "$snap" && fail "B built $snap itself"
for file in disk.ext4 mem state; do
	[ "$(sum "$a" "$snapshots/$snap/$file")" = "$(sum "$b" "$snapshots/$snap/$file")" ] || fail "B's $file differs from A's"
done
calls=$(docker exec "$b" sh -c 'grep -v "^version" /var/lib/kantel-host/docker.log || true')
[ -z "$calls" ] || fail "B ran docker: $calls"
echo "B fetched the image's root filesystem and $snap from A, byte-identical, building nothing"
sleep 35
drain "$h1" true
sandbox=$(from_template "$template")
[ "$(echo "$sandbox" | jq -r .template.start)" = snapshot ] || fail "the sandbox didn't start from the snapshot: $sandbox"
id=$(echo "$sandbox" | jq -r .id)
[ "$(echo "$sandbox" | jq -r .hostId)" = "$h2" ] || fail "the sandbox isn't on B: $sandbox"
[ "$(echo "$sandbox" | jq -r .image)" = "dockerfile@$image_digest" ] || fail "the sandbox's image: $sandbox"
[ "$(run "$id" 'cat /etc/built')" = built ] || fail "the setup's file isn't in the sandbox"
api DELETE "/sandboxes/$id" >/dev/null
# A sweep later the entry is still the one served: nothing built it again while A drains.
sleep 40
entries=$(api GET "/templates/$template/snapshots" | jq -c '[.items[] | select(.state != "discarded") | {id, state, hostId}]')
[ "$(echo "$entries" | jq length)" = 1 ] && [ "$(echo "$entries" | jq -r '.[0].id + " " + .[0].state')" = "$snap ready" ] ||
	fail "the template's entries with A draining: $entries"
drain "$h1" false
echo "a sandbox started on B from the copy ($id), and the entry wasn't built again with A draining"

echo "== 3. No peer holds a second template's image: B's copy fails, building nothing"
drain "$h1" true
drain "$h2" true
read -r other other_key <<<"$(dockerfile_template other 'RUN echo other > /etc/other' 'echo own > /etc/own')"
seed "$a" "$other_key" "sha256:$(printf 'other %s' "$name" | sha256sum | cut -d' ' -f1)"
drain "$h1" false
built_other() { [ -n "$(ready_on "$other" "$h1")" ]; }
wait=600 until_ok built_other || fail "the second template didn't build on A"
snap2=$(ready_on "$other" "$h1")
wait=300 until_ok mapped "$a" "$snap2" || fail "A made no maps of $snap2"
docker exec "$a" rm -f "$templates/$other_key.map" "$templates/$other_key.pool" "$templates/$other_key.json" "$templates/$other_key.ext4"
sleep 35
drain "$h2" false
failed() { logged "$b" 'the copy fails' "$other_key"; }
wait=300 until_ok failed || fail "B wasn't asked for a copy of $snap2, or didn't fail it"
sleep 5
docker exec "$b" test -e "$templates/$other_key.ext4" && fail "B made the second image"
docker exec "$b" test -e "$snapshots/$snap2" && fail "B has a snapshot $snap2"
logged "$b" 'template snapshot ready' "$snap2" && fail "B built $snap2"
echo "B found no peer with the second image and failed the copy of $snap2, building nothing"
echo
echo "PASS"
