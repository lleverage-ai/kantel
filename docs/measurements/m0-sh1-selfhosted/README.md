# Self-hosted cold starts and takeover (M0-SH1), 27 October 2026

Measured on the compose stack (`deploy/compose`) on one shared machine:
AMD EPYC 7401P (48 threads), 135 GB RAM, Linux 7.2.7, Docker 29.8.1, load
average about 10 from other work. **Both runtimes were runc**: the host has no
gVisor, so the isolate host and the sandbox containers ran without the
hardening the plan requires. Re-run on runsc before treating these as
production numbers (`deploy/compose/README.md`).

## Cold-start table, self-hosted rows (50 runs each)

| Step (plan Table 6) | Target p50 / p95 | Measured p50 / p95 | min–max |
|---|---|---|---|
| Isolate session ready, workspace listed | 100 ms / 300 ms | **141 ms / 159 ms** | 122–192 ms |
| Container on the same workspace version, warm image | 3 s / 8 s | **1.57 s / 2.75 s** | 0.96–3.20 s |
| Small repo worktree off a warm mirror | 1 s / 3 s | not measured here: M0-BE2 (#5) | |
| Large monorepo checkout ready | 10 s / 25 s | not measured here: M0-BE2 (#5) | |
| Dependencies ready from a cached layer | 15 s / 40 s | not measured here: M0-BE2 (#5) | |

Reference rows (same runs):

| Step | p50 / p95 |
|---|---|
| New session's first command (`ls -R \| wc -l`, 381 entries) | 194 ms / 213 ms |
| A further command in the same, loaded isolate | 38 ms / 43 ms |
| Session open: lease, Pi schema and migrations, Harness open | 149 ms / 281 ms |

Container phases (p50, cumulative from the start of the call): tar of the
workspace 75 ms, `create` 229 ms, copy-in 401 ms, `start` 762 ms, command
finished 1,217 ms, workspace read back 1,401 ms. `start` and the wait for a
trivial command are about half; copy-in and copy-out of a 1.2 MB workspace
about a third.

## Takeover after the owner dies mid tool call

Lease TTL 10 s, renewed every 2.5 s, takeover poll 500 ms. Every run is the
full scripted task with `--crash` and passed all of its checks.

| How the owner died | Runs | Kill to resumed on the other host, p50 / max | Of which: kill to lease acquired | lease acquired to session resumed |
|---|---|---|---|---|
| `docker kill` (process gone, Postgres connection drops) | 10 | **0.99 s / 2.53 s** | p50 0.53 s | p50 0.45 s |
| `docker pause` (process frozen, connection stays up) | 5 | **10.9 s / 12.2 s** | p50 10.1 s (the TTL) | p50 0.98 s |

"Kill" times include the `docker compose kill` command itself (p50 0.74 s).
After a kill the lease is free as soon as Postgres drops the dead host's
advisory lock, so the TTL does not matter; after a pause only the TTL frees
it, and the new owner acquires it 8–38 ms after expiry. Opening the session
on the new owner includes removing the dead owner's still-running sandbox
container, which is most of the 0.35–2.15 s spread.

## Method

- `apps/selfhosted/src/measure.ts`, run inside `host-a` so it uses the same
  clients as the session host: a seeded workspace of 300 files of 4 KB in 81
  directories (381 entries), one warm-up of each row not recorded, then 50
  runs. Each isolate run uses a new session ID, so the workerLoader loads a
  new Dynamic Worker; each container run starts a new container. Wall clock
  from the session host.
- `deploy/compose/scripts/takeover.sh kill 10` and `pause 5`: the scripted
  task with `--crash`, timing from just before the kill command to the new
  owner's `resumedAt` (both clocks on this machine).
- Raw numbers: `raw/cold-start-2026-10-27.json`, `raw/takeover-kill-2026-10-27.jsonl`,
  `raw/takeover-pause-2026-10-27.jsonl`.
