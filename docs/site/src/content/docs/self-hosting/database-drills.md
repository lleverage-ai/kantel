---
title: Postgres drills
description: A repeatable drill of what the control plane does when its Postgres fails over, goes away or is restored from a backup, and when several gateways start at once, with the results on a local install.
---

Before you rely on a database, try what it does on a bad day. The drill in `apps/selfhosted/test/drill/postgres.ts` runs three tests against a Postgres you name by its URL, with gateways of its own from the installed gateway image:

1. **Several gateways start at once on an empty database.** Each must become ready, with no error in its log, and the schema must have every table.
2. **Postgres goes away under a steady write load**, and comes back, or the URL's endpoint moves to a promoted standby. Writers create environments through every gateway the whole time. The gateways must write again without being restarted, and every write that was acknowledged must still be there afterwards, read back through each gateway.
3. **A backup, taken under the same load, is restored into a fresh database**, and a gateway with the first one's bootstrap file starts on it. It must find its deployment, every write acknowledged before the backup began must be there, and none begun after it ended.

The drill puts its tables in a schema of its own (`drill_<run>`), never the install's, and drops it from both databases at the end, so you can run it against a database an install already uses. It needs Docker and [Bun](https://bun.sh), and runs from a checkout of the repository.

## On a local install

After [installing](/self-hosting/install/), the gateway image is on the machine as `harbour-selfhosted:dev` (or your `KANTEL_IMAGE_TAG`). To drill the bundled Postgres, give the drill the install's network and the URL its gateway uses, a database to restore into, and a command that takes Postgres away for 10 seconds:

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml exec -T postgres \
  psql -U harbour -d harbour -c 'CREATE DATABASE drill_restore'
bun apps/selfhosted/test/drill/postgres.ts \
  --network harbour_control \
  --database-url postgres://harbour:harbour@postgres:5432/harbour \
  --restore-url postgres://harbour:harbour@postgres:5432/drill_restore \
  --outage-command 'docker stop harbour-postgres-1 && sleep 10 && docker start harbour-postgres-1' \
  --watch http://127.0.0.1:58090 \
  --report drill.json
```

`--watch` follows the install's own gateway through the outage too. The names start with your `COMPOSE_PROJECT_NAME` if you set one, rather than `harbour`.

For a failover, `apps/selfhosted/test/drill/local-postgres.sh` starts Postgres the way a managed, highly available one runs: a primary with a synchronous streaming standby, one writer endpoint (a network alias) that moves to the standby when it's promoted, and an empty Postgres to restore into.

```sh
sh apps/selfhosted/test/drill/local-postgres.sh up drill    # prints the three settings below
bun apps/selfhosted/test/drill/postgres.ts \
  --network drill-net \
  --database-url postgres://kantel:kantel-drill@drill-db:5432/kantel \
  --restore-url postgres://kantel:kantel-drill@drill-restore:5432/kantel \
  --outage-command 'sh apps/selfhosted/test/drill/local-postgres.sh failover drill'
sh apps/selfhosted/test/drill/local-postgres.sh down drill
```

`failover` kills the primary, promotes the standby and moves the endpoint to it. `partition` cuts the primary off the network instead, still running, as when its machine is lost. Start the pair again (`down`, then `up`) before the next run.

## On your own Postgres

The same drill runs against a managed Postgres, from a machine that can reach it. Make an empty database and a user for it as in [Use your own Postgres](/self-hosting/database/#point-an-install-at-it), and a second empty database to restore into:

```sh
bun apps/selfhosted/test/drill/postgres.ts \
  --network bridge \
  --database-url 'postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem' \
  --database-ca ~/.kantel/database-ca.pem \
  --restore-url 'postgres://kantel:PASSWORD@restore.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem' \
  --report drill.json
