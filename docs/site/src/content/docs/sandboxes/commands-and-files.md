---
title: Commands and files
description: Run a command in a sandbox and read its exit code and output, run long commands in the background, and read, write, list and delete the sandbox's files.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). Running commands needs a key with `exec`, and files need `files`. The sandbox must be running: a call made while it starts waits for it, and a call to a stopped one answers `409`, so resume it first. See [When the sandbox isn't running](#when-the-sandbox-isnt-running).

## Run a command

Send a command line. A microVM runs it with `bash -lc`, in the sandbox user's home (`/home/user`), and an isolate runs it in its own shell, in `/workspace`. A relative `cwd` or file path starts from the same place. The call answers when the command ends:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/commands" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"command": "cd app && npm test", "timeoutMs": 120000}' | jq '{state, exitCode, stdout}'
```

```ts
const run = await kantel.runCommand("sbx_4kq9x2mt", { command: "cd app && npm test", timeoutMs: 120_000 });
if (run.exitCode !== 0) console.error(run.stderr);
```

The answer is a [Command](/api/reference/types/#command):

```json
{
  "id": "cmd_9a8b7c",
  "sandboxId": "sbx_4kq9x2mt",
  "command": "cd app && npm test",
  "state": "exited",
  "exitCode": 0,
  "stdout": "Tests: 42 passed, 42 total\n",
  "stderr": "",
  "truncated": false,
  "startedAt": 1793660400000,
  "endedAt": 1793660431200,
  "durationMs": 31200
}
```

Check `exitCode`, not the HTTP status: a command that fails still answers `200`, with its own exit code. Beside `command`, the body takes:

| Field | What it does |
| --- | --- |
| `cwd` | The directory to run in. Default the sandbox user's home |
| `env` | More environment variables, for this command only |
| `stdin` | Text to send to its standard input |
| `timeoutMs` | How long to wait. Default 30,000 (30 seconds), at most 600,000 (10 minutes). A detached command has no limit unless you give one |
| `detached` | Start it and answer at once. See [below](#long-commands-and-servers) |

A command still running at `timeoutMs` is killed, and the answer has `state: "timed_out"`. `stdout` and `stderr` each hold up to 1 MiB; when there was more, `truncated` is `true`. For big output, write it to a file in the command and [read the file](#read-a-file).

Commands are safe to retry with an `Idempotency-Key` header: a retry with the same key answers the first run and doesn't run it again, detached or not. The same key with another command is `422` with `refused`. If the first call failed part way or stopped answering, the command may have run: a retry with the same key is `409` `conflict` with `details.idempotencyKey: "held"`, and doesn't run it. List the sandbox's commands to see, then use a new key. Without a key, a retry that reached Kantel the first time runs the command twice, so send one with anything that isn't safe to run twice. The `kantel` CLI and its MCP server send one with every command. See [Safe retries](/api/reference/#safe-retries).

Writing a file needs no key: writing the same content again leaves the same file.

## Long commands and servers

A detached command answers at once, in `state: "running"`, and runs with no time limit unless you give it a `timeoutMs`. Use it for a dev server, a long build or an agent's own loop:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/commands" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"command": "cd app && npm run dev -- --host 0.0.0.0 --port 3000", "detached": true}' | jq -r .id
```

Read it back by its ID for its state, its output so far while it runs (on a microVM, for any command, detached or not), and once it has ended its exit code and output (up to 1 MiB of each stream, as for any command). Kill it when you're done:

```ts
const server = await kantel.runCommand("sbx_4kq9x2mt", {
	command: "cd app && npm run dev -- --host 0.0.0.0 --port 3000",
	detached: true,
});
const now = await kantel.getCommand("sbx_4kq9x2mt", server.id);
console.log(now.state, now.stdout);
await kantel.killCommand("sbx_4kq9x2mt", server.id); // state: "killed"
```

A kill ends the command and every process it started. Killing a command that has already ended answers it as it is. A stop ends every running command, so after a resume from a stop, start your servers again. A paused sandbox's programs carry on when it resumes.

A detached command doesn't keep its sandbox running: the sandbox still stops at its `stopsAt` (see [auto-stop](/sandboxes/lifecycle/#auto-stop-and-extending)), so give a long job a sandbox with a later stop time, or none.

An isolate on a kantel-host runs a command in its own shell rather than as a process, so a command there stops after 30 seconds unless its `timeoutMs` says otherwise, detached or not.

On a self-hosted host, detached commands with no limit and kills that stop the process need a kantel-host that has them. On an older one, a detached command still stops at that host's own limit (2 minutes on a microVM), and a kill marks the command killed but can't stop its process. The command's `stderr` says so in either case. Upgrade the host's kantel-host to fix both.

## Command history

A sandbox keeps its commands, newest first, and you can list them while it's stopped too:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/commands?limit=10" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {id, command, state, exitCode}'
```

## Read a file

Give a path, absolute or relative to the user's home. A file comes back as UTF-8 text, or as base64 with `encoding=base64` for binary files:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/files?path=app/package.json" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq -r .content
```

```ts
const file = await kantel.readFile("sbx_4kq9x2mt", { path: "app/package.json" });
const image = await kantel.readFile("sbx_4kq9x2mt", { path: "app/screenshot.png", encoding: "base64" });
const bytes = Buffer.from(image.content, "base64");
```

One read answers at most 1 MiB. Read a bigger file in parts with `offset` (the byte to start at) and `length` (at most 1048576): `size` in the answer is the whole file's, and `offset` where the part starts, so read again from `offset` plus the part's length until you reach `size`. Use `encoding=base64` for parts, as a cut can fall inside a UTF-8 character:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/files?path=out.tar.gz&encoding=base64&offset=1048576&length=1048576" \
  -H "Authorization: Bearer $KANTEL_API_KEY"
```

`kantel scp` and `kantel files get` read a big file this way for you.

## Write a file

A write makes the file's directories and replaces anything already at the path. Set `mode` for its permissions:

```sh
curl -s -X PUT "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/files" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"path": "bin/setup.sh", "content": "#!/bin/sh\nnpm ci\n", "mode": "0755"}'
```

```ts
await kantel.writeFile("sbx_4kq9x2mt", { path: "bin/setup.sh", content: "#!/bin/sh\nnpm ci\n", mode: "0755" });
```

To write bytes, send them as base64 with `"encoding": "base64"`.

## List a directory

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/files/list?path=app" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {name, kind, size}'
```

