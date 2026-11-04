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
| Tools | `ip`, `iptables`, `mkfs.ext4`, `cp`, and `/dev/net/tun` (`modprobe tun`) |
| Disk and memory | 20 GiB free under `/var/lib/kantel-host` and 4 GiB of memory, or more |
| Network | Outbound to the control plane's public URL. When installing, also to GitHub, for `kantel-host`, Firecracker and the images |

## Check a machine

To check a machine before it joins, install only the binary, then run its checks:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --no-join
sudo kantel-host doctor
```

```text
ok    kvm                    /dev/kvm opens read-write
ok    nested virtualisation  kvm_amd nested=1
ok    root                   kantel-host runs as root (TAP devices, iptables, /dev/kvm)
ok    ip                     ip
ok    iptables               iptables
ok    mkfs.ext4              mkfs.ext4
ok    cp                     cp
ok    tun                    /dev/net/tun
ok    disk                   412 GiB free at /var/lib/kantel-host (20 GiB or more recommended)
ok    memory                 128776 MiB (4 GiB or more recommended)

This machine can run both tiers: microVMs (Firecracker) and isolates (workerd, inside a microVM).
```

`kvm`, `root`, `ip`, `iptables`, `mkfs.ext4`, `cp` and `tun` decide whether the machine can run microVMs. `disk` and `memory` are advice. Before the first install, `disk` reads 0 GiB, because `/var/lib/kantel-host` doesn't exist yet. A machine that is itself a VM gets a `host is a VM` line too, which fails without nested virtualisation. `--json` prints the checks as JSON.

## Get kantel-host and the images

Each of Kantel's [GitHub Releases](https://github.com/lleverage-ai/kantel/releases) carries `kantel-host` for Linux on x86_64 and arm64 (`kantel-host-linux-amd64`, `kantel-host-linux-arm64`), the host installer `install.sh`, and `SHA256SUMS`. The join command Kantel prints runs that installer from the latest release:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_…
```

The line works the same in bash, zsh and fish, since the script runs under `sh`. It picks the binary for the machine's architecture, downloads it with `SHA256SUMS` from the same release, refuses it if its SHA-256 doesn't match, and then runs `kantel-host install` with the options after `--`. Two options of its own come first: `--version 0.2.0` installs that release rather than the latest, and `--no-join` only puts the binary in `/usr/local/bin`. Every release file has a build provenance attestation too, which `gh attestation verify kantel-host-linux-amd64 --repo lleverage-ai/kantel` checks.

To build `kantel-host` yourself instead, with Go 1.26 or later:

```sh
git clone https://github.com/lleverage-ai/kantel.git
cd kantel
(cd apps/host && CGO_ENABLED=0 go build -trimpath -o dist/kantel-host ./cmd/kantel-host)
```

Add `GOARCH=arm64` to build it for an aarch64 host on an x86_64 machine, copy `apps/host/dist/kantel-host` to the host, and run `sudo ./kantel-host install --url … --token …` there in place of the join command.

