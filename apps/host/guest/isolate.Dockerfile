# The isolate tier's VM: a small Debian with systemd, the guest agent and the isolate runtime (kantel-isolate, from
# apps/host/isolate-runtime). No network device: the runtime reaches the host's blob store and egress proxy through
# the guest agent's vsock bridges. `apps/host/guest/rootfs.sh <out> isolate` builds it.
#
# Build context: apps/host, with dist/kantel-guest-<arch>, dist/kantel-isolate-<arch> and dist/isolate-assets-<arch>
# built (rootfs.sh builds the agent, and guest/isolate-runtime.sh the runtime and its assets).
FROM debian:trixie-slim
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends systemd systemd-sysv ca-certificates iproute2 procps e2fsprogs \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/man/* \
	&& find /usr/share/doc -type f ! -name copyright -delete
# (Each package's copyright file stays: the image is published, and they carry the licences.)

# Security updates: a rebuild of debian:trixie-slim from a warm cache keeps its old packages. The daily build
# (.github/workflows/sandbox-image.yml, through release.sh and rootfs.sh) passes today's date, which re-runs this layer
# even with a warm cache. The image's own sources include trixie-security, so no other source is needed.
ARG KANTEL_SECURITY_REFRESH=unset
RUN echo "security refresh $KANTEL_SECURITY_REFRESH" \
	&& apt-get update \
	&& apt-get -y upgrade --no-install-recommends \
	&& apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/man/* \
	&& find /usr/share/doc -type f ! -name copyright -delete

# Staged, then copied with modes made readable (COPY keeps the build context's modes; see Dockerfile).
COPY dist/kantel-guest-${TARGETARCH} /tmp/kantel-rootfs/usr/local/bin/kantel-guest
COPY dist/kantel-isolate-${TARGETARCH} /tmp/kantel-rootfs/usr/local/bin/kantel-isolate
COPY dist/isolate-assets-${TARGETARCH}/ /tmp/kantel-rootfs/opt/kantel-isolate/
COPY guest/rootfs/usr/sbin/kantel-init /tmp/kantel-rootfs/usr/sbin/kantel-init
COPY guest/rootfs/etc/systemd/system/kantel-guest.service /tmp/kantel-rootfs/etc/systemd/system/kantel-guest.service
COPY guest/isolate/ /tmp/kantel-rootfs/
# The runtime's unit lives with the runtime, its only copy.
COPY isolate-runtime/systemd/kantel-isolate.service /tmp/kantel-rootfs/etc/systemd/system/kantel-isolate.service
COPY guest/rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md /tmp/kantel-rootfs/usr/share/kantel/THIRD-PARTY-NOTICES.md
RUN chmod -R u+rwX,go+rX-w /tmp/kantel-rootfs && cp -a /tmp/kantel-rootfs/. / && rm -rf /tmp/kantel-rootfs

# The runtime's own user, with no home and no login; its assets are root's and read-only to it.
RUN useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kantel-isolate \
	&& chown -R root:root /opt/kantel-isolate && chmod -R a+rX,go-w /opt/kantel-isolate \
	&& systemctl enable kantel-guest.service kantel-isolate.service \
	&& systemctl mask serial-getty@ttyS0.service getty@tty1.service systemd-timesyncd.service \
		systemd-networkd-wait-online.service apt-daily.timer apt-daily-upgrade.timer e2scrub_all.timer fstrim.timer \
	&& chmod 0755 /usr/sbin/kantel-init \
	&& mkdir -p /newroot /disk \
	&& echo kantel-isolate > /etc/hostname
