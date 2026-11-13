#!/bin/bash
set -e
D=$HOME/.local/state/workstreams/lle-18983/LLE-18987; S=$D/ssh.sh
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/measure.sh kernel $t $r; done; done
$S 5 'ip link del wgspk0'; $S 6 'ip link del wgspk1'
$S 5 "nohup /root/wg-spike/wgspike userspace -name wgspk0 -priv $PRIV_A -peer-pub $PUB_B -endpoint [2a01:4f8:2230:1794::2]:51899 -addr 10.199.0.1/24 -allowed 10.199.0.2/32 > /root/wg-spike/us.log 2>&1 < /dev/null &"
$S 6 "nohup /root/wg-spike/wgspike userspace -name wgspk1 -priv $PRIV_B -peer-pub $PUB_A -endpoint [2a01:4f8:2230:1793::2]:51899 -addr 10.199.0.2/24 -allowed 10.199.0.1/32 > /root/wg-spike/us.log 2>&1 < /dev/null &"
sleep 3; $S 5 'ping -c 3 -q 10.199.0.2 | tail -1; ethtool -k wgspk0 | grep -E "segmentation-offload|generic-receive"'
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/measure.sh userspace $t $r; done; done
for r in 1 2 3; do for t in tcp1 tcp8 http; do $D/measure.sh raw $t $r; done; done
echo ALLDONE
