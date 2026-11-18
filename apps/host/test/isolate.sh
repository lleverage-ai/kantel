#!/usr/bin/env bash
# Runs the real-VM isolate tier tests (internal/agent/isolate_vmtest_test.go) in a privileged container of their own:
# isolate VMs booted, snapshotted and restored through kantel-host's own code, and commands (the shell, node, python,
# a CPU loop) run in their sandboxes.
#
#   apps/host/test/isolate.sh <images-dir> <firecracker-binary>
#
# <images-dir> holds vmlinux-x86_64 and isolate-amd64.ext4 (guest/kernel/build.sh and guest/rootfs.sh <out> isolate
# make them). Needs Docker, /dev/kvm and Go. KANTEL_VMTEST_ISOLATE_IMAGE names another image in <images-dir>, and
# KANTEL_VMTEST_SHELL_ONLY=1 leaves out node and python (for an image from before kantel-isolate, to compare with).
set -euo pipefail

images=$(realpath "${1:?usage: isolate.sh <images-dir> <firecracker-binary>}")
firecracker=$(realpath "${2:?usage: isolate.sh <images-dir> <firecracker-binary>}")
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
	-e KT_EXPERIMENT_SETTLE="${KT_EXPERIMENT_SETTLE:-}" -e KANTEL_VMTEST_ISOLATE_IMAGE="${KANTEL_VMTEST_ISOLATE_IMAGE:-}" -e KANTEL_VMTEST_SHELL_ONLY="${KANTEL_VMTEST_SHELL_ONLY:-}" \
	"$image" /opt/vmtest/agent.test -test.run "${KANTEL_VMTEST_RUN:-IsolateVM}" -test.v -test.timeout 15m
