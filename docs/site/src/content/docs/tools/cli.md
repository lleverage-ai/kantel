---
title: Command line
description: Install the kantel command, sign in with an API key, and make, drive, snapshot and stop sandboxes from a terminal or a script, with every command by group.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The `kantel` command calls routes a control plane serves only when it runs with `KANTEL_COMPUTE=experimental`. Its commands and their output may still change.
:::

`kantel` does from a terminal what the [API](/api/reference/) does over HTTP: make a sandbox, run commands in it, move files in and out, open its ports, SSH, desktop and browser, take snapshots, and manage keys, webhooks and organisations. Every command can print Kantel's JSON answer instead of a table, for scripts. The same program is Kantel's [MCP server](/tools/mcp-server/).

## Install it

It needs Node.js 22 or later, and [pnpm](https://pnpm.io/) 10 to build it (`npm install -g pnpm@10` if you don't have it). The command isn't on npm yet, so build it from Kantel's repository and install the result:

```sh
git clone https://github.com/lleverage-ai/kantel.git
cd kantel
pnpm install --frozen-lockfile --filter '@kantel/cli...'
pnpm --filter @kantel/cli build
npm install -g ./packages/cli/dist
kantel version
```

The build writes one file, `packages/cli/dist/kantel.js`, with everything it needs inside it. `npm install -g` links that folder onto your `PATH` as `kantel`, so keep the clone. To update it, run `git pull` and the build again.

## Sign in

The command needs your control plane's address and a [scoped API key](/accounts/api-keys/). `kantel login` checks the key and saves both, so the commands after it don't need them. Pipe the key in to keep it out of your shell's history:

```sh
printf '%s\n' "$KANTEL_API_KEY" | kantel login --url http://127.0.0.1:58090
kantel whoami
```

```
url          http://127.0.0.1:58090
user         admin <admin@localhost>
key          bootstrap (key_2036krxcay): sandboxes:read, sandboxes:write, sandboxes:delete, exec, files, ...
account      acc_8w3zkfuz4d
accounts     acc_8w3zkfuz4d (personal, owner)
mode         selfhosted
super-admin  yes
```

It saves them in `~/.config/kantel/config.json` (under `$XDG_CONFIG_HOME` if you set it), which only you can read. `kantel logout` removes the saved key.

Each setting comes from the first place that has it:

1. a flag: `--url`, `--key` and `--account`;
2. the environment: `KANTEL_URL`, `KANTEL_API_KEY` and `KANTEL_ACCOUNT`;
3. the saved file.

Without any of them, the address is `http://127.0.0.1:58090`, a self-hosted install on the same machine. A key always acts in the account it was made in, which `whoami` shows.

## A first sandbox

```sh
kantel sandbox create --type microvm --name fix-login-bug --label ticket=PROJ-12
```

```
Created sbx_g2yy5jhyqr (fix-login-bug): microvm default, running.
  Run a command:  kantel exec sbx_g2yy5jhyqr -- echo hello
  Stop it:        kantel sandbox stop sbx_g2yy5jhyqr
```

It waits until the sandbox runs; add `--no-wait` to answer at once. Without `--type`, you get an isolate. See [Isolates and microVMs](/sandboxes/types/).

Copy a file in, run it, and copy a result out:

```sh
kantel files put sbx_g2yy5jhyqr ./setup.sh app/setup.sh
kantel exec sbx_g2yy5jhyqr -- 'cd app && sh setup.sh'
kantel files get sbx_g2yy5jhyqr app/report.txt ./report.txt
```

Stop it when you're done. Its disk is kept, and it costs nothing to run while it's stopped:

```sh
kantel sandbox stop sbx_g2yy5jhyqr
kantel sandbox resume sbx_g2yy5jhyqr
```

## Running commands

`kantel exec` runs a command in a sandbox and waits for it. The command's output comes out on yours, and `kantel` exits with the command's exit code, so it works in scripts and `make` as the command would locally:

```sh
kantel exec sbx_g2yy5jhyqr -- 'cd app && npm test' || echo "tests failed"
```

One word after `--` is a shell command line, as above. Several words are a command and its arguments, which `kantel` quotes for you:

```sh
kantel exec sbx_g2yy5jhyqr -- ls -la "my folder"
```

| Flag | What it does |
| --- | --- |
| `--cwd <dir>` | Run it in this directory instead of the sandbox user's home |
| `--env K=V` | An environment variable for this command. Repeat it for more |
| `--timeout <ms>` | Kill it after this long. Default 30 seconds. A command that's killed exits `124` |
| `--detach` | Start it and answer at once, with no time limit: for servers and long jobs |
| `--stdin` | Send your terminal's input to the command |

When Kantel itself refuses, `kantel` prints `kantel: <code>: <message>`, such as `kantel: conflict: …` for a stopped sandbox, and exits `1`. A command line `kantel` can't make sense of exits `2`.

## Output for scripts

Every command takes `--json`, which prints Kantel's answer as it is, as the [API reference](/api/reference/) describes it:

```sh
id=$(kantel sandbox create --type microvm --json | jq -r .id)
kantel exec "$id" -- 'uname -a'
kantel sandbox stop "$id"
```

In fish, use `set id (kantel sandbox create --type microvm --json | jq -r .id)`.

## Commands

`kantel help` lists every command, and `kantel help <command>` (or `--help` after one) shows its flags. `sb` is short for `sandbox`, `ls` for `list` and `rm` for `delete`.

| Group | Commands |
| --- | --- |
| Signing in | `login`, `logout`, `whoami` |
| [Sandboxes](/sandboxes/lifecycle/) | `sandbox create`, `list [--all]`, `get`, `start`, `stop [--pause]`, `resume`, `recover`, `fork [--count N]`, `delete --yes`, `extend <id> <minutes>`, `usage` |
| [Commands and files](/sandboxes/commands-and-files/) | `exec`, `files ls`, `files cat`, `files put`, `files get`, `files rm` |
| [Ports](/sandboxes/public-ports/), [SSH](/sandboxes/ssh/), [desktop and browser](/sandboxes/desktop-and-browser/) | `port expose`, `port list`, `port hide`, `ssh [--exec]`, `desktop`, `browser` |
| [Snapshots](/snapshots/history/) | `snapshot list`, `take`, `save <sandboxId> <name>`, `files`, `rm` |
| [API keys](/accounts/api-keys/) and [organisations](/accounts/organisations/) | `key list`, `key create`, `key rotate`, `key revoke`, `org list`, `org create`, `org join` |
| [Webhooks](/monitoring/webhooks/), events and [OpenTelemetry](/monitoring/opentelemetry/) | `webhook list`, `webhook create`, `webhook rm`, `webhook test`, `events`, `telemetry get`, `telemetry set`, `telemetry rm` |
| Hosts (super-admins) | `host list`, `host join-token` |
| [Coding agents](/coding-agents/) | `mcp`, `agents` |

A few that are worth knowing:

- `kantel sandbox delete <id>` refuses unless you add `--yes`, because a delete can't be undone.
- `kantel ssh <id>` prints the `ssh` command that connects, with a key pair it makes and keeps under `~/.config/kantel/ssh/`. Add `--exec` to connect straight away, or `--public-key ~/.ssh/id_ed25519.pub` to let in your own key.
- `kantel browser <id>` prints the browser's live view URL and its CDP URL, for [Playwright](/sandboxes/desktop-and-browser/#drive-it-with-playwright).
- `kantel key create agent --preset agent` makes a key for a coding agent and prints its secret once. The other presets are `ci`, `read-only` and `admin`; `--scope` picks scopes one by one, `--sandbox` limits the key to one sandbox and `--expires-days` sets when it stops working.
- `kantel files` moves files of up to 1 MiB each. For bigger ones, run `git clone`, `curl` or `scp` in or against the sandbox.

<!-- Sources (99a1829a): packages/cli/README.md, packages/cli/src/commands.ts, packages/cli/src/main.ts, packages/cli/src/config.ts, packages/cli/scripts/build.ts; every command above run against packages/compute/src/serve.ts -->
