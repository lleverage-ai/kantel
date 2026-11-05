#!/usr/bin/env bash
# Runs the real-VM bucket mount tests (internal/agent/mounts_vmtest_test.go) in a privileged container of their own,
# beside a MinIO of their own on a Docker network of their own, so nothing on the machine itself is touched.
#
#   apps/host/test/mounts.sh <images-dir> <firecracker-binary>
#
# <images-dir> holds vmlinux-x86_64 and sandbox-amd64.ext4 (guest/rootfs.sh and guest/kernel/build.sh make them),
# with this tree's guest agent in it. Needs Docker, /dev/kvm and Go. MINIO_IMAGE picks MinIO's image.
set -euo pipefail

images=$(realpath "${1:?usage: mounts.sh <images-dir> <firecracker-binary>}")
firecracker=$(realpath "${2:?usage: mounts.sh <images-dir> <firecracker-binary>}")
minio_image=${MINIO_IMAGE:-minio/minio:RELEASE.2023-03-20T20-16-18Z}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d -p "$here" .vmtest.XXXXXX)
net="kantel-mounts-vmtest-$$"
minio="kantel-mounts-minio-$$"
cleanup() {
	docker rm -f "$minio" >/dev/null 2>&1 || true
	docker network rm "$net" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

(cd "$here" && CGO_ENABLED=0 go test -c -tags vmtest -o "$work/agent.test" ./internal/agent/)
cp "$firecracker" "$work/firecracker"
chmod -R a+rX "$work"

image=kantel-host-vmtest:local
docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables iputils-ping curl ca-certificates python3 e2fsprogs procps hostname && rm -rf /var/lib/apt/lists/*
EOF

key="vmtest$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
secret="$(head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker network create "$net" >/dev/null
docker run -d --rm --name "$minio" --network "$net" -e MINIO_ROOT_USER="$key" -e MINIO_ROOT_PASSWORD="$secret" \
	"$minio_image" server /data >/dev/null
ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$minio")
for _ in $(seq 50); do
	docker run --rm --network "$net" curlimages/curl:latest -fsS -o /dev/null "http://$ip:9000/minio/health/ready" 2>/dev/null && break
	sleep 0.5
done

# --shm-size: a stop's memory snapshot goes to /dev/shm first (the spool), and Docker's default is 64 MB.
docker run --rm --name "kantel-mounts-vmtest-$$" --privileged --device /dev/kvm --network "$net" --shm-size 8g \
	-v "$images:/images:ro" -v "$work:/opt/vmtest:ro" \
	-e KANTEL_VMTEST_IMAGES=/images -e KANTEL_VMTEST_FIRECRACKER=/opt/vmtest/firecracker \
	-e KANTEL_VMTEST_S3="http://$ip:9000" -e KANTEL_VMTEST_S3_KEY="$key" -e KANTEL_VMTEST_S3_SECRET="$secret" \
	"$image" /opt/vmtest/agent.test -test.run 'BucketMounts' -test.v -test.timeout 20m
