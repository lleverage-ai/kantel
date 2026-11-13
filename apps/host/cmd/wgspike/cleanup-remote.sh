pkill -f /root/wg-spike/wgspike; sleep 1
for l in $(ip -br link | awk '{print $1}' | grep '^wgspk' | cut -d@ -f1); do ip link del "$l"; done
for ns in $(ip netns list | awk '{print $1}' | grep '^wgspk'); do ip netns del "$ns"; done
for c in input output; do for h in $(nft -a list chain inet ci_egress $c | grep 'comment "wgspike"' | sed 's/.*# handle //'); do nft delete rule inet ci_egress $c handle $h; done; done
lsmod | grep -q '^wireguard ' && ! grep -qx wireguard /root/wg-spike/wgspike-lsmod-before.txt && modprobe -r wireguard
rm -rf /var/lib/wgspike /root/wg-spike
