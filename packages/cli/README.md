# kantel

Kantel's command line and MCP server: make sandboxes, run commands in them, move files, expose ports, take snapshots
and manage API keys from a terminal, a script or a coding agent.

```sh
npx kantel login --url https://kantel.example < key.txt
npx kantel sandbox create
npx kantel exec sbx_4kq9x2mt -- uname -a
npx kantel sandbox stop sbx_4kq9x2mt
```

It needs Node 22 or later. In this repository the package is `@kantel/cli`; it is published to npm as `kantel`.

## Signing in

The CLI needs Kantel's URL and an API key (`ksk_…`). It takes each from the first of:

1. flags: `--url`, `--key` (or `--api-key`) and `--account <id>`;
2. the environment: `KANTEL_URL`, `KANTEL_API_KEY` and `KANTEL_ACCOUNT`;
3. `${XDG_CONFIG_HOME:-~/.config}/kantel/config.json`, which `kantel login` writes, readable by you only.

The URL may be given with or without `/v1`; it defaults to `http://127.0.0.1:58090`, a local install.

```sh
npx kantel login --url https://kantel.example --key ksk_…   # or pipe the key in, to keep it out of your history
npx kantel whoami
npx kantel logout
```

`kantel login` checks the key before it saves it.

## Commands

`npx kantel help` lists them all, and `npx kantel help <command>` (or `--help` on any command) shows a command's
flags. Every command takes `--json` to print Kantel's answer as it is, for scripts.

| Command | What it does |
| --- | --- |
| `sandbox create [--type isolate\|microvm] [--size] [--name] [--from <snapshot>] [--image] [--auto-stop <min>] [--label k=v]… [--no-wait]` | Create a sandbox and wait until it runs |
| `sandbox list [--all]`, `sandbox get <id>` | List and show sandboxes |
| `sandbox start\|stop\|resume\|recover <id>` | Its lifecycle; `stop --pause` keeps a microVM's memory |
| `sandbox fork <id> [--count N]` | Copy it into new sandboxes |
| `sandbox delete <id> --yes` | Delete it for good: it refuses without `--yes` |
| `sandbox extend <id> <minutes>`, `sandbox usage <id>` | Move its auto-stop; its running time and cost |
| `exec <id> [--cwd] [--env K=V]… [--timeout <ms>] [--detach] -- <command…>` | Run a command; its output and exit code are kantel's |
| `files ls\|cat\|put\|get\|rm …` | A sandbox's files, up to 1 MiB each |
| `port expose\|list\|hide …` | HTTPS URLs for a sandbox's ports |
| `ssh <id> [--exec]`, `desktop <id>`, `browser <id>` | SSH, desktop and browser access to a microVM |
| `snapshot list\|take\|save\|files\|rm …` | Snapshots, and saved snapshots to start sandboxes from |
| `key list\|create\|rotate\|revoke …` | Scoped API keys; a new key's secret is shown once |
| `org list\|create\|join …`, `webhook …`, `events`, `telemetry …`, `host …` | Accounts, webhooks, events, OpenTelemetry and hosts |
| `mcp` | The MCP server on stdio |
| `agents [claude\|codex\|pi\|cursor\|all] [--write]` | Setup for coding agents |

`sb` is short for `sandbox`, `ls` for `list` and `rm` for `delete`.

With `exec`, one word after `--` is a shell command line (`kantel exec <id> -- 'make && make test'`); several are a
command and its arguments, quoted for the shell. Its stdout and stderr come out on kantel's, and kantel exits with
its exit code (124 when it timed out). A Kantel error prints `kantel: <code>: <message>` on stderr and exits 1.

## Coding agents

Give the agent its own scoped key, which can make and drive sandboxes but not delete them or manage the account, and
put its secret in `KANTEL_API_KEY`:

```sh
npx kantel key create agent --preset agent
export KANTEL_API_KEY=<the secret>
```

Then, with your Kantel's URL in place of `https://kantel.example` (`npx kantel agents` prints these with it filled in):

Claude Code:

```sh
claude mcp add kantel -e KANTEL_URL=https://kantel.example -e KANTEL_API_KEY=$KANTEL_API_KEY -- npx -y kantel mcp
```

Codex:

```sh
codex mcp add kantel --env KANTEL_URL=https://kantel.example --env KANTEL_API_KEY=$KANTEL_API_KEY -- npx -y kantel mcp
```

or in `~/.codex/config.toml`, with the key in place of `$KANTEL_API_KEY`:

```toml
[mcp_servers.kantel]
command = "npx"
args = ["-y", "kantel", "mcp"]
env = { KANTEL_URL = "https://kantel.example", KANTEL_API_KEY = "$KANTEL_API_KEY" }
```

Cursor (`.cursor/mcp.json`) and other MCP clients, with the key in place of `$KANTEL_API_KEY`:

```json
{
  "mcpServers": {
    "kantel": {
      "command": "npx",
      "args": ["-y", "kantel", "mcp"],
      "env": { "KANTEL_URL": "https://kantel.example", "KANTEL_API_KEY": "$KANTEL_API_KEY" }
    }
  }
}
```

pi has no MCP: it uses the CLI. `npx kantel agents --write` puts a block in `./AGENTS.md` (between
`<!-- kantel:start -->` and `<!-- kantel:end -->`, replacing an old one) that tells it to create a sandbox with
`npx kantel sandbox create --json`, run commands with `npx kantel exec <id> -- <cmd>` and stop it with
`npx kantel sandbox stop <id>`. Start pi with `KANTEL_URL` and `KANTEL_API_KEY` set.

`kantel agents` never prints a key you have: every snippet carries the `$KANTEL_API_KEY` placeholder.

### The MCP server

`kantel mcp` speaks MCP over stdio (newline-delimited JSON-RPC 2.0, protocol revisions 2025-06-18, 2025-03-26 and
2024-11-05). Its tools: `sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_stop`, `sandbox_resume`,
`sandbox_fork`, `sandbox_delete`, `sandbox_exec` (each output cut to about 64 KiB), `file_read`, `file_write`,
`file_list`, `port_expose`, `snapshot_save`, `snapshot_list`, `browser_open` and `desktop_open`. An error Kantel
answers comes back as a tool result with `isError`, for the agent to read.

## From code

```ts
import { createMcpServer, run } from "@kantel/cli";

const exitCode = await run(["sandbox", "list", "--json"], { env: { KANTEL_URL: "…", KANTEL_API_KEY: "…" } });
```

## Building

`pnpm --filter @kantel/cli build` bundles the CLI, with the SDK, into `dist/kantel.js` and writes `dist/package.json`
for the `kantel` package.
