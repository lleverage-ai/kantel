---
title: Hosts
description: Add your own Linux machines as the hosts that run your sandboxes, on app.kantel.dev or a self-hosted control plane. Check a machine first, link it directly or over a private network such as Tailscale, choose which host a sandbox goes on with labels, and update, drain, revoke or remove a host later.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
`kantel-host`, its settings and the hosts API may still change.
:::

A host is a Linux machine that runs sandboxes. It runs `kantel-host`, which boots microVMs with Firecracker, and isolates with workerd inside a microVM. The host dials out to the control plane over a WebSocket and keeps that connection open, so it needs no inbound port and can sit behind NAT. A sandbox stays on the host it started on, since its disk and memory are there.

You bring the hosts, whether you use the hosted control plane at app.kantel.dev or run your own. [Quick start](/quickstart/) adds one host to app.kantel.dev, and [Self-host quick start](/self-hosting/quickstart/) joins one on the control plane's own machine. This page covers each step in full, for any number of machines.

## How a host reaches Kantel

A host only ever connects out, to the control plane's URL. That URL decides the link:

| Link | How | Use it for |
| --- | --- | --- |
| Direct | The control plane's public HTTPS URL, such as `https://app.kantel.dev` | app.kantel.dev, or a self-hosted control plane with a public address. The host needs outbound HTTPS only |
| Private network | The control plane's address on a network the host shares with it, such as a Tailscale tailnet | A self-hosted control plane that shouldn't be on the internet. See [Over a private network](#over-a-private-network) |

Kantel Connect, a link through kantel.dev for hosts and self-hosted control planes that can't reach each other directly, is coming.

## What a host needs

| | |
| --- | --- |
| System | Linux on x86_64 or aarch64 |
| KVM | `/dev/kvm`, readable and writable by root. A cloud VM needs nested virtualisation from its provider. Without KVM a host runs isolates only, and only for code you trust (see [Without KVM](#without-kvm)) |
| Nested virtualisation | Optional. With `kvm_intel nested=1` or `kvm_amd nested=1`, every sandbox gets a `/dev/kvm` of its own |
| Root | `kantel-host` makes TAP devices and iptables rules |
| Tools | `ip`, `iptables`, `mkfs.ext4`, `cp`, and `/dev/net/tun` (`modprobe tun`). For bundle mounts (experimental), `mkfs.erofs` from erofs-utils too |
| Disk and memory | 20 GiB free under `/var/lib/kantel-host` and 4 GiB of memory, or more |
| File system | Any. XFS (made with reflinks, the default in current `mkfs.xfs`) or btrfs is best for `/var/lib/kantel-host`: snapshots, forks and sandboxes made from them then share disk blocks with what they were copied from until those blocks change, so each one costs only what differs. On ext4 each is a full copy of the sandbox's disk |
| Network | Outbound to the control plane's public URL. When installing, also to GitHub, for `kantel-host`, Firecracker and the images |

## Check a machine

To check a machine before it joins, run the installer with `--check`. It downloads `kantel-host` into a temporary directory, checks it against `SHA256SUMS`, runs its `doctor` from there and installs nothing:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --check
```

```text
ok      kvm                    /dev/kvm opens read-write
ok      nested virtualisation  kvm_amd nested=1
ok      root                   kantel-host runs as root (TAP devices, iptables, /dev/kvm)
ok      ip                     ip
ok      iptables               iptables
ok      mkfs.ext4              mkfs.ext4
ok      cp                     cp
ok      docker                 Docker 28.5.1 builds templates' images
ok      tun                    /dev/net/tun
ok      mkfs.erofs             mkfs.erofs (bundle mounts)
ok      disk                   412 GiB free at /var/lib, which will hold /var/lib/kantel-host (20 GiB or more recommended)
ok      memory                 128776 MiB (4 GiB or more recommended)

This machine can run both tiers: microVMs (Firecracker) and isolates (workerd, inside a microVM).
```

On a machine that already has `kantel-host`, `sudo kantel-host doctor` runs the same checks.

`kvm`, `root`, `ip`, `iptables`, `mkfs.ext4`, `cp` and `tun` are required for microVMs. `doctor` exits 0 only when every required check is `ok`: one that fails says `FAIL`, one it couldn't find out says `unknown`, and either exits 1, so a script can stop there. `disk`, `memory`, `nested virtualisation`, `docker` (which only template builds need) and `mkfs.erofs` (without it, the host offers no bundle mounts) are advice, and say `warn` when they're short. A machine that is itself a VM gets a `host is a VM` line too, which warns without nested virtualisation. With `--isolate-runtime native` (see [Without KVM](#without-kvm)), only `root` is required. `--json` prints the checks as JSON, each with its `state` and whether it's `required`. Options after `--check` that change the checks go on to `doctor`: `--root`, `--config`, `--isolate-runtime` and `--json`.

## Get kantel-host and the images

Each of Kantel's [GitHub Releases](https://github.com/lleverage-ai/kantel/releases) carries `kantel-host` for Linux on x86_64 and arm64 (`kantel-host-linux-amd64`, `kantel-host-linux-arm64`), the host installer `install.sh`, and `SHA256SUMS`. The join command Kantel prints runs that installer from the latest release:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_…
```

The line works the same in bash, zsh and fish, since the script runs under `sh`. It picks the binary for the machine's architecture, downloads it with `SHA256SUMS` from the same release, refuses it if its SHA-256 doesn't match, and then runs `kantel-host install` with the options after `--`. Its own options come first: `--version 0.2.0` installs that release rather than the latest, `--no-join` only puts the binary in `/usr/local/bin`, and `--check` only [checks the machine](#check-a-machine). `--dry-run`, anywhere in the options, [shows what the install would do](#see-what-install-will-do) and changes nothing. Every release file has a build provenance attestation too, which `gh attestation verify kantel-host-linux-amd64 --repo lleverage-ai/kantel` checks.

To build `kantel-host` yourself instead, with Go 1.26 or later:

```sh
git clone https://github.com/lleverage-ai/kantel.git
cd kantel
(cd apps/host && CGO_ENABLED=0 go build -trimpath -o dist/kantel-host ./cmd/kantel-host)
```

Add `GOARCH=arm64` to build it for an aarch64 host on an x86_64 machine, copy `apps/host/dist/kantel-host` to the host, and run `sudo ./kantel-host install --url … --token …` there in place of the join command.

A host also needs a guest kernel and a sandbox image. Kantel publishes them for x86_64 and arm64 as a public [GitHub Release](https://github.com/lleverage-ai/kantel/releases), and the installer fetches the ones for the host's architecture from there by default, so there's nothing to build. The arm64 images are boot-checked in emulation before they're published, not yet on arm64 hardware. The sandbox image is Ubuntu 26.04 with Docker, an Openbox desktop with a dock, Chromium and SSH, and the release also has the isolate image. `manifest.json` lists each file with its SHA-256. The installer reads it, and refuses a file whose digest doesn't match. `THIRD-PARTY-NOTICES.md`, in the release and in the image, says what the images contain and under which licences. The release also carries the exact source of the GPL and LGPL libraries the sandbox image bundles outside a distro package (libx264, x265 and libde265, in Selkies' screen encoder), listed in `SOURCES.md` with their SHA-256.

The installer gets the images from one of two places:

- `--images` on `kantel-host install`: a directory on the host, or an http(s) URL that serves the directory.
- The control plane, at `GET /v1/hosts/images/…`, which redirects to Kantel's published release unless `KANTEL_COMPUTE_IMAGES` says otherwise. That setting is a directory the gateway can read, an http(s) URL it redirects to, or `off`. On the Docker Compose stack, use a URL: the gateway runs in a container, so it can't see a directory on the machine.

To use your own images, such as a custom image, build them on a machine with Docker and Go, and point `--images` or `KANTEL_COMPUTE_IMAGES` at the directory:

```sh
apps/host/guest/kernel/build.sh ~/kantel-images x86_64      # or aarch64
apps/host/guest/rootfs.sh ~/kantel-images sandbox amd64      # or arm64
apps/host/dist/kantel-host manifest ~/kantel-images
```

`apps/host/guest/README.md` lists what's in the image, and shows how to build a custom image on top of it. For isolates, also run `apps/host/guest/rootfs.sh ~/kantel-images isolate amd64`, which needs Bun as well. You can gzip an image first (`sandbox-amd64.ext4.gz`), and the host unpacks it as it downloads.

## Add a host

### On app.kantel.dev

In the console, open **Settings**, then **Hosts**, and select **Add a host** (or run `kantel hosts add <name>`). It makes a one-time token for the space you're in, your personal space or an organisation you're an admin of, and shows the command to run on the machine:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://app.kantel.dev --token kth_…
```

That is the host installer on Kantel's latest GitHub Release, below. The host belongs to that space: only its members' sandboxes run on it. Add any of the [installer's flags](#what-the-installer-does) after the token. See [Your own hosts](/own-hosts/).

### On a self-hosted control plane

A self-hosted control plane runs sandboxes on hosts unless `KANTEL_COMPUTE_BACKEND=stub` says otherwise. Hosts reach it at its local address, `http://127.0.0.1:58090`, which only a host on the same machine can use. For hosts on other machines, tell it the URL where hosts and people reach it:

```sh
kantel-admin compute enable --public-url https://kantel.example.com --apply
```

That sets `KANTEL_PUBLIC_URL`. The same URL goes into every join command and every desktop, browser and SSH link, so your users' browsers need to reach it as well as your hosts. Behind a TLS proxy it is `https://`, and the relay links are then `wss://`. To give hosts a different address from the console's, set `KANTEL_COMPUTE_PUBLIC_URL` instead.

A super-admin can also set the address hosts join at in the console, under **Admin**, **Install**, or in **Add host** when its command shows the loopback address, or with [`PUT /v1/admin/public-url`](/api/reference/hosts/). It goes ahead of the deployment's own for the join commands made from then on, with no restart, and clearing it goes back to the deployment's. It changes only join commands: desktop, browser and SSH links still use `KANTEL_PUBLIC_URL`.

Then make a join token, with [`kantel-admin`](/self-hosting/admin-cli/), on the console's **Hosts** page (shown to a deployment's admins) or with [`POST /v1/admin/hosts/join-tokens`](/api/reference/hosts/):

```sh
kantel-admin host add --name builder-1 --label zone=ams
```

A token works once, and for an hour unless `--expires-minutes` says otherwise. The host takes its name and labels from it. On the machine, run the printed command:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_…
```

### Over a private network

A self-hosted control plane can stay off the internet and reach its hosts over a private network, such as a Tailscale tailnet that the control plane's machine, the hosts and your own computer are all on.

The Compose stack publishes the gateway on `127.0.0.1:58090` only, so first put a proxy in front of it that listens on the private network and nowhere else. On a tailnet, Tailscale Serve does that, and gives it an HTTPS name on the tailnet (the tailnet needs HTTPS certificates turned on):

```sh
sudo tailscale serve --bg 58090
```

Check it from another machine on the tailnet: `curl https://kantel.your-tailnet.ts.net/healthz` should answer `{"ok":true}`. Then use that URL as the public URL:

```sh
kantel-admin compute enable --public-url https://kantel.your-tailnet.ts.net --apply
```

Join commands then carry that address, and hosts connect to it over the tailnet. Your browser needs to reach it too, for desktop, browser and SSH links. To keep the console on another address and give only hosts the tailnet one, set `KANTEL_COMPUTE_PUBLIC_URL` to it instead.

### What the installer does

The installer hands its options to `kantel-host install`, which:

1. checks for `/dev/kvm` and nested virtualisation;
2. copies itself to `/usr/local/bin/kantel-host`;
3. downloads Firecracker v1.17.0 from GitHub, checked against the release's `SHA256SUMS`, then the kernel and the images into `/var/lib/kantel-host/images`. A file that is already there with the right digest isn't fetched again;
4. registers with the control plane, and saves the host's ID and credential in `/etc/kantel-host/config.json`;
5. writes the `kantel-host` systemd unit, then enables and starts it.

Without systemd, such as in a container, install stops after step 4: run `kantel-host run` as root under a supervisor of your own, and restart it when it exits.

Install adds no users or groups, since `kantel-host` runs as root, and changes no sysctl settings. For microVMs, `kantel-host` sets up its own network when it registers (it starts its tiers for a moment to report what the host can run) and each time the service starts: iptables chains `KANTEL-INPUT` and `KANTEL-FORWARD`, jumped to from `INPUT`, `FORWARD` and, on a host with Docker, `DOCKER-USER`, and ip6tables rules that drop its devices' traffic. The service adds a TAP device for each microVM in `10.231.0.0/16`, with IPv6 off on it.

#### Running it again

Every step can run again. A file already in place with the right digest is kept, a download goes to `<name>.part` and only replaces the file once its digest matches, and the settings and the unit are written whole. So if an install stops part way, run the same command again and it carries on:

- Stopped before registering: the token hasn't been used, so the same command starts over and skips what it already fetched.
- Stopped after registering: the host keeps the SHA-256 of the token it registered with (never the token), so the same command carries on without using the token again. Install checks that it can save its settings before it registers, since a registration it couldn't save would leave the token used up.
- With the same `--url` and no token: install updates the binary, the images and the service, and keeps the registration.
- With a different token: the machine registers again with that token.

#### See what install will do

`--dry-run` prints every step: each download with its URL and expected SHA-256, each directory and file it writes with its mode, the systemd unit and the `systemctl` commands, and the registration. Then it exits without changing anything, and without using the token:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --dry-run --url https://kantel.example.com --token kth_…
```

```text
==> Download kantel-host
  get    https://github.com/lleverage-ai/kantel/releases/latest/download/kantel-host-linux-amd64 (sha256 4f1c…, from …/SHA256SUMS): downloaded and checked now, into a temporary directory
==> Check this machine
  check  kvm: /dev/kvm opens read-write
  check  nested virtualisation: kvm_amd nested=1
==> Install kantel-host 0.3.0
  copy   /tmp/tmp.Xb2/kantel-host-linux-amd64 to /usr/local/bin/kantel-host (mode 0755)
==> Fetch Firecracker and the sandbox images
  check  images host-images-20261105.1 from https://kantel.example.com/v1/hosts/images/manifest.json
  mkdir  /var/lib/kantel-host (mode 0755)
  mkdir  /var/lib/kantel-host/bin (mode 0755)
  get    https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-x86_64.tgz (sha256 0609…, from firecracker-v1.17.0-x86_64.tgz.sha256.txt), its firecracker-v1.17.0-x86_64 to /var/lib/kantel-host/bin/firecracker (mode 0755)
  mkdir  /var/lib/kantel-host/images (mode 0755)
  get    https://kantel.example.com/v1/hosts/images/vmlinux-x86_64 to /var/lib/kantel-host/images/vmlinux (sha256 6ae3…, mode 0644)
  get    https://kantel.example.com/v1/hosts/images/sandbox-amd64.ext4.gz to /var/lib/kantel-host/images/sandbox.ext4 (sha256 8500…, unpacked as it downloads, mode 0644)
  get    https://kantel.example.com/v1/hosts/images/isolate-amd64.ext4.gz to /var/lib/kantel-host/images/isolate.ext4 (sha256 e670…, unpacked as it downloads, mode 0644)
==> Register with https://kantel.example.com
  mkdir  /etc/kantel-host (mode 0755)
  post   https://kantel.example.com/v1/hosts/register as "builder-1", which uses the token up
  note   to report what this host can run, registering starts its tiers for a moment, which makes their directories under /var/lib/kantel-host; for microVMs it also makes the bucket mounts' read cache, /var/lib/kantel-host/mount-cache, up to 10240 MiB, and their key, /var/lib/kantel-host/mount-proof.key, and sets up the network rules below
==> Save the settings
  write  /etc/kantel-host/config.json (mode 0600: the control plane, the host's ID and credential, and its settings)
==> Start the service
  write  /etc/systemd/system/kantel-host.service (the kantel-host systemd unit, mode 0644)
  run    systemctl daemon-reload
  run    systemctl enable --now kantel-host
  run    systemctl restart kantel-host
```

It ends with what install leaves to the service, as above. The real output has the full digests. To read the plan, the dry run downloads only the images' `manifest.json` and Firecracker's digest. It needs root, like the install, to see `/dev/kvm` and the settings as the install would. A dry run fails where the install would, such as with no usable `/dev/kvm` or images it can't reach. The plan and the install come from the same list of steps, and the install prints each line as it does it. On a machine that already has `kantel-host`, `sudo kantel-host install --dry-run …` does the same. So does `sudo kantel-host plan …`, which the installer runs: it takes the same options and only ever prints the plan, even if an option swallows `--dry-run` as its value.

| Flag | What it does |
| --- | --- |
| `--url URL` | The control plane's public URL (or `KANTEL_URL`) |
| `--token kth_…` | The join token (or `KANTEL_HOST_TOKEN`) |
| `--name NAME` | The host's name in Kantel. Default: the machine's hostname |
| `--label KEY=VALUE` | A label. Repeat it, or separate several with commas |
| `--images DIR\|URL` | Where to get the kernel and images. Default: the control plane's `/v1/hosts/images` |
| `--tiers LIST` | `microvm`, `isolate` or both, comma-separated. Default: what the machine can run |
| `--isolate-runtime native` | Run isolates with workerd on the host itself, with no KVM. For trusted code only |
| `--proxy-data-path` | Send sandboxes' traffic on to the account's [upstream proxy](/sandboxes/egress-proxy/#send-traffic-through-your-own-proxy). Experimental |
| `--inject-guest-agent` | Boot microVMs through Kantel's initramfs, which puts the guest agent into [any Linux image](/sandboxes/custom-images/). Experimental |
| `--root DIR` | Where sandboxes live. Default `/var/lib/kantel-host` |
| `--config FILE` | The settings file. Default `/etc/kantel-host/config.json` |
| `--no-start` | Install and register, but don't start the service |
| `--dry-run` | Print what the install would do, and change nothing. See [See what install will do](#see-what-install-will-do) |

Put any of these after the token in the join command. `sudo kantel-admin host join --url … --token …` on the machine runs the same installer, and `kantel-admin host add --ssh root@builder-1` runs the printed command on the machine over SSH.

### Without KVM

A machine with no usable `/dev/kvm` can still run isolates, with workerd straight on the host rather than inside a microVM:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_… --tiers isolate --isolate-runtime native --images …
```

workerd isn't a hardened sandbox, so give such a host only code you trust. Its images need `workerd-amd64` (or `workerd-arm64`) in the manifest, and the repository has no script yet that puts it there.

## Check on a host

On the host:

```sh
sudo kantel-host status
sudo kantel-host sandboxes
sudo kantel-host sandboxes show sbx_…
journalctl -u kantel-host -f
```

`status` prints the agent's version, the control plane it's registered with, its host ID, whether the service is active and how many sandboxes it holds in each state. `sandboxes` lists them: ID, type, size, state, the account that owns each, its base image version, its address on the host and when it was made. `sandboxes show` prints one in full, and `--json` gives either as JSON. Both read the running service over a socket only root can use (`/run/kantel-host/agent.sock`; `controlSocket` in the config moves it, `"off"` turns it off), and they only read: stop or delete a sandbox through Kantel (`kantel stop`, or the console), which keeps the record of every sandbox. The journal has the connection, each sandbox the host starts, and the [egress proxy's](/sandboxes/egress-proxy/#what-a-refusal-looks-like) decisions.

From anywhere, with a key that has `hosts:admin`:

```sh
kantel-admin host list
kantel-admin host info host_u7nfa06bgsim
```

```text
ID                 NAME       STATE   VERSION  TYPES    SANDBOXES  SEEN
host_u7nfa06bgsim  builder-1  online  dev      microvm  1          just now
```

A host is `online`, `draining`, `unreachable` (registered, but not connected now) or `revoked`. `host info` adds its machine, whether it has KVM, its labels and when it joined.

Every 5 seconds a host also sends Kantel its CPU, memory and disk, and each running sandbox's CPU and memory, and a microVM's disk and IO pressure. It measures CPU and memory from its own side and runs nothing in a sandbox to do it; only the guest knows its disk and IO, so its agent answers those:

- A microVM's CPU is its Firecracker process's CPU time as a share of its vCPUs. Its memory is what the guest itself counts as used, its total less its available memory, as `free -m` shows it in the guest. The guest's kernel reports those figures to Firecracker through a virtio-balloon device that only reports (it never takes memory from the guest), and the host reads them from Firecracker, so nothing runs in the sandbox. Page cache isn't counted, and the figure falls when the guest frees memory.
- A microVM restored from a snapshot made before the host had that device (or one on a kernel without `virtio_balloon`) can't report, so its memory is its Firecracker process's resident memory instead: the guest memory the VM has touched, page cache included. A microVM doesn't give that memory back to the host, so that figure stays near its high point after a spike. Each reading says which it is (`memSource`, `guest` or `rss`, on the host's link).
- A microVM's disk is its own disk as `df` counts it in the guest, and its IO pressure is the share of the interval in which at least one of its tasks waited on IO (the guest kernel's `/proc/pressure/io`, `some`). The host asks the guest's agent for both, waiting at most half a second, so a guest that doesn't answer in time, or whose agent predates them, has neither in that reading. The guest kernel has pressure figures only when booted with `psi=1`, which hosts from this version add: a sandbox restored from a snapshot made before has disk but no IO pressure until it boots from scratch, and the host makes its templates again once.
- An account's isolates share one runtime, so the host measures the runtime and shares it out. Each isolate's CPU is its part of the runtime's CPU time, split by how long each spent running commands, as a share of one CPU. The runtime's memory is split evenly.
- The disk is the file system the host's data directory (`/var/lib/kantel-host`) is on.

The host keeps each reading until Kantel confirms it has it, up to the last 120 readings (10 minutes' worth at the default interval). Kantel confirms a reading once the gateway holding the host's connection has added it to the sandbox's usage. If the connection drops or stalls, the host sends every unconfirmed reading again, oldest first, when it reconnects, so readings already sent into a connection that then failed aren't lost. Kantel ignores a reading it already has, so nothing appears twice in the usage or the [OpenTelemetry export](/monitoring/opentelemetry/), even when the host reconnects to a different gateway. A confirmation covers that reading and every earlier one. If Kantel can't add a reading, for example while its database is unavailable, it doesn't confirm it or any later one until it has added them all in order, so a failed reading is never skipped. If more than 120 readings go unconfirmed, for example because Kantel was out of reach for longer than 10 minutes, the oldest are dropped and the host logs how many.

A host that predates this sends each reading once, and a reading sent into a connection that then fails is lost. The same applies to a newer host connected to a Kantel that predates it.

### What takes the disk

Every 5 minutes a host also measures what takes the space on its disk and sends it with its next heartbeat. The host record has it as `diskUsage`: the filesystem's size and used bytes, then the bytes of saved snapshots, automatic snapshots, sandboxes (their disks, and their memory while stopped), base images, templates, the bundle cache, and everything else (`otherBytes`, the operating system, logs and other programs). Each file counts once, in the first of those it's in, and in the order bundles, images, templates, sandboxes, then snapshots. So memory a stop's snapshot shares with its sandbox counts for the sandbox. In the console, open a host's row on the Hosts page to see it under the host's graphs. A host that predates this doesn't measure it, and its record has no `diskUsage`.

A host's admin can also limit how much each account keeps in saved snapshots on it, with `savedSnapshotBytesLimit` on the host (`PATCH /v1/admin/hosts/{hostId}`, or `PATCH /v1/hosts/{hostId}` for an account's own host), or **Saved snapshot limit** in the host's menu in the console. A save that would take an account past the limit answers `429` with `exhausted`, saying what the account has saved there. The same bytes saved twice count once. `null` removes the limit.

### Top processes

A running microVM's busiest processes aren't part of the readings: Kantel asks for them only when something wants them, such as the console's metrics dialog, which asks every 10 seconds while it's open (`GET /v1/sandboxes/{sandboxId}/processes`, which needs the `exec` scope, as running `ps` would). The host passes the request to the guest's agent, which reads `/proc` twice half a second apart and answers the busiest processes by CPU, then memory: each one's PID, command line (up to 1 KiB of it), CPU as a share of one vCPU (150% is one and a half) and resident memory. Nothing is kept.

An isolate's processes aren't listed: an account's isolates share one runtime, so its processes are the other isolates' too. A host that predates this doesn't say it can list processes, and Kantel doesn't ask it. A microVM whose guest agent predates this (one booted on an older image, or resumed from a snapshot taken before) can't answer either, until it boots on a current image. For each of these the API answers `not_supported` and the console says the sandbox's host can't list its processes yet.

## Where sandboxes go

Kantel picks a host when a sandbox is created. A host can take the sandbox if it is connected, not draining or revoked, runs the sandbox's type, offers its size, has every label the sandbox asks for, and has the memory and disk free. Among those, Kantel prefers, for an isolate, a host already running the account's isolates, then the most free memory, then the lowest load.

Once placed, a sandbox stays on its host. Stop, start, resume and fork all happen there, and so does a sandbox made from one of its snapshots.

To keep a sandbox on certain hosts, give the create `hostLabels`. The host must have every label:

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"type": "microvm", "hostLabels": {"zone": "ams"}}'
```

To put it on one host, give the create `host`, the host's ID or name. A super-admin may name any host; anyone else may name one of the account's [own hosts](/own-hosts/), and naming any other host answers `not_found`. When that host is offline, draining, doesn't run the type or lacks a label in `hostLabels`, the create answers `503` `unavailable` with `details.reason` `host_unavailable`, rather than placing the sandbox elsewhere. From the command line, and in the console's New sandbox under Host:

```sh
kantel create --type microvm --on builder-1
kantel create --type microvm --host-label zone=ams
kantel list --on builder-1
```

A sandbox's `hostId` and `hostName` say where it runs, as `kantel info` and its page in the console do. A super-admin is shown every sandbox's host; anyone else is shown it when it is one of the account's own hosts. `kantel list --on <host>` (the API's `host` query) lists only the sandboxes on one host. When no host can take a sandbox, Kantel says why: the create answers `503` with `unavailable` and `details.reason` `no_host_with_labels` when no host has the labels, and a sandbox whose matching hosts are all full goes to `error` with `placementReason` `insufficient_capacity`. [When it can't be placed](/sandboxes/lifecycle/#when-it-cant-be-placed) lists them.

A host offers three microVM sizes unless its settings say otherwise:

| Size | vCPUs | Memory | Disk |
| --- | --- | --- | --- |
| `small` | 1 | 1 GiB | 10 GiB |
| `default` | 4 | 2 GiB | 20 GiB |
| `large` | 4 | 8 GiB | 50 GiB |

A create can also ask for any vCPUs and memory with `resources`, such as `{"type": "microvm", "resources": {"vcpus": 3, "memoryMb": 6144}}`. A shape that matches a size goes as that size; any other goes only to a host whose `kantel-host` makes custom shapes. Its disk is the smallest size's with at least its memory, unless it asks for one or starts from a snapshot, which keeps that snapshot's disk; the sandbox's `resources` say what it got. A snapshot that holds its sandbox's memory (a pause) restores only into the machine it was taken of, so a create from one leaves `resources` and `size` out, or asks for that machine; another is refused (`invalid`) before anything is made. `GET /v1/sandbox-shapes` says what the hosts you may use offer.

A microVM's disk can be chosen apart from its vCPUs and memory: `resources.diskGb`, with them or alone (`{"type": "microvm", "size": "large", "resources": {"diskGb": 60}}`), or `kantel new --type microvm --disk 60`. A host gives a disk off its sizes from `microvm.minDiskGiB` to `microvm.maxDiskGiB`, and only when it has that much disk free; `GET /v1/sandbox-shapes` says the range (`microvm.diskGb`), at most the most disk any host you may use had free when it last said. A host keeps a sandbox's disk through a stop, a start and a fork, and a disk is never shrunk.

Hosts keep no warm microVMs waiting for a create, hosted or self-hosted: an idle VM holds its memory, and the machine may be doing other things. A create restores a template snapshot from the host's disk instead, in a few hundred milliseconds. A host keeps one template per vCPU count, whatever the memory and disk: a sandbox restored from it is given the rest of its memory (virtio-mem) and has its disk grown. The host makes the sizes' counts in the background when it starts, about a gigabyte of disk each; the first create of another count boots from scratch, in a few seconds, while that count's template is made for the next. Once one is made, the host removes any template it kept per size (an update from a version before these), as no create uses them. With `microvm.sharedTemplate` set to `false` in the settings file, a host keeps a template per size instead, made the first time the size is asked for, and a shape off the sizes always boots from scratch. `KANTEL_COMPUTE_POOLS`, which once set warm pools, is ignored with a warning. A `kantel-host` from before then is told to keep none, so it makes no more. It can't end a warm VM it already has: its next create of that size takes it, and updating the host (the new version clears them when it starts) ends the rest.

An isolate's `resources` is its memory alone, 128 to 512 MB in steps of 64 (256 by default); it shares its account's VM's CPU. Kantel records what it asked for, but workerd can't hold one isolate to a memory limit yet: the account's VM's memory is the limit its isolates share.

## Update a host

The control plane checks Kantel's latest `kantel-host` release about once an hour. The console's **Hosts** page marks a host that runs an older version **Out of date** and counts those hosts over the table. To update one, choose **Update to** *version* from the host's **⋯** menu. The host downloads that release, checks it against the release's `SHA256SUMS` and restarts on it. The row shows **Updating to** *version* until the host connects on the new version, usually within seconds. Its sandboxes keep running, but SSH sessions, terminals and port connections to them through Kantel drop while the host reconnects. `kantel-admin host update <hostId>` and `POST /v1/admin/hosts/{hostId}/update` do the same, and an account's own hosts are updated with `POST /v1/hosts/{hostId}/update`.

Nothing updates on its own this way: a host moves only when someone asks. A host that is offline can be updated once it's back. A host on a newer prerelease or its own build isn't marked. To read the latest release from a mirror, set `KANTEL_HOST_RELEASES` to a URL that answers `{"tag_name": "v0.4.2"}` or `{"version": "0.4.2"}`; set it to `off` to stop checking.

### Check for updates now

To see a release that came out within the hour, choose **Check for updates** on the **Hosts** page (a super-admin's, for the deployment's hosts). The control plane reads the latest release again at once, and hosts behind it show **Update to** straight away. `kantel-admin host check-for-updates` and `POST /v1/admin/hosts/check-for-updates` do the same. Every replica of the control plane sees the check through its database and reads again within about 10 seconds. One check every 30 seconds is all that's made: within that, a check answers what the last one found. A check never names a version, and the control plane only trusts what it reads from the release itself.

Kantel's release workflow asks app.kantel.dev for a check as it publishes a release, so hosted users see it within a minute. A self-hosted control plane can be told the same way, from a release hook or a scheduled job of your own: set `KANTEL_RELEASE_CHECK_TOKEN` on the control plane to a secret of at least 32 characters, then call

```sh
curl -fsS -X POST -H "Authorization: Bearer $KANTEL_RELEASE_CHECK_TOKEN" https://kantel.example.com/v1/hosts/releases/check
```

It answers `{"checked": true, "latestVersion": "0.4.2"}`, or `"checked": false` within 30 seconds of the last check. Without the setting the control plane refuses these calls (403), and a wrong token is a 401. Either way it still reads the release every hour.

On the machine itself:

```sh
sudo kantel-host update                  # the latest release
sudo kantel-host update --version 0.2.0  # or a given one
```

`update` downloads the release's binary for the machine, checks it against the release's `SHA256SUMS`, replaces `/usr/local/bin/kantel-host` and restarts the service. `--url` takes a binary from elsewhere instead, unchecked, and one ending `.gz` is unpacked. Running sandboxes keep running through the restart, and the new agent takes them over.

To have hosts update themselves, set the version you want on the control plane:

```sh
kantel-admin config set KANTEL_HOST_VERSION=0.2.0 --apply
```

Every connected host on another version then fetches that version from Kantel's GitHub Release, checks it against the release's `SHA256SUMS`, and restarts into it. To serve the binaries yourself, also set `'KANTEL_HOST_UPDATE_URL=https://downloads.example.com/{version}/kantel-host-{os}-{arch}'`. A host fetches that URL, with `{os}` as `linux` and `{arch}` as `amd64` or `arm64`, and restarts into it. `kantel-admin host list` and the console show the version beside each host that hasn't moved yet. With `KANTEL_HOST_VERSION` set, the console marks any host on another version, an older pin included, and its **Update to** moves the host to that version. To keep a host where it is, set `"autoUpdate": false` in its settings file. That stops only the automatic move, not an update someone asks for.

## Drain, revoke and remove

```sh
kantel-admin host drain host_u7nfa06bgsim          # no new sandboxes; --undo takes it back
kantel-admin host revoke host_u7nfa06bgsim --yes   # its credential stops working
```

Draining stops new sandboxes going on a host, and the ones already there keep running. Revoking closes its connection and refuses its credential, so its sandboxes can't be reached until it joins again with a new token. Removing a host on the console's **Hosts** page revokes it.

To take `kantel-host` off the machine:

```sh
sudo kantel-host uninstall           # stop the service and its microVMs, and keep the files
sudo kantel-host uninstall --purge   # and delete sandboxes, snapshots, images, settings and the binary
```

Uninstalling doesn't tell the control plane, so revoke the host as well.

## The settings file

`/etc/kantel-host/config.json` holds the host's registration and settings. Restart the service after changing it, with `sudo systemctl restart kantel-host`. The settings you're most likely to change:

| Setting | Default | What it does |
| --- | --- | --- |
| `egress` | `open` | A sandbox's network when its account has no [proxy settings](/sandboxes/egress-proxy/) turned on: `open` (through the egress proxy, with no rules), `proxy`, or `none` (no network at all) |
| `egressAllowCIDRs` | none | Private ranges the egress proxy may connect to anyway, such as `["192.168.10.0/24"]` for a package mirror on your network. Bucket mounts reach their store under the same rule, so a MinIO on your network needs its range here |
| `mountCacheMiB` | `10240` | The host's read cache for bucket mounts (experimental), on disk in `mountCacheDir` (default `<root>/mount-cache`) and shared by every sandbox on the host; the least recently read goes first. `-1` turns bucket mounts off |
| `proxyDataPath` | `false` | What `--proxy-data-path` sets |
| `injectGuestAgent` | `false` | What `--inject-guest-agent` sets: `sandboxImage` may be [any Linux image](/sandboxes/custom-images/) |
| `proxyPort` | `3129` | The egress proxy's port, on each sandbox's gateway address |
| `subnet` | `10.231.0.0/16` | Where sandboxes' addresses come from. Each microVM gets a `/30` of it |
| `tiers` | what the machine can run | `["microvm"]`, `["isolate"]` or both |
| `overcommitMemory` | `1.5` | How much more memory running sandboxes may be given than the host has, as a ratio. Restored sandboxes share their template's unchanged memory |
| `templateRegistry` | none | The registry the host pulls templates' base images from, by digest, such as `ghcr.io/lleverage-ai`. Without it, the host makes templates only from its own sandbox image, and refuses a template whose base is a published digest. Templates are experimental (`KANTEL_TEMPLATES`) |
| `templateBuilder` | off | Builds templates' custom images (a Dockerfile, or an image reference) in a build microVM whose only network is the egress proxy, never with the host's Docker. `{ "registries": ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"] }` names the registries, and the hosts their blobs redirect to, a build may reach besides the template's grants. Needs `injectGuestAgent`. See [Custom images](/sandboxes/custom-images/#a-templates-custom-image). Experimental |
| `autoUpdate` | `true` | Whether the control plane may move the host to another version |
| `usageIntervalSeconds` | `5` | How often the host sends its and its sandboxes' usage, up to `300`. Below `0`, never |
| `keepForkSnapshots` | `false` | Keep the snapshot a running microVM's fork is made from as one of its source's automatic snapshots, its disk copied into the fork. By default the fork takes that snapshot's disk, one copy of the disk fewer, and the snapshot, which nothing restores again, is deleted once the fork has started |
| `microvm.sharedTemplate` | `true` | One template snapshot per vCPU count, serving every memory and disk, rather than one per size (see above) |
| `microvm.minDiskGiB` | the smallest size's disk | The least disk a create may ask for apart from its size (`resources.diskGb`). Less than the smallest size's boots from scratch, as the templates are made with that |
| `microvm.maxDiskGiB` | `1024` | The most disk a create may ask for apart from its size, at most `4096` |
| `bundleCacheMiB` | `10240` | The bundle images the host keeps for bundle mounts (experimental) that no sandbox uses now, in MiB, under `bundleCacheDir` (default `/var/lib/kantel-host/bundles`). Images in use are never removed. `-1` turns bundle mounts off |
| `bundleDrives` | `8` | How many different bundles one microVM can mount, at most 12. Every microVM has that many empty read-only drives for them |

<!-- Sources (00d22cc): apps/selfhosted/src/gateway/compute.ts:1-45,100-140, deploy/compose/compose.yaml:325-340, packages/admin/src/admin.ts:404-430. (5be456c): apps/host/cmd/kantel-host/install.go:30-190,366-460,600-660, apps/host/cmd/kantel-host/main.go:60-215, apps/host/cmd/kantel-host/manifest.go, apps/host/internal/hostinfo (Checks), apps/host/internal/agent/config.go:20-120, apps/host/internal/agent/conn.go:194-210, apps/host/internal/microvm/microvm.go:55-60, apps/host/guest/README.md, apps/host/guest/rootfs.sh, packages/hosts/src/scheduler.ts:1-115, packages/hosts/src/service.ts:300-340, packages/compute/src/service.ts:334-347, packages/api/src/compute-schema.ts:391-395, apps/selfhosted/src/gateway/compute.ts:15-40,183-190, deploy/compose/compose.yaml:325-338 -->
