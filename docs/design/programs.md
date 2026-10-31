# Saved programs (Workflow 2.0, experimental)

Status: experimental, behind `KANTEL_PROGRAMS=on` (needs code mode). TASK-4326.

## What

A **program** is a code mode script an agent (or a person) saved under a name in a project. It runs through the API
with **no model in the loop**: `POST /v1/programs/{id}/runs` with an input, answered with the output, synchronously or
by polling. Each save is a new immutable **version**, numbered from 1 and never reused.

```
POST   /v1/programs                              save a new program and its v1
GET    /v1/programs?projectId=                   list
GET    /v1/programs/{id}                         get
DELETE /v1/programs/{id}                         delete, with its versions (runs' sessions stay)
GET    /v1/programs/{id}/versions                list versions
POST   /v1/programs/{id}/versions                save the next version
GET    /v1/programs/{id}/versions/{n}            get one
DELETE /v1/programs/{id}/versions/{n}            delete one (it can't run again)
POST   /v1/programs/{id}/runs                    run: {input, version?, mode: sync|async, waitMs?}; 200 ended, 202 running
GET    /v1/programs/{id}/runs                    the newest 100 runs
GET    /v1/programs/{id}/runs/{runId}            status, output, logs, error, waiting: "approval"
POST   /v1/programs/{id}/runs/{runId}/cancel     stop a running run
```

A version holds `code` (an async function body: `input` is the run's input, `await tools.<name>(args)` calls a tool,
the returned JSON value is the output), optional `inputSchema` and `outputSchema` (JSON Schema, checked before the
run and after it), `tools` (the allowlist), `timeoutMs` (default 5 minutes, at most an hour) and `maxOutputTokens`.

Agents save with the `save_program` tool after trying the script with `codemode`. The version records the session.

## How

Nothing new executes code. The design reuses what a session already guarantees.

- **A version is an agent profile**: `program-<id>-v<n>` in the program's project, with tools `codemode` plus the
  version's `tools` and nothing else, and the model route `kantel-program`. The allowlist is enforced the way any
  profile's is: code mode only reaches tools the conversation has enabled.
- **A run is a session** of that profile, created and prompted as the API caller. Its "model" is the program runner
  (`src/programs/runner-model.ts`), a scripted provider that calls `codemode` with the program, wrapped with its input
  and an `// @options` line carrying the budget, and answers with the output as JSON. No gateway call and no tokens.
- So a run gets, unchanged: code mode's durable journal and replay (a run survives the stack object restarting), the
  project's tool rules and Ask approvals (a run waiting on one reports `waiting: "approval"`), the audit trail of
  every tool call, the transcript, and stopping (cancel aborts the session's run).
- Programs, versions and runs are rows in the stack's D1 (`programs`, `program_versions`, `program_runs`). A run's
  status is settled from its session's result when the call waits, in the background, or on the next read.
- Audit: `programs.program.created|removed`, `programs.version.created|removed`, `programs.run.started|ended`
  (source `programs`), besides the run session's own events.

## Access

Viewer on the project reads programs and runs; operator saves, deletes, runs and cancels. An agent counts as operator
on its own session's project, so it can save programs there. A program can't be given `codemode`, `subagent` or
`save_program`.

## Not yet

Triggers and schedules, a console page, credentials or secrets passed in as inputs, rollback by pointer (run an older
version with `version`), `agent()`/model steps and human input inside a program, per-run cost budgets, pagination,
and evals. See the TASK-4326 note for the gap analysis against Lleverage's Workflow 2.0.
