# The microVM sandbox's root filesystem: Debian 13 with systemd, SSH, Docker, a desktop (TigerVNC + Openbox) and
# Chromium, plus Kantel's guest agent. apps/host/guest/rootfs.sh turns it into a read-only ext4 image that every
# sandbox on a host shares; each sandbox writes to its own disk through an overlay (kantel-init).
#
# Build context: apps/host, with the guest agent already built at dist/kantel-guest-<arch> (rootfs.sh does both).
FROM debian:trixie
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		systemd systemd-sysv dbus udev kmod iproute2 iptables nftables iputils-ping procps psmisc \
		ca-certificates curl wget git openssh-server sudo less nano vim-tiny jq unzip zip xz-utils file \
		python3 python3-pip python3-venv nodejs npm build-essential pkg-config \
		docker.io containerd docker-cli \
		tigervnc-standalone-server tigervnc-tools openbox xterm x11-utils x11-xserver-utils xdotool dbus-x11 \
		chromium fonts-dejavu-core fonts-liberation imagemagick \
		e2fsprogs \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

# The sandbox user, as on other sandboxes agents know: `user`, uid 1000, passwordless sudo, in the docker group.
RUN useradd --uid 1000 --create-home --shell /bin/bash --groups sudo,docker user \
	&& echo "user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/user && chmod 0440 /etc/sudoers.d/user \
	&& passwd -d root && passwd -l root

# Staged, then copied with modes made readable: COPY keeps the build context's modes, and a checkout made under a
# strict umask (077) would otherwise leave /usr and /etc/... unreadable to the sandbox user.
COPY dist/kantel-guest-${TARGETARCH} /usr/local/bin/kantel-guest
COPY guest/rootfs/ /tmp/kantel-rootfs/
RUN chmod -R u+rwX,go+rX-w /tmp/kantel-rootfs /usr/local/bin/kantel-guest \
	&& cp -a /tmp/kantel-rootfs/. / && rm -rf /tmp/kantel-rootfs

# No serial getty (the console is Firecracker's stdout), no units that wait for hardware a microVM doesn't have, and
# SSH keys only per sandbox (the guest agent makes them after every create and fork).
RUN systemctl enable kantel-guest.service kantel-desktop.service ssh.service docker.service \
	&& systemctl mask serial-getty@ttyS0.service getty@tty1.service systemd-timesyncd.service apt-daily.timer \
		apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer man-db.timer systemd-networkd-wait-online.service \
		NetworkManager-wait-online.service \
	&& rm -f /etc/ssh/ssh_host_* \
	&& chmod 0755 /usr/sbin/kantel-init \
	&& mkdir -p /newroot /disk \
	&& echo kantel > /etc/hostname
