---
title: Hosts
description: Add Linux machines that run your sandboxes with kantel-host, check a machine first, choose which host a sandbox goes on with labels, and update, drain, revoke or remove a host later.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
`kantel-host`, its settings and the hosts API may still change, and `kantel-host` isn't published yet, so this page builds it from the repository.
:::

A host is a Linux machine that runs sandboxes. It runs `kantel-host`, which boots microVMs with Firecracker, and isolates with workerd inside a microVM. The host dials out to the control plane over a WebSocket and keeps that connection open, so it needs no inbound port and can sit behind NAT. A sandbox stays on the host it started on, since its disk and memory are there.

[Quickstart](/quickstart/) joins one host on the control plane's own machine. This page covers each step in full, for any number of machines.

## What a host needs

| | |
| --- | --- |
| System | Linux on x86_64 or aarch64 |
| KVM | `/dev/kvm`, readable and writable by root. A cloud VM needs nested virtualisation from its provider. Without KVM a host runs isolates only, and only for code you trust (see [Without KVM](#without-kvm)) |
| Nested virtualisation | Optional. With `kvm_intel nested=1` or `kvm_amd nested=1`, every sandbox gets a `/dev/kvm` of its own |
| Root | `kantel-host` makes TAP devices and iptables rules |
| Tools | `ip`, `iptables`, `mkfs.ext4`, `cp`, and `/dev/net/tun` (`modprobe tun`) |
| Disk and memory | 20 GiB free under `/var/lib/kantel-host` and 4 GiB of memory, or more |
| Network | Outbound to the control plane's public URL. When installing, also to GitHub, for Firecracker |

## Check a machine

```sh
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

The join command Kantel prints runs `npx -y @kantel/host@latest`, but that package isn't on npm yet. Until it is, build the binary from Kantel's repository with Go 1.26 or later:

```sh
git clone https://github.com/lleverage-ai/kantel.git
cd kantel
(cd apps/host && CGO_ENABLED=0 go build -trimpath -o dist/kantel-host ./cmd/kantel-host)
```

Add `GOARCH=arm64` to build it for an aarch64 host on an x86_64 machine. Copy `apps/host/dist/kantel-host` to each host.

A host also needs a guest kernel and a sandbox image. No public set is published yet, so build them on a machine with Docker and Go:

```sh
apps/host/guest/kernel/build.sh ~/kantel-images x86_64      # or aarch64
apps/host/guest/rootfs.sh ~/kantel-images sandbox amd64      # or arm64
apps/host/dist/kantel-host manifest ~/kantel-images
```

The image is Ubuntu 26.04 with Docker, an XFCE desktop, Chrome and SSH. `apps/host/guest/README.md` lists what's in it, and shows how to build a custom image on top of it. For isolates, also run `apps/host/guest/rootfs.sh ~/kantel-images isolate amd64`, which needs Bun as well. `manifest` writes `manifest.json`, which lists each file with its SHA-256. The installer reads it, and refuses a file whose digest doesn't match. You can gzip the sandbox image first (`sandbox-amd64.ext4.gz`), and the host unpacks it as it downloads.

The installer gets the images from one of two places:

- `--images` on `kantel-host install`: a directory on the host, or an http(s) URL that serves the directory.
- The control plane, at `GET /v1/hosts/images/…`, when you set `KANTEL_COMPUTE_IMAGES`. That is a directory the gateway can read, or an http(s) URL it redirects to. On the Docker Compose stack, use a URL: the gateway runs in a container, so it can't see a directory on the machine. Without the setting, the route answers 404, and an install without `--images` stops.

## Add a host

A self-hosted control plane runs sandboxes on hosts unless `KANTEL_COMPUTE_BACKEND=stub` says otherwise. Hosts reach it at its local address, `http://127.0.0.1:58090`, which only a host on the same machine can use. For hosts on other machines, tell it the URL where hosts and people reach it:

```sh
kantel-admin compute enable --public-url https://kantel.example.com --apply
```

That sets `KANTEL_PUBLIC_URL`. The same URL goes into every join command and every desktop, browser and SSH link, so your users' browsers need to reach it as well as your hosts. Behind a TLS proxy it is `https://`, and the relay links are then `wss://`. To give hosts a different address from the console's, set `KANTEL_COMPUTE_PUBLIC_URL` instead.

Then make a join token, with [`kantel-admin`](/self-hosting/admin-cli/), on the console's **Hosts** page (shown to a deployment's admins) or with [`POST /v1/admin/hosts/join-tokens`](/api/reference/hosts/):

```sh
kantel-admin host add --name builder-1 --label zone=ams
```

A token works once, and for an hour unless `--expires-minutes` says otherwise. The host takes its name and labels from it. On the machine, run the printed command with the binary you built in place of `npx -y @kantel/host@latest`:

```sh
sudo ./kantel-host install --url https://kantel.example.com --token kth_… --images ~/kantel-images
```

Install:

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
| `--root DIR` | Where sandboxes live. Default `/var/lib/kantel-host` |
| `--config FILE` | The settings file. Default `/etc/kantel-host/config.json` |
| `--no-start` | Install and register, but don't start the service |

`kantel-admin host join --url … --token …`, and `host add --ssh root@builder-1`, run the same install through `npx @kantel/host`, so they work only once that package is published.

### Without KVM

A machine with no usable `/dev/kvm` can still run isolates, with workerd straight on the host rather than inside a microVM:

```sh
sudo ./kantel-host install --url https://kantel.example.com --token kth_… --tiers isolate --isolate-runtime native --images …
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

## Where sandboxes go

Kantel picks a host when a sandbox is created. A host can take the sandbox if it is connected, not draining or revoked, runs the sandbox's type, offers its size, has every label the sandbox asks for, and has the memory and disk free. Among those, Kantel prefers a host with a warm sandbox of that type and size ready, because a create there is a restore rather than a boot. Next it prefers, for an isolate, a host already running the account's isolates, then the most free memory, then the lowest load.

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
| `default` | 2 | 2 GiB | 20 GiB |
| `large` | 4 | 8 GiB | 50 GiB |

Each host keeps one warm `default` microVM ready. `KANTEL_COMPUTE_POOLS` on the control plane changes that for every host, as JSON such as `{"microvm/default": 2, "microvm/large": 1}`.

## Update a host

```sh
sudo kantel-host update --url https://downloads.example.com/kantel-host-linux-amd64
```

`update` downloads the binary, checks that it runs, replaces `/usr/local/bin/kantel-host` and restarts the service. A URL ending `.gz` is unpacked. The control plane doesn't serve `kantel-host` binaries itself, so give `--url`. Running sandboxes keep running through the restart, and the new agent takes them over.

To have hosts update themselves, set the version you want and where to get it on the control plane:

```sh
kantel-admin config set KANTEL_HOST_VERSION=0.2.0 \
  'KANTEL_HOST_UPDATE_URL=https://downloads.example.com/{version}/kantel-host-{os}-{arch}' --apply
```

A host on another version then fetches that URL, with `{os}` as `linux` and `{arch}` as `amd64` or `arm64`, and restarts into it. `kantel-admin host list` shows the newer version beside each host that hasn't moved yet. To keep a host where it is, set `"autoUpdate": false` in its settings file.

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
| `egressAllowCIDRs` | none | Private ranges the egress proxy may connect to anyway, such as `["192.168.10.0/24"]` for a package mirror on your network |
| `proxyDataPath` | `false` | What `--proxy-data-path` sets |
| `proxyPort` | `3129` | The egress proxy's port, on each sandbox's gateway address |
| `subnet` | `10.231.0.0/16` | Where sandboxes' addresses come from. Each microVM gets a `/30` of it |
| `tiers` | what the machine can run | `["microvm"]`, `["isolate"]` or both |
| `overcommitMemory` | `1.5` | How much more memory running sandboxes may be given than the host has, as a ratio. Restored sandboxes share their template's unchanged memory |
| `autoUpdate` | `true` | Whether the control plane may move the host to another version |

<!-- Sources (00d22cc): apps/selfhosted/src/gateway/compute.ts:1-45,100-140, deploy/compose/compose.yaml:325-340, packages/admin/src/admin.ts:404-430. (5be456c): apps/host/cmd/kantel-host/install.go:30-190,366-460,600-660, apps/host/cmd/kantel-host/main.go:60-215, apps/host/cmd/kantel-host/manifest.go, apps/host/internal/hostinfo (Checks), apps/host/internal/agent/config.go:20-120, apps/host/internal/agent/conn.go:194-210, apps/host/internal/microvm/microvm.go:55-60, apps/host/guest/README.md, apps/host/guest/rootfs.sh, packages/hosts/src/scheduler.ts:1-115, packages/hosts/src/service.ts:300-340, packages/compute/src/service.ts:334-347, packages/api/src/compute-schema.ts:391-395, apps/selfhosted/src/gateway/compute.ts:15-40,183-190, deploy/compose/compose.yaml:325-338 -->
