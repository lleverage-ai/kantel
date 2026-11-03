---
title: What Kantel is
description: Kantel, by Lleverage, is a compute plane for AI agents that you can run yourself. It gives agents sandboxes to work in, on Linux machines you add with one command.
---

Kantel, by Lleverage, gives AI agents somewhere to run code. You ask it for a sandbox, a Linux environment of the agent's own, and get one back quickly. The agent runs commands in it, reads and writes its files, opens its desktop or browser, and you stop, resume, fork or delete it when the work is done.

Kantel doesn't run the agent. Claude Code, Codex, pi or your own agent loop stays wherever it already runs, and reaches Kantel over the API, the TypeScript SDK, the `kantel` CLI or the MCP server. That keeps Kantel to one job, compute, and lets any harness use it.

You can run all of Kantel yourself. The control plane, which serves the console and the API, installs with one command, and each Linux machine you want to run sandboxes on joins it with one more. There is also a hosted version, for trying Kantel without a machine of your own. See [Hosted or self-hosted](/hosted-or-self-hosted/).

## What you get

- **Sandboxes** in two sizes of isolation: lightweight isolates that start almost at once, and microVMs with their own Linux kernel, root, Docker and nested virtualisation.
- **Stop, resume and fork.** A stopped sandbox keeps its disk, and a fork copies a sandbox so several agents can start from the same state.
- **Snapshots.** Every sandbox keeps a history of its disk, and you can save a state under a name to start new sandboxes from.
- **A desktop, a browser and SSH** for each sandbox, for agents that use a computer the way a person does, and for you to watch or step in.
- **Personal accounts and organisations.** Your sandboxes are your own until you share them with an organisation.
- **Scoped API keys**, so a script or an agent gets only the access it needs.
- **A proxy** for traffic leaving sandboxes, where you can add credentials on the way out so they never sit inside a sandbox.
- **Webhooks and OpenTelemetry**, to follow sandboxes from your own systems.

[Concepts](/concepts/) explains each of these words once.

## Where to start

| You want to | Start with |
| --- | --- |
| Understand the moving parts | [Concepts](/concepts/) |
| Decide where to run it | [Hosted or self-hosted](/hosted-or-self-hosted/) |
| Run the control plane on your machine | [Install Kantel](/self-hosting/install/) |
| Make and drive a sandbox | [Create and manage sandboxes](/sandboxes/lifecycle/) |
| Let Claude Code, Codex or pi use it | [Use from your coding agent](/coding-agents/) |
| Call it from TypeScript | [TypeScript SDK](/tools/typescript-sdk/) |
| Look up a route | [API reference](/api/reference/) |

## Status

Kantel used to be an agent platform, with sessions, models, connections and approvals of its own. It is now becoming the compute plane described here, and these pages describe that. The parts still being built carry an **Experimental** badge in the sidebar and a note at the top of the page; anything a page doesn't mention isn't there yet.

Kantel was called Harbour before it was renamed, and a few names keep that: `harbour` in some image, database and Worker names, `HARBOUR_*` settings (read when the `KANTEL_*` one isn't set) and API keys starting `hbr_`. Write them as they are.

<!-- Sources (e496aeb): README.md:1-20, apps/site/public/install.sh:1-25, docs/site/README.md:1-60 -->
