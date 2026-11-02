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

## Access

Viewer on the project reads programs and runs. Operator saves, deletes, runs and cancels them. An agent counts as
operator on its own session's project, so it can save programs there.

Every route, with its bodies and answers, is in the [programs reference](/api/reference/programs/).

<!-- Sources: apps/cloudflare/src/programs/service.ts:1-40, packages/api/src/programs-schema.ts:1-160, packages/api/src/program-routes.ts:1-30, apps/cloudflare/wrangler.jsonc:91-94, apps/cloudflare/src/codemode/serve.ts:20-30 -->
