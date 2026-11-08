# The microVM sandbox's default image: Ubuntu 26.04 LTS with systemd, SSH, Docker and containerd, git, curl, jq,
# build tools, Node, Python and Go, an Openbox desktop on a TigerVNC display, Chromium with its DevTools port on a display
# of its own, and Selkies streaming the desktop and, on demand, the browser alone, plus Kantel's guest agent.
# apps/host/guest/rootfs.sh turns it into a read-only ext4 image that every sandbox on a host shares; each sandbox
# writes to its own disk through an overlay (kantel-init). apps/host/guest/README.md says what listens where and how custom images layer on top.
#
# Build context: apps/host, with the guest agent already built at dist/kantel-guest-<arch> (rootfs.sh does both).
#
# Reproducible: the base image is pinned by digest, Ubuntu's packages come from snapshot.ubuntu.com at
# UBUNTU_SNAPSHOT, Chromium comes from snapshot.debian.org at the same date, and Node, Go and Selkies are pinned
# releases checked against their SHA-256. Docker's apt repository keeps no snapshots, so Docker is pinned by version;
# /etc/kantel/image.json records every version that went in.
#
# Everything in the image may be redistributed: /usr/share/kantel/THIRD-PARTY-NOTICES.md (from guest/rootfs/, and
# published beside the image) lists what it bundles, under which licences, and where each one's source is.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
ARG TARGETARCH
ARG UBUNTU_SNAPSHOT=20261103T000000Z
ARG DOCKER_VERSION=5:29.9.2-1~ubuntu.26.04~resolute
ARG CONTAINERD_VERSION=2.4.2-3~ubuntu.26.04~resolute
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG NODE_SHA256_ARM64=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
ARG SELKIES_VERSION=2.2.0
ARG SELKIES_SHA256_AMD64=0e9725fd1c94c73f469a26520bb196137cc4e2b7def7b6d3174879def831abaa
ARG SELKIES_SHA256_ARM64=bf2e5c640a87eedd5a80e6a5b29782df1f8bc28bc29298ec3a9c9f3fe90f86c3
ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# Ubuntu's own packages, from the archive as it was at UBUNTU_SNAPSHOT (the snapshot service is HTTPS only, so CA
# certificates come first, and again from the snapshot). apt knows the snapshot of archive.ubuntu.com by its host, but
# arm64's ports.ubuntu.com only by the Origin of a Release file it already holds, so after the lists are cleared an
# update would read the live archive and then look for the packages under the snapshot. The host's mapping fixes that:
# snapshot.ubuntu.com/ubuntu carries every architecture.
# The desktop is Openbox with two tint2 panels (a top bar and a dock), rofi for the app list, and small GTK 3 apps
# that need no GPU: LXTerminal, PCManFM and Geany. hsetroot draws the background as a root pixmap, which tint2 and
# rofi show through their rounded corners without a compositor; librsvg2-common lets GTK and rofi draw SVG icons;
# xsettingsd hands the GTK apps the DPI a viewer's pixel ratio asks for (kantel-session).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
	&& echo "APT::Snapshot \"$UBUNTU_SNAPSHOT\";" > /etc/apt/apt.conf.d/50kantel-snapshot \
	&& echo 'Acquire::Snapshots::URI::Host::ports.ubuntu.com "https://snapshot.ubuntu.com/ubuntu/@SNAPSHOTID@/";' \
		>> /etc/apt/apt.conf.d/50kantel-snapshot \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
		systemd systemd-sysv dbus dbus-user-session udev kmod util-linux-extra iproute2 iptables nftables iputils-ping procps psmisc \
		ca-certificates curl wget gnupg git openssh-server sudo less nano vim-tiny jq unzip zip xz-utils file \
		python3 python3-pip python3-venv python3-dev build-essential pkg-config e2fsprogs \
		tigervnc-standalone-server tigervnc-tools dbus-x11 x11-utils x11-xserver-utils xdotool xclip xauth \
		openbox tint2 rofi hsetroot xsettingsd lxterminal pcmanfm geany librsvg2-common \
		adwaita-icon-theme fonts-dejavu-core fonts-liberation fonts-noto-color-emoji imagemagick \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# Docker and containerd from Docker's repository, pinned.
RUN install -d -m 0755 /etc/apt/keyrings \
	&& curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
	&& echo "deb [arch=$TARGETARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu resolute stable" \
		> /etc/apt/sources.list.d/docker.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends "docker-ce=$DOCKER_VERSION" "docker-ce-cli=$DOCKER_VERSION" \
		"containerd.io=$CONTAINERD_VERSION" docker-buildx-plugin docker-compose-plugin \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# Chromium, as Debian 13 (trixie) builds it: open source and redistributable (Google Chrome isn't), on amd64 and arm64,
