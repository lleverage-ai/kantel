# Third-party notices: Kantel's host images (sandbox image, isolate image, guest kernel)

The default sandbox image (`sandbox-<arch>.ext4`), the isolate image (`isolate-<arch>.ext4`) and the guest kernel
(`vmlinux-<arch>`) that Kantel publishes are
built from source in the lleverage-ai/kantel repository (`apps/host/guest`), by `rootfs.sh` and `kernel/build.sh`.
Everything in them is free and open-source software that may be redistributed. This file says what they contain,
under which licences, and where the source of each part is. It is in the image at
`/usr/share/kantel/THIRD-PARTY-NOTICES.md` and published beside it.

The image holds the full licence text of every Debian-format package at `/usr/share/doc/<package>/copyright`, and
`/usr/share/kantel/packages.tsv` lists every package with its version and the source package it was built from.
`/etc/kantel/image.json` records the main components' versions.

## Kantel's own parts

`kantel-guest`, `kantel-init`, `kantel-desktop`, `kantel-session`, `kantel-apps`, `kantel-chromium`,
`kantel-browser`, `kantel-stream`, `kantel-image-info`, the configuration under `/etc/kantel`,
`/etc/systemd/system/kantel-*` and `/home/user/.config`, the desktop's icons and dock entries (`/usr/share/kantel/icons`,
`/usr/share/kantel/dock`) and its Openbox theme (`/usr/share/themes/Kantel`): Apache License 2.0, source in
https://github.com/lleverage-ai/kantel (`apps/host`). The desktop's Openbox, tint2, rofi, xsettingsd, LXTerminal,
PCManFM and Geany are Ubuntu's packages (below).

## The guest kernel

Linux (`vmlinux-<arch>`): GPL-2.0-only (with the syscall note). Built from the kernel.org release named by
`KERNEL_VERSION` in `apps/host/guest/kernel/build.sh` (https://cdn.kernel.org/pub/linux/kernel/v6.x/), configured
with Firecracker's CI guest config (https://github.com/firecracker-microvm/firecracker, `resources/guest_configs/`,
Apache-2.0) plus `apps/host/guest/kernel/kantel.config`. The exact `.config` is published beside the kernel as
`vmlinux-<arch>.config`.

## Ubuntu

Ubuntu 26.04 LTS packages, from the `main` and `universe` components only (none from `restricted` or `multiverse`),
taken from https://snapshot.ubuntu.com/ at the date in `/etc/kantel/image.json` (`aptSnapshot`). Their licences
(mostly GPL, LGPL, BSD, MIT, Apache-2.0 and similar) are in each package's `/usr/share/doc/<package>/copyright`.
Their source packages, at the same versions, are in the same snapshot:
`https://snapshot.ubuntu.com/ubuntu/<aptSnapshot>/pool/` (apt inside a sandbox reads Ubuntu's live archive, which
may have moved past them). The Ubuntu name and logo are Canonical's trademarks; this image is not endorsed by
Canonical.

## Chromium

Debian 13's `chromium`, `chromium-common` and `libjpeg62-turbo` packages (Debian `main`), from
https://snapshot.debian.org/ at the same date (`trixie-security` and `trixie`). Chromium is BSD-3-Clause with many
third-party components under their own licences, all listed in `/usr/share/doc/chromium/copyright`. Source:
`https://snapshot.debian.org/archive/debian-security/<aptSnapshot>/pool/updates/main/c/chromium/` and
https://chromium.googlesource.com/chromium/src. This is Chromium, not Google Chrome; it carries no Google branding.

## Docker

