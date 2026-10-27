// Append-only audit events in Postgres. M0 writes them directly; the plan's
// outbox from the session log, the vault and the control plane comes in M1.

import type pg from "pg";

export class Audit {
	constructor(
		private readonly pool: pg.Pool,
		private readonly actor: string,
	) {}

	async record(sessionId: string | null, source: string, kind: string, detail: Record<string, unknown> = {}): Promise<void> {
		await this.pool.query(
			`INSERT INTO harbour.audit_events (session_id, actor, kind, detail) VALUES ($1, $2, $3, $4)`,
			[sessionId, `${source}:${this.actor}`, kind, JSON.stringify(detail)],
		);
	}
}
