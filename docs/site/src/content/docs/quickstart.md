---
title: Quickstart
description: Run Kantel yourself, from nothing to a microVM you can open a shell and a desktop in. Install the control plane, build the kantel and kantel-admin commands, join a Linux host, then start, use and delete your first sandbox.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Hosts, the compute API and its commands may still change. Kantel's commands aren't on npm yet, so this page builds them from the repository; the sandbox images are published for x86_64. Expect the steps to get shorter.
:::

This page goes from nothing to a running microVM on a Linux machine of your own. It puts the control plane and the host on one machine, which is the quickest way to try it. To use separate machines, see [Hosts](/hosts/).

## What you need

- A Linux machine on x86_64 or aarch64, with `/dev/kvm` and root. Bare metal works, and so does a cloud VM that has nested virtualisation turned on. Plan for at least 20 GiB of free disk and 4 GiB of memory.
- Docker with the Compose v2 plugin, for the control plane. See [Install Kantel](/self-hosting/install/#what-you-need).
- To build the commands: `git`, Node.js 22 or later, [pnpm](https://pnpm.io/) 10 (`npm install -g pnpm@10`) and Go 1.26 or later.

## 1. Install the control plane

```sh
curl -fsSL https://kantel.dev/install.sh | sh
```

The console is then at <http://127.0.0.1:58090/>. [Install Kantel](/self-hosting/install/) explains signing in and the installer's options.

## 2. Build the commands

`kantel` drives sandboxes, and `kantel-admin` runs the install and its hosts. Build both from Kantel's repository:

```sh
git clone https://github.com/lleverage-ai/kantel.git
cd kantel
pnpm install --frozen-lockfile --filter '@kantel/cli...' --filter '@kantel/admin...'
pnpm --filter @kantel/cli build
pnpm --filter @kantel/admin build
npm install -g ./packages/cli/dist ./packages/admin/dist
kantel version
kantel-admin version
```

Keep the clone: you build the host agent from it next.

## 3. Save the first API key

```sh
kantel-admin bootstrap-key --save
kantel-admin status
```

`bootstrap-key --save` saves the deployment's first API key for `kantel` and `kantel-admin`. That key can do everything, so keep it to yourself.

The control plane always serves the compute API, and runs sandboxes on the hosts you add. `status` should say:

```text
backend     your hosts
public URL  none: hosts on this machine join at http://127.0.0.1:58090
```

That address is where the host connects to, and where your desktop, browser and SSH links point, so both the host and your browser need to reach it. On one machine, the console's own address does. For hosts on other machines, set a public URL: see [Hosts](/hosts/#add-a-host).

## 4. Build the host agent

A host runs `kantel-host`, which boots every sandbox from a kernel and a disk image. From the root of the clone:

```sh
(cd apps/host && CGO_ENABLED=0 go build -trimpath -o dist/kantel-host ./cmd/kantel-host)
```

The kernel and images are published: the installer fetches them in the next step and checks each one's SHA-256. The default sandbox is Ubuntu 26.04 with Docker, an XFCE desktop, Chromium and SSH. The published set is for x86_64; on an aarch64 machine, build your own, as [Hosts](/hosts/#get-kantel-host-and-the-images) shows, and add `--images ~/kantel-images` to the install.

Check that the machine can run sandboxes:

```sh
sudo apps/host/dist/kantel-host doctor
```

The `kvm`, `root`, `ip`, `iptables`, `mkfs.ext4`, `cp` and `tun` lines must say `ok`. On a machine that has never been a host, the `disk` line reads 0 GiB because `/var/lib/kantel-host` doesn't exist yet: check the free space with `df -h /var/lib` instead. [Hosts](/hosts/#check-a-machine) explains each line.

## 5. Join the host

Make a join token, with **Add a host** on the console's **Hosts** page or with:

```sh
kantel-admin host add --name host-1
```

```text
Run this on the machine as root, before 2026-11-03 10:37 UTC:

  sudo npx -y @kantel/host@latest install --url http://127.0.0.1:58090 --token kth_…
```

The `@kantel/host` package isn't on npm yet, so run the binary you built in its place, with the same URL and token:

```sh
sudo apps/host/dist/kantel-host install --url http://127.0.0.1:58090 --token kth_…
```

It copies itself to `/usr/local/bin/kantel-host`, downloads Firecracker and the images (about 1 GB), registers with the control plane and starts the `kantel-host` systemd service. The token works once. Then:

```sh
kantel-admin host list
```

```text
ID                 NAME    STATE   VERSION  TYPES    SANDBOXES  SEEN
host_u7nfa06bgsim  host-1  online  dev      microvm  0          just now
```

## 6. Your first sandbox

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
kantel ssh sbx_4kq9x2mt --exec
kantel desktop sbx_4kq9x2mt
```

`kantel ssh` makes a key pair, lets it in and connects through the control plane's relay. `kantel desktop` opens the sandbox's desktop in your browser. Neither needs an open port on the host or the sandbox. See [SSH](/sandboxes/ssh/) and [Desktop and browser](/sandboxes/desktop-and-browser/).

The sandbox reaches the internet through its host's [egress proxy](/sandboxes/egress-proxy/), which you can limit to named sites. When you're done:

```sh
kantel stop sbx_4kq9x2mt            # keep its disk
kantel delete sbx_4kq9x2mt --yes    # or delete it for good
```

## Next

- [Hosts](/hosts/): more machines, labels, where sandboxes go, updates and removing a host.
- [Egress proxy](/sandboxes/egress-proxy/): allow and deny lists, and your own upstream proxy.
- [Command line](/tools/cli/): everything `kantel` does.
- [Install Kantel](/self-hosting/install/#your-own-settings): sign-in email, a TLS address and the other settings.

<!-- Sources (5be456c): packages/admin/src (compute enable, bootstrap-key, host add), packages/admin/scripts/build.ts, packages/cli/scripts/build.ts, apps/host/cmd/kantel-host/install.go:70-190, apps/host/cmd/kantel-host/manifest.go, apps/host/guest/README.md, apps/host/guest/rootfs.sh, apps/host/guest/kernel/build.sh, apps/selfhosted/src/gateway/compute.ts:1-45 (00d22cc), deploy/compose/compose.yaml:325-340 (00d22cc), packages/admin/src/admin.ts:330-366 (00d22cc). Run end to end on a local stack for TASK-4706. -->
