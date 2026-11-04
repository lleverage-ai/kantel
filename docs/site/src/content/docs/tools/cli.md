---
title: Command line
description: Install the kantel command, sign in through the browser or with an API key, and make, drive, copy files into, snapshot and stop sandboxes from a terminal, a script or a coding agent.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The `kantel` command calls Kantel's compute API, which every control plane serves. Its commands and their output may still change.
:::

`kantel` does from a terminal what the [API](/api/reference/) does over HTTP: make a sandbox, run commands in it, copy files in and out, give its ports URLs, open its SSH, desktop and browser, take snapshots, and manage keys, webhooks and organisations. Every command can print Kantel's JSON answer instead of a table, for scripts and agents. The same program is Kantel's [MCP server](/tools/mcp-server/), and `kantel init` teaches a project's [coding agents](/coding-agents/) to use it.

Running a self-hosted install, and its hosts, is a separate command for operators: [`kantel-admin`](/self-hosting/admin-cli/).

## Install it

It needs Node.js 22 or later, on Linux or macOS. Each of Kantel's [GitHub Releases](https://github.com/lleverage-ai/kantel/releases) carries it as one file, `kantel.js`, and an installer for it that needs no sudo. This line works in bash, zsh and fish:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install-cli.sh | sh
kantel version
```

It checks the files against the release's `SHA256SUMS`, puts them in `~/.local/share/kantel`, and links `~/.local/bin/kantel` and `~/.local/bin/kantel-admin` (the [operator's command](/self-hosting/admin-cli/)) to them. If `~/.local/bin` isn't on your `PATH`, it says how to put it there (`fish_add_path ~/.local/bin` in fish). Run the same line again to update. After `| sh -s --`, `--dir DIR` links the commands in another directory, `--no-admin` installs `kantel` alone, and `--version 0.1.0` installs that release. `gh attestation verify ~/.local/share/kantel/kantel.mjs --repo lleverage-ai/kantel` checks that Kantel's release workflow built it.

It isn't on npm (publishing is on hold), so `npx kantel` doesn't work: install it as above and run `kantel`. To build it yourself instead, run `pnpm install --frozen-lockfile --filter '@kantel/cli...'` and `pnpm --filter @kantel/cli build` in a clone of the repository, which writes one file, `packages/cli/dist/kantel.js`, and `npm install -g ./packages/cli/dist` to put it on your `PATH`.

## Sign in

```sh
kantel login --url https://kantel.example.com
```

```
Open this page and check the code matches: BCDF-GHJK
  https://kantel.example.com/device?code=BCDF-GHJK
Waiting for you to approve it in the browser…
Signed in to https://kantel.example.com as Ada <ada@example.com>, in acc_8w3zkfuz4d.
Saved to /home/ada/.config/kantel/config.json.
```

It opens Kantel's console at a page that asks you to approve the sign-in, signed in as yourself. Check the code there matches the one in your terminal, pick the account, and select **Approve**. The command gets an API key of its own, named after your machine (`kantel on build-01`), that lasts 90 days: you can see and revoke it on the console's **API keys** page. Approving needs admin or owner in the account, as making any key does. A code lasts 15 minutes.

Add `--no-browser` to print the page without opening it, such as over SSH. Without a terminal, as when a coding agent runs it, `kantel login` prints the page and code and stops; `kantel login --wait` then waits for your approval with the same code. With `--json` it prints them as `{"event": "login_pending", "url": …, "code": …}`.

If you already have a [scoped API key](/accounts/api-keys/), pipe it in instead, which keeps it out of your shell's history and the process list:

```sh
printf '%s' "$KANTEL_API_KEY" | kantel login --key-stdin --url http://127.0.0.1:58090
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

Either way it checks the key and saves it, with the address, in `~/.config/kantel/config.json` (under `$XDG_CONFIG_HOME` if you set it), which only you can read. `kantel logout` removes the saved key.

Each setting comes from the first place that has it:

1. a flag: `--url`, `--key` and `--account`;
2. the environment: `KANTEL_URL`, `KANTEL_API_KEY` and `KANTEL_ACCOUNT`;
3. the saved file.

Without any of them, the address is `http://127.0.0.1:58090`, a self-hosted install on the same machine. A key always acts in the account it was made in, which `whoami` shows.

