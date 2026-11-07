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

It needs Node.js 22 or later, on Linux or macOS. Each of Kantel's [GitHub Releases](https://github.com/lleverage-ai/kantel/releases) carries it as one file, `kantel.js`, and kantel.dev serves an installer for it that needs no sudo. This line works in bash, zsh and fish:

```sh
curl -fsSL https://kantel.dev/cli.sh | sh
kantel version
kantel login
```

It downloads the latest release's files, checks them against its `SHA256SUMS`, puts them in `~/.local/share/kantel`, and links `~/.local/bin/kantel` to them. If `~/.local/bin` isn't on your `PATH`, it says how to put it there (`fish_add_path ~/.local/bin` in fish). `kantel update` updates it to the latest release (`--check` only says whether there is one, and `--version 0.3.2` installs that release): it runs that release's own installer, so it checks the download the same way and updates `kantel-admin` too where it is installed. Running the install line again does the same. After `| sh -s --`, `--admin` adds `~/.local/bin/kantel-admin` (the [operator's command](/self-hosting/admin-cli/), for self-hosting; once it's installed, updates keep it up to date unless you say `--no-admin`), `--dir DIR` links the commands in another directory, and `--version 0.1.0` installs that release. Each release also carries the same installer as `install-cli.sh`, which installs that release. `gh attestation verify ~/.local/share/kantel/kantel.mjs --repo lleverage-ai/kantel` checks that Kantel's release workflow built it.

It isn't on npm (publishing is on hold), so `npx kantel` doesn't work: install it as above and run `kantel`. To build it yourself instead, run `pnpm install --frozen-lockfile --filter '@kantel/cli...'` and `pnpm --filter @kantel/cli build` in a clone of the repository, which writes one file, `packages/cli/dist/kantel.js`, and `npm install -g ./packages/cli/dist` to put it on your `PATH`.

## Sign in

```sh
kantel login
```

It signs in to the hosted service at `https://app.kantel.dev`. For a self-hosted Kantel, give its address once and the saved config remembers it:

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

Without any of them, the address is `https://app.kantel.dev`, the hosted service. A key always acts in the account it was made in, which `whoami` shows.

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

A microVM's machine is a named size (`--size large`) or a shape of its own (`--vcpus 8 --memory 16`, in GB). Which sizes there are, and what each holds, is up to the hosts: `kantel sizes` lists them, with the most `--vcpus` and `--memory` may ask for. On app.kantel.dev the sizes are `small`, `default` and `large` (4 vCPU, 8 GB); a large monorepo's type-check needs about 16 GB, so ask for that shape. From a snapshot, a sandbox is the machine the snapshot was taken of, unless you give `--size` or `--vcpus` and `--memory`: a snapshot of the disk alone (what `kantel snapshot save` keeps unless you add `--memory`) starts at any of them, as in `kantel new --from monorepo-ci --vcpus 8 --memory 16`. A snapshot that holds its sandbox's memory has that sandbox's machine, and Kantel refuses another before it makes anything.

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

`kantel list` shows your running sandboxes (`--all` for the stopped ones too, `--mine` for only your own, not the ones others share in an organisation, and `--on <host>` for those on one host), `kantel info <id>` one of them, `kantel fork <id> --count 3` makes copies, and `kantel delete <id> --yes` erases one for good.

## Running commands

`kantel exec` runs a command in a sandbox and waits for it. The command's output comes out on yours as it is written, and `kantel` exits with the command's exit code, so it works in scripts and `make` as the command would locally:

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

`kantel exec` starts every command by its ID and follows it, so a command keeps running when its sandbox's host reconnects to Kantel or Kantel's gateway restarts, and `exec` and `attach` carry on following it, its output still coming as it is written. If `kantel` can't reach Kantel for two minutes, its own connection reset included, it stops following and exits `1` with the command's ID, which may still be running: `kantel attach <id> <command>` picks it up again, from its output so far. If the start itself gets no answer, `kantel` can't know the ID and says so: `kantel ps <id>` lists the command if it started. A host on a kantel-host from before this ends its commands when it reconnects, and says so in the command's stderr.

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

Push also leaves credentials behind, at any depth, and names each one it skips on stderr:

- Always: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.netrc`, `.pypirc` and `.docker/config.json`, even when git tracks them.
- Unless git tracks the file: `.claude`, `.codex` and `.cursor`, which hold agents' sign-ins, `.npmrc`, and `.env` files such as `.env.local`. `.env.example`, `.env.sample` and `.env.template` go. A project's committed `.claude/settings.json` goes; your untracked `.claude/settings.local.json` doesn't.
- Links that resolve outside the directory, or to a file left out above.

`--no-default-excludes` sends the first two groups too; links outside the directory never go. Push refuses a directory inside one it leaves out, such as `~/.ssh`, unless you add `--no-default-excludes`. It refuses your home directory, or a directory holding it or Kantel's config directory (`~/.config/kantel`), unless you add `--allow-home`; even then Kantel's config directory, which holds your API key, stays behind, and nothing inside it is ever pushed.

### Syncing a git checkout

When the sandbox already has a clone of your repository, such as one made from a [saved snapshot](/snapshots/saved/) with its dependencies installed and its build caches warm, `kantel sync <id> --git` sends only the difference. Push sends every file, which takes minutes on a monorepo of 20,000 ([#726](https://github.com/lleverage-ai/kantel/issues/726)); sync sends one patch against the commit the clone started from:

```sh
kantel sync sbx_g2yy5jhyqr --git                                # this repository, to /home/user/<its name>
kantel sync sbx_g2yy5jhyqr ~/src/app --git --to /srv/app       # another repository, to another clone
```

```
Synced /home/user/lleverage in sbx_g2yy5jhyqr (467 files changed: a 2.5 MiB patch, 812 KiB sent) on 9540593c20 (.kantel-base-sha) in 2.4 s. Both trees are 24ec943e03.
```

The commit it diffs against, the base, is the first of:

1. `--base <commit>`.
2. The checkout's `.kantel-base-sha` file, for a checkout whose HEAD has moved on since it was made.
3. The `git.base` [label](/snapshots/saved/#record-what-it-holds-and-how-fresh-it-is) on the snapshot the sandbox was made from.
4. The checkout's HEAD.

Your repository must have the base too: when it doesn't, sync says so, and `git fetch origin <commit>` gets it.

Here, sync stages your working tree in a copy of your index, so yours isn't touched, and with objects of its own, so nothing it reads is left in your repository: your tracked changes, deletions and mode changes, and the new files `.gitignore` doesn't leave out. `git diff-tree --binary` from the base to that tree is the patch, binary files and links included. It goes up gzipped. In the sandbox, one command runs `git clean -fd`, which keeps the files the checkout's `.gitignore` leaves out, such as `node_modules` and build output, then `git reset --hard <base>` and `git apply --index`. Two syncs into one checkout take turns. Last, it checks that `git write-tree` names the same tree on both sides, and that the files match the index. Anything else in the checkout is lost: its own commits, changes and untracked files.

It fails, and says which, when no base is recorded, when the base isn't in your repository or the sandbox's clone, when the patch doesn't apply, and when the trees don't match after it. A failure before the patch applies leaves the checkout as it was; one after the reset leaves it at the base.

Sync leaves out what push would, but only among the files that changed: credentials, and new `.claude`, `.codex`, `.cursor`, `.npmrc` and `.env` files. Each stays at the base's version, and is named on stderr; `--no-default-excludes` sends them. As push does, it refuses a repository in Kantel's config directory or in one it leaves out, such as `.ssh`, and your home directory, or one that holds it, without `--allow-home`; Kantel's own config never goes, whatever the flags. It sends the whole repository, whichever of its directories you name, but not what's in submodules or a repository inside it, and Git LFS files go as their pointers. It needs a microVM with git, gzip and flock, which Kantel's image has.

Both push and scp go through Kantel's files API, so they work on isolates as well as microVMs and need no SSH. The API moves at most 1 MiB a call: a bigger file comes out in ranged reads, and goes in in parts that a command in the sandbox joins, which needs a microVM. `kantel files` (`ls`, `cat`, `put`, `get`, `rm`) works on one file at a time.

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
- Setting a protected variable again with a new value rotates it: running sandboxes keep their placeholder and send the new value. It stays protected unless you give `--plain`, and it keeps the bindings the variable has when the new value is written, including any changed since. If someone removed it or made it plain in the meantime, the rotation is refused rather than saving the new value unprotected. `--keep-value` with new `--bind`s changes where it may go without entering it again.
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

When Kantel can't be reached, or a proxy in front of it fails (a 502, 503 or 504 that isn't Kantel's own answer), `kantel` sends a call again that is safe to send twice: any read, such as `info`, `list` or a poll, and a create, fork or command, which carry an `Idempotency-Key` so Kantel does them once. It waits 0.5, 1, 2 and 4 seconds between the five tries, then exits `1` saying why. Other changes, such as `stop`, `delete` or a file's write, are sent once, since the first may have happened.

## Commands

`kantel help` lists every command, and `kantel help <command>` (or `--help` after one) shows its flags. `ls` is short for `list` and `rm` for `delete`. The first CLI's spellings, such as `kantel sandbox create` and `kantel sandbox get`, still work.

| Group | Commands |
| --- | --- |
| Signing in | `login [--key-stdin] [--no-browser] [--wait]`, `logout`, `whoami` |
| [Sandboxes](/sandboxes/lifecycle/) | `new [--size S \| --vcpus N --memory GB]`, `sizes`, `list [--all] [--mine]`, `info`, `start`, `stop [--pause]`, `resume`, `recover`, `fork [--count N]`, `delete --yes`, `extend <id> <minutes>`, `usage` |
| [Commands](/sandboxes/commands-and-files/) | `exec [-d] [--timeout <s>]`, `attach`, `ps`, `kill` |
| [Files](/sandboxes/commands-and-files/) | `scp [-r]`, `push`, `sync --git`, `files ls`, `files cat`, `files put`, `files get`, `files rm` |
| [Ports](/sandboxes/public-ports/), [SSH](/sandboxes/ssh/), [desktop and browser](/sandboxes/desktop-and-browser/) | `host <id> <port>`, `port list`, `port hide`, `ssh`, `desktop`, `browser` |
| [Snapshots](/snapshots/history/) | `snapshot list`, `info <id or name>`, `take`, `save <sandboxId> <name> [--label k=v]…`, `files`, `rm` |
| [Environments](/sandboxes/environments/) and [egress](/sandboxes/egress-proxy/) | `env list`, `env create`, `env show`, `env delete`, `env set [--protected] [--bind …] [--value-stdin] [--keep-value]`, `env unset`, `env file`, `env file rm`, `env repo add`, `env repo rm`, `env grant`, `env grant rm`, `egress [--denied]`, `grant`, `grant rm` |
| [API keys](/accounts/api-keys/) and [organisations](/accounts/organisations/) | `key list`, `key create`, `key rotate`, `key revoke`, `org list`, `org create`, `org join` |
| [Webhooks](/monitoring/webhooks/), events and [OpenTelemetry](/monitoring/opentelemetry/) | `webhook list`, `webhook create`, `webhook rm`, `webhook test`, `events`, `telemetry get`, `telemetry set`, `telemetry rm` |
| [Your own hosts](/own-hosts/) (experimental): machines of your own | `hosts add [name]`, `hosts list`, `hosts info`, `hosts drain [--off]`, `hosts rm` |
| [Coding agents](/coding-agents/) | `init`, `mcp`, `agents` |
| This command | `update [--check] [--version V]`, `version` |

`kantel key create agent --preset agent` makes a key for a coding agent and prints its secret once. The other presets are `ci`, `read-only` and `admin`; `--scope` picks scopes one by one, `--sandbox` limits the key to one sandbox and `--expires-days` sets when it stops working.

Listing and joining hosts moved to the operators' command: `kantel-admin host list` and `kantel-admin host add`. See [Hosts](/hosts/).

<!-- Sources: packages/cli/src/commands.ts, packages/cli/src/environments.ts, packages/cli/src/login.ts, packages/cli/src/transfer.ts, packages/cli/src/agents.ts, packages/cli/src/config.ts, packages/cli/scripts/build.ts; device sign-in: packages/compute/src/service.ts (startDeviceLogin, approveDeviceLogin) -->