Each entry is a `file`, `directory` or `symlink`, with its size and when it changed. Leave `path` out for the user's home. Long directories come in pages, like the sandbox list.

## Delete a file

A delete takes a file, or a directory and everything in it:

```sh
curl -s -X DELETE "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/files?path=app/node_modules" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

It answers `204` with no body.

## Files in a stopped sandbox

The file routes need a running sandbox. To read files from a stopped one without resuming it, read them from its newest snapshot: see [Browse a snapshot's files](/snapshots/history/#browse-a-snapshots-files).

## When the sandbox isn't running

Commands, files, ports, file URLs and archives need a running sandbox.

A call made while the sandbox is `starting`, such as a command sent straight after `resumeSandbox` with `"wait": false`, waits for it to run, then goes on as usual. The wait is up to 60 seconds and doesn't count against the command's `timeoutMs`. If the start fails, the call answers as for a sandbox in `error`. If the sandbox is still starting after 60 seconds, the call answers `409` with `sandbox_starting`: send it again.

Kantel never resumes a sandbox for such a call. Auto-stop is a lifetime from the sandbox's start, not idleness, so a call that resumed it would undo the stop you set. An [idle stop](/sandboxes/lifecycle/#idle-stop) has its own `stopReason`, `idle-stop`, and isn't resumed by a call either. A call to a sandbox that is `stopped`, `paused`, `stopping` or in `error` answers `409` `conflict`. Its `details` are a [SandboxNotRunning](/api/reference/types/#sandboxnotrunning): a stable `code`, the sandbox's `state`, the `stopReason` where Kantel recorded why it stopped, and a `hint`:

```json
{
  "error": {
    "code": "conflict",
    "message": "The sandbox is stopped (auto-stop); resume it first",
    "details": {
      "code": "sandbox_stopped",
      "sandboxId": "sbx_4kq9x2mt",
      "state": "stopped",
      "stopReason": "auto-stop",
      "hint": "Resume it with kantel resume sbx_4kq9x2mt or POST /v1/sandboxes/sbx_4kq9x2mt/resume, then try again"
    }
  }
}
```

| `details.code` | The sandbox is | What to do |
| --- | --- | --- |
| `sandbox_starting` | still starting after the call waited 60 seconds | Send the call again |
| `sandbox_stopping` | stopping | Once it has stopped, resume it |
| `sandbox_stopped` | stopped | Resume it |
| `sandbox_paused` | paused | Resume it |
| `sandbox_error` | in `error`: its start or its last operation failed | Resume it, or recover it |
| `sandbox_deleting` | being deleted | Use another sandbox |

`stopReason` is `auto-stop` when the sandbox reached its stop time, the rule's reason when Kantel stopped it, such as egress it couldn't apply, or what failed for a sandbox in `error`. A stop someone asked for has no `stopReason`. It is the sandbox's own `reason`, and not `details.reason`, which only a sandbox that can't be placed has. To resume, call `POST /v1/sandboxes/{sandboxId}/resume` (`resumeSandbox`) or run `kantel resume <id>`, then send the call again. In the SDK, the error is a `KantelApiError` with the details in `error.details`:

```ts
import { KantelApiError, type SandboxNotRunning } from "@kantel/api/sdk";

try {
  await kantel.runCommand("sbx_4kq9x2mt", { command: "npm test" });
} catch (error) {
  const details = error instanceof KantelApiError ? (error.details as SandboxNotRunning | undefined) : undefined;
  if (details?.code === "sandbox_stopped" || details?.code === "sandbox_paused") {
    await kantel.resumeSandbox("sbx_4kq9x2mt", { wait: true });
    await kantel.runCommand("sbx_4kq9x2mt", { command: "npm test" });
  } else throw error;
}
```

`kantel exec` and the other CLI commands print the error and, on the next line, what to run, such as `Resume it with: kantel resume sbx_4kq9x2mt`.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:509-620, packages/api/src/compute-schema.ts:506-613; not-running calls: packages/compute/src/not-running.ts, packages/compute/src/service.ts requireRunning -->
