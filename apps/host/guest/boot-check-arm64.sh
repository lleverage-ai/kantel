#!/bin/sh
# Boots the arm64 guest kernel and sandbox image from a release build in QEMU's aarch64 emulation (TCG, in Docker,
# so it runs on an x86_64 machine with no arm64 hardware) and checks the sandbox comes up: the kernel, kantel-init's
# overlay, systemd with no failed units, the guest agent, Docker (hello-world, pulled over QEMU's network), the
# desktop, Chromium's DevTools (CDP) and Selkies. release.sh's arm64 images are published only after this passes.
#
#   apps/host/guest/boot-check-arm64.sh <out-dir>
#
# Reads vmlinux-aarch64 and sandbox-arm64.ext4 (or .ext4.gz) from <out-dir>, and writes boot-check-arm64.log (the
# guest's console, with a "BOOTCHECK <name> <ok|FAIL> <detail>" line per check) and boot-check-arm64.png (the
# desktop, with Chromium open on it). Exits non-zero when a check fails. Needs Docker; 10 to 20 minutes on 48 cores.
#
# What it can't check: Firecracker itself (it needs KVM on arm64 hardware), so the guest boots as QEMU's `virt`
# machine with the same kernel, image, disks and kantel-init, its console on virtio (the Firecracker config has no
# PL011 UART) and its disks on PCI. Nor what the host does over vsock: networking is set up here by hand, and nothing
# talks to the guest agent beyond its unit being up. Nested virtualisation isn't there on arm64.
set -eu

OUT=${1:?usage: boot-check-arm64.sh <out-dir>}
OUT=$(cd "$OUT" && pwd)
[ -f "$OUT/vmlinux-aarch64" ] || { echo "$OUT/vmlinux-aarch64 is missing" >&2; exit 1; }
[ -f "$OUT/sandbox-arm64.ext4" ] || [ -f "$OUT/sandbox-arm64.ext4.gz" ] || {
	echo "$OUT/sandbox-arm64.ext4(.gz) is missing" >&2
	exit 1
}
TIMEOUT=${BOOT_CHECK_TIMEOUT:-2400}
rm -f "$OUT/boot-check-arm64.log" "$OUT/boot-check-arm64.png"

docker run --rm -i -v "$OUT:/out" -e TIMEOUT="$TIMEOUT" -e DEBIAN_FRONTEND=noninteractive debian:trixie sh -euc '
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends qemu-system-arm e2fsprogs gzip >/dev/null
	work=/var/tmp/boot-check
	mkdir -p "$work"
	if [ -f /out/sandbox-arm64.ext4 ]; then root=/out/sandbox-arm64.ext4; else
		gzip -dc /out/sandbox-arm64.ext4.gz >"$work/sandbox-arm64.ext4"
		root=$work/sandbox-arm64.ext4
	fi

	# The sandbox disk (/dev/vdb), as a host makes it, with the check in its overlay (root/): a unit that runs once
	# the system is up, writes its results to the console and powers off.
	d=$work/disk
	mkdir -p "$d/root/usr/local/bin" "$d/root/etc/systemd/system/multi-user.target.wants" \
		"$d/root/etc/systemd/system/docker.service.d"
	# No host egress proxy here: Docker pulls directly over QEMU user networking.
	printf "%s\n" "[Service]" "Environment=HTTP_PROXY= HTTPS_PROXY=" \
		>"$d/root/etc/systemd/system/docker.service.d/zz-boot-check.conf"
	printf "%s\n" "[Unit]" "Description=Kantel arm64 boot check" "After=multi-user.target kantel-browser.service" \
		"[Service]" "Type=oneshot" "ExecStart=/usr/local/bin/kantel-boot-check" "StandardOutput=tty" \
		"StandardError=tty" "TTYPath=/dev/hvc0" "[Install]" "WantedBy=multi-user.target" \
		>"$d/root/etc/systemd/system/kantel-boot-check.service"
	ln -s ../kantel-boot-check.service "$d/root/etc/systemd/system/multi-user.target.wants/kantel-boot-check.service"
	cat >"$d/root/usr/local/bin/kantel-boot-check" <<"CHECK"
