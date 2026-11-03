# The isolate tier's VM: a small Debian with systemd, the guest agent and workerd running the isolate worker
# (apps/host/isolate). No network device: the worker reaches the host's blob store and egress proxy through the
# guest agent's vsock bridges. `apps/host/guest/rootfs.sh <out> isolate` builds it.
#
# Build context: apps/host, with dist/kantel-guest-<arch>, dist/workerd-<arch> and isolate/dist built (rootfs.sh
# does all three).
FROM debian:trixie-slim
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends systemd systemd-sysv ca-certificates iproute2 procps e2fsprogs \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/man/* \
	&& find /usr/share/doc -type f ! -name copyright -delete
# (Each package's copyright file stays: the image is published, and they carry the licences.)

# Staged, then copied with modes made readable (COPY keeps the build context's modes; see Dockerfile).
COPY dist/kantel-guest-${TARGETARCH} /tmp/kantel-rootfs/usr/local/bin/kantel-guest
COPY dist/workerd-${TARGETARCH} /tmp/kantel-rootfs/usr/local/bin/workerd
COPY isolate/config.capnp /tmp/kantel-rootfs/opt/kantel-isolate/config.capnp
COPY isolate/dist /tmp/kantel-rootfs/opt/kantel-isolate/dist
COPY guest/rootfs/usr/sbin/kantel-init /tmp/kantel-rootfs/usr/sbin/kantel-init
COPY guest/rootfs/etc/systemd/system/kantel-guest.service /tmp/kantel-rootfs/etc/systemd/system/kantel-guest.service
COPY guest/isolate/ /tmp/kantel-rootfs/
COPY guest/rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md /tmp/kantel-rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md
RUN chmod -R u+rwX,go+rX-w /tmp/kantel-rootfs && cp -a /tmp/kantel-rootfs/. / && rm -rf /tmp/kantel-rootfs

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin workerd \
	&& systemctl enable kantel-guest.service kantel-workerd.service \
	&& systemctl mask serial-getty@ttyS0.service getty@tty1.service systemd-timesyncd.service \
		systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer \
	&& chmod 0755 /usr/sbin/kantel-init \
	&& mkdir -p /newroot /disk \
	&& echo kantel-isolate > /etc/hostname
