#!/usr/bin/env bash
# Runs the real-VM isolation tests (internal/agent/isolation_vmtest_test.go) in a privileged container of their own,
# so their iptables rules, network namespace and veth pair stay in that container's network namespace and nothing
# on the machine itself (its firewall, its other services) is touched.
#
#   apps/host/test/isolation.sh <images-dir> <firecracker-binary>
#
# <images-dir> holds vmlinux-x86_64 and sandbox-amd64.ext4 (guest/rootfs.sh and guest/kernel/build.sh make them).
# Needs Docker, /dev/kvm and Go. KANTEL_VMTEST_RUN picks other real-VM tests (default Isolation), such as Bundles
# (internal/agent/bundles_vmtest_test.go), which needs images with erofs in the kernel and a guest agent that mounts
# bundles.
set -euo pipefail

images=$(realpath "${1:?usage: isolation.sh <images-dir> <firecracker-binary>}")
firecracker=$(realpath "${2:?usage: isolation.sh <images-dir> <firecracker-binary>}")
here=$(cd "$(dirname "$0")/.." && pwd)
# Beside the source rather than in /tmp, which a sandboxed shell may not share with the Docker daemon.
work=$(mktemp -d -p "$here" .vmtest.XXXXXX)
trap 'rm -rf "$work"' EXIT

(cd "$here" && CGO_ENABLED=0 go test -c -tags vmtest -o "$work/agent.test" ./internal/agent/)
cp "$firecracker" "$work/firecracker"
chmod -R a+rX "$work"

image=kantel-host-vmtest:local
docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables iputils-ping curl ca-certificates python3 e2fsprogs erofs-utils procps hostname && rm -rf /var/lib/apt/lists/*
EOF

name="kantel-host-vmtest-$$"
docker run --rm --name "$name" --privileged --device /dev/kvm \
	-v "$images:/images:ro" -v "$work:/opt/vmtest:ro" \
	-e KANTEL_VMTEST_IMAGES=/images -e KANTEL_VMTEST_FIRECRACKER=/opt/vmtest/firecracker \
	"$image" /opt/vmtest/agent.test -test.run "${KANTEL_VMTEST_RUN:-Isolation}" -test.v -test.timeout 15m
