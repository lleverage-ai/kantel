# Sandbox contract

## What it is for

One sandbox per session in two tiers over the same workspace: the isolate (file tools, plain shell) and the container
(real binaries). The tool, not the agent, picks the tier through a routing table. Every sandbox is a lease with a TTL.
Mounts are read-only: a command that writes under a mount point fails and the source is unchanged.

## Records

- `SandboxLease`: session, workspace, tier, the workspace version it started on, acquire and expiry times, and how it
  ended (`released`, `expired`, `session_ended`, `aborted`).
- `TierRoute`: one row of the tool-to-tier table; `DEFAULT_TIER_ROUTES` is the default.
- `SandboxUsage`: per tier, leases, held ms and busy ms.

## Key operations

`acquire`, `renew`, `release` (the container commits first; idempotent), `exec`, `run` (route, reuse or acquire, then
exec), `route`, `leases`, `releaseSession`, `sweep` and `usage`. Portable logic in `@harbour/sandbox`: `routeTool`
(first matching row wins; the program is the first word after `cd <dir> &&` steps and `NAME=value` assignments, or
`argv[0]`, reduced to its basename; unknown tools go to the isolate), `commandProgram` and `tokenizeShell`.

## Rules and the suite cases that enforce them

| Rule | Case |
| --- | --- |
| Routing is table-driven | routes tools to tiers through the table |
| The isolate commits after each command that changed files | commits an isolate write at the end of the command |
| The container sees the isolate's last write | lets the container see the isolate's last write |
| The container commits on release | lets the isolate see the container's write after the container lease is released |
| `git` exists only in the container | has no git in the isolate and git in the container |
| Exit codes propagate | propagates exit codes |
| Writes under a mount fail in both tiers; reads work | refuses writes under /project from either tier and leaves the source and workspace unchanged, while reads work |
| Leases past their TTL are swept; `exec`/`renew` are `expired` | sweeps a lease past its TTL as expired and rejects exec and renew on it |
| One live lease per session per tier | rejects a second live lease on the same tier with conflict |
| `releaseSession` ends every live lease | ends every live lease of a session on releaseSession |
| Held time is reported per tier | reports held time per tier |
| `run` reuses leases and audits escalation once | reuses the session's lease per tier in run and audits escalation once |
| `release` is idempotent and audited once | releases idempotently and audits the release once |
| Another organisation sees `not_found` | hides another organisation's leases as not_found |
| The session-end teardown ends the session's live leases with its reason, audits each release once, leaves other sessions alone, and a second run changes nothing | session end: the teardown (session_ended) ends the session's leases once, and a second run changes nothing |
| After `aborted` the session acquires and runs again | session end: the teardown (aborted) ends the session's leases once and leaves the session usable |

## Project access (settled question 7)

Every lease belongs to a session, and the session's project is the one checked. After the organisation lookup (the
workspace for `acquire` and `run`, the lease for the rest), each call requires through `ProjectAccess`:

- operator on `input.sessionId`: `sandbox.acquire`, `sandbox.run`; when the workspace is project-owned, the session
  must belong to that project too;
- operator on the lease's session: `sandbox.renew`, `sandbox.release`, `sandbox.exec`;
- viewer on the session: `sandbox.leases`, `sandbox.usage`; operator on it: `sandbox.releaseSession` (`system`
  passes, so the teardown never fails a check).

A session with no leases in the organisation lists nothing and reports zero usage, and `releaseSession` on a session
with no live lease does nothing, all without a check or an audit. `route` is a pure function and takes no context.
`sweep` is a worker call (settled by Tom on 27 Oct 2026, question 13: "Require a system identity"): it takes a
`SystemContext`, and no caller, a human, a service or an agent is `forbidden`, audited once as `access.denied`, and
releases nothing ("worker calls: sweep refuses no caller, a human, a service and an agent, and releases nothing",
run with `projectAccess`). An agent acts
only from its own open session, or on a child session as its supervisor. Lists always name a session, so there is no
unfiltered list. Cases (run with `projectAccess`): "project access: refuses an operator outside the project on every
session call, and changes nothing", "... refuses an agent whose session belongs to another project, and changes
nothing", "... refuses an agent whose session was closed", "... lets an operator on the project and an agent in its
own session work".

## Session end (settled question 8)

Given `sessionEnd`, the factory registers `releaseSession(ctx, end.sessionId, end.reason)` once as the `sandbox`
teardown. Both reasons end the session's live leases (the reason becomes `endReason`); `aborted` leaves the session
free to acquire again. A unit test in `test/memory.test.ts` checks the registration.

## The in-memory implementation

`createMemorySandboxes({ workspaces, clock?, audit?, routes?, defaultTtlMs?, access?, sessionEnd? })` (default TTL 15
minutes; without `access` it checks only the organisation). There is no
real shell: a small interpreter runs `printf`, `echo`, `cat`, `ls [path]`, `mkdir [-p]`, `cd`, `exit`, `true`,
`false`, `>`/`>>` and `&&` lists, plus `git --version` in the container. Anything else it cannot model (pipes, `;`,
`||`, expansions, globs) exits 2; unknown programs exit 127. Parent directories of written files are created
implicitly; paths outside the workspace and mounts do not exist. A container lease keeps its own changes but re-reads
the current head before each command, and on release commits its files on top of the current head. Expired leases are
discarded, not committed; other end reasons commit. Busy time comes from the clock, so it is zero in tests. It leaves
out `env`, `timeoutMs`, output truncation and `SandboxPolicy`.

## Open questions

- How a real container picks up isolate commits while its lease is live (the memory target re-reads the head each
  command); and how re-basing on release resolves a file both tiers changed.
- Whether `aborted` and `session_ended` should commit the container's changes or discard them.
- Where `SandboxPolicy` (allowed tiers, sizes) is enforced: here or in the runtime.
