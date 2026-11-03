---
title: Quick start
description: From nothing to a running microVM on a Linux machine of your own, with Kantel's hosted service at app.kantel.dev. Sign in, add your machine as a host with one command, then create a sandbox from the kantel CLI.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The hosted service, hosts and the compute API may still change. The sandbox images are published for x86_64.
:::

Kantel's hosted service runs the control plane for you at <https://app.kantel.dev>. You bring the Linux machines that run your sandboxes. This page signs you in, adds one machine as a host, and starts a sandbox on it.

To run the control plane yourself as well, see [Self-host quick start](/self-hosting/quickstart/).

## What you need

- A Linux machine on x86_64 or aarch64, with `/dev/kvm` and root. Bare metal works, and so does a cloud VM with nested virtualisation turned on. Plan for at least 20 GiB of free disk and 4 GiB of memory. It needs outbound HTTPS only: no open ports.
- Node.js 22 or later and `curl` on the machine you work from, for the `kantel` command.

## 1. Sign in

Open <https://app.kantel.dev>, enter your email address and select **Email me a code**. Enter the six-digit code from the email. A code lasts 10 minutes.

You start in your personal space, where your hosts, sandboxes and keys are your own. To share them with a team, [make an organisation](/accounts/organisations/) and invite people to it.

## 2. Add a host

On the console's **Hosts** page, select **Add a host**. It shows a command with a one-time token for the space you're in. Run it on the Linux machine:

```sh
curl -fsSL https://kantel.dev/host.sh | sudo sh -s -- --url https://app.kantel.dev --token kth_…
```

The installer fetches `kantel-host` from Kantel's latest GitHub Release and checks it against the release's `SHA256SUMS`. It then downloads Firecracker and the sandbox images (about 1 GB), registers the machine and starts the `kantel-host` systemd service. The token works once, for an hour.

The host connects out to Kantel and keeps that connection open, so it can sit behind NAT or a home router. It shows up as **Online** on the **Hosts** page. To check a machine before it joins, or to add more, see [Hosts](/hosts/).

## 3. Install the CLI and sign in

```sh
curl -fsSL https://kantel.dev/cli.sh | sh
kantel login --url https://app.kantel.dev
```

The first line installs `kantel` in `~/.local/bin`, with no sudo, and works in bash, zsh and fish. `kantel login` opens the console to approve the sign-in: check that the code matches the one in your terminal, and select **Approve**. The CLI gets an API key of its own, which lasts 90 days.

## 4. Your first sandbox

```sh
kantel new --type microvm --name first
```

```text
Created sbx_4kq9x2mt (first): microvm default, running.
  Run a command:  kantel exec sbx_4kq9x2mt -- echo hello
  Stop it:        kantel stop sbx_4kq9x2mt
```

Run commands in it, open a shell, and look at its desktop:

```sh
kantel exec sbx_4kq9x2mt -- uname -a
kantel ssh sbx_4kq9x2mt
kantel desktop sbx_4kq9x2mt
```

When you're done:

```sh
kantel stop sbx_4kq9x2mt            # keep its disk
kantel delete sbx_4kq9x2mt --yes    # or delete it for good
```

## Next

- [Use from your coding agent](/coding-agents/): Claude Code, Codex and pi.
- [Hosts](/hosts/): more machines, labels and where sandboxes go.
- [Organisations](/accounts/organisations/): share hosts and sandboxes with a team.
- [Command line](/tools/cli/): everything `kantel` does.
