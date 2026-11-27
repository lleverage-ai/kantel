# The microVM guest

What runs inside a microVM sandbox: the default image (`Dockerfile`), its guest kernel (`kernel/`), and the files
both add (`rootfs/`). `rootfs.sh` turns the image into the read-only ext4 every sandbox on a host shares;
`kernel/build.sh` builds the kernel. `kantel-host install` fetches both, checked against the images manifest (see
"Publishing" below).

## What's in the default image

Ubuntu 26.04 LTS (pinned by digest, packages from `snapshot.ubuntu.com` at `UBUNTU_SNAPSHOT`), systemd, and:

- Docker CE and containerd (pinned versions), with Buildx and Compose. Containers reach the egress proxy through the
  guest agent's forwarder on docker0's gateway (`172.17.0.1:3128`), which doesn't move on a fork or resume as the
  proxy's own address does; `~/.docker/config.json` (user's and root's) gives every container and build
  `HTTPS_PROXY` there, and no `HTTP_PROXY`, so containers still call each other by name over plain HTTP (#760)
- git, curl, wget, jq, build-essential, pkg-config, Python 3 with pip and venv, Node and Go (pinned releases,
  checked against their SHA-256). Node (`NODE_VERSION`, 26) is the only one, in `/usr/local`, with npm and no corepack;
  a project that needs another installs it beside it (docs: Isolates and microVMs, "Node")
- a desktop on a TigerVNC X server (display `:1`, 1920x1080 until a viewer resizes it): Openbox with a top bar and a
  dock ("The desktop" below), and Chromium (Debian 13's build, from `snapshot.debian.org` at the same date; Ubuntu's
  own Chromium is a snap, and Google Chrome can't be redistributed)
- Selkies, streaming the desktop to a browser
- OpenSSH, the guest agent (`kantel-guest`) and `kantel-init`
- `kantel-connect` (the guest agent), ssh's `ProxyCommand` through the egress proxy, which
  `/etc/ssh/ssh_config.d/kantel.conf` uses for `github.com` (to `ssh.github.com:443`), with GitHub's published host
  keys in `/etc/ssh/ssh_known_hosts`: a sandbox has no DNS and no route out but the proxy, which ssh doesn't read
  (docs: Egress proxy, "Git over SSH"). Update the keys if GitHub changes them; the build checks they parse
- `kantel-sign` (the guest agent), Git's signing program for a sandbox with a signing key: it sends each commit or tag
  to the host over vsock port 1028, which signs it with a key the sandbox never holds. `/etc/gitconfig` includes
  `/etc/kantel/gitconfig`, which the agent writes (with `/etc/kantel/signing.pub`) only while the sandbox has a key

`/etc/kantel/image.json` records every version that went in (`kantel-image-info` writes it at build time), and
`/usr/share/kantel/packages.tsv` every package with its source package. What the image bundles, under which licences,
and where each part's source is: [`rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md`](rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md),
at the same path in the image and published beside it. Everything in it may be redistributed; keep it that way (no
Google Chrome, nothing from Ubuntu's `restricted` or `multiverse`), and update the notices when a component is added.
The one exception is a private build with Chrome for Testing ("Chrome for Testing" below), which is never published.

The sandbox user is `user` (uid 1000): passwordless sudo, and in the `docker` and `kvm` groups, so it runs
containers and nested VMs without root.

The build reads only the snapshot, so it is reproducible and fails when `snapshot.ubuntu.com` does. apt in a sandbox,
and in a custom image's build, reads Ubuntu's live archive instead (`archive.ubuntu.com` and `security.ubuntu.com`,
`ports.ubuntu.com` on arm64), as any Ubuntu machine does, so it doesn't depend on the snapshot service (#706: it
answered 503, 502 and 401 for hours, and a 4xx fails `apt-get update` outright, however the sources are pinned).
`kantel-apt-sources` writes those sources last and moves `APT::Snapshot` to `/etc/kantel/apt-snapshot.conf`, which
records the snapshot the image was built from; Debian's Chromium source then reads `deb.debian.org`, still limited to
Chromium's packages. The guest agent points apt at the egress proxy in `/etc/apt/apt.conf.d/90kantel-proxy`, so apt
goes through it in any environment, including a root shell that never read the proxy variables.

sudo keeps the proxy and CA variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms,
`NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY`, `REQUESTS_CA_BUNDLE`) by `env_keep` in `/etc/sudoers.d/kantel-proxy`, so
`sudo npm i -g pnpm` reaches the network as `npm i` does (#731). It keeps what the caller had: a root shell started some
other way has them from `/etc/profile.d/kantel.sh` if it's a login shell. A sandbox has no DNS, so a name only resolves
through the proxy: `getent hosts`, `ping` and `nslookup` fail, and a program that ignores the proxy variables can't
connect.

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
| 172.17.0.1:3128 | The same forwarder on docker0's gateway, for containers (bound before docker0 is up) | `kantel-guest.service` | |

The host's egress proxy sits on each sandbox's own gateway address, which a fork changes. Shells and `exec` get it
from `/etc/kantel/proxy.env`; Chromium and dockerd, which read a proxy once at start, use the forwarder on 3128, which
follows the sandbox's current proxy, so a fork or resume never restarts them (no lost tabs or containers).

Every other systemd service gets the proxy and CA variables from `/etc/systemd/system.conf.d/kantel-proxy.conf`
(`DefaultEnvironment`), and PAM sessions (sudo, su, SSH, cron) from `/etc/environment`, both pointing at the forwarder,
so they are fixed in the image and never go stale (#730). The sandbox's own variables (`kantel new -e`) are for
commands only; a unit that wants them adds `EnvironmentFile=-/etc/kantel/env`, which the guest agent rewrites on every
start, resume and fork. A test in `internal/microvm` checks both files against the variables the host sets.

Selkies needs no GPU, no UDP and no TURN: it serves one HTTP port, so a relay that carries a TCP stream carries the
desktop. It has no login of its own; whatever fronts it (the gateway's signed URLs) does access control.

Both streams follow the viewer: its window's size times its device pixel ratio becomes the display's, so the picture
is one stream pixel per screen pixel, sharp on a HiDPI screen, up to a pixel budget (`kantel-selkies`): 2240x1260's
worth (2,822,400 pixels), or 1920x1080's on a sandbox of two vCPUs or fewer, about what each encodes at 30 frames a
second. A larger window gets the budget's size in its own shape, drawn to fill it, and a DPI lowered to match, so the
desktop's text stays the size of the viewer's own. Selkies sets that DPI as `Xft.dpi`, which Chromium reads as it
starts, and the desktop session follows it (below). Selkies encodes only what changes (its Turbo mode off), in 4:4:4
colour (4:2:0 for a browser that can't decode it), with no overlay of its own.
`/etc/kantel/desktop.env` can set `KANTEL_DESKTOP_SIZE` (the desktop's size until a viewer resizes it),
`KANTEL_STREAM_ENCODER` (`h264enc`, `h264enc-striped`, `jpeg`), `KANTEL_STREAM_FPS`, `KANTEL_STREAM_MAX_PIXELS` (`0`
lifts the budget) and `KANTEL_STREAM_FLAGS`, which comes last and so overrides any of Selkies' settings above, such as
`--video-fullcolor=false`.

### The desktop

`kantel-session` (from `kantel-desktop`) runs Openbox and two tint2 panels: a thin top bar (an Applications button,
the open windows, the clock) and a dock at the bottom with five launchers, left to right: the apps list (rofi),
Chromium, a terminal (LXTerminal), a file manager (PCManFM) and an editor (Geany). All are small GTK 3 apps that draw
on the CPU, so they need no GPU and start in well under a second. The look is dark (Adwaita-dark, DejaVu fonts, a
Kantel Openbox theme); the settings are in `rootfs/home/user/.config`, the dock's launchers and icons in
`rootfs/usr/share/kantel/{dock,icons}`. LXTerminal keeps 10,000 lines of scrollback; Geany shows line numbers, its
One Dark scheme and its file browser in the sidebar.

The session follows the DPI Selkies sets for the viewer (`Xft.dpi`, 96 at a pixel ratio of 1, 144 at 2 on four vCPUs,
120 on two), live: xsettingsd hands it to the GTK apps, which redraw at it, and a watcher in `kantel-session`
restarts Openbox in place (window titles, menus; windows stay open) and the two panels at it. tint2 scales by
`scale_relative_to_dpi`, which `kantel-session` sets in a copy of each panel's file under
`$XDG_RUNTIME_DIR/kantel-session`, since Xvnc's monitor has no physical size for tint2 to read. xsettingsd reads a
file of the session's own there with the DPI alone, not the `~/.xsettingsd` Selkies writes, which would also turn
on subpixel antialiasing and fringe the text in colour on the viewer's screen. A stream restarts with its display
(`PartOf=`), so a new X server gets the viewer's size and DPI again.

The dock's Chromium (`kantel-chromium`) is the desktop's own: a profile of its own (`~/.config/chromium`, beside the sandbox
browser's `~/.config/kantel-chrome`) through the guest's proxy, not the sandbox's browser. That one runs on display `:2` with its DevTools port open to
the session's tools, and the browser view streams it alone; sharing it would put the user's tabs in front of the
agent's automation and take the browser view's window away. Where desktop.env puts the sandbox's browser on `:1`
(`KANTEL_BROWSER_DISPLAY=:1`, or a host from before the browser view), the dock raises it instead.

`KANTEL_DESKTOP_SESSION` in `/etc/kantel/desktop.env` runs another session in its place, as a custom image that
installs XFCE might (`KANTEL_DESKTOP_SESSION=startxfce4`).

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

The host asks for this by booting the guest with `kantel.browser=surface` on its kernel command line, which every
`kantel-host` from this change on does (and the display's and stream's units have as their condition). A host from
before it would drop the guest agent's report of the surface, so the control plane would open the desktop's page for
the browser: booted without the argument, the image keeps Chromium on the desktop, where that page shows it. Any image
works on any host; the browser alone needs both to be new.

The guest agent's `browserSurface` report is a prediction, made at boot before services start, and the control plane
keeps it by image version. What a machine shows is decided from the machine itself: `kantel-browser` writes the display
it started Chromium on to `/run/kantel-browser/display` (its unit's runtime directory: removed when the unit stops and
on a cold boot, kept in memory snapshots), and `openBrowser` reads it in the same command that asks Chromium for its
DevTools target. `:2` with the display up gives the browser alone (6081); anything else, including an image from
before this record, a sandbox paused under an older host or a setup that moved Chromium back, gives the desktop's page.

`KANTEL_BROWSER_DISPLAY=:1` in `desktop.env` (its last assignment) puts Chromium back on the desktop, as before (no
other value moves it):
the guest agent then reports
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

## Chrome for Testing

When Debian's Chromium is behind on a security fix that can't wait (LLE-18651: CVE-2026-125350, exploited in the wild,
while Debian had no 157), `KANTEL_BROWSER=cft` builds the sandbox image with Google Chrome for Testing in place of
Debian's Chromium. `debian`, the default, builds as before. The `cft` image has `CFT_VERSION`'s zip (pinned by version
and SHA-256 in the `Dockerfile`) in `/opt/chrome-for-testing`, without its Widevine CDM, with `/usr/bin/chromium`
pointing at it, the libraries its `deb.deps` names from Ubuntu, and Chromium's icon. The build fails below
`CFT_MIN_VERSION`. Everything that looks for `chromium` finds it (`kantel-browser`, `kantel-chromium`, the guest agent's
capabilities), the window class `Chromium-browser` is matched where Chromium's is, `image.json` records it as
`chromeForTesting`, and Chromium's sandbox stays on. The daily security refresh doesn't touch it: a newer one is a new
`CFT_VERSION`.

Chrome for Testing is a flavour of Google Chrome, under Google's terms, which forbid redistributing it
(GoogleChromeLabs/chrome-for-testing#21). So a `cft` image is **never published**, and never served through a
control plane (the hosted one's `/v1/hosts/images` and a self-hosted gateway's `KANTEL_COMPUTE_IMAGES` ask no
credential, so serving it there would distribute it). `release.sh --publish` refuses it, `out/BUILD` records the
browser, no workflow sets `KANTEL_BROWSER` (a test in `internal/guest` fails if one does), and the image's
`THIRD-PARTY-NOTICES.md` says what it bundles and that it may not be redistributed (`cft/notices.md`).

Hosts you run yourself take it in one of two ways: automatically from a private image source (below), or by hand
through `sandboxImage`.

### From a private image source

A host with `imagePatching` on can follow a private source of host images instead of the control plane's image
channel: `imageSource` in `/etc/kantel-host/config.json`. It is off unless set. The host asks the source for its
version every `intervalMinutes` (default 60) and takes a new one as it takes the channel's: it checks the manifest's
signature against `imageKey` before fetching anything else, checks every file against the manifest's SHA-256, installs
the version beside the others, and one rename makes it current. Sandboxes stay on the version they were made on; new
sandboxes, and the templates rebuilt for the new image, start on it. Anything that fails leaves the current images as
they are and is logged. Pointing the source back at a version the host still has (it keeps the newest two, and any a
sandbox or snapshot is on) rolls back without downloading the images again.

Build the whole set with `release.sh`, never with `--publish` (which refuses a `cft` build anyway). Without it,
`release.sh` builds every image the host takes (kernels, the sandbox and isolate images, the guest agent, the isolate
runtime), writes `manifest.json` with each file's SHA-256, and `SHA256SUMS`:

```sh
VERSION=host-images-20261126.cft-158.0.8127.88   # release.sh wants host-images-<yyyymmdd>; a new one for every build
KANTEL_BROWSER=cft apps/host/guest/release.sh out "$VERSION"
apps/host/guest/boot-check-arm64.sh out
(cd out && sha256sum -c SHA256SUMS)
```

Sign the manifest with your own key (a `cosign generate-key-pair` key kept off the hosts; each host has only
`cosign.pub`, as `imageKey`). Kantel's workflow signs its public images keylessly, as its own GitHub workflow, which a
private build can't be. `cosign` records the signature in Sigstore's public transparency log, as the host's check
expects: the entry holds the manifest's digest and your public key, not the images.

```sh
cosign sign-blob --yes --key cosign.key --bundle out/manifest.json.sigstore.json out/manifest.json
cosign verify-blob --key cosign.pub --bundle out/manifest.json.sigstore.json out/manifest.json
```

Then upload it where only your hosts can read it. Either:

- **A directory over HTTPS** (`"type": "http"`, the default): any static file server, such as an R2 or S3 bucket
  behind Cloudflare Access. Upload `manifest.json`, `manifest.json.sigstore.json`, `SHA256SUMS` and the files
  `release.sh` listed under `<url>/$VERSION/`. Then, last, write `<url>/channel.json` as `{"version": "$VERSION"}`:
  that is what moves the hosts, so a half-uploaded version is never taken.
- **A private GitHub repository's releases** (`"type": "github-release"`, `url`
  `https://api.github.com/repos/<owner>/<repo>`): make a release tagged `$VERSION` with the same files as assets,
  as a draft, and publish it once every asset is up. Its latest release (never a draft or a prerelease) is the version
  the hosts take. Assets are fetched through the API by name, with `Accept: application/octet-stream`.

`headersFile` names a file of `Name: value` lines sent with every request to the source's own origin, and nowhere
else (a redirect to another origin, such as a release asset's storage, goes without them). Only its owner may read
it (mode 600 or 400), and it must belong to the user kantel-host runs as (root); a file the group or anyone else can
read is refused, the reason is logged, and the host stays on its images until it's fixed. The values are never logged. The file is read again at
every check, so a rotated token needs no restart. Headers need an `https://` URL.

```sh
# Cloudflare Access service token
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$ID" "$SECRET" | sudo install -m 600 /dev/stdin /etc/kantel-host/image-source.headers
# or a GitHub token that can read the repository's contents
printf 'Authorization: Bearer %s\n' "$TOKEN" | sudo install -m 600 /dev/stdin /etc/kantel-host/image-source.headers
```

```json
{
  "imagePatching": true,
  "imageKey": "/etc/kantel-host/cosign.pub",
  "imageSource": {
    "type": "http",
    "url": "https://images.example.com/kantel",
    "headersFile": "/etc/kantel-host/image-source.headers",
    "intervalMinutes": 60
  }
}
```

Restart kantel-host after changing the config. It logs `following the image source` and, after each version,
`host images updated`. Remove `imageSource` (and `imageKey`) to go back to Kantel's channel once Debian's Chromium has
the fix and the public images carry it. The control plane's channel and `kantel-host install` never send the source's
headers, and a host on a source doesn't follow the channel.

### By hand

Build it locally and copy it to the hosts you run yourself, which boot it through `sandboxImage`:

```sh
KANTEL_BROWSER=cft apps/host/guest/rootfs.sh out sandbox amd64   # out/sandbox-amd64.ext4
KANTEL_BROWSER=cft apps/host/guest/rootfs.sh out sandbox arm64   # under QEMU user emulation, about an hour
apps/host/guest/boot-check-arm64.sh out                           # with out/vmlinux-aarch64 (kernel/build.sh)
```

On each host, copy `sandbox-<arch>.ext4` to
`/var/lib/kantel-host/private/sandbox-cft-<CFT_VERSION>-<arch>.ext4`, set `"sandboxImage"` to that path in
`/etc/kantel-host/config.json`, and restart kantel-host, which makes its templates again for the new image. A
reinstall keeps an operator's own `sandboxImage`. Remove the setting once Debian's Chromium has the fix and the public
images carry it.

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

## The isolate image

`isolate.Dockerfile` is the isolate tier's VM: Debian 13 slim with systemd, the guest agent and `kantel-isolate`
(Kantel's isolate runtime, `apps/host/isolate-runtime`: deno_core and V8), whose `kantel-isolate.service` runs it as
its own unprivileged user. `/usr/local/bin/kantel-isolate` is the binary, `/opt/kantel-isolate` its assets (the
guest bundles, Pyodide and its memory snapshot), read-only. It has no network device: the runtime reaches the host's
blob store and egress proxy through the guest agent's vsock bridges (`127.0.0.1:7001` and `7002`), and the host
reaches it on `127.0.0.1:8080` (the `isolate` ready name).

`rootfs.sh <out> isolate <arch>` builds both through `isolate-runtime.sh`, which compiles the runtime in a Rust
container (glibc, cross-compiled for the other architecture; the script says why) and runs the crate's
`build-assets.sh`. `KANTEL_ISOLATE_BINARY` and `KANTEL_ISOLATE_ASSETS` build the image around a binary and assets made
elsewhere. With an early build of the runtime the image is about 560 MB (80 MB gzipped), against about 600 MB (87 MB)
when it ran workerd; the runtime (about 70 MB) and Pyodide with its snapshot (about 45 MB) are most of it.
`test/isolate.sh <images> <firecracker>` boots it through `kantel-host`'s own code and runs commands in it.

## The kernel

`kernel/kantel.config` is a Firecracker guest config with what Docker needs (overlayfs, cgroups v2, namespaces,
netfilter and nftables, bridge, veth, VXLAN, IPVS) and KVM, so a sandbox runs its own VMs: on a host whose KVM has
nested virtualisation on (`kvm_amd nested=1` or `kvm_intel nested=1`), `/dev/kvm` is there in every sandbox.
`kernel/kantel-<arch>.config` adds what only one architecture has (x86_64's Intel and AMD KVM). FUSE (bucket mounts)
is in Firecracker's config already; `kantel.config` names it so the build fails if it ever isn't. It has erofs too,
for bundle mounts: the host attaches each bundle a sandbox mounts as an erofs image on a read-only drive (`/dev/vdc`
on), which the guest agent mounts read-only where asked (`POST /bundles`). An image whose kernel or guest agent
predates them says so in each bundle mount's status.

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
