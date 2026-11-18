#!/usr/bin/env bash
# An isolate's upgrade to a microVM on another host, with real hosts (packages/hosts/src/service.ts, the cross-host
# path; upgrade.test.ts tests it with fake ones): local-stack.sh --two-hosts starts the self-hosted control plane
# and two kantel-host processes from this branch, host a with isolates only and host b with microVMs only. Then, over
# the API:
#
#   1. an isolate is made (on a), given files by its shell and by file writes (a directory tree, an executable, a
#      link, 7 MB), and runs a command;
#   2. an upgrade that b can't do (its Firecracker replaced by false for the while) fails, and leaves the isolate as
#      it was: on a, running, with its files, taking commands and writes again;
#   3. an isolate of 20,001 files, more than Kantel moves between hosts, is refused at once: before a microVM is made
#      or a file read, the isolate thawed;
#   4. the upgrade: the microVM runs on b with the same ID, the files at /home/user/workspace with /workspace a link
#      to them (contents, mode and link checked by the microVM's own tools), the isolate gone from a, the
#      sandbox.upgraded event saying what moved, and a command runs.
#
# It prints each step's time, and stops and removes the stack at the end, whatever happened.
#
#   apps/host/test/upgrade-crosshost.sh
#
# Needs what local-stack.sh needs (its KANTEL_STACK_* settings pick the images; the isolate image should be this
# branch's). KANTEL_STACK_DIR defaults to a directory of its own here, and the port to 29801 (KANTEL_STACK_PORT).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export KANTEL_STACK_DIR=${KANTEL_STACK_DIR:-/tmp/kantel-upgrade-crosshost-$$}
stack="$here/local-stack.sh"
trap '"$stack" down >/dev/null || true' EXIT
"$stack" up --two-hosts --port "${KANTEL_STACK_PORT:-29801}"

url=$(cat "$KANTEL_STACK_DIR/url")
key=$(jq -r .computeKey "$KANTEL_STACK_DIR/bootstrap.json")
host_a=$(head -1 "$KANTEL_STACK_DIR/containers")
host_b=$(tail -1 "$KANTEL_STACK_DIR/containers")
id_b=$(cat "$KANTEL_STACK_DIR/b/host-id")
id_a=$(cat "$KANTEL_STACK_DIR/a/host-id")
work=$(mktemp -d)
trap 'rm -rf "$work"; "$stack" down >/dev/null || true' EXIT

api() {
	local method=$1 path=$2
	shift 2
	curl -sS -X "$method" "$url/v1$path" -H "authorization: Bearer $key" -H 'content-type: application/json' "$@"
}
ms() { echo $((($(date +%s%N) - $1) / 1000000)); }
fail() {
	echo "FAIL: $*" >&2
	exit 1
}
# Runs a command in $sandbox, or in $in when it is set.
run() {
	jq -n --arg c "$1" '{command: $c, timeoutMs: 120000}' | api POST "/sandboxes/${in:-$sandbox}/commands" -d @-
}
# The command's stdout, failing unless it exits 0.
ok() {
	local out
	out=$(run "$1")
	[ "$(echo "$out" | jq .exitCode)" = 0 ] || fail "$1: $(echo "$out" | jq -c '{exitCode, stdout, stderr}')"
	echo "$out" | jq -r .stdout
}
# Lines as one, space-separated.
words() { tr -s '\n' ' ' | sed 's/ *$//'; }
on_host() { docker exec "$1" /opt/kantel/kantel-host sandboxes; }

echo
echo "== 1. An isolate with files"
began=$(date +%s%N)
sandbox=$(api POST /sandboxes -d '{"type":"isolate","wait":true}' | jq -r .id)
[ "$(api GET "/sandboxes/$sandbox" | jq -r .hostId)" = "$id_a" ] || fail "the isolate isn't on host a"
echo "isolate $sandbox on host a in $(ms "$began") ms"
ok "mkdir -p src/deep data && echo hello > src/a.txt && printf '#!/bin/sh\necho run ok\n' > run.sh && chmod 755 run.sh && ln -s src/a.txt link && seq 1 20000 > src/deep/numbers.txt" >/dev/null
began=$(date +%s%N)
for n in 1 2 3; do
	head -c 1000000 /dev/urandom >"$work/big$n.bin"
	jq -n --rawfile data <(base64 -w0 "$work/big$n.bin") --arg path "/workspace/data/big$n.bin" \
		'{path: $path, content: $data, encoding: "base64"}' | api PUT "/sandboxes/$sandbox/files" -d @- >/dev/null
done
echo "3 MB written by file writes in $(ms "$began") ms"
ok "node -e 'const b=Buffer.alloc(4<<20);for(let i=0;i<b.length;i++)b[i]=(i*7+(i>>9))&255;require(\"fs\").writeFileSync(\"/workspace/data/gen.bin\",b)'" >/dev/null
expected=$( (cd "$work" && sha256sum big1.bin big2.bin big3.bin | awk '{print $1}') && node -e 'const b=Buffer.alloc(4<<20);for(let i=0;i<b.length;i++)b[i]=(i*7+(i>>9))&255;console.log(require("crypto").createHash("sha256").update(b).digest("hex"))')
in_isolate=$(ok "cd data && sha256sum big1.bin big2.bin big3.bin gen.bin" | awk '{print $1}')
[ "$in_isolate" = "$expected" ] || fail "the isolate's files aren't what was written"
began=$(date +%s%N)
got=$(ok "cat link && wc -l src/deep/numbers.txt" | words)
[ "$got" = "hello 20000 src/deep/numbers.txt" ] || fail "a command in the isolate: $got"
echo "a command in the isolate in $(ms "$began") ms"

