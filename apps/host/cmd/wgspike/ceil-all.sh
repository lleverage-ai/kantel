#!/bin/bash
set -e
D=~/.local/state/workstreams/lle-18983/LLE-18987; S=$D/ssh.sh
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/ceiling.sh raw $t $r; done; done
$S 5 'bash /root/wg-spike/ceiling-remote.sh kernel'
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/ceiling.sh kernel $t $r; done; done
$S 5 'bash /root/wg-spike/ceiling-remote.sh teardown-tunnel; bash /root/wg-spike/ceiling-remote.sh userspace; ip netns exec wgspk-a ping -c2 -q 10.199.1.2 | tail -1'
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/ceiling.sh userspace $t $r; done; done
$S 5 'bash /root/wg-spike/ceiling-remote.sh teardown-tunnel'
echo ALLDONE