# and without snapd (Ubuntu's chromium is a snap). Debian's security archive carries the current stable Chromium. The
# pin lets apt take only these packages from Debian; everything else stays Ubuntu's. APT::Snapshot applies here too,
# so the build gets Debian's archive as it was at UBUNTU_SNAPSHOT. Debian's archive keys come from Ubuntu's own
# debian-archive-keyring.
RUN apt-get update && apt-get install -y --no-install-recommends debian-archive-keyring \
	&& printf '%s\n' 'Types: deb' 'URIs: http://deb.debian.org/debian-security' 'Suites: trixie-security' \
		'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-trixie-security-automatic.gpg' '' \
		'Types: deb' 'URIs: http://deb.debian.org/debian' 'Suites: trixie' 'Components: main' \
		'Signed-By: /usr/share/keyrings/debian-archive-trixie-automatic.gpg' > /etc/apt/sources.list.d/debian-chromium.sources \
	&& printf '%s\n' 'Package: *' 'Pin: release o=Debian' 'Pin-Priority: -1' '' \
		'Package: chromium chromium-common chromium-sandbox libjpeg62-turbo' 'Pin: release o=Debian' 'Pin-Priority: 500' \
		> /etc/apt/preferences.d/debian-chromium \
	&& apt-get update && apt-get install -y --no-install-recommends chromium \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# Node, Go and Selkies: pinned releases, checked.
RUN case "$TARGETARCH" in \
		amd64) node_arch=x64 node_sum=$NODE_SHA256_AMD64 go_sum=$GO_SHA256_AMD64 selkies_sum=$SELKIES_SHA256_AMD64 ;; \
		arm64) node_arch=arm64 node_sum=$NODE_SHA256_ARM64 go_sum=$GO_SHA256_ARM64 selkies_sum=$SELKIES_SHA256_ARM64 ;; \
	esac \
	&& curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node_arch.tar.xz" -o /tmp/node.tar.xz \
	&& echo "$node_sum  /tmp/node.tar.xz" | sha256sum -c - \
	&& tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE \
		--exclude=README.md \
	&& install -d /usr/share/doc/node && tar -xJf /tmp/node.tar.xz -O "node-v$NODE_VERSION-linux-$node_arch/LICENSE" \
		> /usr/share/doc/node/LICENSE \
	&& curl -fsSL "https://go.dev/dl/go$GO_VERSION.linux-$TARGETARCH.tar.gz" -o /tmp/go.tar.gz \
	&& echo "$go_sum  /tmp/go.tar.gz" | sha256sum -c - \
	&& tar -xzf /tmp/go.tar.gz -C /usr/local \
	&& ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/ \
	&& selkies_deb="selkies-$SELKIES_VERSION-ubuntu26.04-$TARGETARCH.deb" \
	&& curl -fsSL "https://github.com/selkies-project/selkies/releases/download/$SELKIES_VERSION/$selkies_deb" \
		-o "/tmp/$selkies_deb" \
	&& echo "$selkies_sum  /tmp/$selkies_deb" | sha256sum -c - \
	&& apt-get update && apt-get install -y --no-install-recommends "/tmp/$selkies_deb" \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# Security updates: the base image is pinned by digest and the packages above by UBUNTU_SNAPSHOT, so a rebuild alone
# never picks up a fix. The daily build (.github/workflows/sandbox-image.yml, through release.sh and rootfs.sh) passes
# today's date, which re-runs this layer even with a warm cache. APT::Snapshot would hold this upgrade at the snapshot
# too, so for this one layer its setting is moved aside: apt reads the live archives the image's sources name (Ubuntu's
# with its -updates and -security pockets, security.ubuntu.com among them; deb.debian.org's trixie-security for
# Chromium, still limited to Chromium's packages by the pin above), and the setting comes back for anything installed
# later. Docker and containerd stay held at their pinned versions. A build with the refresh is reproducible only from
# its own date; /etc/kantel/image.json and packages.tsv, written below, record what went in.
ARG KANTEL_SECURITY_REFRESH=unset
RUN echo "security refresh $KANTEL_SECURITY_REFRESH" \
	&& mv /etc/apt/apt.conf.d/50kantel-snapshot /tmp/50kantel-snapshot \
	&& apt-mark hold docker-ce docker-ce-cli containerd.io >/dev/null \
	&& apt-get update \
	&& apt-get -y upgrade --no-install-recommends \
	&& apt-mark unhold docker-ce docker-ce-cli containerd.io >/dev/null \
	&& mv /tmp/50kantel-snapshot /etc/apt/apt.conf.d/50kantel-snapshot \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

