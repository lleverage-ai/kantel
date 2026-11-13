#!/usr/bin/env bash
# A Kantel stack on this machine from this checkout, to try things by hand or to test against: the self-hosted
# control plane (apps/selfhosted, run from source with Bun, everything in memory) and real kantel-host processes built
# from this branch, each in a privileged container of its own with /dev/kvm.
#
#   apps/host/test/local-stack.sh up [--two-hosts | --hosts <n>] [--name <prefix>] [--port <port>]
#   apps/host/test/local-stack.sh status [--name <prefix>]
#   apps/host/test/local-stack.sh down [--name <prefix>]
#
# up starts it and leaves it running. By default one host runs both tiers, isolates and microVMs, so an isolate's
# upgrade is done by its own host (the normal case). --two-hosts runs two instead: host a with isolates only and host b
# with microVMs only, so an upgrade makes the microVM on b and Kantel moves the files (upgrade-crosshost.sh tests that).
# --hosts <n> runs n hosts with microVMs only, h1 to hn, each in its own container on Docker's bridge, so they reach
# each other's addresses there (the pool mesh's tests).
#
# --name <prefix> names the stack: its containers are kantel-stack-<prefix>-<host>, its hosts <prefix>-<host> in
# Kantel, its state is in /tmp/kantel-local-stack-<prefix> (unless KANTEL_STACK_DIR says), and without --port its
# gateway takes a free port from 29800 up. So stacks with different names run side by side; status and down take the
# same --name. Without --name the stack is named after its directory, as before.
# It prints the control plane's URL, where its super-admin API key is, and commands to try with this branch's CLI.
# down stops and removes what up made (the gateway by its PID, the containers by their names) and nothing else; the
# Docker image it builds (kantel-host-stack:local) is kept for the next up. status says what is running.
#
# Needs Docker, /dev/kvm, Go, Bun, jq, curl and the workspace's node_modules (npx -y pnpm@10.34.9 install). The guest
# images and Firecracker default to an installed host's (/var/lib/kantel-host); set them with
#
#   KANTEL_STACK_KERNEL          the guest kernel (default /var/lib/kantel-host/images/vmlinux)
#   KANTEL_STACK_SANDBOX_IMAGE   the microVM image (default /var/lib/kantel-host/images/sandbox.ext4)
#   KANTEL_STACK_ISOLATE_IMAGE   the isolate VM's image (default /var/lib/kantel-host/images/isolate.ext4); one from
#                                guest/rootfs.sh <out> isolate amd64 on this branch runs this branch's isolate runtime
#   KANTEL_STACK_FIRECRACKER     Firecracker (default /var/lib/kantel-host/bin/firecracker)
#   KANTEL_STACK_DIR             where the stack's state is (default /tmp/kantel-local-stack): the gateway's log and
#                                bootstrap file (its keys, mode 0600), the hosts' settings, PIDs and names. One stack
#                                per directory; give another directory (and --port) for a second
#
# The gateway listens on Docker's bridge address (172.17.0.1 usually), where the hosts' containers reach it, on
# --port (default 29800). The hosts' sandboxes have open egress through each host's proxy.
set -euo pipefail

here=$(cd "$(dirname "$0")/../../.." && pwd)
image=kantel-host-stack:local
name=
named=false

usage() {
	sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
	exit 2
}

need() {
	for tool in "$@"; do
		command -v "$tool" >/dev/null || {
			echo "local-stack: $tool is needed" >&2
			exit 1
		}
	done
}

# The stack's directory and name: --name's, else the directory's.
locate() {
	if [ -n "$name" ]; then
		named=true
		case $name in
		*[!a-z0-9-]* | -*)
			echo "local-stack: --name takes lower-case letters, digits and dashes" >&2
			exit 2
			;;
		esac
		dir=${KANTEL_STACK_DIR:-/tmp/kantel-local-stack-$name}
	else
		dir=${KANTEL_STACK_DIR:-/tmp/kantel-local-stack}
		name=$(basename "$dir")
	fi
}

# A port nothing listens on, from 29800 up.
free_port() {
	local port
	for port in $(seq 29800 29999); do
		if [ -z "$(ss -Htln "sport = :$port")" ]; then
			echo "$port"
			return
		fi
	done
	echo "local-stack: no free port from 29800 to 29999: give one with --port" >&2
	exit 1
}

url() { cat "$dir/url"; }
key() { jq -r .computeKey "$dir/bootstrap.json"; }