echo
echo "== 2. An upgrade host b can't do leaves the isolate as it was"
docker exec "$host_b" mount --bind /bin/false /opt/kantel/firecracker
began=$(date +%s%N)
refused=$(api POST "/sandboxes/$sandbox/upgrade" -d '{}')
echo "refused in $(ms "$began") ms: $(echo "$refused" | jq -c .error)"
docker exec "$host_b" umount /opt/kantel/firecracker
[ "$(echo "$refused" | jq -r '.error.code // empty')" != "" ] || fail "the upgrade didn't fail: $refused"
[ "$(api GET "/sandboxes/$sandbox" | jq -c '[.type, .state, .hostId]')" = "[\"isolate\",\"running\",\"$id_a\"]" ] ||
	fail "the sandbox isn't the running isolate on a: $(api GET "/sandboxes/$sandbox" | jq -c '{type, state, hostId}')"
on_host "$host_b" | grep -q "$sandbox" && fail "host b kept a microVM"
[ "$(ok "cd data && sha256sum big1.bin big2.bin big3.bin gen.bin" | awk '{print $1}')" = "$expected" ] ||
	fail "the isolate's files changed"
ok "echo again > src/again.txt" >/dev/null
echo "the isolate is on a, running, with its files, and takes commands and writes"

echo
echo "== 3. An isolate of more files than Kantel moves is refused before a microVM is made"
many=$(api POST /sandboxes -d '{"type":"isolate","wait":true}' | jq -r .id)
jq -n --arg c "node -e 'const fs=require(\"fs\");fs.mkdirSync(\"/workspace/many\");for(let i=0;i<20001;i++)fs.writeFileSync(\"/workspace/many/f\"+i,\"x\")'" \
	'{command: $c, timeoutMs: 300000}' | api POST "/sandboxes/$many/commands" -d @- | jq -e '.exitCode == 0' >/dev/null ||
	fail "writing 20,001 files"
began=$(date +%s%N)
refused=$(api POST "/sandboxes/$many/upgrade" -d '{}')
took=$(ms "$began")
echo "refused in $took ms: $(echo "$refused" | jq -c .error)"
[ "$(echo "$refused" | jq -r .error.code)" = not_supported ] || fail "the upgrade of 20,001 files: $refused"
# It was 20 minutes, every file read (each read parsing the whole manifest) with the microVM made and the isolate held.
[ "$took" -lt 30000 ] || fail "the refusal took $took ms"
[ "$(api GET "/sandboxes/$many" | jq -c '[.type, .state]')" = '["isolate","running"]' ] || fail "the isolate after the refusal"
on_host "$host_b" | grep -q "$many" && fail "host b made a microVM for it"
[ "$(in=$many ok "echo thawed > many/f0 && cat many/f0")" = thawed ] || fail "the refused isolate takes no writes"

echo
echo "== 4. The upgrade"
began=$(date +%s%N)
upgraded=$(api POST "/sandboxes/$sandbox/upgrade" -d '{}')
took=$(ms "$began")
[ "$(echo "$upgraded" | jq -c '[.id, .type, .state, .hostId]')" = "[\"$sandbox\",\"microvm\",\"running\",\"$id_b\"]" ] ||
	fail "the upgrade: $(echo "$upgraded" | jq -c '{id, type, state, hostId, error}')"
echo "upgraded in $took ms: $(echo "$upgraded" | jq -c '{id, type, state, hostName}')"
on_host "$host_a" | grep -q "$sandbox" && fail "host a still has the isolate"
on_host "$host_b" | grep "$sandbox" | grep -q microvm || fail "host b doesn't run the microVM"
began=$(date +%s%N)
[ "$(ok "readlink /workspace")" = "/home/user/workspace" ] || fail "/workspace isn't the link"
echo "the first command in the microVM in $(ms "$began") ms"
[ "$(ok "cd /home/user/workspace/data && sha256sum big1.bin big2.bin big3.bin gen.bin" | awk '{print $1}')" = "$expected" ] ||
	fail "the microVM's files aren't the isolate's"
[ "$(ok "readlink /workspace/link && cat /workspace/link && /workspace/run.sh && stat -c %a /workspace/run.sh && wc -l /workspace/src/deep/numbers.txt && stat -c %U /home/user/workspace/src/a.txt" | words)" = \
	"src/a.txt hello run ok 755 20000 /workspace/src/deep/numbers.txt user" ] || fail "the microVM's link, executable or tree"
event=$(api GET "/events?sandboxId=$sandbox" | jq -c '[.items[] | select(.type == "sandbox.upgraded")][0].data | {path, files, bytes, durationMs}')
echo "sandbox.upgraded: $event"
# The isolate's 11 entries, and src/again.txt.
[ "$(echo "$event" | jq -c '[.files, .bytes]')" = "[12,$((3 * 1000000 + (4 << 20) + 108894 + 6 + 22 + 6))]" ] ||
	fail "the event doesn't count what moved"
[ "$(echo "$event" | jq -r .path)" = control-plane ] || fail "the upgrade wasn't moved by the control plane"
[ "$id_a" != "$id_b" ]
echo
echo "PASS"