# The sandbox user, as on other sandboxes agents know: `user`, uid 1000, passwordless sudo, in the docker group and
# the kvm group (/dev/kvm, for nested VMs). Ubuntu's images come with an `ubuntu` user at uid 1000; it goes.
RUN userdel -r ubuntu 2>/dev/null || true; \
	groupadd -f --system kvm \
	&& useradd --uid 1000 --create-home --shell /bin/bash --groups sudo,docker,kvm user \
	&& echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && chmod 0440 /etc/sudoers.d/user \
	&& passwd -d root && passwd -l root

# Staged, then copied with modes made readable: COPY keeps the build context's modes, and a checkout made under a
# strict umask (077) would otherwise leave /usr and /etc/... unreadable to the sandbox user. Geany's settings name its
# file browser plugin by a path with the architecture in it, filled in here and checked.
COPY dist/kantel-guest-${TARGETARCH} /usr/local/bin/kantel-guest
COPY guest/rootfs/ /tmp/kantel-rootfs/
RUN chmod -R u+rwX,go+rX-w /tmp/kantel-rootfs /usr/local/bin/kantel-guest \
	&& cp -a /tmp/kantel-rootfs/. / && rm -rf /tmp/kantel-rootfs \
	&& sed -i "s|@MULTIARCH@|$(dpkg-architecture -qDEB_HOST_MULTIARCH)|" /home/user/.config/geany/geany.conf \
	&& test -f "$(sed -n 's|^active_plugins=\(.*\);$|\1|p' /home/user/.config/geany/geany.conf)" \
	&& chown -R 1000:1000 /home/user && mkdir -p /etc/kantel \
	&& chmod 0440 /etc/sudoers.d/kantel-proxy && visudo -c >/dev/null \
	&& install -d -m 0700 /root/.docker && install -m 0600 /home/user/.docker/config.json /root/.docker/config.json \
	&& ln -sf kantel-guest /usr/local/bin/kantel-doctor \
	&& ln -sf kantel-guest /usr/local/bin/kantel-connect \
	&& ssh-keygen -lf /etc/ssh/ssh_known_hosts >/dev/null \
	&& test "$(ssh -G git@github.com | sed -n 's/^proxycommand //p')" = '/usr/local/bin/kantel-connect %h %p'

# What a sandbox installs: Ubuntu's live archive (archive.ubuntu.com and security.ubuntu.com, ports.ubuntu.com on
# arm64), as any Ubuntu machine, and not the snapshot: snapshot.ubuntu.com failed for hours on 5 Nov 2026
# (lleverage-ai/kantel#706), and a 4xx from it fails `apt-get update` outright, so a fallback under it isn't enough.
# APT::Snapshot moves to /etc/kantel/apt-snapshot.conf, which records UBUNTU_SNAPSHOT, and Debian's Chromium source
# reads deb.debian.org under its pin. Written last, so the steps above read only what they did before (the snapshot, and
# the live archive in the security refresh alone): the build stays reproducible, and still fails loudly when the
# snapshot does. kantel-apt-sources says how.
RUN /usr/local/sbin/kantel-apt-sources

# No serial getty (the console is Firecracker's stdout), no units that wait for hardware a microVM doesn't have or
# fetch things on a timer, and SSH keys only per sandbox (the guest agent makes them after every create and fork).
# sshd runs as a plain service rather than Ubuntu's socket activation (see ssh.service.d/kantel.conf).
RUN systemctl disable ssh.socket && rm -f /etc/systemd/system/ssh.service.requires/ssh.socket \
	&& systemctl enable kantel-guest.service kantel-desktop.service kantel-browser-display.service kantel-browser.service \
		kantel-stream.service ssh.service docker.service containerd.service \
	&& systemctl mask serial-getty@ttyS0.service getty@tty1.service systemd-timesyncd.service apt-daily.timer \
		apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer man-db.timer motd-news.timer dpkg-db-backup.timer \
		systemd-networkd-wait-online.service NetworkManager-wait-online.service \
	&& rm -f /etc/ssh/ssh_host_* \
	&& chmod 0755 /usr/sbin/kantel-init \
	&& mkdir -p /newroot /disk \
	&& echo kantel > /etc/hostname \
	&& kantel-image-info > /etc/kantel/image.json \
	&& dpkg-query -W -f '${Package}\t${Version}\t${source:Package}\t${source:Version}\n' | sort \
		> /usr/share/kantel/packages.tsv
