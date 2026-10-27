# @harbour/runtime-selfhosted

The session runtime for the self-hosted target: `@harbour/runtime`'s SQL session store and every session's Pi Durable
storage in one Postgres schema, through chord's portable `SqliteDatabase` facade over Postgres.

```ts
import pg from "pg";
import { createSelfhostedSessionRuntime, openPostgresSessionDatabase } from "@harbour/runtime-selfhosted";

const pool = new pg.Pool({ connectionString });
const database = await openPostgresSessionDatabase({ pool, schema: "harbour_sessions" });
const service = await createSelfhostedSessionRuntime({ database, models, identity, audit, hostHandler });
// … serve service.runtime, service.directory and the rest; on shutdown:
await service.close();
await database.close();
```

`openPostgresSessionDatabase` takes a `pg.Pool` (it checks out one connection and releases it on close) or a
connection the caller owns (a `pg.Client`, a `PoolClient` or PGlite). Everything runs on that one connection, one
statement or transaction at a time, with the schema on its `search_path`; a transaction is `BEGIN` … `COMMIT` on it,
rolled back when its callback rejects. The SQLite dialect the store and Pi Durable emit is translated on the way
(`translateSqliteToPostgres`): `STRICT` and `json_valid` checks dropped, `INTEGER` widened to `BIGINT`,
`INSERT OR IGNORE` as `ON CONFLICT DO NOTHING`, `?` as `$n`. `int8` columns come back as numbers.

`createSelfhostedSessionRuntime` builds `createSessionRuntime` over that database and resumes, before it returns,
every session a previous process left mid-run or whose sleep has fallen due.

Pi's table and index names carry each session's prefix (`pi_<uuid>_`); one index name passes Postgres's 63-byte limit
and is truncated, deterministically and without colliding.

## Tests

`pnpm test` runs the runtime conformance suite (with project access), a restart mid model call and the facade's own
cases on PGlite, so CI needs no services. The conformance suite and the restart test run on a real Postgres too when
`HARBOUR_TEST_DATABASE_URL` is set:

```sh
HARBOUR_TEST_DATABASE_URL=postgres://harbour:harbour@127.0.0.1:55432/harbour \
pnpm --filter @harbour/runtime-selfhosted test
```

Each case uses its own schema (`m1_be1_<random>`), dropped afterwards.
