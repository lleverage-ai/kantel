---
title: Use your own Postgres
description: Run the control plane on a managed, highly available Postgres instead of the bundled one, what that database must provide, and how to move an install's data onto it.
---

The control plane keeps its records in Postgres: people, organisations, projects, keys and sign-ins, the audit log, the compute API's records, and the registry of hosts. The installer starts a Postgres of its own for them, in a container beside the gateway, with its data in a Docker volume on the same machine. That's enough to try Kantel, but it has no standby and no backups: if the machine or its disk goes, so do the records.

For an install you rely on, give the control plane a Postgres of your own: a managed one, such as Amazon RDS or Aurora, Google Cloud SQL, Azure Database for PostgreSQL or Scaleway's Managed Database for PostgreSQL, or one you run with failover yourself. Kantel doesn't set one up for you. With your own database, the stack doesn't start the bundled Postgres.

## What the database must provide

| Need | Why |
| --- | --- |
| Postgres 17 | The version Kantel is tested on, and the bundled one's |
| One writer endpoint that moves on failover | Every gateway reads and writes through one address. After a failover it must lead to the new primary, as a managed service's endpoint does. Not a read replica, and not a list of hosts |
| Automatic failover | A standby in another zone that takes over when the primary goes, without you. Calls under way at that moment fail, and the gateway's `/readyz` answers 503 until the database answers again. A gateway may not recover on its own yet: if it keeps failing after a failover, restart it with `docker compose -f ~/.kantel/src/deploy/compose/compose.yaml -f ~/.kantel/src/deploy/compose/external-postgres.yaml restart gateway` (`kantel-admin apply` leaves an unchanged gateway running) |
| Backups with point-in-time recovery | Daily backups and the write-ahead log, kept for at least 7 days, so you can restore to a minute before a mistake, not only to last night |
| Connections: 12 per gateway | Each gateway holds a pool of up to 10, keeps one open for live updates and opens one briefly when it starts. Leave room for the service's own and your tools' |
| A database and a user of its own | The user needs to create the schema the tables go in (`harbour_m1`, or `KANTEL_GATEWAY_SCHEMA`), or own it if you make it first. Kantel needs no extensions |
| A direct connection | Not through a pooler in transaction mode (such as PgBouncer's): the gateway listens for notifications on a connection of its own and sets its schema in the connection's startup options, which those break |
| TLS | Unless the database is on a network only the control plane reaches. See [TLS](#tls) |

Keep `KANTEL_SECRETS_KEY` apart from the database's backups, in your secrets manager. Environments' protected values and secret files are encrypted in the database with it: a backup with the key beside it gives anyone who takes both every secret in it, and a backup without any copy of the key restores those values unreadable.

## Point an install at it

Make an empty database and a user for Kantel on the service, then give the installer its URL:

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- \
  --database-url 'postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full'
```

The installer saves the URL in `~/.kantel/src/deploy/compose/.env`, which only you can read and upgrades keep, and starts the stack without its own Postgres. A password with characters such as `@`, `/`, `:` or `'` in it is percent-encoded in a URL: `@` is `%40`.

To move an install that already has data on the bundled Postgres, move the data first, as in [Move an install's data](#move-an-installs-data). Pointed at an empty database, it starts a new deployment there: a new organisation, new keys, no hosts.

To stop using your own database, remove `KANTEL_DATABASE_URL` from `.env` and run the installer with `--upgrade`. The bundled Postgres starts again with the data it had.

### TLS

Put the TLS mode in the URL's `sslmode`:

| `sslmode` | What the gateway does |
| --- | --- |
| `verify-full` | Encrypts, and checks the server's certificate and name. Use this |
| `require`, `verify-ca`, `prefer` | The same as `verify-full`. Kantel's Postgres client checks the certificate for these too, unlike `psql`; add `uselibpqcompat=true` to the URL for `psql`'s meaning |
| `no-verify` | Encrypts without checking the certificate. Only on a network you trust |
| `disable`, or none | No TLS |

Most managed services sign their certificates with a CA of their own, which the gateway doesn't trust until you give it the CA's certificate. Download it from the service, keep it outside `~/.kantel/src` (upgrades replace that directory), and pass it with `--database-ca`. The gateway finds it at `/etc/kantel/database-ca.pem`, so name that path in the URL's `sslrootcert`:

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- \
  --database-url 'postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem' \
  --database-ca ~/.kantel/database-ca.pem
```

It's saved in `.env` as `KANTEL_DATABASE_CA_FILE`. A service whose certificate comes from a public CA needs no file.

### In the settings, and by hand

The two settings can go in `~/.kantel/src/deploy/compose/.env` like [any other](/self-hosting/install/#your-own-settings), in single quotes when they have a `$` in them:

```sh
KANTEL_DATABASE_URL='postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem'
KANTEL_DATABASE_CA_FILE=/home/you/.kantel/database-ca.pem
```

Then run the installer with `--upgrade`, or `kantel-admin apply`. Both start the stack with `deploy/compose/external-postgres.yaml` beside `compose.yaml` when `KANTEL_DATABASE_URL` is set. To run Docker Compose yourself, name both files, and use Compose 2.20 or later:

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml -f ~/.kantel/src/deploy/compose/external-postgres.yaml up -d --wait
```

`compose.yaml` alone starts the bundled Postgres, and its gateway uses that one, whatever `.env` says.

## Move an install's data

This copies everything from the bundled Postgres to yours, so the same organisations, projects, keys, sign-ins, audit log and hosts carry over. The control plane is down from the first step until the last.

1. Make an empty database and a user for Kantel on the service, on Postgres 17.
2. Stop the gateway, so nothing changes while you copy:

   ```sh
   docker compose -f ~/.kantel/src/deploy/compose/compose.yaml stop gateway
   ```

3. Dump the bundled database to a file:

   ```sh
   docker compose -f ~/.kantel/src/deploy/compose/compose.yaml exec -T postgres \
     pg_dump -U harbour -d harbour --format=custom --no-owner --no-privileges > kantel.dump
   ```

4. Restore it into yours, with the same URL the gateway will use. This runs `pg_restore` in a container, with the CA certificate where the URL names it; leave out the `-v` line if you have none:

   ```sh
   docker run --rm -i \
     -v ~/.kantel/database-ca.pem:/etc/kantel/database-ca.pem:ro \
     postgres:17-alpine pg_restore --no-owner --no-privileges --exit-on-error \
     --dbname 'postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem' \
     < kantel.dump
   ```

   `pg_restore` is `psql`'s kind of client: it doesn't know `no-verify` or `uselibpqcompat`, so use `sslmode=require` in its URL if the gateway's has those.

5. Point the install at it and start it again:

   ```sh
   curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade \
     --database-url 'postgres://kantel:PASSWORD@db.example.com:5432/kantel?sslmode=verify-full&sslrootcert=/etc/kantel/database-ca.pem' \
     --database-ca ~/.kantel/database-ca.pem
   ```

6. Check it's the same deployment: the key in the bootstrap file still answers, and you can sign in as before.

   ```sh
   docker compose -f ~/.kantel/src/deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
   curl -s http://127.0.0.1:58090/v1/me -H "authorization: Bearer ktk_..."
   ```

7. Remove the bundled Postgres's container once you're done with it. Its data stays in the `harbour_pgdata` volume, as it was when you copied it, until you delete that with `docker volume rm harbour_pgdata` (the volume's prefix is your `COMPOSE_PROJECT_NAME`, if you set one):

   ```sh
   docker compose -f ~/.kantel/src/deploy/compose/compose.yaml rm -sf postgres
   ```

Keep `kantel.dump` somewhere safe until you trust your database's own backups, then delete it: it holds everything the database does.

## Backups and restores

The database is the control plane's state. What isn't in it:

- the gateway's `gatewaystate` volume, which holds the bootstrap file with the keys the first start made (`/var/lib/harbour/bootstrap.json`). Keep a copy of it, apart from the database's backups as it holds keys too;
- `KANTEL_SECRETS_KEY` and your other settings, in `deploy/compose/.env`. Keep a copy of them in your secrets manager.

To restore, have the service restore a backup to a point in time. Most make a new instance with a new address: put its URL in `KANTEL_DATABASE_URL` and run `kantel-admin apply`. Whatever the control plane wrote after that point is gone. Try a restore before you need one.

<!-- Sources: deploy/compose/external-postgres.yaml, deploy/compose/compose.yaml (postgres, gateway), apps/site/public/install.sh (save_database_settings, run_compose), apps/cli/internal/admin/stack.go (composeFiles), apps/selfhosted/src/gateway/durable.ts:54-66,76-90,140,149 (the startup options, the setup connection, the pool of 10, the LISTEN connection, /readyz on the pool), apps/selfhosted/src/gateway/live-relay.ts:56-110, node_modules/pg-connection-string 2.14.1 (sslmode) -->
