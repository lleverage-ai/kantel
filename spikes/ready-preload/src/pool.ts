/**
 * The pool directory: which warmed SessionDOs are free. A new session claims one here, and the claim is part of the
 * measured hand-out, since Harbour would have to look one up the same way. One object per bench batch.
 */
import { DurableObject } from "cloudflare:workers";
import { where } from "./where.ts";

export class PoolDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS spike_free (seq INTEGER PRIMARY KEY AUTOINCREMENT, slot TEXT NOT NULL UNIQUE)",
		);
	}

	async add(slot: string): Promise<void> {
		this.ctx.storage.sql.exec("INSERT INTO spike_free (slot) VALUES (?)", slot);
	}

	/** The oldest free slot, removed so no one else gets it; undefined when the pool is empty. */
	async claim(): Promise<string | undefined> {
		const row = this.ctx.storage.sql
			.exec<{ seq: number; slot: string }>("SELECT seq, slot FROM spike_free ORDER BY seq LIMIT 1")
			.toArray()[0];
		if (row === undefined) return undefined;
		this.ctx.storage.sql.exec("DELETE FROM spike_free WHERE seq = ?", row.seq);
		return row.slot;
	}

	where() {
		return where();
	}

	async size(): Promise<number> {
		return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM spike_free").one().n;
	}
}
