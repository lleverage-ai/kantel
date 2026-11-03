# The microVM guest

What runs inside a microVM sandbox: the default image (`Dockerfile`), its guest kernel (`kernel/`), and the files
both add (`rootfs/`). `rootfs.sh` turns the image into the read-only ext4 every sandbox on a host shares;
`kernel/build.sh` builds the kernel. `kantel-host install` fetches both, checked against the images manifest (see
"Publishing" below).

## What's in the default image

Ubuntu 26.04 LTS (pinned by digest, packages from `snapshot.ubuntu.com` at `UBUNTU_SNAPSHOT`), systemd, and:

- Docker CE and containerd (pinned versions), with Buildx and Compose
- git, curl, wget, jq, build-essential, pkg-config, Python 3 with pip and venv, Node and Go (pinned releases,
  checked against their SHA-256)
- an XFCE session on a TigerVNC X server (display `:1`, 1920x1080), Chromium on that display (Debian 13's build,
  from `snapshot.debian.org` at the same date; Ubuntu's own Chromium is a snap, and Google Chrome can't be
  redistributed)
- Selkies, streaming the desktop to a browser
- OpenSSH, the guest agent (`kantel-guest`) and `kantel-init`

`/etc/kantel/image.json` records every version that went in (`kantel-image-info` writes it at build time), and
`/usr/share/kantel/packages.tsv` every package with its source package. What the image bundles, under which licences,
and where each part's source is: [`rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md`](rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md),
at the same path in the image and published beside it. Everything in it may be redistributed; keep it that way (no
Google Chrome, nothing from Ubuntu's `restricted` or `multiverse`), and update the notices when a component is added.

The sandbox user is `user` (uid 1000): passwordless sudo, and in the `docker` and `kvm` groups, so it runs
containers and nested VMs without root.

## What listens where

Everything is on the guest's loopback; the host reaches it over vsock (`GET /ports/{port}` on the guest agent) and
nothing in the guest listens on the sandbox's network except SSH.

| Port | Service | Unit | Ready name |
| --- | --- | --- | --- |
| 22 | OpenSSH (keys only, host key made per sandbox) | `ssh.service` | `ssh` |
| 5901 | VNC (RFB) of display `:1` | `kantel-desktop.service` | `desktop` |
| 9222 | Chromium's DevTools (CDP) | `kantel-browser.service` | `browser` |
| 6080 | Selkies: its web client and the WebSocket stream (H.264 on the CPU) | `kantel-stream.service` | `stream` |
| (socket) | Docker | `docker.service` | `docker` |
| 3128 | The guest agent's forwarder to the host's egress proxy (Chromium's and dockerd's proxy) | `kantel-guest.service` | |

The host's egress proxy sits on each sandbox's own gateway address, which a fork changes. Shells and `exec` get it
from `/etc/kantel/proxy.env`; Chromium and dockerd, which read a proxy once at start, use the forwarder on 3128, which
follows the sandbox's current proxy, so a fork or resume never restarts them (no lost tabs or containers).

Selkies needs no GPU, no UDP and no TURN: it serves one HTTP port, so a relay that carries a TCP stream carries the
desktop. It has no login of its own; whatever fronts it (the gateway's signed URLs) does access control.
`/etc/kantel/desktop.env` can set `KANTEL_DESKTOP_SIZE`, `KANTEL_STREAM_ENCODER` (`h264enc`, `h264enc-striped`,
`jpeg`), `KANTEL_STREAM_FPS` and `KANTEL_STREAM_FLAGS`.

## Templates and readiness

A host boots the image once per size, waits for its services, and snapshots it (the template); every create restores
that snapshot. `/etc/kantel/ready` lists the services (by ready name) the template waits for. SSH is never in it: the
image has no host keys, and the guest agent writes them (then starts sshd) on every create and fork, so no two
sandboxes share a host key.

## Custom images

A custom image is a Dockerfile that starts from the default one and adds to it:

```Dockerfile
FROM kantel-guest-sandbox:amd64
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
# No desktop? Stop its units and say so, or the template waits for them:
# RUN systemctl disable kantel-desktop kantel-browser kantel-stream && printf 'docker\n' > /etc/kantel/ready
RUN kantel-image-info > /etc/kantel/image.json
```

Build the default image, then the custom one, to an ext4:

```sh
apps/host/guest/rootfs.sh out sandbox amd64
KANTEL_GUEST_DOCKERFILE=path/to/Dockerfile apps/host/guest/rootfs.sh out sandbox amd64   # out/custom-amd64.ext4
```

Point a host's `sandboxImage` at the result (or publish it, below). Keep `kantel-init`, the guest agent's unit and
the `user` account: the host relies on them. The host fingerprints Firecracker, the kernel and the image, and
rebuilds its templates when any of them changes.

## Snapshots on top

A sandbox writes only to its own sparse ext4 (`/dev/vdb`), which `kantel-init` overlays on the shared image at `/`
(`/var/lib/docker` and `/var/lib/containerd` are bind mounts of plain ext4 directories on that disk, since an
overlay's upper directory can't sit on an overlay). A snapshot is that disk plus, unless taken without, the VM's
memory. Restoring one needs the same base image and kernel underneath: a snapshot is a layer over a specific image,
not a whole one. Replacing a host's image therefore orphans the snapshots taken on the old one, until the host keeps
old images for them.

## The kernel

`kernel/kantel.config` is a Firecracker guest config with what Docker needs (overlayfs, cgroups v2, namespaces,
netfilter and nftables, bridge, veth, VXLAN, IPVS) and KVM, so a sandbox runs its own VMs: on a host whose KVM has
nested virtualisation on (`kvm_amd nested=1` or `kvm_intel nested=1`), `/dev/kvm` is there in every sandbox.

## Publishing

`kantel-host install` reads `<images>/manifest.json` (`kantel-host manifest <dir>` writes it) and fetches
`vmlinux-<arch>` and `sandbox-<arch>.ext4` from it, checking each file's SHA-256; a `.gz` file is unpacked as it
downloads. `<images>` is the control plane's `GET /v1/hosts/images/...`, served from `KANTEL_COMPUTE_IMAGES`: a
directory, or an http(s) URL it redirects to (`off` serves none). It defaults to Kantel's published images, a public
GitHub Release on lleverage-ai/kantel pinned by tag (`DEFAULT_HOST_IMAGES` in
`packages/hosts/src/http.ts`), so a host installed from any control plane, hosted or self-hosted, gets them with no
setting.

`release.sh` builds and publishes one:

```sh
apps/host/guest/release.sh out host-images-20261103            # build: kernel, sandbox and isolate images, manifest
apps/host/guest/release.sh out host-images-20261103 --publish  # and make the GitHub Release (needs push access)
```

Every release also carries the exact source of the GPL and LGPL libraries the sandbox image bundles outside a distro
package: Selkies' pixelflux wheel links libx264 and x265 (GPL-2.0-or-later) and libde265 (LGPL-3.0-or-later).
`gpl-sources.sh`, which `release.sh` runs on each built sandbox image, checks that the image's pixelflux is the wheel
pixelflux published, reads the commit of each library from pixelflux's build recipe at that release, checks it against
the libraries' versions in the image, and writes `source-<name>-<version>.tar.gz` (`git archive` of that commit), with
`SOURCES.md` and `SOURCES.sha256`. It also takes a published `sandbox-<arch>.ext4`, to add the sources to a release
that lacks them (`gh release upload <tag> out/SOURCES.* out/source-*`, without `--clobber`).

A release is never replaced: a new image gets a new tag (`host-images-<yyyymmdd>[.<n>]`), and a pull request moves
`DEFAULT_HOST_IMAGES` to it. Running `kantel-host install` again on a host fetches only the files whose digest has
changed, and the host rebuilds its templates for the new image. To serve your own images (a custom image, say), build the
same directory with your image in it and point `KANTEL_COMPUTE_IMAGES` at it, or install a host with
`--images <url-or-dir>`.