# The gateway's PID, when it is the process up started (its command line names the gateway); else nothing.
gateway_pid() {
	[ -f "$dir/gateway.pid" ] || return 0
	local pid
	pid=$(cat "$dir/gateway.pid")
	if [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q "src/gateway/main.ts"; then
		echo "$pid"
	fi
}

# A host: its join token minted, registered (its credential kept in its settings, mode 0600) and started.
start_host() {
	local host=$1 tiers=$2
	local token reg label
	label=$host_label_prefix$host
	token=$(curl -sf -X POST "$(url)/v1/admin/hosts/join-tokens" -H "authorization: Bearer $(key)" \
		-H 'content-type: application/json' -d "{\"name\":\"$label\"}" | jq -r .token)
	reg=$(curl -sf -X POST "$(url)/v1/hosts/register" -H 'content-type: application/json' \
		-d "{\"token\":\"$token\",\"name\":\"$label\"}")
	mkdir -p "$dir/$host"
	(
		umask 077
		echo "$reg" | jq --arg cp "$(url)" --argjson tiers "$tiers" --arg name "$label" '{
			controlPlane: $cp, hostId: .hostId, credential: .credential, name: $name, tiers: $tiers,
			kernel: "/images/vmlinux", sandboxImage: "/images/sandbox.ext4", isolateImage: "/images/isolate.ext4",
			firecracker: "/opt/kantel/firecracker", egress: "open", autoUpdate: false
		}' >"$dir/$host/config.json"
	)
	local container
	container="kantel-stack-$name-$host"
	docker rm -f "$container" >/dev/null 2>&1 || true
	echo "$container" >>"$dir/containers"
	docker run -d --name "$container" --privileged --device /dev/kvm \
		-v "$kernel:/images/vmlinux:ro" -v "$sandbox_image:/images/sandbox.ext4:ro" -v "$isolate_image:/images/isolate.ext4:ro" \
		-v "$dir/bin:/opt/kantel:ro" -v "$dir/$host/config.json:/etc/kantel-host/config.json:ro" \
		"$image" sh -c 'ulimit -c 0; exec /opt/kantel/kantel-host run --config /etc/kantel-host/config.json' >/dev/null
	echo "$reg" | jq -r .hostId >"$dir/$host/host-id"
}

# Waits until every host up started is connected and ready for the tiers it runs.
wait_hosts() {
	local want=$1 deadline=$((SECONDS + 300))
	until [ "$(curl -sf "$(url)/v1/admin/hosts" -H "authorization: Bearer $(key)" |
		jq '[.items[] | select(.state == "online")] | length')" -ge "$want" ]; do
		if [ $SECONDS -gt $deadline ]; then
			echo "local-stack: the hosts didn't connect; docker logs <container> says why" >&2
			return 1
		fi
		sleep 1
	done
}

