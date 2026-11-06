---
title: Quick start
description: From nothing to a running sandbox on a Linux machine of your own, with Kantel's hosted service at app.kantel.dev. Sign in with an email code, add your machine as a host with one command, then install the kantel CLI and create a sandbox.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The hosted service, hosts of your own and the compute API may still change. [What works today](/what-works-today/) says what has run on real machines so far.
:::

Kantel's hosted service runs the control plane for you at <https://app.kantel.dev>. You bring the Linux machines that run your sandboxes: a sandbox only ever runs on a host of your own account, so you add one before your first sandbox. This page signs you in, adds one machine as a host, and starts a sandbox on it.

To run the control plane yourself as well, see [Self-host quick start](/self-hosting/quickstart/).

## What you need

- A Linux machine on x86_64 or aarch64, with `/dev/kvm` and root. Bare metal works, and so does a cloud VM with nested virtualisation turned on. Plan for at least 20 GiB of free disk and 4 GiB of memory. It needs outbound HTTPS only: no open ports. (A machine without KVM can run isolates only, for code you trust, with extra setup: see [Without KVM](/hosts/#without-kvm).)
- Node.js 22 or later and `curl` on the machine you work from, for the `kantel` command, on Linux or macOS.

## 1. Sign in

Open <https://app.kantel.dev>, enter your email address and select **Email me a code**. Enter the six-digit code from the email. A code works once, for 10 minutes.

You start in your personal space, where your hosts, sandboxes and keys are your own. To share them with a team, [make an organisation](/accounts/organisations/) and invite people to it.

## 2. Add a host

Open **Settings**, then **Hosts**, and select **Add a host**. (Until you have one, the **Sandboxes** page links there too: **Add a host of your own**.) It shows a command with a one-time token for the space you're in. Run it on the Linux machine:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://app.kantel.dev --token kth_…
```

The installer fetches `kantel-host` from Kantel's latest GitHub Release and checks it against the release's `SHA256SUMS`. It then downloads Firecracker and the sandbox images (about 1 GB), registers the machine and starts the `kantel-host` systemd service. The token works once, for an hour.

The host connects out to Kantel and keeps that connection open, so it can sit behind NAT, at home or on a tailnet. It shows up on the **Hosts** page as **Joining**, then **Online**. Once the CLI is installed, `kantel hosts add <name>` prints the same command. See [Your own hosts](/own-hosts/) for more machines and where sandboxes go.

## 3. Install the CLI and sign in

```sh
curl -fsSL https://kantel.dev/cli.sh | sh
kantel login
```

The first line installs `kantel` in `~/.local/bin`, with no sudo, and works in bash, zsh and fish. `kantel login` opens the console to approve the sign-in: check that the code matches the one in your terminal, and select **Approve**. The CLI gets an API key of its own, which lasts 90 days. See [Command line](/tools/cli/#install-it) for the installer's options.

## 4. Your first sandbox

```sh
kantel new --type microvm --name first
```

```text
Created sbx_4kq9x2mt (first): microvm default, running.
  Run a command:  kantel exec sbx_4kq9x2mt -- echo hello
  Stop it:        kantel stop sbx_4kq9x2mt
```

Without `--type` you get an isolate, which starts in milliseconds. You can also press **New** on the console's **Sandboxes** page. Run commands in it, open a shell, and look at its desktop:

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
- [Your own hosts](/own-hosts/): more machines, and where sandboxes go.
- [Organisations](/accounts/organisations/): share hosts and sandboxes with a team.
- [Environments and protected variables](/sandboxes/environments/): give sandboxes credentials they can use but never read.
- [Command line](/tools/cli/): everything `kantel` does.
