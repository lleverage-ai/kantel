---
title: Custom images
description: Run any Linux image as a microVM with Kantel's injected guest agent, what an image needs for commands, files, ports, SSH, a desktop, a browser and Docker, and how a sandbox reports what its image has.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The injected guest agent is off by default and turned on per host. Without it, a host runs Kantel's own image, as before.
:::

A microVM normally boots Kantel's own image, which ships Kantel's init and guest agent. A host with `injectGuestAgent` on boots any Linux image instead: Kantel supplies the kernel and an initramfs, and the initramfs puts a static guest agent into the image at boot. Nothing of Kantel's has to be in the image, and the image itself isn't changed: the agent lives on a tmpfs at `/.kantel`, and the sandbox's own writes go to its disk, layered over the image.

The agent is one static Go binary, so it needs no C library, shell or tools from the image. It gives every sandbox:

- commands and files ([Commands and files](/sandboxes/commands-and-files/));
- [ports](/sandboxes/public-ports/), forwarded to the sandbox's loopback;
- [SSH](/sandboxes/ssh/), served by the agent itself, so the image needs no `sshd`;
- its network (address, route, DNS, hostname and the egress proxy's CA), set up without `ip`, `ifconfig` or `update-ca-certificates`.

It was tested on Kantel's own image, `debian:trixie`, `alpine:3.22` and `busybox:1.37` (`apps/host/test/injected.sh`).

## What an image needs

| For | The image needs |
| --- | --- |
| To boot at all | A Linux root filesystem for the host's architecture (`x86_64` or `aarch64`), as an ext4, squashfs or erofs image. Nothing else |
| Commands as `argv` | The program you run |
| Commands as a `command` string | `/bin/sh` (or `bash`, which is used where the image has it). A busybox `sh` is enough |
| Files and ports | Nothing |
| SSH: shells and commands | A shell, as for a `command`. Keys go in the user's `~/.ssh/authorized_keys`, as [Kantel's SSH access](/sandboxes/ssh/) puts them. The agent enforces no key options, so it refuses a key whose line has any (`command=`, `restrict`, `from=`), and an account whose shell is `nologin` or `false` can't log in |
| SFTP, and `scp` (which uses SFTP) | OpenSSH's `sftp-server`, such as Debian's `openssh-sftp-server` or Alpine's `openssh-sftp-server` |
| Docker | `dockerd`, and systemd as the image's init to start it |
| `/dev/kvm` inside | Nothing in the image; the host must allow [nested virtualisation](/hosts/) |
| The desktop and browser | Kantel's desktop stack: TigerVNC, XFCE and Selkies, with Kantel's `kantel-desktop` and `kantel-browser` services and systemd. Today only Kantel's own image has them |
| Reading a snapshot's files without starting it | Nothing in the image. On the host: `debugfs` for an ext4 image, as for Kantel's own; `unsquashfs` (`squashfs-tools` 4.6 or later) for a squashfs one. An erofs image's snapshot files can't be read this way: start the sandbox to read them |

Commands and SSH run as `user` where the image has that account, as Kantel's image does, and as `root` where it doesn't. An image without `/etc/passwd` runs everything as root, with `/root` as home.

Kantel's kernel is used, so the image's `/boot` and `/lib/modules` are ignored. Programs that need a kernel module Kantel's kernel doesn't build in won't work.

### systemd or not

When the image's `/sbin/init` is systemd (Debian and Ubuntu images that install it, Kantel's own), the initramfs adds a unit for the agent to systemd's runtime units in `/run`, for that boot only, and hands over to systemd, which then starts the image's own services too. Otherwise Kantel's agent is PID 1: it mounts `/proc`, `/sys`, `/dev/pts`, `/run` and `/tmp`, reaps orphaned processes, and on a stop ends every process before the machine shuts down. Stock `debian:trixie`, `alpine` and `busybox` images have no systemd, so they run this way, and their services (Docker included) don't start on their own.

## Turn an image into a root filesystem

A host boots the image file at `sandboxImage` in its [settings file](/hosts/#the-settings-file). One way to make one from an OCI image, with Docker and `squashfs-tools`:

```sh
ctr=$(docker create debian:trixie /bin/true)
docker export "$ctr" | sudo sh -c 'mkdir -p /tmp/rootfs && tar -xf - -C /tmp/rootfs'
docker rm "$ctr"
sudo mksquashfs /tmp/rootfs /var/lib/kantel-host/images/debian.sqfs -noappend -comp zstd
```

Extract as root, so device nodes and owners survive. A squashfs image is read-only, which is all the host needs: each sandbox writes to a disk of its own.

## Turn it on for a host

Add `--inject-guest-agent` to the host's join command, or set `injectGuestAgent` in `/etc/kantel-host/config.json`, point `sandboxImage` at the image, and restart the host:

```json
{
  "injectGuestAgent": true,
  "sandboxImage": "/var/lib/kantel-host/images/debian.sqfs"
}
```

The installer fetches the agent (`kantel-guest-amd64` or `kantel-guest-arm64`) with the other images; `guestAgent` names another one. Running the installer again (an upgrade, say) keeps a `sandboxImage` or `guestAgent` of your own and fetches only the files it put there itself. Those are `images/sandbox.ext4` and `images/kantel-guest` under the host's root, so give your own files any other name; the installer stops with an error rather than treat one of yours as its own. The host builds its initramfs from the agent and makes its templates again when the agent changes. A host runs one image, so to offer several, run a host per image and choose between them with [labels](/hosts/).

## What a sandbox says its image has

When a microVM starts, its agent looks at the image and the host passes on what it found as the sandbox's `capabilities.guest`. A sandbox's `desktop`, `browser`, `docker` and `kvm` capabilities are `false` where its image lacks them, and the console shows the image's details on the sandbox's page and hides the desktop and browser it doesn't have, saying why.

```json
{
  "capabilities": {
    "exec": true, "files": true, "ssh": true, "ports": true, "pause": true,
    "desktop": false, "browser": false, "docker": false, "kvm": true,
    "guest": {
      "reportedAt": 1793796229126,
      "agent": { "version": "1.18.0", "injected": true },
      "os": { "id": "alpine", "name": "Alpine Linux v3.22", "version": "3.22.7" },
      "arch": "x86_64",
      "libc": "musl",
      "shell": "/bin/sh",
      "init": "kantel",
      "desktop": { "available": false, "reason": "No desktop in this image" },
      "browser": { "available": false, "reason": "No browser in this image" },
      "docker": { "available": false, "reason": "No Docker in this image", "kvm": true }
    }
  }
}
```

Opening the desktop or browser of a sandbox whose image has none answers `501` with `not_supported` and the reason. A sandbox on a host from before the guest agent reported has no `guest`, and Kantel's own image's capabilities.

<!-- Sources: apps/host/internal/guestinit/init_linux.go, apps/host/internal/guestinit/initramfs.go, apps/host/internal/guest/capabilities.go, apps/host/internal/guest/sshd.go, apps/host/internal/guest/server.go (LoginUser, identity), apps/host/internal/agent/config.go (InjectGuestAgent, GuestAgent), apps/host/internal/microvm/injected_vmtest_test.go, apps/host/test/injected.sh, packages/hosts/src/backend.ts (capabilitiesOf), packages/compute/src/service.ts (openDesktop, openBrowser) -->
