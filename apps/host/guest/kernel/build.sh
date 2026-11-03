#!/bin/sh
# Builds the microVM guest kernel (vmlinux) in Docker: Firecracker's own CI guest config for 6.1 plus KVM, so a
# sandbox has /dev/kvm (nested virtualisation) and can run Docker.
#
#   apps/host/guest/kernel/build.sh <out-dir> [x86_64|aarch64]
#
# Needs Docker. About 3 minutes on 48 cores. The output is <out-dir>/vmlinux-<arch>.
set -eu

OUT=${1:?usage: build.sh <out-dir> [x86_64|aarch64]}
ARCH=${2:-x86_64}
KERNEL_VERSION=${KERNEL_VERSION:-6.1.158}
FC_REF=${FC_REF:-v1.17.0}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

case "$ARCH" in
x86_64) KARCH=x86_64 TARGET=vmlinux IMAGE=vmlinux ;;
aarch64) KARCH=arm64 TARGET=Image IMAGE=arch/arm64/boot/Image ;;
*) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

docker run --rm -v "$OUT:/out" -v "$HERE:/cfg:ro" -e KERNEL_VERSION="$KERNEL_VERSION" -e FC_REF="$FC_REF" \
	-e ARCH="$ARCH" -e KARCH="$KARCH" -e TARGET="$TARGET" -e IMAGE="$IMAGE" debian:bookworm sh -euc '
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends build-essential bc bison flex libelf-dev libssl-dev curl \
		ca-certificates xz-utils python3 >/dev/null
	cd /tmp
	curl -fsSL "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" | tar -xJ
	cd "linux-$KERNEL_VERSION"
	curl -fsSL "https://raw.githubusercontent.com/firecracker-microvm/firecracker/$FC_REF/resources/guest_configs/microvm-kernel-ci-$ARCH-6.1.config" -o .config
	cat /cfg/kantel.config >> .config
	make ARCH=$KARCH olddefconfig >/dev/null
	# Every option kantel.config turns on has to survive olddefconfig (it drops one whose dependencies are off).
	for k in CONFIG_OVERLAY_FS CONFIG_VIRTIO_VSOCKETS $(sed -n "s/^\(CONFIG_[A-Z0-9_]*\)=y$/\1/p" /cfg/kantel.config); do
		grep -q "^$k=y" .config || { echo "$k missing after olddefconfig" >&2; exit 1; }
	done
	make ARCH=$KARCH -j"$(nproc)" $TARGET >/dev/null
	cp "$IMAGE" "/out/vmlinux-$ARCH"
	cp .config "/out/vmlinux-$ARCH.config"
'
echo "$OUT/vmlinux-$ARCH"
