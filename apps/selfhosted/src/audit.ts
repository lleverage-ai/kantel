// Append-only audit events in Postgres, written directly: the spike has no
// outbox from the session log, the vault and the control plane.

import type pg from "pg";

export class Audit {
	constructor(
		private readonly pool: pg.Pool,
		private readonly actor: string,
	) {}

	async record(
		sessionId: string | null,
		source: string,
		kind: string,
		detail: Record<string, unknown> = {},
	): Promise<void> {
		await this.pool.query(
			`INSERT INTO harbour.audit_events (session_id, actor, kind, detail) VALUES ($1, $2, $3, $4)`,
			[sessionId, `${source}:${this.actor}`, kind, JSON.stringify(detail)],
		);
	}

	/** The per-session command log the scenario surface reports as `execs`. */
	async exec(sessionId: string, record: object): Promise<void> {
		await this.pool.query(`INSERT INTO harbour.execs (session_id, body) VALUES ($1, $2)`, [
			sessionId,
			JSON.stringify(record),
		]);
	}
}
