#!/bin/bash
# usage: measure.sh mode test run   (mode raw|kernel|userspace; test tcp1|tcp8|http)
D=~/.local/state/workstreams/lle-18983/LLE-18987; S=$D/ssh.sh
mode=$1 test=$2 runno=$3
if [ $mode = raw ]; then A5="[2a01:4f8:2230:1793::2]" A6="[2a01:4f8:2230:1794::2]"; else A5=10.199.0.1 A6=10.199.0.2; fi
b5=$($S 5 /root/wg-spike/wgspike stat); b6=$($S 6 /root/wg-spike/wgspike stat)
case $test in
  tcp1) r=$($S 5 /root/wg-spike/wgspike tcpsend -to $A6:51899 -streams 1 -dur 20s);;
  tcp8) r=$($S 5 /root/wg-spike/wgspike tcpsend -to $A6:51899 -streams 8 -dur 20s);;
  http) r=$($S 6 /root/wg-spike/wgspike httpget -url http://$A5:51899 -par 8);;
esac
a5=$($S 5 /root/wg-spike/wgspike stat); a6=$($S 6 /root/wg-spike/wgspike stat)
jq -cn --arg mode $mode --arg test $test --argjson run $runno --argjson r "$r" --argjson b5 "$b5" --argjson a5 "$a5" --argjson b6 "$b6" --argjson a6 "$a6" '
 def cores(b;a): ((a.busy-b.busy)/(a.all-b.all)*a.ncpu*100|round)/100;
 def attr(b;a;c): ((([a.procs|to_entries[]|.value-(b.procs[.key]//0)]|add) + (a.irq-b.irq) + c*100) / ((a.all-b.all)/a.ncpu) *100|round)/100;
 {mode:$mode,test:$test,run:$run,gbps:(($r.gbps*1000|round)/1000),sec:(($r.seconds*10|round)/10),proto:$r.proto,
  cores5:cores($b5;$a5),cores6:cores($b6;$a6),attr5:attr($b5;$a5;(if $test=="http" then 0 else $r.cpu end)),attr6:attr($b6;$a6;(if $test=="http" then $r.cpu else 0 end)),
  load5:[$b5.load,$a5.load],load6:[$b6.load,$a6.load],jobs5:[$b5.jobs,$a5.jobs],jobs6:[$b6.jobs,$a6.jobs],at:(now|todate)}' | tee -a $D/results2.jsonl
