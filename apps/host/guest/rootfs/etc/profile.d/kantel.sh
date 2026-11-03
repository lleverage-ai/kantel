# The sandbox's egress proxy and CA, when the host gives it one (the guest agent writes /etc/kantel/proxy.env).
if [ -r /etc/kantel/proxy.env ]; then
	set -a
	. /etc/kantel/proxy.env
	set +a
fi
