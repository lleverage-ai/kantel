#!/usr/bin/env bash
# Kill (or pause) the session owner mid tool call, N times, and record how
# long the other host takes to resume the session. Run from the repo root
# with the stack up.
#
#   deploy/compose/scripts/takeover.sh kill 10 > takeover-kill.jsonl
#   deploy/compose/scripts/takeover.sh pause 5 > takeover-pause.jsonl
#
# kill:  the process dies; its Postgres connection drops and so does its
#        liveness lock, so the lease is free at once.
# pause: the process is frozen but its connection stays up (a hung or cut-off
#        host); the lease frees only when its TTL runs out.
set -euo pipefail
mode="${1:-kill}"
runs="${2:-10}"
# COMPOSE_FILE as the stack was brought up with (deploy/compose/egress-vault.yaml on top, say); compose.yaml alone by default.
export COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose/compose.yaml}"
compose="docker compose"
out="$(mktemp -d)"

for i in $(seq 1 "$runs"); do
	$compose up -d --wait host-a host-b >/dev/null 2>&1
	if [ "$mode" = "kill" ]; then
		kill_cmd="$compose kill host-a"
		after=""
		budget=""
	else
		kill_cmd="$compose pause host-a"
		after="$compose unpause host-a"
		# The TTL, plus the pause command itself and opening the session on the new owner.
		budget="--takeover-budget-ms=13000"
	fi
	bun spike/scenario/run.ts --crash --kill-cmd "$kill_cmd" ${after:+--after-cmd "$after"} $budget \
		--fallback http://127.0.0.1:58082 --json "$out/$i.json" >&2 || true
	if [ -f "$out/$i.json" ]; then
		bun -e "const r = await Bun.file('$out/$i.json').json(); console.log(JSON.stringify({ mode: '$mode', run: $i, takeoverMs: r.takeoverMs, ...r.takeoverDetail, totalMs: r.totalMs, passed: r.passed, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) }))"
	fi
done
$compose up -d --wait host-a host-b >/dev/null 2>&1
