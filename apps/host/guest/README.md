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
| 6081 | Selkies on the browser's own display: the browser alone, started on demand | `kantel-browser-stream.service` | |
| (socket) | Docker | `docker.service` | `docker` |
| 3128 | The guest agent's forwarder to the host's egress proxy (Chromium's and dockerd's proxy) | `kantel-guest.service` | |

The host's egress proxy sits on each sandbox's own gateway address, which a fork changes. Shells and `exec` get it
from `/etc/kantel/proxy.env`; Chromium and dockerd, which read a proxy once at start, use the forwarder on 3128, which
follows the sandbox's current proxy, so a fork or resume never restarts them (no lost tabs or containers).

Selkies needs no GPU, no UDP and no TURN: it serves one HTTP port, so a relay that carries a TCP stream carries the
desktop. It has no login of its own; whatever fronts it (the gateway's signed URLs) does access control.
`/etc/kantel/desktop.env` can set `KANTEL_DESKTOP_SIZE`, `KANTEL_STREAM_ENCODER` (`h264enc`, `h264enc-striped`,
`jpeg`), `KANTEL_STREAM_FPS` and `KANTEL_STREAM_FLAGS`.

### The browser alone

Chromium runs on a display of its own, TigerVNC's `:2` (`kantel-browser-display.service`), with no window manager and
nothing else on it; the desktop (`:1`) doesn't show it. A second Selkies (`kantel-browser-stream`, port 6081) streams
that display, so `openBrowser`'s page is the browser alone while `openDesktop`'s is the desktop, each with its own
ticket. The viewer sizes it: Selkies resizes `:2` to the viewer's window and the display keeps Chromium's window at
the screen's size.

The browser's stream isn't enabled and isn't in `ready`: the guest agent starts its unit when the host first opens
port 6081 and stops it once no connection has been open for five minutes, so a sandbox nobody watches spends nothing
on encoding. `/etc/kantel/on-demand` lists such services (port, unit, idle time); the first page load waits for
Selkies to start, a few seconds. The guest agent reports the surface (`browserSurface` in the sandbox's capabilities)
when the image has the display, the stream and their units, so the console can offer a Browser view only where there
is one.

`KANTEL_BROWSER_DISPLAY=:1` in `desktop.env` puts Chromium back on the desktop, as before: the guest agent then reports
no browser surface and `openBrowser` answers the desktop's page. `KANTEL_BROWSER_SIZE` sets `:2`'s size until a viewer
resizes it (1280x800), and `KANTEL_BROWSER_STREAM_FLAGS` adds Selkies flags. Another streaming stack would take the
place of `kantel-browser-stream` on the same port, behind the same relay route.

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
# RUN systemctl disable kantel-desktop kantel-browser-display kantel-browser kantel-stream \
#     && rm /etc/kantel/on-demand && printf 'docker\n' > /etc/kantel/ready
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

## Bucket mounts

A bucket mount (experimental) is a read-only FUSE file system the guest agent serves at the mount's path, mounted
with `MS_RDONLY`, so every write fails with `EROFS`. The host lists the bucket prefix once (the manifest: each
object's path, size, modification time and ETag) and the guest answers `ls`, `stat` and `find` from it with no
call to anyone; an object's bytes come from the host when they are first read, over vsock port 1027, which reaches
only that sandbox's own mounts on the host. The host keeps what it read in a shared on-disk cache (8 MiB chunks, by
object and ETag), so a second sandbox on the host reading the same object never reaches the store. The bucket
source's credentials stay on the host.

- The view changes only when the manifest does: after `refreshTtlSeconds` (default 60; 0 never), on the control
  plane's `sandbox.mounts.refresh`, or from inside with `getfattr -n user.kantel.refresh <mount>` (or Python's
  `os.getxattr`). The host lists at most once every 5 seconds a mount, however often it is asked.
- An object rewritten in the bucket after it was listed and never read on the host fails with `ESTALE` until a
  refresh, rather than answer bytes that don't match its listed size and ETag. One read before, from any sandbox on
  the host, is served from the cache.
- Files are mode `0444`: object stores keep no execute bit, so run scripts with their interpreter (`sh x.sh`).
- Mounts are restored by the guest agent after a restart (`/run/kantel/mounts.json`), and kept across stop and
  resume; a cold start mounts them again.

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
`kernel/kantel-<arch>.config` adds what only one architecture has (x86_64's Intel and AMD KVM). FUSE (bucket mounts)
is in Firecracker's config already; `kantel.config` names it so the build fails if it ever isn't.

The host also relies on two drivers the Firecracker config already has built in, and `build.sh` fails if either is
missing: vsock, for the guest agent, and `virtio_balloon`. Every microVM gets a balloon that never takes memory and only
reports the guest's own memory figures, which the host reads from Firecracker as the sandbox's memory.

## arm64

The same Dockerfile, kernel config and scripts build arm64 (aarch64) images: Firecracker's aarch64 guest config, and
the arm64 builds of Ubuntu, Docker, Chromium, Node, Go and Selkies. `kernel/build.sh` cross-compiles the kernel, so
an x86_64 machine builds both; the images build under QEMU user emulation there, which Docker needs registered once
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`). `boot-check-arm64.sh <out>` boots the result in
QEMU's aarch64 emulation and checks systemd, Docker, the desktop, CDP and Selkies, since Firecracker itself needs arm64
hardware. An arm64 sandbox has no `/dev/kvm`: Firecracker doesn't offer nested virtualisation on arm64.

## Publishing

`kantel-host install` reads `<images>/manifest.json` (`kantel-host manifest <dir>` writes it) and fetches
`vmlinux-<arch>` and `sandbox-<arch>.ext4` from it, checking each file's SHA-256; a `.gz` file is unpacked as it
downloads. `<images>` is the control plane's `GET /v1/hosts/images/...`, served from `KANTEL_COMPUTE_IMAGES`: a
directory, or an http(s) URL it redirects to (`off` serves none). It defaults to Kantel's published images, a public
GitHub Release on lleverage-ai/kantel pinned by tag (`DEFAULT_HOST_IMAGES` in
`packages/hosts/src/http.ts`), so a host installed from any control plane, hosted or self-hosted, gets them with no
setting.

`release.sh` builds and publishes one, for amd64 and arm64 (`ARCHES` picks others):

```sh
apps/host/guest/release.sh out host-images-20261103            # build: kernels, sandbox and isolate images, manifest
apps/host/guest/boot-check-arm64.sh out                        # boot the arm64 images in QEMU
apps/host/guest/release.sh out host-images-20261103 --publish  # make the GitHub Release (needs push access)
```

`--publish` publishes the build already in `out` when it's of the same tag and architectures from a clean `apps/host`
at the same tree as the commit it publishes at (`out/BUILD` records that), so a build checked on a branch is
published from main once merged, without building again. It refuses arm64 until `boot-check-arm64.sh` has passed on
that build (a new build clears the check's log). One manifest lists every architecture's files, and
`kantel-host install` takes its own (`vmlinux-arm64` and `sandbox-arm64.ext4` on an arm64 host). `SHA256SUMS` lists
every asset.

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