## A first sandbox

```sh
kantel new --type microvm --name fix-login-bug --label ticket=PROJ-12
```

```
Created sbx_g2yy5jhyqr (fix-login-bug): microvm default, running.
  Run a command:  kantel exec sbx_g2yy5jhyqr -- echo hello
  Stop it:        kantel stop sbx_g2yy5jhyqr
```

It waits until the sandbox runs; add `--no-wait` to answer at once. Without `--type`, you get an isolate. See [Isolates and microVMs](/sandboxes/types/). `--from <snapshot>` starts it from a [saved snapshot](/snapshots/saved/), `--env K=V` sets a variable every command sees, `--env <env>` starts it from an [environment](#environments-and-protected-variables), and `--host 3000` gives a port a URL as soon as it runs.

Copy your project in, run its tests, and copy a result out:

```sh
kantel push sbx_g2yy5jhyqr .
kantel exec sbx_g2yy5jhyqr -- 'cd my-app && npm ci && npm test'
kantel scp sbx_g2yy5jhyqr:my-app/coverage.json .
```

Stop it when you're done. Its disk is kept, and it costs nothing while it's stopped:

```sh
kantel stop sbx_g2yy5jhyqr
kantel resume sbx_g2yy5jhyqr
```

`kantel list` shows your running sandboxes (`--all` for the stopped ones too), `kantel info <id>` one of them, `kantel fork <id> --count 3` makes copies, and `kantel delete <id> --yes` erases one for good.

## Running commands

`kantel exec` runs a command in a sandbox and waits for it. The command's output comes out on yours, and `kantel` exits with the command's exit code, so it works in scripts and `make` as the command would locally:

```sh
kantel exec sbx_g2yy5jhyqr 'cd app && npm test' || echo "tests failed"
```

One word is a shell command line, as above. Several words are a command and its arguments, which `kantel` quotes for you; put them after `--` when they have flags of their own:

```sh
kantel exec sbx_g2yy5jhyqr -- ls -la "my folder"
```

| Flag | What it does |
| --- | --- |
| `--cwd <dir>` | Run it in this directory instead of the sandbox user's home |
| `--env K=V` | An environment variable for this command. Repeat it for more |
| `--timeout <seconds>` | Kill it after this long. Default 30, at most 600. A command that's killed exits `124`. `0` means no limit: it runs detached and `kantel` follows its output |
| `-d`, `--detach` | Start it, print its ID and answer at once, with no time limit: for servers and long jobs |
| `--stdin` | Send your terminal's input to the command |

### Servers and long jobs

A detached command keeps running after `kantel` answers. Follow it, see what is running, and stop it:

```sh
cmd=$(kantel exec sbx_g2yy5jhyqr -d -- 'cd app && npm run dev')
kantel attach sbx_g2yy5jhyqr "$cmd"     # its output so far, then more as it comes; Ctrl-C stops following
kantel ps sbx_g2yy5jhyqr                # the sandbox's commands, newest first
kantel kill sbx_g2yy5jhyqr "$cmd"
```

`attach` exits with the command's exit code once it ends. Kantel keeps the first 1 MiB of each of a command's streams, so send a chatty job's output to a file and copy the file out.

When Kantel itself refuses, `kantel` prints `kantel: <code>: <message>`, such as `kantel: conflict: …` for a stopped sandbox, and exits `1`. A command line `kantel` can't make sense of exits `2`.

## Copying files

`kantel scp` copies between your machine and a sandbox, with `<sandbox-id>:<path>` naming the sandbox's side. A path without a leading `/` is under the sandbox user's home.

```sh
kantel scp ./report.txt sbx_g2yy5jhyqr:/home/user/       # a file into a directory
kantel scp sbx_g2yy5jhyqr:out.zip .                      # a file out
kantel scp -r ./site sbx_g2yy5jhyqr:/srv/site            # a directory in
kantel scp -r sbx_g2yy5jhyqr:build ./build               # a directory out
```

`kantel push <id> [dir]` copies a directory, the current one by default, to `/home/user/<its name>` (or `--to <path>`). In a git repository it sends the files git tracks and the new ones `.gitignore` doesn't leave out, so `node_modules`, build output and `.git` stay behind. Executable bits are kept; files you deleted locally stay in the sandbox.

Both go through Kantel's files API, so they work on isolates as well as microVMs and need no SSH. The API moves at most 1 MiB a call: a bigger file comes out in ranged reads, and goes in in parts that a command in the sandbox joins, which needs a microVM. `kantel files` (`ls`, `cat`, `put`, `get`, `rm`) works on one file at a time.

## Ports, SSH, desktop and browser

```sh
kantel host sbx_g2yy5jhyqr 3000          # an HTTPS URL for port 3000, with a token in it
kantel host sbx_g2yy5jhyqr 3000 --public # one anyone can open
kantel ssh sbx_g2yy5jhyqr                # a shell (microVMs)
kantel ssh sbx_g2yy5jhyqr -- uname -a    # one command over SSH, with its exit code
kantel desktop sbx_g2yy5jhyqr            # opens its desktop in your browser
kantel browser sbx_g2yy5jhyqr            # starts Chromium: opens its live view, prints its CDP URL
```

- `host` prints the port's [URL](/sandboxes/public-ports/). Unless `--public`, it carries a token: anyone with the whole URL can open it. `kantel port list <id>` shows a sandbox's ports and `kantel port hide <id> <port>` stops one working.
- `ssh` makes a key pair the first time and keeps it under `~/.config/kantel/ssh/`. After `--` it runs that command instead of a shell; `--print` prints the `ssh` command that connects instead of running it. `--public-key ~/.ssh/id_ed25519.pub` lets in your own key. See [SSH](/sandboxes/ssh/).
- `desktop` and `browser` open their page when you're at a terminal, and only print it otherwise or with `--print`. The URLs carry short-lived tokens. Drive the browser with [Playwright](/sandboxes/desktop-and-browser/#drive-it-with-playwright) and the CDP URL `browser` prints.

## Environments and protected variables

An [environment](/sandboxes/environments/) holds the variables, secret files, repositories and grants a new sandbox starts with. A protected variable never enters the sandbox: it gets a `kph_…` placeholder, which the egress proxy swaps for the value only in requests to the destinations you bind it to.

```sh
kantel env create work
printf '%s' "$GH_TOKEN" | kantel env set work GH_TOKEN --value-stdin --protected --bind api.github.com
kantel env set work NODE_ENV=development
kantel new --env work
```

- `env set` takes the environment first, or as `--env <env>`. `--bind <host>[/path-prefix][:METHOD,METHOD]` says where a protected value may go, such as `api.openai.com/v1/:POST,GET`; repeat it for more. `--value-stdin` reads the value from stdin, which keeps it out of your shell's history and the process list.
- Setting a protected variable again with a new value rotates it: running sandboxes keep their placeholder and send the new value. It stays protected unless you give `--plain`, and a new value alone sends only the value, so it keeps the bindings the variable has when it is written, including any changed since. `--keep-value` with new `--bind`s changes where it may go without entering it again.
- `env show <env>` shows a plain variable's value, but for a protected one only `protected` and its bindings. No command prints a protected value, with or without `--json`.
- `env file <env> <path>` adds a secret file from `--from <file>` or stdin, with `--mode` (default `0600`), and `env file rm` removes one. `env repo add <env> <url> [--path] [--ref]` clones a repository into new sandboxes, and `env repo rm` stops it.
- `env grant <env> allow|deny <host> [--method M]… [--path P]…` adds a [grant](/sandboxes/egress-proxy/#grants) for the environment's sandboxes, and `grant <sandbox> …` one for a single sandbox. `env grant rm` and `grant rm` remove one by its ID. Each of these edits sends the list as it read it, and Kantel refuses the write if the list changed in between, so the command reads it again and redoes the edit rather than undoing someone else's change. The host `*` is every host.
- `egress <sandbox>` prints the sandbox's [egress log](/sandboxes/environments/#the-egress-log): each request's time, method, host and path, whether it was allowed, the refusal's code or the grant that decided, and the protected variables swapped in. `--denied` shows refusals only.

An environment is named by its name or its `env_…` ID.

## Coding agents

In a project, run:

```sh
kantel init
```

It writes Kantel's block into `AGENTS.md` (read by Codex, pi and Cursor) and `CLAUDE.md` (Claude Code), replacing an older one and leaving the rest of each file alone, and installs a `kantel` skill in `.agents/skills/kantel/` (Codex and pi) and `.claude/skills/kantel/` (Claude Code). They tell the agent when to use a sandbox and how, with the commands on this page. `--for claude` (or `codex`, `pi`) limits it to those agents, and `--global` installs the skill under your home for every project, without the `.md` files. Nothing it writes holds a key: the agent uses your sign-in, or a key of its own in `KANTEL_API_KEY`:

```sh
kantel key create coding-agent --preset agent --expires-days 30
```

For agents that take MCP servers, `kantel agents` prints the setup for Claude Code, Codex and Cursor. See [Use from your coding agent](/coding-agents/).

## Output for scripts

Every command takes `--json`, which prints Kantel's answer as it is, as the [API reference](/api/reference/) describes it:

```sh
id=$(kantel new --type microvm --json | jq -r .id)
kantel exec "$id" -- uname -a
kantel stop "$id"
```

In fish, use `set id (kantel new --type microvm --json | jq -r .id)`.

## Commands

`kantel help` lists every command, and `kantel help <command>` (or `--help` after one) shows its flags. `ls` is short for `list` and `rm` for `delete`. The first CLI's spellings, such as `kantel sandbox create` and `kantel sandbox get`, still work.

| Group | Commands |
| --- | --- |
| Signing in | `login [--key-stdin] [--no-browser] [--wait]`, `logout`, `whoami` |
| [Sandboxes](/sandboxes/lifecycle/) | `new`, `list [--all]`, `info`, `start`, `stop [--pause]`, `resume`, `recover`, `fork [--count N]`, `delete --yes`, `extend <id> <minutes>`, `usage` |
| [Commands](/sandboxes/commands-and-files/) | `exec [-d] [--timeout <s>]`, `attach`, `ps`, `kill` |
| [Files](/sandboxes/commands-and-files/) | `scp [-r]`, `push`, `files ls`, `files cat`, `files put`, `files get`, `files rm` |
| [Ports](/sandboxes/public-ports/), [SSH](/sandboxes/ssh/), [desktop and browser](/sandboxes/desktop-and-browser/) | `host <id> <port>`, `port list`, `port hide`, `ssh`, `desktop`, `browser` |
| [Snapshots](/snapshots/history/) | `snapshot list`, `take`, `save <sandboxId> <name>`, `files`, `rm` |
| [Environments](/sandboxes/environments/) and [egress](/sandboxes/egress-proxy/) | `env list`, `env create`, `env show`, `env delete`, `env set [--protected] [--bind …] [--value-stdin] [--keep-value]`, `env unset`, `env file`, `env file rm`, `env repo add`, `env repo rm`, `env grant`, `env grant rm`, `egress [--denied]`, `grant`, `grant rm` |
| [API keys](/accounts/api-keys/) and [organisations](/accounts/organisations/) | `key list`, `key create`, `key rotate`, `key revoke`, `org list`, `org create`, `org join` |
| [Webhooks](/monitoring/webhooks/), events and [OpenTelemetry](/monitoring/opentelemetry/) | `webhook list`, `webhook create`, `webhook rm`, `webhook test`, `events`, `telemetry get`, `telemetry set`, `telemetry rm` |
| [Your own hosts](/own-hosts/) (experimental): machines of your own | `hosts add [name]`, `hosts list`, `hosts info`, `hosts drain [--off]`, `hosts rm` |
| [Coding agents](/coding-agents/) | `init`, `mcp`, `agents` |

`kantel key create agent --preset agent` makes a key for a coding agent and prints its secret once. The other presets are `ci`, `read-only` and `admin`; `--scope` picks scopes one by one, `--sandbox` limits the key to one sandbox and `--expires-days` sets when it stops working.

Listing and joining hosts moved to the operators' command: `kantel-admin host list` and `kantel-admin host add`. See [Hosts](/hosts/).

<!-- Sources: packages/cli/src/commands.ts, packages/cli/src/environments.ts, packages/cli/src/login.ts, packages/cli/src/transfer.ts, packages/cli/src/agents.ts, packages/cli/src/config.ts, packages/cli/scripts/build.ts; device sign-in: packages/compute/src/service.ts (startDeviceLogin, approveDeviceLogin) -->
