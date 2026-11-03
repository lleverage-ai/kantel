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

## Codex

```sh
codex mcp add kantel --env KANTEL_URL=http://127.0.0.1:58090 --env KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp
```

Or add it to `~/.codex/config.toml` yourself, with the key's secret in place of `ksk_...`:

```toml
[mcp_servers.kantel]
command = "kantel"
args = ["mcp"]
env = { KANTEL_URL = "http://127.0.0.1:58090", KANTEL_API_KEY = "ksk_..." }
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

pi doesn't take MCP servers. It uses the `kantel` command through its shell instead: see [Use from your coding agent](/coding-agents/#pi-and-the-kantel-command).

## Tools

| Tool | What it does |
| --- | --- |
| `sandbox_create` | Make a sandbox and wait until it runs. An isolate unless `type` is `microvm`; `from` starts it from a snapshot |
| `sandbox_list`, `sandbox_get` | The account's sandboxes, or one with its state, capabilities and cost |
| `sandbox_stop`, `sandbox_resume` | Stop one, keeping its disk (`pause` keeps a microVM's memory too), and bring it back |
| `sandbox_fork` | Copies of a sandbox, `count` at a time |
| `sandbox_delete` | Delete one for good. An `agent` key isn't allowed to |
| `sandbox_exec` | Run a command line and wait for it: its exit code, stdout and stderr, each cut to about 64 KiB |
| `file_read`, `file_write`, `file_list` | A sandbox's files, up to 1 MiB each, as text or base64 |
| `port_expose` | An HTTPS URL for a port in the sandbox |
| `snapshot_save`, `snapshot_list` | Save a sandbox's state under a name, and list saved snapshots or one sandbox's history |
| `browser_open`, `desktop_open` | URLs to watch and drive a microVM's browser or desktop, and the browser's CDP URL |

When Kantel refuses a call, such as `sandbox_delete` with an `agent` key or `browser_open` on an isolate, the tool answers with Kantel's error code and message rather than failing, so the agent can read what went wrong and try something else.

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
