# @harbour/sql

The SQL seam Harbour's durable stores run on, so one store serves the self-hosted target (Postgres) and Cloudflare
(D1, or a Durable Object's SQLite).

- `SqlDriver` (`.`): `dialect`, `query(sql, params)` and `batch(statements)`, which runs statements atomically.
  Statements use `?` placeholders. There are no interactive transactions, because D1 has none.
- `@harbour/sql/postgres`: `postgresPoolDriver(pool)` over `pg`'s `Pool` (each batch in `BEGIN` … `COMMIT`),
  `postgresTransactionalDriver(db)` over PGlite, and `postgresClientDriver(client)` over a client already in the
  caller's transaction, so a producer's writes and its audit outbox rows commit together. They take the client's
  shape, not a package.
- `@harbour/sql/sqlite`: `d1Driver(env.DB)` (D1's own `batch`) and `syncSqliteDriver(db)` for `node:sqlite` or Bun.
- `@harbour/sql/testing` (Node only): fresh databases for tests on PGlite, `node:sqlite` and D1 in Miniflare, plus a
  real Postgres when `HARBOUR_TEST_POSTGRES_URL` is set (each database is a schema of its own, dropped on close).
  `testDatabaseKinds()` lists them, so a store registers its conformance suite once per kind.

D1 binds at most 100 parameters in a statement, so stores keep multi-row inserts small and pass lists as one JSON
parameter.
