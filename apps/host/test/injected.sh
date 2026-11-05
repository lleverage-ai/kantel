#!/usr/bin/env bash
# Runs the injected guest agent's real-VM tests (internal/microvm/injected_vmtest_test.go) in a privileged container:
# Kantel's own image and stock debian:trixie, alpine and busybox images, each booted through Kantel's initramfs with
# nothing of Kantel's in it.
#
#   apps/host/test/injected.sh <images-dir> <firecracker-binary> [kantel,debian,alpine,busybox]
#
# <images-dir> holds vmlinux-x86_64 and, for the kantel case, sandbox-amd64.ext4 (a release's, or guest/rootfs.sh's).
# The stock images are turned into read-only squashfs root filesystems here (docker export, then mksquashfs), which
# the initramfs mounts as it does an ext4 one. Needs Docker, /dev/kvm and Go.
set -euo pipefail

images=$(realpath "${1:?usage: injected.sh <images-dir> <firecracker-binary> [images]}")
firecracker=$(realpath "${2:?usage: injected.sh <images-dir> <firecracker-binary> [images]}")
which=${3:-kantel,debian,alpine,busybox}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d -p "$here" .vmtest.XXXXXX)
trap 'rm -rf "$work"' EXIT

(cd "$here" && CGO_ENABLED=0 go test -c -tags vmtest -o "$work/microvm.test" ./internal/microvm/)
(cd "$here" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=vmtest" -o "$work/kantel-guest" ./cmd/kantel-guest)
cp "$firecracker" "$work/firecracker"

image=kantel-host-vmtest-injected:local
docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables e2fsprogs squashfs-tools procps && rm -rf /var/lib/apt/lists/*
EOF

# Each stock image as a squashfs, made in the container (as root, so device nodes and owners survive).
specs=()
for name in ${which//,/ }; do
	case "$name" in
	kantel) specs+=("kantel=/images/sandbox-amd64.ext4"); continue ;;
	debian) ref=debian:trixie ;;
	alpine) ref=alpine:3.22 ;;
	busybox) ref=busybox:1.37 ;;
	*) echo "unknown image $name" >&2; exit 2 ;;
	esac
	docker pull -q "$ref" >/dev/null
	ctr=$(docker create "$ref" /bin/true)
	docker export "$ctr" >"$work/$name.tar"
	docker rm "$ctr" >/dev/null
	docker run --rm -v "$work:/work" "$image" sh -euc "mkdir /rootfs && tar -xf /work/$name.tar -C /rootfs && mksquashfs /rootfs /work/$name.sqfs -noappend -comp zstd -quiet -no-progress && chown $(id -u):$(id -g) /work/$name.sqfs && rm /work/$name.tar"
	specs+=("$name=/opt/vmtest/$name.sqfs")
done
chmod -R a+rX "$work"

docker run --rm --name "kantel-host-vmtest-injected-$$" --privileged --device /dev/kvm \
	-v "$images:/images:ro" -v "$work:/opt/vmtest:ro" \
	-e KANTEL_VMTEST_KERNEL=/images/vmlinux-x86_64 -e KANTEL_VMTEST_FIRECRACKER=/opt/vmtest/firecracker \
	-e KANTEL_VMTEST_AGENT=/opt/vmtest/kantel-guest -e KANTEL_VMTEST_INJECT_IMAGES="$(IFS=,; echo "${specs[*]}")" \
	"$image" /opt/vmtest/microvm.test -test.run 'Injected' -test.v -test.timeout 30m