up() {
	local two=false hosts=0 port=
	while [ $# -gt 0 ]; do
		case $1 in
		--two-hosts) two=true ;;
		--hosts)
			hosts=${2:-}
			shift
			;;
		--name)
			name=${2:-}
			shift
			;;
		--port)
			port=$2
			shift
			;;
		*) usage ;;
		esac
		shift
	done
	case $hosts in
	'' | *[!0-9]*) usage ;;
	esac
	if $two && [ "$hosts" -gt 0 ]; then
		echo "local-stack: --two-hosts or --hosts, not both" >&2
		exit 2
	fi
	locate
	need docker go bun jq curl ss
	# Kantel's names for the hosts: stack-<host> as before for an unnamed stack, else <name>-<host>.
	host_label_prefix=stack-
	if $named; then
		host_label_prefix=$name-
		[ -n "$port" ] || port=$(free_port)
	fi
	port=${port:-29800}
	[ -e /dev/kvm ] || {
		echo "local-stack: /dev/kvm is needed" >&2
		exit 1
	}
	if [ -n "$(gateway_pid)" ]; then
		echo "local-stack: a stack is up in $dir already: $0 down first, or set KANTEL_STACK_DIR" >&2
		exit 1
	fi
	kernel=$(realpath "${KANTEL_STACK_KERNEL:-/var/lib/kantel-host/images/vmlinux}")
	sandbox_image=$(realpath "${KANTEL_STACK_SANDBOX_IMAGE:-/var/lib/kantel-host/images/sandbox.ext4}")
	isolate_image=$(realpath "${KANTEL_STACK_ISOLATE_IMAGE:-/var/lib/kantel-host/images/isolate.ext4}")
	local firecracker
	firecracker=$(realpath "${KANTEL_STACK_FIRECRACKER:-/var/lib/kantel-host/bin/firecracker}")
	for file in "$kernel" "$sandbox_image" "$isolate_image" "$firecracker"; do
		[ -r "$file" ] || {
			echo "local-stack: can't read $file" >&2
			exit 1
		}
	done
	mkdir -p "$dir/bin"
	chmod 700 "$dir"
	rm -f "$dir/containers"
	echo "$name" >"$dir/name"

	(cd "$here/apps/host" && CGO_ENABLED=0 go build -o "$dir/bin/kantel-host" ./cmd/kantel-host)
	cp "$firecracker" "$dir/bin/firecracker"
	docker build -q -t "$image" - >/dev/null <<'EOF'
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables iputils-ping curl ca-certificates python3 e2fsprogs erofs-utils procps hostname && rm -rf /var/lib/apt/lists/*
EOF

	# Docker's bridge: where the hosts' containers reach the gateway, and this machine does too.
	local address
	address=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
	echo "http://$address:$port" >"$dir/url"
	rm -f "$dir/bootstrap.json"
	(
		cd "$here/apps/selfhosted"
		PORT=$port HOST=$address KANTEL_COMPUTE_PUBLIC_URL="http://$address:$port" KANTEL_COMPUTE_IMAGES=off \
			KANTEL_HOST_RELEASES=off KANTEL_BOOTSTRAP_FILE="$dir/bootstrap.json" \
			setsid nohup bun src/gateway/main.ts >"$dir/gateway.log" 2>&1 </dev/null &
		echo $! >"$dir/gateway.pid"
	)
	local deadline=$((SECONDS + 60))
	until [ -s "$dir/bootstrap.json" ] && curl -sf "$(url)/healthz" >/dev/null; do
		if [ $SECONDS -gt $deadline ] || [ -z "$(gateway_pid)" ]; then
			echo "local-stack: the gateway didn't start; $dir/gateway.log says why" >&2
			tail -20 "$dir/gateway.log" >&2
			exit 1
		fi
		sleep 0.5
	done

	if $two; then
		start_host a '["isolate"]'
		start_host b '["microvm"]'
		wait_hosts 2
	elif [ "$hosts" -gt 0 ]; then
		local i
		for i in $(seq "$hosts"); do
			start_host "h$i" '["microvm"]'
		done
		wait_hosts "$hosts"
	else
		start_host host '["microvm","isolate"]'
		wait_hosts 1
	fi
	status
	local down_args=
	$named && down_args=" --name $name"
	# Which isolate runtime the image has: one from before kantel-isolate (workerd) runs no node or python.
	while read -r container; do
		docker logs "$container" 2>&1 | grep -o 'msg="isolate runtime".*' | sed "s/^/$container: /" || true
	done <"$dir/containers"
	cat <<EOF

Try it with this branch's CLI (the key is the gateway's super-admin key, in $dir/bootstrap.json):

  export KANTEL_URL=$(url)
  export KANTEL_API_KEY=\$(jq -r .computeKey $dir/bootstrap.json)
  alias kantel='node $here/packages/cli/src/main.ts'
  kantel new --auto-upgrade
  kantel ssh <id>
    git clone https://github.com/octocat/Hello-World.git
  kantel get <id>

The hosts' logs: docker logs -f <container> (above). The gateway's: $dir/gateway.log. Stop it all: $0 down$down_args
EOF
}

# status and down take --name only.
stack_args() {
	while [ $# -gt 0 ]; do
		case $1 in
		--name)
			name=${2:-}
			shift
			;;
		*) usage ;;
		esac
		shift
	done
	locate
}

status() {
	if [ ! -f "$dir/url" ]; then
		echo "No stack in $dir."
		return 0
	fi
	local pid
	pid=$(gateway_pid)
	echo "Control plane: $(url) ($([ -n "$pid" ] && echo "gateway PID $pid" || echo "not running"))"
	echo "API key:       jq -r .computeKey $dir/bootstrap.json"
	if [ -f "$dir/containers" ]; then
		while read -r container; do
			echo "Host container: $container ($(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo gone))"
		done <"$dir/containers"
	fi
	if [ -n "$pid" ]; then
		curl -sf "$(url)/v1/admin/hosts" -H "authorization: Bearer $(key)" |
			jq -r '.items[] | "Host \(.name) (\(.id)): \(.state), tiers \(.tiers | join(", ")), \(.allocated.sandboxes) sandboxes"'
	fi
}

down() {
	local pid
	pid=$(gateway_pid)
	if [ -n "$pid" ]; then
		kill "$pid"
		for _ in $(seq 50); do
			[ -d "/proc/$pid" ] || break
			sleep 0.1
		done
		[ -d "/proc/$pid" ] && kill -9 "$pid"
		echo "Stopped the gateway (PID $pid)."
	fi
	if [ -f "$dir/containers" ]; then
		while read -r container; do
			# Its microVMs and isolates are its processes: they go with it.
			docker rm -f "$container" >/dev/null 2>&1 && echo "Removed $container."
		done <"$dir/containers"
	fi
	rm -rf "$dir"
}

case ${1:-} in
up)
	shift
	up "$@"
	;;
status)
	shift
	stack_args "$@"
	status
	;;
down)
	shift
	stack_args "$@"
	down
	;;
*) usage ;;
esac