Docker CE (`docker-ce`, `docker-ce-cli`), containerd (`containerd.io`), Buildx and Compose, from Docker's apt
repository (https://download.docker.com/linux/ubuntu), at the versions in `/etc/kantel/image.json`: Apache-2.0
(`/usr/share/common-licenses/Apache-2.0`). Source: https://github.com/moby/moby, https://github.com/docker/cli,
https://github.com/containerd/containerd, https://github.com/docker/buildx and https://github.com/docker/compose,
at the matching release tags. Docker and the Docker logo are trademarks of Docker, Inc.

## Node.js

Node.js, the official release tarball (https://nodejs.org/dist/), in `/usr/local`: MIT, with bundled components
under their own permissive licences, all in `/usr/share/doc/node/LICENSE`. Source: https://github.com/nodejs/node at
the release tag. Node.js is a trademark of the OpenJS Foundation.

## Go

Go, the official release (https://go.dev/dl/), in `/usr/local/go`: BSD-3-Clause (`/usr/local/go/LICENSE`). Source:
https://go.googlesource.com/go at the release tag (also in `/usr/local/go/src`).

## Selkies

Selkies, the desktop stream, from its release `.deb` (https://github.com/selkies-project/selkies/releases), in
`/opt/selkies` and `/usr/lib/*/selkies_*_interposer.so`: MPL-2.0. Source: https://github.com/selkies-project/selkies
at the release tag. It carries its own Python environment; each package's licence is in
`/opt/selkies/lib/python3*/site-packages/*.dist-info/`. Among them:

- pixelflux (the screen encoder) and pcmflux (audio): MPL-2.0, https://github.com/selkies-project/pixelflux and
  https://github.com/selkies-project/pcmflux. Their `licenses/LICENSES.md` inventories every native library they
  contain.
- pixelflux's published build links **libx264** and **x265**, which are **GPL-2.0-or-later**, so that extension as
  distributed is under the GPL, and **libde265** (its virtual camera's HEVC decoder), **LGPL-3.0-or-later**. All
  three are in `pixelflux.libs/`. Their exact corresponding source is attached to the same GitHub Release as the
  image (https://github.com/lleverage-ai/kantel/releases, the `host-images-*` tag in the images' `manifest.json`):
  `source-x264-*.tar.gz`, `source-x265-*.tar.gz` and `source-libde265-*.tar.gz`, each the upstream commit that
  pixelflux's build recipe checks out, with `source-pixelflux-*.tar.gz`, pixelflux's own source at the same release,
  whose `pyproject.toml` is that recipe. `SOURCES.md` there names each commit and upstream
  (https://code.videolan.org/videolan/x264, https://bitbucket.org/multicoreware/x265_git,
  https://github.com/strukturag/libde265) and `SOURCES.sha256` their checksums; `apps/host/guest/gpl-sources.sh`
  makes them from the built image. Selkies' other encoders (libvpx BSD-3-Clause, SVT-AV1 BSD-3-Clause-Clear,
  OpenH264 BSD-2-Clause, libjpeg-turbo) are permissive.
- The other bundled shared libraries (in `*.libs/`: libpulse, libsndfile, libdbus, libsystemd, libgcrypt and
  others under LGPL-2.1-or-later; libwebp, libpng, freetype, harfbuzz, zstd and
  others under permissive licences) are unmodified builds of those libraries and may be replaced.
- The remaining Python packages (aiohttp, cryptography, pillow, psutil, uvloop and others) are under Apache-2.0,
  MIT, BSD, ISC or PSF-2.0, as each `*.dist-info` says.

## The isolate image

`isolate-<arch>.ext4`, the isolate tier's VM (`apps/host/guest/isolate.Dockerfile`), holds:

- Debian 13 (`debian:trixie-slim`) packages from Debian `main`, with each one's licence in
  `/usr/share/doc/<package>/copyright` and its source at https://snapshot.debian.org/ by version;
- workerd, Cloudflare's runtime (`/usr/local/bin/workerd`, from npm's `@cloudflare/workerd-linux-*`): Apache-2.0,
  source at https://github.com/cloudflare/workerd at the matching release;
- Kantel's isolate worker (`/opt/kantel-isolate`, Apache-2.0), a bundle that includes just-bash (Apache-2.0) and its
  dependencies, all under permissive licences (MIT, ISC, BSD-2/3-Clause, Apache-2.0), as `apps/host/isolate/bun.lock`
  lists them;
- this file, at `/usr/share/kantel/THIRD-PARTY-NOTICES.md`.

## Codecs and patents

The image contains video codecs (H.264 and H.265 encoders in Selkies; Chromium's media decoders and Ubuntu's
OpenH264, built from source). Their copyright licences above allow redistribution. Patent licences for H.264 and
H.265 are a separate matter that this notice does not grant; whoever deploys the image is responsible for any that
their use needs.

## Getting the source

Everything above is published source at the stated locations, pinned by version: the Ubuntu and Debian snapshots
keep every package version permanently, and each image release carries the source of the GPL and LGPL libraries
bundled in Selkies' pixelflux (above). If you need a copy of the source of any GPL or LGPL component of a published
image and can't get it from those locations, open an issue at https://github.com/lleverage-ai/kantel/issues.
