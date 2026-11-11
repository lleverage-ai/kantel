---
title: MCP server
description: Connect Claude Code, Codex, Cursor or any MCP client to Kantel with kantel mcp, the tools it offers, and what an agent's key lets it do.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The MCP server calls Kantel's compute API, which every control plane serves. Its tools may still change.
:::

`kantel mcp` is an [MCP](https://modelcontextprotocol.io/) server that gives a coding agent tools to make sandboxes, run commands and move files in them, open their ports and browsers, and save snapshots. It's part of the [`kantel` command](/tools/cli/): the agent's client starts it and talks to it over stdin and stdout, and it calls your control plane with the key in its environment.

## Before you start

1. [Install the `kantel` command](/tools/cli/#install-it), so `kantel` is on your `PATH`.
2. Make the agent a key of its own with the `agent` preset. It can make, drive, stop and snapshot sandboxes, but can't delete them or change your account:

   ```sh
   kantel key create agent --preset agent
   ```

   It prints the key's secret once. Put it in `KANTEL_API_KEY` for the commands below:

   ```sh
   export KANTEL_API_KEY=ksk_...
   ```

In the commands below, put your control plane's address in place of `http://127.0.0.1:58090`. `kantel agents` prints the same setup with the address you're signed in to filled in, and never with a key in it. Each starts `kantel` by name, so it needs `kantel` on the `PATH` the client starts it with, not `npx kantel`: the command isn't on npm. If `kantel` isn't on your `PATH`, `kantel agents` says so and prints the setup with its full path instead.

## Claude Code

```sh
claude mcp add kantel -e KANTEL_URL=http://127.0.0.1:58090 -e KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp
```

That adds it for the project you're in. To have it in every project, start with `claude mcp add --scope user kantel` instead. `claude mcp list` shows whether it connects.

Claude Code waits for a tool call as long as `MCP_TOOL_TIMEOUT` says, which is about 28 hours when it isn't set, so Kantel's longest waits fit. If you've set it lower, give Kantel its own limit: add `"timeout": 660000` (milliseconds) to the `kantel` entry in `~/.claude.json` or `.mcp.json`.

## Codex

```sh
codex mcp add kantel --env KANTEL_URL=http://127.0.0.1:58090 --env KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp
```

Codex gives a tool call 60 seconds unless told otherwise, and a Kantel tool can wait up to 10 minutes. `codex mcp add` has no flag for it, so add `tool_timeout_sec = 660` under `[mcp_servers.kantel]` in `~/.codex/config.toml`. Or add all of it there yourself, with the key's secret in place of `ksk_...`:

```toml
[mcp_servers.kantel]
command = "kantel"
args = ["mcp"]
env = { KANTEL_URL = "http://127.0.0.1:58090", KANTEL_API_KEY = "ksk_..." }
tool_timeout_sec = 660
```

## Cursor and other clients

Most MCP clients take a JSON entry like this one. For Cursor it goes in `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "kantel": {
      "command": "kantel",
      "args": ["mcp"],
      "env": { "KANTEL_URL": "http://127.0.0.1:58090", "KANTEL_API_KEY": "ksk_..." }
    }
  }
}
```

If your client has a tool timeout, make it at least 660 seconds.

pi doesn't take MCP servers. It uses the `kantel` command through its shell instead: see [Use from your coding agent](/coding-agents/#pi-and-the-kantel-command).

## Tools

| Tool | What it does |
| --- | --- |
| `sandbox_create` | Make a sandbox and wait until it runs. The agent chooses `type`, `isolate` or `microvm`, and the tool's description says when each fits; `from` starts it from a snapshot, whose type it takes |
| `sandbox_list`, `sandbox_get` | The account's sandboxes, or one with its state, capabilities and cost |
| `sandbox_stop`, `sandbox_resume` | Stop one, keeping its disk (`pause` keeps a microVM's memory too), and bring it back |
| `sandbox_fork` | Copies of a sandbox, `count` at a time |
| `sandbox_delete` | Delete one for good. An `agent` key isn't allowed to |
| `sandbox_exec` | Run a command line and wait for it: its exit code, stdout and stderr, each cut to about 64 KiB. With `detached`, start it and answer its ID at once |
| `command_get`, `command_list`, `command_kill` | A command's state and output, waiting up to `waitMs` for it to end; a sandbox's commands, a page at a time with `cursor`; mark one killed |
| `file_read`, `file_write`, `file_list` | A sandbox's files, up to 1 MiB each, as text or base64 |
| `port_expose` | An HTTPS URL for a port in the sandbox |
| `snapshot_save`, `snapshot_list` | Save a sandbox's state under a name, and list saved snapshots or one sandbox's history |
| `browser_open`, `desktop_open` | URLs to watch and drive a microVM's browser or desktop, and the browser's CDP URL |

When Kantel refuses a call, such as `sandbox_delete` with an `agent` key or `browser_open` on an isolate, the tool answers with Kantel's error code and message rather than failing, so the agent can read what went wrong and try something else.

## Long calls

`sandbox_exec` waits up to its `timeoutMs`: 30 seconds unless the agent asks for more, and at most 10 minutes, after which the command is killed. `sandbox_create`, `sandbox_fork` and `sandbox_resume` wait until the sandbox runs, `sandbox_stop` with `wait` until it has stopped, and `snapshot_save` until the snapshot is saved.

While a call waits, the server sends the client a progress notification every 15 seconds if the request asked for them with a progress token. Claude Code counts these against its idle timeout, but not its tool timeout. When the client cancels a call, the server stops waiting and sends no answer. What it started carries on: a command runs to its own timeout.

For a command that might outlast the client's tool timeout, the agent runs `sandbox_exec` with `detached`, which answers the command's ID at once. `command_get` with `waitMs` then waits up to that long for it to end, and answers its exit code and output. If it's still running, the answer says so and tells the agent to call `command_get` again. `command_list` finds a command whose call the client gave up on.

A detached command has no time limit unless `sandbox_exec` gives it a `timeoutMs`, and `command_kill` stops it and every process it started. On a host whose kantel-host predates `exec-control`, the old limits still apply: a detached command ends after about 2 minutes on a microVM, and `command_kill` only marks it killed, so end it with `sandbox_exec` too, such as `pkill -f`. The command's stderr says when that happened. An isolate runs a command for at most 30 seconds unless its `timeoutMs` says otherwise, detached or not.

## Check it by hand

The server speaks newline-delimited JSON-RPC on stdin and stdout, so you can try it without an agent:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | KANTEL_URL=http://127.0.0.1:58090 kantel mcp | jq -r 'select(.id == 2) | .result.tools[].name'
```

It prints the tool names above. A wrong key shows up only when a tool runs: the tool answers `unauthenticated`.

<!-- Sources (99a1829a): packages/cli/src/mcp.ts, packages/cli/src/agents.ts, packages/cli/README.md; tools/list and tools/call run against packages/compute/src/serve.ts -->
