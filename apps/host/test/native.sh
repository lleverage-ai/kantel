#!/usr/bin/env bash
# Runs the isolate tier's tests (internal/isolate) as root in a privileged container of its own, so the native
# runtime's root-only parts run: a uid of its own for each account's runtime, its cgroup (memory.max, pids.max) and
# its sockets, which another account's runtime must not reach (TestNativeRuntimesApart). The test process is moved
# out of the container's root cgroup first, as kantel-host is in a service's cgroup on a host, so controllers can be
# enabled for the runtimes' cgroups.
#
#   apps/host/test/native.sh
#
# Needs Docker and Go; no KVM. KANTEL_VMTEST_RUN picks tests (default all of internal/isolate's).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
# Beside the source rather than in /tmp, which a sandboxed shell may not share with the Docker daemon.
work=$(mktemp -d -p "$here" .vmtest.XXXXXX)
trap 'rm -rf "$work"' EXIT
(cd "$here" && CGO_ENABLED=0 go test -c -o "$work/isolate.test" ./internal/isolate/)
chmod -R a+rX "$work"
docker run --rm --privileged --cgroupns=private -v "$work:/opt/vmtest:ro" -e RUN="${KANTEL_VMTEST_RUN:-.}" \
	debian:trixie-slim sh -euc '
		mkdir -p /sys/fs/cgroup/init && echo $$ > /sys/fs/cgroup/init/cgroup.procs
		# Out of the mount, whose directories other uids may not traverse.
		cp /opt/vmtest/isolate.test /usr/local/bin/isolate.test
		cd /tmp && exec /usr/local/bin/isolate.test -test.v -test.run "$RUN"'
