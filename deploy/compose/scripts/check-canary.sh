#!/usr/bin/env bash
# After the scenario and the conformance suite: the canary secret the vault
# injects must appear nowhere but the vault's own environment. Checks every
# service log, the whole database (transcripts, audit, workspace history) and
# every workspace object in MinIO. Run from the repo root with the stack up.
#
# Self-test: KANTEL_CANARY_SECRET="Tides of the Harbour" must FAIL the
# Postgres and MinIO checks, because the research page's title is in the
# transcript and the workspace (the logs never carry tool output).
set -uo pipefail
# COMPOSE_FILE as the stack was brought up with (deploy/compose/egress-vault.yaml on top, say); compose.yaml alone by default.
export COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose/compose.yaml}"
compose="docker compose"
canary="${KANTEL_CANARY_SECRET:-${HARBOUR_CANARY_SECRET:-harbour-canary-0000}}"
work="$(mktemp -d)"
found=0

# Capture first, then search: `producer | grep -q` lets the producer die of
# SIGPIPE, which pipefail would turn into a false "absent".
$compose logs --no-color >"$work/logs" 2>&1
$compose exec -T postgres pg_dump -U harbour harbour >"$work/db.sql"

if grep -qF -- "$canary" "$work/logs"; then
	echo "FAIL canary found in service logs"
	found=1
else
	echo "ok   canary absent from all service logs ($(wc -l <"$work/logs") lines)"
fi

if grep -qF -- "$canary" "$work/db.sql"; then
	echo "FAIL canary found in Postgres (transcripts, audit or workspace history)"
	found=1
else
	echo "ok   canary absent from Postgres ($(wc -c <"$work/db.sql") bytes dumped)"
fi

volume="$($compose config --format json | bun -e "const c = JSON.parse(await Bun.stdin.text()); console.log(c.name + '_miniodata')")"
if docker run --rm -v "$volume:/data:ro" alpine:3.22 grep -rqF -- "$canary" /data; then
	echo "FAIL canary found in MinIO workspace objects"
	found=1
else
	echo "ok   canary absent from MinIO ($(docker run --rm -v "$volume:/data:ro" alpine:3.22 sh -c 'find /data -type f | wc -l') files)"
fi
exit "$found"