```

With no `--outage-command`, the drill waits, under load, for a failover you start yourself, from your provider's console or CLI, and measures from the first failed write. Or give it the command your provider has for a failover. `pg_dump`, `pg_restore` and `psql` run in a `postgres:17-alpine` container with the same URLs, so use an `sslmode` they read as the gateway does: `verify-full`, with the CA in `sslrootcert`. The drill takes a logical backup with `pg_dump`; it doesn't exercise your provider's own backups and point-in-time recovery, which you should [try as well](/self-hosting/database/#backups-and-restores).

Run `bun apps/selfhosted/test/drill/postgres.ts --help` for the other settings: how many gateways (`--gateways`, default 3) and writers (`--writers`, default 6), how long to load before the outage (`--warmup`) and how long writes must succeed after it (`--settle`). It prints each check and what it measured, writes them to `--report` as JSON, and exits 0 when every check passed.

## Results on a local install

On 18 November 2026, on Kantel's main branch (with [the migration lock and failover recovery](/self-hosting/install/#when-the-database-restarts)), Postgres 17.11 in Docker 29 on a 48-core Linux machine shared with other work, 3 gateways and 6 writers unless it says otherwise. Every check passed in all fourteen runs.

**Concurrent start.** 3 gateways at once on an empty database were all ready in 1.3 to 3.8 seconds; 8 at once in 2.3 to 4.1 seconds. No error in any log, and every one of the 29 tables there.

**Outage under load.** No acknowledged write was lost in any run, and no gateway was restarted.

| What happened to Postgres | Runs | Writes failed | Writes back after Postgres was | Slowest call | Gateways not ready |
| --- | --- | --- | --- | --- | --- |
| Stopped, and started again 10 s later (the bundled one) | 4 | 30 to 34 of 10,800 to 23,600 | back: 0.2 to 1.6 s | 2.5 s | 10.8 to 14 s |
| The same, 8 gateways and 16 writers | 2 | 78 to 79 of 37,000 to 43,000 | back: 0.4 to 0.7 s | 7.4 s | 11.0 to 11.6 s |
| Killed, standby promoted, endpoint moved | 4 | 6 to 12 of 14,500 to 57,700 | moved: 0.06 to 1.0 s | 3.1 s | 1.0 to 4.4 s |
| Cut off the network, standby promoted, endpoint moved | 4 | 3 to 5 of 8,900 to 21,000 | moved: 0.25 to 0.7 s | 2.6 s | 0.25 to 0.5 s |

The install's own gateway, followed with `--watch` through the stop and start, was ready again each time.

**Restore.** A `pg_dump` under load took 1.2 to 11 seconds (once 110 seconds, while the machine was busy), restoring it into a fresh database 1.4 to 13 seconds, and the gateway on it was ready 0.9 to 2.1 seconds after it started. It found its deployment, the bootstrap's key answered, every write acknowledged before the backup began was there (6,100 to 35,700 of them), and none begun after it ended.

## What the results mean

- **The gateways recover on their own.** Within about a second of the database answering again, or of its address leading to the new primary, every gateway writes again, without a restart. The time your service takes to fail over is the time the control plane can't write.
- **Calls fail fast while it's away.** A call fails within a few seconds, an error `unavailable` (500), rather than hanging; `/readyz` answers 503 until the database is back, so a load balancer can stop sending calls there. With more gateways and writers, each waiting for a connection, the slowest call took longer, but none hung.
- **A failed call may still have been applied.** In each run, up to 4 writes that failed with `unavailable` were in the database afterwards: their commit reached Postgres before the connection broke. Check before you make something again. A create sent with an `Idempotency-Key` is never made twice: a retry with the same key after a call that didn't finish answers `conflict` (`held`).
- **No acknowledged write is lost when the standby is synchronous.** The local standby replicates synchronously, so the primary acknowledges a commit only once the standby has it. A service that replicates asynchronously can lose the last writes it acknowledged before a failover: check what yours does.
- **Each gateway starting with no bootstrap file makes a deployment of its own.** On an empty database, 3 gateways made 3 organisations, each with its own operator key. A gateway given another's bootstrap file finds that one's deployment instead, as the restore drill's does.

<!-- Sources: apps/selfhosted/test/drill/postgres.ts, apps/selfhosted/test/drill/local-postgres.sh, apps/selfhosted/src/gateway/main.ts (serveGateway, the bootstrap file), apps/selfhosted/src/gateway/components.ts (bootstrap, createDeployment), apps/selfhosted/src/gateway/durable.ts (start-up wait, pool renewal), packages/sql/src/postgres.ts (retries, PostgresCommitUnknownError), packages/compute/src/service.ts (createEnvironment). Results: the drill's reports from 18 Nov 2026, LLE-19619 -->
