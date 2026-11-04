---
title: What Kantel is
description: Kantel, by Lleverage, gives AI agents sandboxes to work in, on Linux machines you add with one command. Use the hosted control plane at app.kantel.dev, or run all of it yourself.
---

Kantel, by Lleverage, gives AI agents somewhere to run code. You ask it for a sandbox, a Linux environment of the agent's own, and get one back in about a second. The agent runs commands in it, reads and writes its files, opens its desktop or browser, and you stop, resume, fork or delete it when the work is done.

Kantel doesn't run the agent. Claude Code, Codex, pi or your own agent loop stays wherever it already runs, and reaches Kantel over the API, the TypeScript SDK, the `kantel` CLI or the MCP server.

Sandboxes run on **hosts**: Linux machines you add with one command. A host connects out to Kantel, so it needs no open ports.

## Two ways to run it

- **Hosted.** Sign in at <https://app.kantel.dev> and add your own machines as hosts. Kantel's control plane, the console and the API, runs for you. Start with the [Quick start](/quickstart/).
- **Self-hosted.** Run the control plane on your own machine too, with one command, and nothing on kantel.dev. Start with the [Self-host quick start](/self-hosting/quickstart/).

The console, the API, the SDK, the CLI and the MCP server are the same in both: code you write against one works against the other with a different address and key.

## What you get

- **Sandboxes** in two kinds: isolates that start almost at once, and microVMs with their own Linux kernel, root, Docker and nested virtualisation.
- **Stop, resume and fork.** A stopped sandbox keeps its disk, and a fork copies a sandbox so several agents can start from the same state.
- **Snapshots.** Every sandbox keeps a history of its disk, and you can save a state under a name to start new sandboxes from.
- **A desktop, a browser and SSH** for each sandbox, to watch an agent work or step in.
- **A personal space and organisations.** Your hosts and sandboxes are your own until you share them through an organisation.
- **Scoped API keys**, so a script or an agent gets only the access it needs.
- **An [egress proxy](/sandboxes/egress-proxy/)** on every host, which can add credentials on the way out so they never sit inside a sandbox.
- **Webhooks and OpenTelemetry**, to follow sandboxes from your own systems.

[Concepts](/concepts/) explains each of these once.

## Where to start

| You want to | Start with |
| --- | --- |
| Go from nothing to a running microVM | [Quick start](/quickstart/) |
| Add the machines that run sandboxes | [Hosts](/hosts/) |
| Share with a team | [Organisations](/accounts/organisations/) |
| Let Claude Code, Codex or pi use it | [Use from your coding agent](/coding-agents/) |
| Make and drive a sandbox | [Create and manage sandboxes](/sandboxes/lifecycle/) |
| Run all of it yourself | [Self-host quick start](/self-hosting/quickstart/) |
| Look up a route | [API reference](/api/reference/) |

Parts still being built carry an **Experimental** badge in the sidebar and a note at the top of the page.

Kantel was called Harbour, and a few names keep that: `harbour` in some image, database and Worker names, `HARBOUR_*` settings (read when the `KANTEL_*` one isn't set) and API keys starting `hbr_`. Write them as they are.
