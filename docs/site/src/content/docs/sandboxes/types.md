---
title: Isolates and microVMs
description: The two types of sandbox, what each can and can't do, how to choose one, and how to read a sandbox's capabilities and size.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

Every sandbox is one of two types. You choose with `type` when you [create it](/sandboxes/lifecycle/#create-a-sandbox), and the same API drives both.

| | `isolate` | `microvm` |
| --- | --- | --- |
| What it is | A workerd isolate running [just-bash](https://github.com/vercel-labs/just-bash), a bash written in TypeScript, over files kept in `/workspace` | A Firecracker microVM with its own Linux kernel |
| Starts in | Milliseconds | Longer: a machine boots |
| Costs | Almost nothing | Its size's hourly rate while it runs |
| Commands and files | Yes, in the isolate's shell, starting in `/workspace` | Yes, with `bash`, starting in `/home/user` |
| git, Node, Python, packages, root | No | Yes |
| Docker | No | Yes |
| `/dev/kvm` inside, for virtual machines of its own | No | Yes, where its host allows nested virtualisation |
| Desktop, browser and SSH | No | Yes |
| Pause, keeping memory | No | Yes, where its host supports it |
| Size | None | `small`, `default`, `large` or `xlarge` |

A microVM on Kantel's own image has all of these. One on a [custom image](/sandboxes/custom-images/) has the desktop, browser and Docker only where its image does, and its `capabilities` say so.

An isolate is the default.

## Choosing one

Choose an **isolate** when the whole task is calling HTTP APIs and working on text or JSON: reading issues, tickets or logs with a token, reshaping an export with `jq` or `awk`, or running the same small check over many items, one fork each. It starts in milliseconds, costs almost nothing, and forks for almost nothing too, since a fork copies only the list of its files. Its requests go through the [egress proxy](/sandboxes/egress-proxy/) like a microVM's, so a [protected variable](/sandboxes/environments/) stays a placeholder inside it, and `kantel egress <sandbox>` shows every request it made.

Choose a **microVM** for anything a normal Linux machine does: cloning, installing, building, testing or running a project, any language runtime, Docker, a server, a desktop and browser, or a job longer than a few minutes. If you're unsure, choose a microVM.

An isolate can become a microVM when the work turns out to need one: [upgrade it](#upgrade-an-isolate-to-a-microvm), and it keeps its ID, files and settings. A microVM doesn't go back to being an isolate.

### What an isolate's shell has

An isolate runs bash's syntax (pipes, redirections, variables, functions, loops and `if`) and these commands, all written in TypeScript:

- files: `cat`, `cp`, `mv`, `rm`, `ln`, `ls`, `mkdir`, `find`, `stat`, `touch`, `tree`, `du`, `split`, `file`;
- text: `grep`, `rg`, `sed`, `awk`, `cut`, `sort`, `uniq`, `wc`, `head`, `tail`, `tr`, `diff`, `comm`, `join`, `paste`, `column`, `xargs`, `base64`, `md5sum`, `sha256sum`;
- data and network: `jq`, `curl`, and `gzip`, `gunzip` and `zcat`;
- shell: `echo`, `printf`, `date`, `seq`, `expr`, `sleep`, `timeout`, `env`, `export`, `test`.

`help` lists the shell's builtins, and every command takes `--help`. It has no `git`, `node`, `python`, `sqlite3`, `yq`, `tar` or package manager, and runs no program of its own: each of those answers `command not found` or `not available in an isolate` with exit code 127. Only `/workspace` is kept. A file written anywhere else, such as `/tmp`, is gone when the command ends.

A command runs for at most 30 seconds unless its `timeoutMs` gives it longer (up to 10 minutes).

## Upgrade an isolate to a microVM

When an isolate's work turns out to need a real machine, such as a `git clone`, an `npm install` or a build, upgrade it. It becomes a microVM with the same ID, name, labels, env, [environments](/sandboxes/environments/), egress grants and protected variables, and its `/workspace` files are in the microVM at `/home/user/workspace`, with `/workspace` a link to them, so the paths a command used still work:

```sh
kantel upgrade sbx_4kq9x2mt
kantel exec sbx_4kq9x2mt -- git -C /workspace status
```

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/upgrade" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"size": "large"}'
```

The body takes `size` or `resources`, and `image`, as a [create](/sandboxes/lifecycle/#create-a-sandbox) does; `{}` makes the deployment's default microVM. The call answers once the microVM runs with the files, or with `"wait": false` as soon as the upgrade has begun (`starting`). A key needs `sandboxes:write`, and the call takes an `Idempotency-Key`. In the console, an isolate's ⋯ menu has **Upgrade to microVM**.

- **A running or a stopped isolate** can be upgraded. A stopped one comes back as a running microVM: the files go into a machine that runs. Stop it afterwards if you want it stopped. One that is starting, stopping or in `error` is `conflict`.
- **Commands and file calls sent during the upgrade wait for it**, as calls during a start do, and then run in the microVM.
- **If the microVM can't be made**, the call fails with why (`exhausted` when no host has room), and the isolate is left as it was: still running, or still stopped, with its files.
- **Its cost** changes at the upgrade: its time as an isolate ends then, at the isolate's rate, and its time as a microVM begins, at its size's rate. A `sandbox.upgraded` [event and webhook](/monitoring/webhooks/) record it, with what moved (`data.files`, `data.bytes`) and how (`data.path`).
- **Its environments' secret files and repositories** are set up again in the microVM, where a microVM keeps them, and an exposed port is exposed again on it.
- Its snapshots from before the upgrade stay, as an isolate's: a sandbox made from one is an isolate.

Where the files go: the isolate's own host makes the microVM when it runs microVMs too and has room, and moves the files from its own store into the microVM, never through Kantel. Otherwise the microVM goes on another host the sandbox may use, and Kantel moves the files there, up to 20,000 files and 256 MiB; past that the upgrade is refused (`not_supported`) and the isolate stays as it is.

### Upgrade by itself

Create an isolate with `autoUpgrade` and it upgrades itself the first time a command needs a microVM, then runs that command again there, once:

```sh
kantel new --auto-upgrade
```

```json
{ "autoUpgrade": true }
```

A command that needs a microVM says so in its `needsMicrovm` (`{"command": "tar", "reason": "..."}`), with exit code 127. Without `autoUpgrade`, that is its answer and the isolate stays one. With it, the answer is the command run again in the microVM: its `rerunOf` names the first, whose `rerunAs` names it. `PATCH /v1/sandboxes/{id}` with `{"autoUpgrade": true}` turns it on later. `kantel exec` follows the command run again by itself, and says so. A command that an isolate's runtime stopped for using too much CPU time, memory or wall time says which in `terminated` (`cpu`, `memory` or `wall`).

## Capabilities

What a sandbox can do depends on its type and on the host it landed on. Each sandbox says so in `capabilities`, so read that rather than assume from the type:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq .capabilities
```

```json
{ "exec": true, "files": true, "ssh": true, "desktop": true, "browser": true, "ports": true, "docker": true, "kvm": true, "pause": true }
```

A call a sandbox can't take, such as SSH into an isolate, answers `501` with `not_supported`.

## Sizes

A microVM has a size: `small`, `default`, `large` or `xlarge`. Each deployment decides what the sizes hold, and may offer fewer of them. A running microVM shows what it got in `resources`:

```json
{ "size": "default", "resources": { "vcpus": 2, "memoryMb": 4096, "diskGb": 20 } }
```

To change a sandbox's size, stop it and resume it with another (`{"size": "large"}`), or fork it to a new size. An isolate has no size and no `resources`.

A microVM's disk can be larger than its size gives, without more vCPUs or memory: `"resources": {"diskGb": 60}` on a create, beside a size or vCPUs and memory, or `kantel new --type microvm --size large --disk 60`. `GET /v1/sandbox-shapes` says the range the hosts you may use give (`microvm.diskGb`). A fork, a start and a sandbox made from a snapshot keep the disk they copy.

## Base images

A microVM starts from a base image, such as `ubuntu-26.04`, which its `image` field names. Leave `image` out to get the deployment's default. To start every sandbox with your own tools already installed, set one up once and save it as a [saved snapshot](/snapshots/saved/), then create from that with `from`.

Kantel's own image, which hosts run unless their operator set another, is Ubuntu 26.04 LTS with systemd, Docker, git, build tools, Python 3, Go, Node, an Openbox desktop with Chromium, and SSH. `/etc/kantel/image.json` in a sandbox lists the version of each part that went in.

### Node

The image has one Node: Node 26, installed in `/usr/local`, so `node`, `npm` and `npx` are in `/usr/local/bin`, which comes before `/usr/bin` on every command's default `PATH` (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`). It has no `corepack`, which Node stopped shipping in Node 25: install pnpm or Yarn with `npm install -g`.

A project that needs another Node, such as the Node 24 its `.nvmrc` names, installs it beside the image's in a directory of its own, `/opt/node24` here, and puts that directory first on `PATH`. On arm64, use the `linux-arm64` file:

```sh
kantel exec sbx_4kq9x2mt -- bash -c '
  curl -fsSL https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o /tmp/node.tar.xz
  sudo mkdir -p /opt/node24
  sudo tar -xJf /tmp/node.tar.xz -C /opt/node24 --strip-components=1'
```

Then pick one:

- for one command, `kantel exec sbx_4kq9x2mt -- env PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin node -v`;
- for every command and SSH login, add it to `~/.profile`: `kantel exec sbx_4kq9x2mt -- "echo 'export PATH=/opt/node24/bin:\$PATH' >> ~/.profile"`. Kantel runs each command line, from the CLI or the API, in a login shell (`bash -lc`), which reads `~/.profile` after the sandbox's own variables are set, so this is the setting that holds;
- for the desktop, whose session doesn't read `~/.profile`, put a full `PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` line (no `$PATH`) in `/etc/kantel/desktop.env`, then `sudo systemctl restart kantel-desktop`.

Without one of these, `node` is the image's Node 26. Save the sandbox as a [saved snapshot](/snapshots/saved/) to keep the extra Node for every sandbox made from it. A tool that caches by Node version, such as Turbo, misses a cache built with the other Node, so build and use a snapshot's caches with the same one.

## Placing sandboxes on hosts

On a deployment with several hosts, Kantel picks one that can run the type and has room. Hosts can carry labels, such as `site: home`, and `hostLabels` on a create places the sandbox only on a host with every label you give:

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type": "microvm", "hostLabels": {"site": "home"}}'
```

If no host has every label you give, the sandbox can't be placed, and the create answers `503` with `unavailable`.

<!-- Sources (9cc20eb3): packages/api/src/compute-schema.ts:201-264, packages/api/src/compute-schema.ts:365-404, packages/api/src/compute-routes.ts:334-350, packages/api/src/compute-routes.ts:417-432 -->
