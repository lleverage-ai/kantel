#!/bin/bash
# Runs on ci-5: two network namespaces joined by a veth pair, so the tunnel is CPU-bound, not NIC-bound.
# usage: ceiling-remote.sh setup|raw|kernel|userspace|teardown-tunnel|teardown
B=/root/wg-spike/wgspike
case $1 in
setup)
  ip netns add wgspk-a; ip netns add wgspk-b
  ip link add wgspkva netns wgspk-a type veth peer name wgspkvb netns wgspk-b
  ip -n wgspk-a addr add 192.168.199.1/24 dev wgspkva; ip -n wgspk-b addr add 192.168.199.2/24 dev wgspkvb
  for n in a b; do ip -n wgspk-$n link set lo up; done
  ip -n wgspk-a link set wgspkva up; ip -n wgspk-b link set wgspkvb up
  ip netns exec wgspk-b nohup $B tcpserve -listen :51899 >/root/wg-spike/ns-tcpserve.log 2>&1 </dev/null &
  ip netns exec wgspk-a nohup $B httpserve -listen :51899 -file /var/lib/wgspike/test.bin >/root/wg-spike/ns-httpserve.log 2>&1 </dev/null &
  sleep 1;;
kernel)
  ip netns exec wgspk-a $B kernel -name wgspk0 -priv $PRIV_A -peer-pub $PUB_B -endpoint 192.168.199.2:51899 -addr 10.199.1.1/24 -allowed 10.199.1.2/32
  ip netns exec wgspk-b $B kernel -name wgspk1 -priv $PRIV_B -peer-pub $PUB_A -endpoint 192.168.199.1:51899 -addr 10.199.1.2/24 -allowed 10.199.1.1/32;;
userspace)
  ip netns exec wgspk-a nohup $B userspace -name wgspk0 -priv $PRIV_A -peer-pub $PUB_B -endpoint 192.168.199.2:51899 -addr 10.199.1.1/24 -allowed 10.199.1.2/32 >/root/wg-spike/ns-us-a.log 2>&1 </dev/null &
  ip netns exec wgspk-b nohup $B userspace -name wgspk1 -priv $PRIV_B -peer-pub $PUB_A -endpoint 192.168.199.1:51899 -addr 10.199.1.2/24 -allowed 10.199.1.1/32 >/root/wg-spike/ns-us-b.log 2>&1 </dev/null &
  sleep 2;;
teardown-tunnel)
  pkill -f "wgspike userspace"; sleep 1
  ip -n wgspk-a link del wgspk0 2>/dev/null; ip -n wgspk-b link del wgspk1 2>/dev/null; true;;
teardown)
  pkill -f "wgspike tcpserve -listen :51899" ; true;;
esac
