---
title: Hosted or self-hosted
description: "The two ways to run Kantel, on your own machines or as Lleverage's hosted service: what each one is for, and what changes between them."
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The hosted service is a small demonstration while the compute plane is built. Plans and billing are shown but take no payment.
:::

Kantel is one product with two ways to run it. The console, the API, the SDK, the CLI and the MCP server are the same in both, so code you write against one works against the other with a different address and key.

## Self-hosted

You run the control plane and the hosts. Everything stays on machines you choose: sandboxes, their disks and snapshots, and the records of who did what.

- The control plane installs with one command on any machine with Docker. See [Install Kantel](/self-hosting/install/).
- Each Linux machine that should run sandboxes joins with one more command, and dials out to the control plane, so it needs no open ports.
- You are the super-admin: you add and remove hosts, invite people, and decide which organisations exist.
- There is no billing. Limits are whatever your machines can carry.

Choose this when the work or its data must stay on your own hardware, when you already have machines to use, or when you want microVMs on a laptop or a server under your desk.

## Hosted

Lleverage runs the control plane and the hosts, and you sign in and start sandboxes. Nothing to install.

- You start with a personal account, and can create or join organisations as on a self-hosted install.
- Lleverage's hosts run the sandboxes, so you can't add your own machines.
- Plans and usage are shown in the console, for a feel of a paid service, but no payment is taken.

Choose this to try Kantel before installing it, or to show it to someone.

## What differs

| | Self-hosted | Hosted |
| --- | --- | --- |
| Who runs the control plane | You, with Docker on one machine | Lleverage |
| Who runs the hosts | You: any Linux machine with KVM | Lleverage |
| Adding hosts | One command per machine | Not available |
| Super-admin area | Yours | Lleverage's |
| Plans and billing | None | Shown, no payment taken |
| Where data lives | Your machines | Lleverage's |

<!-- Sources (e496aeb): apps/site/public/install.sh:1-25, deploy/compose/compose.yaml:1-40 -->
