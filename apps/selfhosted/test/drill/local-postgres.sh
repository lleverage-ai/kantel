#!/bin/sh
# Postgres for the drill (postgres.ts) on this machine, shaped like a managed, highly available one: a primary with a
# synchronous streaming standby, both on a Docker network of their own, and one writer endpoint, the network alias
# NAME-db, that moves to the standby when it's promoted. Plus an empty Postgres to restore a backup into, NAME-restore.
#
#   sh local-postgres.sh up NAME        start them; prints the drill's --network, --database-url and --restore-url
#   sh local-postgres.sh outage NAME S  stop the primary, wait S seconds, start it again (the endpoint stays put)
#   sh local-postgres.sh failover NAME  kill the primary, promote the standby, and move NAME-db to it
#   sh local-postgres.sh partition NAME the same, but the primary vanishes from the network instead, still running:
#                                       its connections go silent rather than closing, as when its machine is lost
#   sh local-postgres.sh down NAME      remove the containers and the network (their volumes are anonymous)
#
# Synchronous replication (synchronous_standby_names '*') means the primary acknowledges a commit only once the standby
# has it, so a failover loses no acknowledged write; a service that replicates asynchronously can lose the last ones.
set -eu

image=${KANTEL_DRILL_PG_IMAGE:-postgres:17-alpine}
command=${1:-}
name=${2:-}
[ -n "$command" ] && [ -n "$name" ] || {
	sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}
net=$name-net
password=kantel-drill

# Waits until Postgres in container $1 answers on TCP: during initdb the image's temporary server listens only on its
# socket.
wait_for() {
	i=0
	until docker exec "$1" pg_isready -h 127.0.0.1 -U kantel -d kantel -q 2>/dev/null; do
		i=$((i + 1))
		[ "$i" -lt 120 ] || { echo "$1 never answered" >&2; exit 1; }
		sleep 0.5
	done
}

sql() { docker exec "$1" psql -U kantel -d kantel -v ON_ERROR_STOP=1 -Atqc "$2"; }

case $command in
up)
	docker network create "$net" >/dev/null
	docker run -d --name "$name-a" --network "$net" --network-alias "$name-db" \
		-e POSTGRES_USER=kantel -e POSTGRES_PASSWORD=$password -e POSTGRES_DB=kantel \
		"$image" postgres -c wal_level=replica -c max_wal_senders=5 -c max_replication_slots=5 >/dev/null
	wait_for "$name-a"
	# initdb's own pg_hba.conf has no replication line for other machines.
	docker exec "$name-a" sh -c 'echo "host replication kantel all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
	sql "$name-a" "SELECT pg_reload_conf()" >/dev/null
	# The standby: a base backup of the primary, streaming from it from then on.
	docker run -d --name "$name-b" --network "$net" --user postgres \
		-e PGPASSWORD=$password -e PGDATA=/var/lib/postgresql/data/standby \
		"$image" sh -c "pg_basebackup -h $name-a -U kantel -D \"\$PGDATA\" -R -X stream -C -S standby && exec postgres" \
		>/dev/null
	wait_for "$name-b"
	i=0
	until [ "$(sql "$name-a" "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'")" = 1 ]; do
		i=$((i + 1))
		[ "$i" -lt 120 ] || { echo "the standby never streamed" >&2; exit 1; }
		sleep 0.5
	done
	# Only now: before the standby streams, every commit would wait for it.
	sql "$name-a" "ALTER SYSTEM SET synchronous_standby_names = '*'" >/dev/null
	sql "$name-a" "SELECT pg_reload_conf()" >/dev/null
	docker run -d --name "$name-restore" --network "$net" \
		-e POSTGRES_USER=kantel -e POSTGRES_PASSWORD=$password -e POSTGRES_DB=kantel "$image" >/dev/null
	wait_for "$name-restore"
	echo "--network $net"
	echo "--database-url postgres://kantel:$password@$name-db:5432/kantel"
	echo "--restore-url postgres://kantel:$password@$name-restore:5432/kantel"
	;;
outage)
	docker stop "$name-a" >/dev/null
	sleep "${3:-10}"
	docker start "$name-a" >/dev/null
	wait_for "$name-a"
	;;
failover | partition)
	# A crash, not a clean shutdown: the standby has every commit the primary acknowledged, and nothing is sent on. Or
	# the primary is cut off: commits under way on it wait for a standby that's gone, and are never acknowledged.
	if [ "$command" = failover ]; then
		docker kill "$name-a" >/dev/null
	else
		docker network disconnect "$net" "$name-a"
	fi
	sql "$name-b" "SELECT pg_promote(wait => true)" >/dev/null
	# The endpoint moves: NAME-db now names the new primary, as a managed service's address does after a failover.
	docker network disconnect "$net" "$name-b"
	docker network connect --alias "$name-db" "$net" "$name-b"
	;;
down)
	docker rm -f "$name-a" "$name-b" "$name-restore" >/dev/null 2>&1 || true
	docker network rm "$net" >/dev/null 2>&1 || true
	;;
*)
	echo "unknown command $command" >&2
	exit 2
	;;
esac
