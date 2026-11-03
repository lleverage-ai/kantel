# kantel

Kantel's command line and MCP server: make sandboxes, run commands in them, move files, expose ports, take snapshots
and manage API keys from a terminal, a script or a coding agent.

```sh
npx kantel login --url https://kantel.example     # approve it in the browser
npx kantel new --type microvm
npx kantel push sbx_4kq9x2mt .
npx kantel exec sbx_4kq9x2mt -- 'cd my-app && npm test'
npx kantel stop sbx_4kq9x2mt
```

Operating a self-hosted Kantel (install, upgrade, hosts) is `npx @kantel/admin`, in `packages/admin`.

It needs Node 22 or later. In this repository the package is `@kantel/cli`; it is published to npm as `kantel`.

## Signing in

The CLI needs Kantel's URL and an API key (`ksk_…`). It takes each from the first of:

1. flags: `--url`, `--key` (or `--api-key`) and `--account <id>`;
2. the environment: `KANTEL_URL`, `KANTEL_API_KEY` and `KANTEL_ACCOUNT`;
3. `${XDG_CONFIG_HOME:-~/.config}/kantel/config.json`, which `kantel login` writes, readable by you only.

The URL may be given with or without `/v1`; it defaults to `http://127.0.0.1:58090`, a local install.

```sh
npx kantel login --url https://kantel.example                     # the browser sign-in
printf %s "$KEY" | npx kantel login --key-stdin --url https://…  # or a key you have
npx kantel whoami
npx kantel logout
```

The browser sign-in is RFC 8628's device flow (`POST /v1/auth/device`): it prints a code, opens
`/compute/device?code=…` in the console, and polls until a signed-in person approves it there, which hands the CLI a
new 90-day API key named `kantel on <host>`. A code waiting for approval is kept in `login-pending.json` beside the
config, so running `kantel login` again shows the same one; with no terminal it prints the code and stops, and
`kantel login --wait` waits for it. `kantel login` checks the key before it saves it.

## Commands

`npx kantel help` lists them all, and `npx kantel help <command>` (or `--help` on any command) shows a command's
flags. Every command takes `--json` to print Kantel's answer as it is, for scripts.

| Command | What it does |
| --- | --- |
| `new [--type isolate\|microvm] [--size] [--name] [--from <snapshot>] [--image] [--auto-stop <min>] [--label k=v]… [--env K=V]… [--host <port>]… [--no-wait]` | Create a sandbox and wait until it runs |
| `list [--all]`, `info <id>` | List and show sandboxes |
| `start\|stop\|resume\|recover <id>` | Its lifecycle; `stop --pause` keeps a microVM's memory |
| `fork <id> [--count N]` | Copy it into new sandboxes |
| `delete <id> --yes` | Delete it for good: it refuses without `--yes` |
| `extend <id> <minutes>`, `usage <id>` | Move its auto-stop; its running time and cost |
| `exec <id> [--cwd] [--env K=V]… [--timeout <s>] [-d] [--] <command…>` | Run a command; its output and exit code are kantel's |
| `attach <id> <cmd>`, `ps <id>`, `kill <id> <cmd>` | Follow, list and stop detached commands |
| `scp [-r] <from> <to>`, `push <id> [dir]` | Copy files; `<id>:<path>` is the sandbox's side, and push sends what git would commit |
| `files ls\|cat\|put\|get\|rm …` | A sandbox's files, up to 1 MiB each |
| `host <id> <port> [--public]`, `port list\|hide …` | HTTPS URLs for a sandbox's ports |
| `ssh <id> [--exec]`, `desktop <id>`, `browser <id>` | SSH, desktop and browser access to a microVM |
| `snapshot list\|take\|save\|files\|rm …` | Snapshots, and saved snapshots to start sandboxes from |
| `key list\|create\|rotate\|revoke …` | Scoped API keys; a new key's secret is shown once |
| `org list\|create\|join …`, `webhook …`, `events`, `telemetry …` | Accounts, webhooks, events and OpenTelemetry |
| `init [--global] [--for claude\|codex\|pi]` | AGENTS.md, CLAUDE.md and the kantel skill for coding agents |
| `mcp` | The MCP server on stdio |
| `agents [claude\|codex\|pi\|cursor\|all] [--write]` | MCP setup for coding agents |

`ls` is short for `list` and `rm` for `delete`, and the first CLI's `sandbox …` spellings (`sandbox create`,
`sandbox get`, `sb ls`) still work. `host list` and `host join-token` moved to `@kantel/admin`.

With `exec`, one word is a shell command line (`kantel exec <id> 'make && make test'`); several are a command and
its arguments, quoted for the shell. Its stdout and stderr come out on kantel's, and kantel exits with its exit code
(124 when it timed out). `--timeout 0` runs it detached and follows its output with no time limit. A Kantel error
prints `kantel: <code>: <message>` on stderr and exits 1.

`scp` and `push` use the files API, which moves 1 MiB a call; a bigger file goes in 768 KiB parts joined by a command
in the sandbox (and comes out in 512 KiB parts read by one), so those need a microVM.

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

pi has no MCP: it uses the CLI. `npx kantel init` puts a block in `./AGENTS.md` and `./CLAUDE.md` (between
`<!-- kantel:start -->` and `<!-- kantel:end -->`, replacing an old one) and a `kantel` skill in
`.agents/skills/kantel/` and `.claude/skills/kantel/`, which tell an agent to create a sandbox with
`npx kantel new --json`, run commands with `npx kantel exec <id> -- <cmd>`, push code and stop it.
(`npx kantel agents --write` writes the AGENTS.md block alone.)

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