#!/bin/sh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fails=0
check() {
	name=$1
	shift
	if out=$("$@" 2>&1); then
		echo "BOOTCHECK $name ok $(echo "$out" | tail -n 1 | cut -c1-160)"
	else
		fails=$((fails + 1))
		echo "BOOTCHECK $name FAIL $(echo "$out" | tail -n 3 | tr "\n" " " | cut -c1-300)"
	fi
}
# wait_for <seconds> <command>: runs the command until it succeeds, then once more for its output.
wait_for() { i=0; while [ $i -lt "$1" ]; do sh -c "$2" >/dev/null 2>&1 && break; sleep 2; i=$((i + 2)); done; sh -c "$2"; }
# QEMU user networking (what kantel-guest sets from the host on a real host), on the one NIC whatever udev named it:
# the interface with a device behind it (docker0 and dummy0 have none).
nic=$(for n in /sys/class/net/*; do [ -e "$n/device" ] && basename "$n"; done | head -n 1)
echo "BOOTCHECK nic ok ${nic:-none} of $(ls /sys/class/net | tr "\n" " ")"
ip link set "$nic" up && ip addr add 10.0.2.15/24 dev "$nic" && ip route add default via 10.0.2.2
rm -f /etc/resolv.conf && echo "nameserver 10.0.2.3" >/etc/resolv.conf
echo "BOOTCHECK boot ok kernel=$(uname -r) arch=$(uname -m) uptime=$(cut -d" " -f1 /proc/uptime)s"
check arch sh -c "test \"\$(uname -m)\" = aarch64 && file -L /usr/local/bin/kantel-guest /usr/lib/chromium/chromium | grep -c aarch64"
check overlay sh -c "findmnt -n -o FSTYPE / | grep -x overlay && findmnt -n /var/lib/docker"
check image-info jq -c "{os, chromium, selkies, docker}" /etc/kantel/image.json
check guest-agent systemctl is-active kantel-guest.service
check docker-daemon wait_for 300 "docker info --format {{.Architecture}}"
check docker-hello-world runuser -u user -- sh -c "docker run --rm hello-world | grep -m1 \"Hello from Docker\""
check desktop wait_for 300 "systemctl is-active kantel-desktop.service && test -e /tmp/.X11-unix/X1"
check cdp wait_for 600 "curl -fsS -m 5 http://127.0.0.1:9222/json/version | grep -o \"\\\"Browser\\\": *\\\"[^\\\"]*\\\"\""
check stream wait_for 600 "curl -fsS -m 5 -o /dev/null -w \"selkies http %{http_code}\" http://127.0.0.1:6080/"
# The browser's own display, with Chromium on it; its stream starts only for a viewer (the guest agent), so here by hand.
check browser-display wait_for 300 "systemctl is-active kantel-browser-display.service && test -e /tmp/.X11-unix/X2 && runuser -u user -- env DISPLAY=:2 xdotool search --onlyvisible --class chromium | head -n 1"
check browser-stream wait_for 300 "systemctl start kantel-browser-stream.service && curl -fsS -m 5 -o /dev/null -w \"selkies http %{http_code}\" http://127.0.0.1:6081/"
check kvm sh -c "if [ -e /dev/kvm ]; then echo /dev/kvm present; else echo no /dev/kvm, as expected on arm64; fi"
# The desktop as drawn: X is up before Openbox and the panels paint it (black, two colours), so wait for a picture
# with more in it, after Openbox and both panels (the top bar and the dock).
check session wait_for 300 "pgrep -x openbox >/dev/null && test \$(pgrep -c -x tint2) -ge 2 && echo openbox and \$(pgrep -c -x tint2) panels"
check screenshot wait_for 300 "runuser -u user -- env DISPLAY=:1 import -window root /var/tmp/boot-check.png && test \$(identify -format %k /var/tmp/boot-check.png) -gt 64 && cp /var/tmp/boot-check.png /disk/boot-check.png && identify -format \"%wx%h, %k colours\" /disk/boot-check.png"
check failed-units sh -c "n=\$(systemctl --failed --no-legend | grep -v kantel-boot-check | wc -l); systemctl --failed --no-legend; test \$n = 0 && echo none"
echo "BOOTCHECK done fails=$fails uptime=$(cut -d" " -f1 /proc/uptime)s"
sync
systemctl poweroff --no-block
CHECK
	chmod 0755 "$d/root/usr/local/bin/kantel-boot-check"
	truncate -s 8G "$work/disk.ext4"
	mkfs.ext4 -q -L kantel-disk -d "$d" "$work/disk.ext4"

	# The check powers the guest off, which ends QEMU; panic=0 leaves a panicked guest hanging until the timeout
	# instead of starting it again.
	start=$(date +%s)
	timeout "$TIMEOUT" qemu-system-aarch64 -M virt,gic-version=3 -cpu max,pauth-impdef=on -smp 8 -m 4096 \
		-accel tcg,thread=multi,tb-size=1024 -display none -serial none -monitor none \
		-kernel /out/vmlinux-aarch64 \
		-append "console=hvc0 panic=0 root=/dev/vda ro init=/usr/sbin/kantel-init loglevel=4 kantel.browser=surface" \
		-chardev file,id=con,path=/out/boot-check-arm64.log -device virtio-serial-pci -device virtconsole,chardev=con \
		-drive if=none,id=root,file="$root",format=raw,readonly=on -device virtio-blk-pci,drive=root,addr=0x5 \
		-drive if=none,id=disk,file="$work/disk.ext4",format=raw -device virtio-blk-pci,drive=disk,addr=0x6 \
		-netdev user,id=net -device virtio-net-pci,netdev=net,romfile= -device virtio-rng-pci || true
	echo "QEMU ran for $(( $(date +%s) - start )) s"
	debugfs -R "dump /boot-check.png /out/boot-check-arm64.png" "$work/disk.ext4" 2>/dev/null || true
'
grep -a "^BOOTCHECK" "$OUT/boot-check-arm64.log" || true
grep -aq "^BOOTCHECK done fails=0 " "$OUT/boot-check-arm64.log" || {
	echo "the arm64 boot check failed; the console is $OUT/boot-check-arm64.log" >&2
	exit 1
}
echo "arm64 boot check passed; the desktop is $OUT/boot-check-arm64.png"