A host also needs a guest kernel and a sandbox image. Kantel publishes them for x86_64 and arm64 as a public [GitHub Release](https://github.com/lleverage-ai/kantel/releases), and the installer fetches the ones for the host's architecture from there by default, so there's nothing to build. The arm64 images are boot-checked in emulation before they're published, not yet on arm64 hardware. The sandbox image is Ubuntu 26.04 with Docker, an XFCE desktop, Chromium and SSH, and the release also has the isolate image. `manifest.json` lists each file with its SHA-256. The installer reads it, and refuses a file whose digest doesn't match. `THIRD-PARTY-NOTICES.md`, in the release and in the image, says what the images contain and under which licences. The release also carries the exact source of the GPL and LGPL libraries the sandbox image bundles outside a distro package (libx264, x265 and libde265, in Selkies' screen encoder), listed in `SOURCES.md` with their SHA-256.

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

Without systemd, such as in a container, install stops after step 4: run `kantel-host run` as root under a supervisor of your own, and restart it when it exits. Running `install` again with the same `--url` and no token updates the install and keeps the registration.

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
journalctl -u kantel-host -f
```

`status` prints the agent's version, the control plane it's registered with, its host ID and whether the service is active. The journal has the connection, each sandbox the host starts, and the [egress proxy's](/sandboxes/egress-proxy/#what-a-refusal-looks-like) decisions.

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

Every 5 seconds a host also sends Kantel its CPU, memory and disk, and each running sandbox's CPU and memory. It measures them from its own side and runs nothing in a sandbox to do it:

- A microVM's CPU is its Firecracker process's CPU time as a share of its vCPUs. Its memory is what the guest itself counts as used, its total less its available memory, as `free -m` shows it in the guest. The guest's kernel reports those figures to Firecracker through a virtio-balloon device that only reports (it never takes memory from the guest), and the host reads them from Firecracker, so nothing runs in the sandbox. Page cache isn't counted, and the figure falls when the guest frees memory.
- A microVM restored from a snapshot made before the host had that device (or one on a kernel without `virtio_balloon`) can't report, so its memory is its Firecracker process's resident memory instead: the guest memory the VM has touched, page cache included. A microVM doesn't give that memory back to the host, so that figure stays near its high point after a spike. Each reading says which it is (`memSource`, `guest` or `rss`, on the host's link).
- An account's isolates share one runtime, so the host measures the runtime and shares it out. Each isolate's CPU is its part of the runtime's CPU time, split by how long each spent running commands, as a share of one CPU. The runtime's memory is split evenly.
- The disk is the file system the host's data directory (`/var/lib/kantel-host`) is on.

While the host can't reach Kantel it keeps the last 120 readings (10 minutes' worth at the default interval) and sends them when it reconnects.

## Where sandboxes go

Kantel picks a host when a sandbox is created. A host can take the sandbox if it is connected, not draining or revoked, runs the sandbox's type, offers its size, has every label the sandbox asks for, and has the memory and disk free. Among those, Kantel prefers, for an isolate, a host already running the account's isolates, then the most free memory, then the lowest load.

Once placed, a sandbox stays on its host. Stop, start, resume and fork all happen there, and so does a sandbox made from one of its snapshots.

To keep a sandbox on certain hosts, give the create `hostLabels`. The host must have every label:

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"type": "microvm", "hostLabels": {"zone": "ams"}}'
```

The `kantel` command has no flag for this yet. When no host can take a sandbox, the create answers `503` with `unavailable`, such as `No host can run a microvm sandbox now`.

A host offers three microVM sizes unless its settings say otherwise:

| Size | vCPUs | Memory | Disk |
| --- | --- | --- | --- |
| `small` | 1 | 1 GiB | 10 GiB |
| `default` | 4 | 2 GiB | 20 GiB |
| `large` | 4 | 8 GiB | 50 GiB |

A create can also ask for any vCPUs and memory with `resources`, such as `{"type": "microvm", "resources": {"vcpus": 3, "memoryMb": 6144}}`. A shape that matches a size goes as that size; any other goes only to a host whose `kantel-host` makes custom shapes, and boots from scratch. Its disk is the smallest size's with at least its memory, unless it starts from a snapshot, which keeps that snapshot's disk; the sandbox's `resources` say what it got. `GET /v1/sandbox-shapes` says what the hosts you may use offer.

Hosts keep no warm microVMs waiting for a create, hosted or self-hosted: an idle VM holds its memory, and the machine may be doing other things. A create of one of the sizes restores that size's template snapshot on the host; the host makes the template the first time the size is asked for. `KANTEL_COMPUTE_POOLS`, which once set warm pools, is ignored with a warning. A `kantel-host` from before then is told to keep none, so it makes no more. It can't end a warm VM it already has: its next create of that size takes it, and updating the host (the new version clears them when it starts) ends the rest.

An isolate's `resources` is its memory alone, 128 to 512 MB in steps of 64 (256 by default); it shares its account's VM's CPU. Kantel records what it asked for, but workerd can't hold one isolate to a memory limit yet: the account's VM's memory is the limit its isolates share.

## Update a host

```sh
sudo kantel-host update                  # the latest release
sudo kantel-host update --version 0.2.0  # or a given one
```

`update` downloads the release's binary for the machine, checks it against the release's `SHA256SUMS`, replaces `/usr/local/bin/kantel-host` and restarts the service. `--url` takes a binary from elsewhere instead, unchecked, and one ending `.gz` is unpacked. Running sandboxes keep running through the restart, and the new agent takes them over.

To have hosts update themselves, set the version you want on the control plane:

```sh
kantel-admin config set KANTEL_HOST_VERSION=0.2.0 --apply
```

A host on another version then fetches that version from Kantel's GitHub Release, checks it against the release's `SHA256SUMS`, and restarts into it. To serve the binaries yourself, also set `'KANTEL_HOST_UPDATE_URL=https://downloads.example.com/{version}/kantel-host-{os}-{arch}'`. A host fetches that URL, with `{os}` as `linux` and `{arch}` as `amd64` or `arm64`, and restarts into it. `kantel-admin host list` shows the newer version beside each host that hasn't moved yet. To keep a host where it is, set `"autoUpdate": false` in its settings file.

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
| `autoUpdate` | `true` | Whether the control plane may move the host to another version |
| `usageIntervalSeconds` | `5` | How often the host sends its and its sandboxes' usage, up to `300`. Below `0`, never |

<!-- Sources (00d22cc): apps/selfhosted/src/gateway/compute.ts:1-45,100-140, deploy/compose/compose.yaml:325-340, packages/admin/src/admin.ts:404-430. (5be456c): apps/host/cmd/kantel-host/install.go:30-190,366-460,600-660, apps/host/cmd/kantel-host/main.go:60-215, apps/host/cmd/kantel-host/manifest.go, apps/host/internal/hostinfo (Checks), apps/host/internal/agent/config.go:20-120, apps/host/internal/agent/conn.go:194-210, apps/host/internal/microvm/microvm.go:55-60, apps/host/guest/README.md, apps/host/guest/rootfs.sh, packages/hosts/src/scheduler.ts:1-115, packages/hosts/src/service.ts:300-340, packages/compute/src/service.ts:334-347, packages/api/src/compute-schema.ts:391-395, apps/selfhosted/src/gateway/compute.ts:15-40,183-190, deploy/compose/compose.yaml:325-338 -->
