---
title: What works today
description: What Kantel has been shown doing on real machines, what is covered by tests only, what hasn't been shown yet, and the limits of the machines it runs on.
---

Kantel is still being built, and this page is the plain summary. Read it before you rely on any part of it.

**Shown** means someone ran it on a real machine and recorded the result, not only in an automated test. Most of those runs used two kinds of setup:

- **The bare-metal host**: an AMD EPYC 7401P (48 vCPU, 125 GB) on Linux 7.2.7 with `kvm_amd nested=1` and Firecracker v1.17.0. `kantel-host` ran in a privileged container with `/dev/kvm`, not as the systemd service the installer sets up.
- **A local install**: the self-hosted Docker Compose stack on one machine, over Postgres, with email codes through a local mail catcher, and a real `kantel-host` in a privileged container with KVM.

**Tests only** means automated tests: the compute API with a TypeScript stand-in for `kantel-host`, the built-in stub backend, Go unit tests, or real-VM tests that weren't run for that change. Neither label promises it works on your machine.

## Shown on real machines

| Area | What was shown |
| --- | --- |
| microVMs | Create, exec and files through the SDK on the bare-metal host, with creates from a size's template snapshot in about 210 to 240 ms. A clean install from the published release fetched its kernel and image, checked them against `SHA256SUMS`, and ran sandboxes from them |
| Isolates | Create and exec on the bare-metal host and on local installs, beside microVMs |
| Inside a microVM | Docker (`docker run hello-world`) and nested KVM (`/dev/kvm`) in the default Ubuntu image, on the bare-metal host |
| Stop, resume and fork | Stop with memory and resume, stop without memory and a cold resume, fork, and fork of a stopped sandbox, on the bare-metal host. A live fork ran in a protected-variables check on a real install |
| Snapshots | A stopped sandbox keeps its memory and disk snapshot, and resumes from it, on the bare-metal host |
| Custom images | microVMs on stock `debian:trixie`, `alpine:3.22` and `busybox:1.37`, and `--inject-guest-agent` on stock Alpine on a local install |
| Desktop and browser | The desktop through the relay, to drive and to watch only, and Playwright `connectOverCDP` from outside the sandbox loading a page, on the bare-metal host, including in forks and after a cold resume |
| SSH | `kantel ssh` login, `--exec`, `scp` and `-L` port forwarding through the relay, with keys from `sshAuthorizedKeys`, on the bare-metal host |
| Egress proxy and grants | Default deny with an allow list, refusals of metadata and private addresses, and an allow-list change taking effect without a reboot, on Firecracker VMs on the bare-metal host |
| Protected variables | A protected `GH_TOKEN` swapped on the way out to the real `api.github.com`, with the sandbox only ever holding the placeholder, on a real Firecracker host |
| Account hosts | With `KANTEL_ACCOUNT_HOSTS=experimental` on a local install, a member who isn't an admin added a machine of her own and ran a microVM on it. Other people's sandboxes stayed on the shared host, they couldn't see hers, and drain and removal worked. Under `wrangler dev`, the printed join command installed a released `kantel-host` in a systemd container, which registered and ran an isolate |
| Organisations and API keys | Making an organisation, an invite code, an email invite accepted through the mail catcher, and a key whose secret shows once, on local installs |
| Mounts | With `KANTEL_MOUNTS=experimental` on a local install with a real host: bundle mounts, and bucket mounts from MinIO and from a real Google Cloud Storage bucket read with a service account's JSON key. The files matched the store's checksums, every write failed as read-only, a second sandbox read them from the host's cache, and the mount came back after a stop and resume. The key was nowhere in the guest, or in the host's or gateway's logs. Signed file URLs and archive extraction worked on the same kind of install |
| Usage graphs | Live CPU and memory graphs for a microVM, isolates and their host on a local install with `kantel-host` from main, compared against `top` |
| Self-hosted install | The Compose installer from nothing, upgrades with `--upgrade` that keep data, and `kantel-admin`, on local machines |
| Hosted service | At app.kantel.dev: email-code sign-in to a new personal space, and **Add a host** printing the join command. New without a host refuses, as it should |
| CLI | `new`, `exec`, `exec -d`, `push`, `attach`, `ps`, `ssh` and `scp` against a local install and the bare-metal host |
| TypeScript SDK | The end-to-end run on the bare-metal host went through the public SDK |

