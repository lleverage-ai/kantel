# @harbour/runtime-cloudflare

The session runtime for the Cloudflare target: `@harbour/runtime`'s SQL session store and every session's Pi Durable
storage in a Durable Object's SQLite, and `SessionRuntimeDurableObjectCore`, which a session Durable Object class
wraps. No Node modules and no workers-types at runtime.

```ts
import { DurableObject } from "cloudflare:workers";
import { SessionRuntimeDurableObjectCore } from "@harbour/runtime-cloudflare";

export class SessionsDO extends DurableObject<Env> {
	readonly core: SessionRuntimeDurableObjectCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.core = new SessionRuntimeDurableObjectCore({
			sql: ctx.storage.sql,
			transaction: (work) => ctx.storage.transaction(() => work()),
			setAlarm: (at) => ctx.storage.setAlarm(at),
			getAlarm: () => ctx.storage.getAlarm(),
			models,
			authenticator,
			identity,
			audit,
		});
		ctx.blockConcurrencyWhile(() => this.core.ready);
	}

	fetch(request: Request) {
		return this.core.fetch(request);
	}

	alarm() {
		return this.core.alarm();
	}
}
```

## Transactions

Chord's `SqliteDatabase.transaction` takes an async callback, and the store and Pi Durable await each statement inside
it. `ctx.storage.transactionSync` takes only a synchronous closure, which an `await` always leaves, and Durable Object
SQL refuses `BEGIN`, `COMMIT` and `SAVEPOINT`. So `DurableObjectSessionDatabase` runs each transaction through the
object's async `ctx.storage.transaction`, which on a SQLite-backed object makes every `sql.exec` its closure runs one
transaction, committed when the closure resolves and rolled back when it rejects (as chord's own
`DurableObjectSqliteDatabase` and Pi Durable's `openDurableObjectSqliteStorage` do).

The callbacks await only these synchronous statements, so each runs to its end in microtasks, before the input gate
lets another event in. Work of the object's already in flight is kept out by one queue: outside a transaction a
statement runs at once; while one is open every other call, and every alarm change, waits for it to settle, so a
rollback never takes someone else's write (or the alarm) with it.

## Alarms

The runtime tells the core each session's next wake (`onWakeAt`). The core arms the alarm at the earliest, and never
moves an alarm armed earlier (by this instance, or by an earlier one, read through `getAlarm`). A prompt's wake is
due at once, so an object evicted mid run is woken again. `alarm()` resumes every session whose wake is due, then arms
the alarm for the earliest stored wake still to come. Building the core over existing storage resumes what is due in
`ready`.

## Tests

`pnpm test` runs the runtime conformance suite (with project access) through the core over `node:sqlite` (a double of
`ctx.storage.sql` and `ctx.storage.transaction` that refuses transaction control in SQL, as Durable Objects do), a
restart mid model call with two cores over one database, a retry backoff armed as the alarm and resumed by `alarm()`,
and the facade's own cases. The typecheck checks the shapes against `@cloudflare/workers-types`.
