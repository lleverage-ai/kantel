#!/bin/sh
# The host container's entry for the memory over-commit E2E: kantel-host runs in a child control group (/agent) with
# no limit of its own, under the container's (--memory 16g --memory-swap 16g: no swap), as it would in a systemd unit
# on a machine, so over-commit's own limit on that group (memory.max, memory.swap.max) is what is tested. This shell
# moves to /init. KANTEL_HOST_RUN is what runs kantel-host (default: `kantel-host run`, looped).
set -eu
cg=/sys/fs/cgroup
mkdir -p $cg/init $cg/agent
echo $$ > $cg/init/cgroup.procs
for p in $(cat $cg/cgroup.procs); do echo "$p" > $cg/init/cgroup.procs 2>/dev/null || true; done
echo +memory > $cg/cgroup.subtree_control
run=${KANTEL_HOST_RUN:-'while true; do kantel-host run; sleep 2; done'}
sh -c "echo \$\$ > $cg/agent/cgroup.procs; exec sh -c '$run'" &
wait
