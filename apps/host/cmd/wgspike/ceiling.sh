#!/bin/bash
# usage: ceiling.sh mode test run   (runs on ci-5 only; cores is both ends together)
D=~/.local/state/workstreams/lle-18983/LLE-18987; S=$D/ssh.sh
mode=$1 test=$2 runno=$3
if [ $mode = raw ]; then A=192.168.199.1 B=192.168.199.2; else A=10.199.1.1 B=10.199.1.2; fi
b=$($S 5 /root/wg-spike/wgspike stat)
case $test in
  tcp1) r=$($S 5 ip netns exec wgspk-a /root/wg-spike/wgspike tcpsend -to $B:51899 -streams 1 -dur 20s);;
  tcp8) r=$($S 5 ip netns exec wgspk-a /root/wg-spike/wgspike tcpsend -to $B:51899 -streams 8 -dur 20s);;
  http) r=$($S 5 ip netns exec wgspk-b /root/wg-spike/wgspike httpget -url http://$A:51899 -par 8);;
esac
a=$($S 5 /root/wg-spike/wgspike stat)
jq -cn --arg mode $mode --arg test $test --argjson run $runno --argjson r "$r" --argjson b "$b" --argjson a "$a" '
 {where:"ns",mode:$mode,test:$test,run:$run,gbps:(($r.gbps*1000|round)/1000),sec:(($r.seconds*10|round)/10),proto:$r.proto,
  cores:((($a.busy-$b.busy)/($a.all-$b.all)*$a.ncpu*100|round)/100),attr:(((([$a.procs|to_entries[]|.value-($b.procs[.key]//0)]|add) + ($a.irq-$b.irq) + $r.cpu*100) / (($a.all-$b.all)/$a.ncpu) *100|round)/100),load:[$b.load,$a.load],jobs:[$b.jobs,$a.jobs],at:(now|todate)}' | tee -a $D/ceiling.jsonl
