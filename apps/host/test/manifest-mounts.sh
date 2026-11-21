#!/usr/bin/env bash
# Runs the manifest mount store test (internal/mounts/manifestmount_store_test.go) against a MinIO of its own, in a
# container published on a loopback port, and removes it afterwards. No VM: the host's side, from the manifest to the
# bytes a guest's read gets, against a real S3-compatible store.
#
#   apps/host/test/manifest-mounts.sh
#
# Needs Docker and Go. MINIO_IMAGE picks MinIO's image.
set -euo pipefail

minio_image=${MINIO_IMAGE:-minio/minio:RELEASE.2023-03-20T20-16-18Z}
here=$(cd "$(dirname "$0")/.." && pwd)
name="kantel-manifest-minio-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

key="test$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
secret="$(head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --rm --name "$name" -p 127.0.0.1::9000 -e MINIO_ROOT_USER="$key" -e MINIO_ROOT_PASSWORD="$secret" \
	"$minio_image" server /data >/dev/null
port=$(docker port "$name" 9000/tcp | head -n1 | sed 's/.*://')
for _ in $(seq 50); do
	curl -fsS -o /dev/null "http://127.0.0.1:$port/minio/health/ready" 2>/dev/null && break
	sleep 0.5
done

cd "$here"
KANTEL_TEST_S3="http://127.0.0.1:$port" KANTEL_TEST_S3_KEY="$key" KANTEL_TEST_S3_SECRET="$secret" \
	go test -count=1 -run 'TestManifestMountOnAStore' -v ./internal/mounts/
