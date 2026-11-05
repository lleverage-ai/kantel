#!/bin/sh
# Builds the microVM guest kernel (vmlinux) in Docker: Firecracker's own CI guest config for 6.1 and the architecture,
# plus kantel.config (what Docker needs, and KVM, so a sandbox has /dev/kvm for nested virtualisation) and
# kantel-<arch>.config (that architecture's own additions, if any).
#
#   apps/host/guest/kernel/build.sh <out-dir> [x86_64|aarch64]
#
# Needs Docker. About 3 minutes on 48 cores. The output is <out-dir>/vmlinux-<arch> (for aarch64, the arm64 Image that
# Firecracker boots). The aarch64 kernel is cross-compiled, so it builds on an x86_64 machine too, and vice versa.
set -eu

OUT=${1:?usage: build.sh <out-dir> [x86_64|aarch64]}
ARCH=${2:-x86_64}
KERNEL_VERSION=${KERNEL_VERSION:-6.1.158}
FC_REF=${FC_REF:-v1.17.0}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

case "$ARCH" in
x86_64) KARCH=x86_64 TARGET=vmlinux IMAGE=vmlinux CROSS=x86_64-linux-gnu ;;
aarch64) KARCH=arm64 TARGET=Image IMAGE=arch/arm64/boot/Image CROSS=aarch64-linux-gnu ;;
*) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

# The build container is the machine's own architecture. For the other one it adds Debian's cross compiler
# (gcc-<triplet>) and builds with CROSS_COMPILE; for its own, the native compiler, as before.
docker run --rm -v "$OUT:/out" -v "$HERE:/cfg:ro" -e KERNEL_VERSION="$KERNEL_VERSION" -e FC_REF="$FC_REF" \
	-e ARCH="$ARCH" -e KARCH="$KARCH" -e TARGET="$TARGET" -e IMAGE="$IMAGE" -e CROSS="$CROSS" debian:bookworm sh -euc '
	cross=
	[ "$(uname -m)" = "$ARCH" ] || cross="gcc-$CROSS binutils-$CROSS"
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends build-essential bc bison flex libelf-dev libssl-dev curl \
		ca-certificates xz-utils python3 $cross >/dev/null
	[ -z "$cross" ] || export CROSS_COMPILE="$CROSS-"
	cd /tmp
	curl -fsSL "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" | tar -xJ
	cd "linux-$KERNEL_VERSION"
	curl -fsSL "https://raw.githubusercontent.com/firecracker-microvm/firecracker/$FC_REF/resources/guest_configs/microvm-kernel-ci-$ARCH-6.1.config" -o .config
	extra=/cfg/kantel.config
	[ ! -f "/cfg/kantel-$ARCH.config" ] || extra="$extra /cfg/kantel-$ARCH.config"
	cat $extra >> .config
	make ARCH=$KARCH olddefconfig >/dev/null
	# Every option the Kantel configs turn on has to survive olddefconfig (it drops one whose dependencies are off), and
	# what the host relies on from the CI config: vsock for the guest agent, and the balloon driver, whose statistics
	# are the sandbox memory figures the host reports.
	for k in CONFIG_OVERLAY_FS CONFIG_VIRTIO_VSOCKETS CONFIG_VIRTIO_BALLOON $(sed -n "s/^\(CONFIG_[A-Z0-9_]*\)=y$/\1/p" $extra); do
		grep -q "^$k=y" .config || { echo "$k missing after olddefconfig" >&2; exit 1; }
	done
	make ARCH=$KARCH -j"$(nproc)" $TARGET >/dev/null
	cp "$IMAGE" "/out/vmlinux-$ARCH"
	cp .config "/out/vmlinux-$ARCH.config"
'
echo "$OUT/vmlinux-$ARCH"
