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
- an XFCE session on a TigerVNC X server (display `:1`, 1920x1080), Google Chrome (stable) on that display
- Selkies, streaming the desktop to a browser
- OpenSSH, the guest agent (`kantel-guest`) and `kantel-init`

`/etc/kantel/image.json` records every version that went in (`kantel-image-info` writes it at build time).

The sandbox user is `user` (uid 1000): passwordless sudo, and in the `docker` and `kvm` groups, so it runs
containers and nested VMs without root.

## What listens where

Everything is on the guest's loopback; the host reaches it over vsock (`GET /ports/{port}` on the guest agent) and
nothing in the guest listens on the sandbox's network except SSH.

| Port | Service | Unit | Ready name |
| --- | --- | --- | --- |
| 22 | OpenSSH (keys only, host key made per sandbox) | `ssh.service` | `ssh` |
| 5901 | VNC (RFB) of display `:1` | `kantel-desktop.service` | `desktop` |
| 9222 | Chrome's DevTools (CDP) | `kantel-browser.service` | `browser` |
| 6080 | Selkies: its web client and the WebSocket stream (H.264 on the CPU) | `kantel-stream.service` | `stream` |
| (socket) | Docker | `docker.service` | `docker` |

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
directory, or an http(s) URL it redirects to. So to publish: build the kernel and image, gzip the image, run
`kantel-host manifest` on the directory, and put the directory where `KANTEL_COMPUTE_IMAGES` points.
