---
title: Programs
description: Save a code mode script under a name in a project and run it through the API with no model, as a versioned program.
---

A program is a code mode script saved under a name in a project. It runs through the API with no model in the loop: you
send an input and get the output back, either in the same call or by polling the run. Each save is a new version,
numbered from 1, which never changes and whose number is never reused.

:::caution[Experimental]
Programs are served only where the deployment sets `KANTEL_PROGRAMS=on`, and they need code mode. Without it there are
no routes (`/v1/programs` answers 404), no `save_program` tool and no tables. Only the Cloudflare deployment serves them.
:::

## A version

A version holds:

- `code`: the body of an async JavaScript function, run by code mode. `input` is the run's input, `await tools.<name>(args)`
  calls a tool, and the JSON value it returns is the output.
- `inputSchema` and `outputSchema` (optional): JSON Schema, checked before the run and after it.
- `tools`: the tools the program may call, and no others. A program can't be given `codemode`, `subagent` or
  `save_program`.
- `timeoutMs`: 5 minutes by default, at most an hour.
- `maxOutputTokens`: the output's budget, 10,000 by default.

Agents save programs with the `save_program` tool, usually after trying the script with `codemode`. The version records
the session that saved it.

## Running one

`POST /v1/programs/{programId}/runs` takes `input`, and optionally `version` (the newest by default) and `mode`:

- `sync` (the default) answers `200` with the ended run, or `202` with the running run once `waitMs` has passed (30
  seconds by default, at most 60).
- `async` answers `202` at once.

A program that computes without calling a tool holds the deployment's stack object while it does, so no call is
answered until it stops computing: a `sync` call answers then even if `waitMs` has passed, and an `async` call's `202`
comes then too. Waiting on a tool, such as a slow `bash` command, holds nothing, and `waitMs` is kept.

A run's computation, over the whole program and not each stretch between tool calls, is capped by code mode's interrupt
budget. Past it the run fails with "Execution exceeded its interrupt budget"; `timeoutMs` doesn't raise it. The budget
is counted in work, not time: an empty loop reaches it in about 4 seconds, arithmetic-heavy code in much longer.

`GET /v1/programs/{programId}/runs/{runId}` gives the run's status, output, logs and error. A run waiting for a person
to approve a tool call says `waiting: "approval"`. `POST .../cancel` stops a running run.

A run is an ordinary session in the program's project, created as the caller. Its tool calls go through the project's
rules, approvals and audit, code mode's journal lets it survive a restart, and a person can open the session to read
what happened. Deleting a program or a version leaves its runs' sessions in place. The audit log records
`programs.program.created` and `removed`, `programs.version.created` and `removed`, and `programs.run.started` and
`ended`.

## Pausing for input or an agent

:::caution[Experimental]
Pauses are served only where the deployment also sets `KANTEL_PROGRAM_WAITS=on`. Without it a script has no
`waitForInput` or `agent`, and the `resume` and `steps` routes answer 404.
:::

A program can wait for a value that doesn't come from a tool:

- `await waitForInput({ prompt, key?, schema? })` (or `waitForInput(prompt)`) waits for a person, and returns the value
  they send.
- `await agent(prompt, { agentId?, title?, key?, schema? })` starts an agent session, of `agentId` or the project's default
  agent, as the run's caller, and returns its answer. With `schema`, the answer is parsed as JSON (a fenced `json` block
  counts) and checked. A version can start agents only when its `tools` include `agent`.

While it waits, the run's status is `waiting` and nothing runs: the run's session has stopped its turn, so a wait can
last hours, past any `waitMs`, and costs nothing. `waitingOn` lists what it waits on, one entry per wait, by `kind`:

```json
{
  "status": "waiting",
  "activation": 1,
  "waitingOn": [
    { "kind": "input", "id": "pwait_…", "key": "ship", "prompt": "Ship it?", "schema": { "type": "object" }, "since": 1793600000000 }
  ]
}
```

An `agent` entry also has `agentId` and, once started, the agent's `sessionId`. A running run whose session waits for a
person to allow a tool call has `{ "kind": "approval", "sessionId": … }` there, besides `waiting: "approval"`. More kinds
may come, so skip one you don't know.

`POST /v1/programs/{programId}/runs/{runId}/resume` with `{ "waitId": …, "value": … }` answers an `input` wait (`waitId`
may be left out when the run waits on one). The value is checked against the wait's `schema`. `{ "error": "…" }` instead
makes the program's `await` throw. `waitMs` (0 by default) waits for the resumed run. An `agent` wait resumes by itself
when its session answers.

A resumed run runs its script again from the top, as its next `activation`. Every tool call an earlier activation
finished, and every wait that has its value, returns what it returned before without running again; the first call
that isn't in the run's journal runs as usual. A call is matched by its tool, its arguments and how many such calls came
before it, so a program resumes correctly as long as it makes the same calls in the same order. `Math.random()` is
seeded by the run, so it returns the same numbers each activation; `Date.now()` is not, so don't choose calls by the
clock. A call result over 256 KB isn't kept, and runs again. A run resumes in another instance of the stack object just
the same: the journal and the waits are kept in its storage.

`GET /v1/programs/{programId}/runs/{runId}/steps` lists the journal: each call and wait, the activation that made it, and
`replays`, how many later activations took it from the journal instead of running it again. The audit log adds
`programs.wait.created` and `resolved`, `programs.run.waiting` and `resumed`, and `programs.step.replayed`.

`timeoutMs` and the interrupt budget apply to each activation. Cancelling a waiting run ends it, and stops the sessions of
the agent steps it waited on.

## Access

Viewer on the project reads programs and runs. Operator saves, deletes, runs and cancels them. An agent counts as
operator on its own session's project, so it can save programs there.

Every route, with its bodies and answers, is in the [programs reference](/api/reference/programs/).

<!-- Sources: apps/cloudflare/src/programs/service.ts:1-40, apps/cloudflare/src/programs/journal.ts:1-20, packages/api/src/programs-schema.ts:1-160, packages/api/src/program-routes.ts:1-30, apps/cloudflare/wrangler.jsonc:91-94, apps/cloudflare/src/codemode/serve.ts:20-30 -->
