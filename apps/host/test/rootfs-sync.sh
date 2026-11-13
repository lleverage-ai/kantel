#!/usr/bin/env bash
# Templates' root filesystems from peers (docs/design/disk-store.md, "Phase 3 notes"): local-stack.sh --hosts 2 starts
# the self-hosted control plane, with templates on, and two kantel-host processes from this branch, each in a container
# of its own on Docker's bridge, both in the deployment's default pool, which gets sync on. Each host's `docker` is a
# stand-in that answers `docker version` (so the host builds templates) and fails anything else, logging every call: a
# host that pulls or builds an image shows it there. Then, over the API:
#
#   1. a template on a published Kantel base builds on one host (A), whose root filesystem for that base is put in place
#      first (a copy of the sandbox image, as a pull would have made it), so it pulls nothing; A maps it and reports it;
#   2. the template is rebuilt on the other host (B), A draining: B fetches the root filesystem from A, with no pull and
#      no image build, and its file is byte-identical to A's;
#   3. a request to A's peer sync server for it without a grant is refused.
#
# It stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/rootfs-sync.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; KANTEL_STACK_DIR is ignored). The stack
# is named rootfs-<pid>, with its own state directory, so it runs beside other stacks.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
stack="$here/local-stack.sh"
name=rootfs-$$
# Its own state directory, from its name: one set for another stack must never be the one this test's cleanup takes
# down.
unset KANTEL_STACK_DIR
trap '"$stack" down --name "$name" >/dev/null || true' EXIT
KANTEL_TEMPLATES=experimental "$stack" up --hosts 2 --name "$name" >/dev/null

dir=/tmp/kantel-local-stack-$name
url=$(cat "$dir/url")
key=$(jq -r .computeKey "$dir/bootstrap.json")
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
		docker logs "$container" 2>&1 | grep -iE 'sync|fetch|rootfs|root filesystem|template|mesh' | tail -30 >&2 || true
		docker exec "$container" cat /var/lib/kantel-host/docker.log >&2 || true
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
build_state() { api GET "/templates/$template" | jq -r .build.state; }
built() { [ "$(build_state)" = ready ]; }

h1=$(cat "$dir/h1/host-id")
h2=$(cat "$dir/h2/host-id")
a=kantel-stack-$name-h1
b=kantel-stack-$name-h2

# Each host's Docker: `docker version` answers, anything else fails, and every call is logged. Its settings name a
# registry, which nothing reaches. Both written in place (the settings file is mounted), then the host restarted.
for h in h1 h2; do
	container=kantel-stack-$name-$h
	docker exec -i "$container" sh -c 'cat >/usr/local/bin/docker && chmod +x /usr/local/bin/docker' <<'EOF'
#!/bin/sh
echo "$*" >>/var/lib/kantel-host/docker.log
[ "$1" = version ] && { echo 27.0.0; exit 0; }
echo "no Docker here: $*" >&2
exit 1
EOF
	jq '.templateRegistry = "registry.invalid"' "$dir/$h/config.json" >"$dir/$h/config.new" && cat "$dir/$h/config.new" >"$dir/$h/config.json"
	docker restart "$container" >/dev/null
done
until_ok online "$h1" || fail "$a didn't come back"
until_ok online "$h2" || fail "$b didn't come back"
api PATCH /admin/pools/default -d '{"sync":true}' | jq -e '.sync == true' >/dev/null || fail "sync on"
until_ok mesh_up "$a" || fail "$a brought no mesh up"
until_ok mesh_up "$b" || fail "$b brought no mesh up"

echo "== 1. A builds a template on a published base, from the root filesystem it has"
digest=sha256:$(printf 'rootfs-sync %s' "$name" | sha256sum | cut -d' ' -f1)
api POST /template-bases -d "{\"image\":\"kantel/sandbox\",\"channel\":\"stable\",\"digest\":\"$digest\"}" |
	jq -e .digest >/dev/null || fail "publish the base"
rootfs_key=$(printf 'kantel-base\0kantel/sandbox@%s' "$digest" | sha256sum | cut -d' ' -f1)
file=$templates/$rootfs_key.ext4
docker exec "$a" sh -c "mkdir -p $templates && cp --sparse=always /images/sandbox.ext4 $file.tmp && mv $file.tmp $file"
drain "$h2" true
template=$(api POST /templates -d "{\"name\":\"synced\",\"spec\":{\"base\":{\"image\":\"kantel/sandbox\",\"digest\":\"$digest\"},\"setup\":\"echo built > /etc/built\"}}" | jq -r .id)
[ -n "$template" ] && [ "$template" != null ] || fail "create the template"
wait=600 until_ok built || fail "the template didn't build on A: $(api GET "/templates/$template" | jq -c .build)"
api GET "/templates/$template/snapshots" | jq -e --arg a "$h1" '[.items[] | select(.state == "ready" and .hostId == $a)] | length == 1' >/dev/null ||
	fail "the template wasn't built on A: $(api GET "/templates/$template/snapshots" | jq -c .)"
mapped() { docker exec "$a" test -f "$templates/$rootfs_key.map"; }
until_ok mapped || fail "A made no map of the root filesystem"
# Two heartbeats: A's report of it reaches the catalogue.
sleep 35
echo "A built the template on root filesystem $rootfs_key and mapped it"

echo "== 2. Rebuilt on B, A draining: B fetches the root filesystem from A, pulling and building nothing"
drain "$h2" false
drain "$h1" true
docker exec "$b" test -f "$file" && fail "B has the root filesystem already"
api POST "/templates/$template/rebuild" | jq -e .id >/dev/null || fail "rebuild"
on_b() {
	api GET "/templates/$template/snapshots" |
		jq -e --arg b "$h2" '[.items[] | select(.state == "ready" and .hostId == $b)] | length == 1' >/dev/null
}
wait=600 until_ok on_b || fail "the template wasn't rebuilt on B: $(api GET "/templates/$template/snapshots" | jq -c .)"
docker exec "$b" test -f "$file" || fail "B has no root filesystem"
sum_a=$(docker exec "$a" sha256sum "$file" | cut -d' ' -f1)
sum_b=$(docker exec "$b" sha256sum "$file" | cut -d' ' -f1)
[ "$sum_a" = "$sum_b" ] || fail "the root filesystems differ: A $sum_a, B $sum_b"
calls=$(docker exec "$b" sh -c 'grep -v "^version" /var/lib/kantel-host/docker.log || true')
[ -z "$calls" ] || fail "B ran docker: $calls"
docker logs "$b" 2>&1 | grep -q 'template root filesystem fetched from a peer' || fail "B logged no fetch"
echo "B fetched it from A ($(docker logs "$b" 2>&1 | grep 'disk version fetched' | grep "$rootfs_key" | tail -1 | grep -oE 'fetchedBytes=[0-9]+')), byte-identical ($sum_b), and ran no docker pull or build"

echo "== 3. A's peer sync server refuses it without a grant"
a_addr=$(docker exec "$a" ip -6 -o addr show dev kmesh0 | awk '/fd/ {sub("/128", "", $4); print $4; exit}')
status=$(docker exec "$b" curl -s -o /dev/null -w '%{http_code}' --http2-prior-knowledge "http://[$a_addr]:7480/v1/objects/rootfs/$rootfs_key/1/map")
[ "$status" = 401 ] || fail "a request without a grant: $status"
echo "refused (401) without a grant"
echo
echo "PASS"