## Shown in tests only

- **The deno_core isolate runtime** (`kantel-isolate`): its integration suite covers the shell, `node` and `python`, egress tagging, and stopping runaway loops and memory bombs without slowing a neighbouring sandbox, on the stock V8 and on the build with V8's heap sandbox. Its real-VM test, through `kantel-host` in Firecracker, ran files, `node`, `python`, loop containment and restores from a template on the sandboxed build. Neither has been recorded on the bare-metal host or a deployed install.
- **Upgrading an isolate to a microVM**: on one host, a real-VM test moved files, a link, an executable and a 4 MB file into the microVM. Across hosts, only with stand-in hosts.
- **Snapshot history and restore**, and **saved snapshots**: their API and CLI run against the stub backend and the host stand-in.
- **Webhooks**: an endpoint was added on a local install, but delivery and signing are checked in tests only.
- **OpenTelemetry**: export is unit-tested. No run has checked a real collector receiving the data.
- **Public ports**: tested against the stand-in and in real-VM tests. A port served at `kantel.run` on the hosted service hasn't been checked live.
- **Custom sandbox sizes** (the console's vCPU and memory sliders): a real-VM test exists, but wasn't run on VMs for the change. Preset sizes run on real hosts.
- **The MCP server**: `initialize`, `tools/list` and `tools/call` against the stub backend.
- **GitHub and Google sign-in**: tested against mock providers.
- **[GitHub Actions runners](/sandboxes/github-runners/)**: the webhook, the queue and its waits for room, and runners' registration and deletion are tested against stand-ins for GitHub and the hosts. No real job has run on one yet.

## Not shown yet

:::caution
Read these before relying on Kantel for real work.
:::

- **A sandbox on a host joined to app.kantel.dev.** Joining and sandboxes on account hosts have run on local installs and under `wrangler dev`, not recorded end to end on the hosted service.
- **SSH and public ports on app.kantel.dev.** Their live checks were planned after deploy, and no result is recorded.
- **Host updates.** `kantel-host update`, automatic updates, the console's **Update to** (tested against a host stand-in only), `revoke`, `uninstall` and the systemd service on a bare-metal host have not been run. Running sandboxes keeping going through an update is untested.
- **arm64 hosts.** The arm64 `kantel-host` and images are boot-checked in emulation only, never on arm64 hardware.
- **Hosts without KVM.** The `--isolate-runtime native` path has run only in `kantel-host`'s own tests, with an early build of `kantel-isolate`, not installed on a machine without KVM.
- **macOS hosts.** Not built. A host is Linux only.
- **Kantel Connect**, the link through kantel.dev for hosts and control planes that can't reach each other directly, is coming.
- **Snapshots across image updates.** A snapshot is a layer over the image it was made on, so a host that replaces its image orphans older snapshots.
- **A real coding agent session.** No recorded run of Claude Code, Codex or pi working in a sandbox through the CLI or MCP server.

## Platform limits

- **Hosts**: Linux on x86_64 or aarch64, as root, with `ip`, `iptables`, `mkfs.ext4` and `/dev/net/tun`, and 20 GiB of disk and 4 GiB of memory or more. See [Hosts](/hosts/#what-a-host-needs).
- **KVM**: microVMs need `/dev/kvm`. On a cloud VM that means nested virtualisation from the provider. Without KVM a host runs isolates only, for code you trust.
- **Nested virtualisation**: optional. With `kvm_intel nested=1` or `kvm_amd nested=1` on the host, each microVM gets a `/dev/kvm` of its own.
- **Networking**: IPv4 only. IPv6 is switched off on every sandbox's network device, and `ip6tables` drops anything from one.
- **Stock images**: a custom image without systemd has no Docker, and one without the desktop packages has no desktop or browser.
- **Chromium and the egress proxy**: if the proxy intercepts TLS, Chromium reads its own certificate store, not the system one.
- **The self-hosted control plane**: Linux or macOS with Docker and Compose v2. Hosts are Linux whichever you use.
- **The CLI**: one binary for Linux or macOS, on x86_64 or arm64.

## Next

- [Quick start](/quickstart/): sign in at app.kantel.dev and add a host.
- [Self-host quick start](/self-hosting/quickstart/): run all of it yourself.
