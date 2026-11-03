---
title: Commands and files
description: Run a command in a sandbox and read its exit code and output, run long commands in the background, and read, write, list and delete the sandbox's files.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, and a control plane serves them only when it runs with `KANTEL_COMPUTE=experimental`. Their shapes may still change.
:::

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). Running commands needs a key with `exec`, and files need `files`. The sandbox must be running: a call to a stopped one answers `409` with `conflict`, so resume it first.

## Run a command

Send a command line. A microVM runs it with `bash -lc`, in the sandbox user's home, and an isolate runs it in its own shell. The call answers when the command ends:

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
| `timeoutMs` | How long to wait. Default 30,000 (30 seconds), at most 600,000 (10 minutes) |
| `detached` | Start it and answer at once. See [below](#long-commands-and-servers) |

A command still running at `timeoutMs` is killed, and the answer has `state: "timed_out"`. `stdout` and `stderr` each hold up to 1 MiB; when there was more, `truncated` is `true`. For big output, write it to a file in the command and [read the file](#read-a-file).

Commands are safe to retry with an `Idempotency-Key` header: a retry with the same key answers the first run and doesn't run it again.

## Long commands and servers

A detached command answers at once, in `state: "running"`, and runs with no time limit. Use it for a dev server, a long build or an agent's own loop:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/commands" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"command": "cd app && npm run dev -- --host 0.0.0.0 --port 3000", "detached": true}' | jq -r .id
```

Read it back by its ID for its state and its output so far, and kill it when you're done:

```ts
const server = await kantel.runCommand("sbx_4kq9x2mt", {
	command: "cd app && npm run dev -- --host 0.0.0.0 --port 3000",
	detached: true,
});
const now = await kantel.getCommand("sbx_4kq9x2mt", server.id);
console.log(now.state, now.stdout);
await kantel.killCommand("sbx_4kq9x2mt", server.id); // state: "killed"
```

Killing a command that has already ended answers it as it is. A stop ends every running command, so after a resume from a stop, start your servers again. A paused sandbox's programs carry on when it resumes.

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

Files are read up to 1 MiB. For a bigger one, compress or split it with a command, or copy it over [SSH](/sandboxes/ssh/).

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

<!-- Sources (712a09ae): packages/api/src/compute-routes.ts:509-620, packages/api/src/compute-schema.ts:506-613 -->
