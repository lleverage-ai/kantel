# The microVM sandbox's default image: Ubuntu 26.04 LTS with systemd, SSH, Docker and containerd, git, curl, jq,
# build tools, Node, Python and Go, an XFCE desktop on a TigerVNC display, Google Chrome with its DevTools port, and
# Selkies streaming that desktop to a browser, plus Kantel's guest agent. apps/host/guest/rootfs.sh turns it into a
# read-only ext4 image that every sandbox on a host shares; each sandbox writes to its own disk through an overlay
# (kantel-init). apps/host/guest/README.md says what listens where and how custom images layer on top.
#
# Build context: apps/host, with the guest agent already built at dist/kantel-guest-<arch> (rootfs.sh does both).
#
# Reproducible: the base image is pinned by digest, Ubuntu's packages come from snapshot.ubuntu.com at
# UBUNTU_SNAPSHOT, and Node, Go and Selkies are pinned releases checked against their SHA-256. Docker's and Google's
# apt repositories keep no snapshots, so Docker is pinned by version and Chrome is the stable channel at build time;
# /etc/kantel/image.json records every version that went in.
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
# certificates come first, and again from the snapshot).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
	&& echo "APT::Snapshot \"$UBUNTU_SNAPSHOT\";" > /etc/apt/apt.conf.d/50kantel-snapshot \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
		systemd systemd-sysv dbus dbus-user-session udev kmod util-linux-extra iproute2 iptables nftables iputils-ping procps psmisc \
		ca-certificates curl wget gnupg git openssh-server sudo less nano vim-tiny jq unzip zip xz-utils file \
		python3 python3-pip python3-venv python3-dev build-essential pkg-config e2fsprogs \
		tigervnc-standalone-server tigervnc-tools dbus-x11 x11-utils x11-xserver-utils xdotool xclip xauth \
		xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal \
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

# Google Chrome (stable). Google ships no arm64 Linux build: an arm64 image has no browser yet.
RUN if [ "$TARGETARCH" = amd64 ]; then \
		curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google.gpg \
		&& echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
			> /etc/apt/sources.list.d/google-chrome.list \
		&& apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
		&& rm -f /etc/cron.daily/google-chrome \
		&& apt-get clean && rm -rf /var/lib/apt/lists/*; \
	fi

# Node, Go and Selkies: pinned releases, checked.
RUN case "$TARGETARCH" in \
		amd64) node_arch=x64 node_sum=$NODE_SHA256_AMD64 go_sum=$GO_SHA256_AMD64 selkies_sum=$SELKIES_SHA256_AMD64 ;; \
		arm64) node_arch=arm64 node_sum=$NODE_SHA256_ARM64 go_sum=$GO_SHA256_ARM64 selkies_sum=$SELKIES_SHA256_ARM64 ;; \
	esac \
	&& curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node_arch.tar.xz" -o /tmp/node.tar.xz \
	&& echo "$node_sum  /tmp/node.tar.xz" | sha256sum -c - \
	&& tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE \
		--exclude=README.md \
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

# The sandbox user, as on other sandboxes agents know: `user`, uid 1000, passwordless sudo, in the docker group and
# the kvm group (/dev/kvm, for nested VMs). Ubuntu's images come with an `ubuntu` user at uid 1000; it goes.
RUN userdel -r ubuntu 2>/dev/null || true; \
	groupadd -f --system kvm \
	&& useradd --uid 1000 --create-home --shell /bin/bash --groups sudo,docker,kvm user \
	&& echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && chmod 0440 /etc/sudoers.d/user \
	&& passwd -d root && passwd -l root

# Staged, then copied with modes made readable: COPY keeps the build context's modes, and a checkout made under a
# strict umask (077) would otherwise leave /usr and /etc/... unreadable to the sandbox user.
COPY dist/kantel-guest-${TARGETARCH} /usr/local/bin/kantel-guest
COPY guest/rootfs/ /tmp/kantel-rootfs/
RUN chmod -R u+rwX,go+rX-w /tmp/kantel-rootfs /usr/local/bin/kantel-guest \
	&& cp -a /tmp/kantel-rootfs/. / && rm -rf /tmp/kantel-rootfs \
	&& cp /etc/xdg/xfce4/panel/default.xml /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
	&& chown -R 1000:1000 /home/user && mkdir -p /etc/kantel

# No serial getty (the console is Firecracker's stdout), no units that wait for hardware a microVM doesn't have or
# fetch things on a timer, and SSH keys only per sandbox (the guest agent makes them after every create and fork).
# sshd runs as a plain service rather than Ubuntu's socket activation (see ssh.service.d/kantel.conf).
RUN systemctl disable ssh.socket && rm -f /etc/systemd/system/ssh.service.requires/ssh.socket \
	&& systemctl enable kantel-guest.service kantel-desktop.service kantel-browser.service kantel-stream.service \
		ssh.service docker.service containerd.service \
	&& systemctl mask serial-getty@ttyS0.service getty@tty1.service systemd-timesyncd.service apt-daily.timer \
		apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer man-db.timer motd-news.timer dpkg-db-backup.timer \
		systemd-networkd-wait-online.service NetworkManager-wait-online.service \
	&& rm -f /etc/ssh/ssh_host_* \
	&& chmod 0755 /usr/sbin/kantel-init \
	&& mkdir -p /newroot /disk \
	&& echo kantel > /etc/hostname \
	&& kantel-image-info > /etc/kantel/image.json
