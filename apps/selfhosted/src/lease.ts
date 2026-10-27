// Session leases on Postgres: the self-hosted stand-in for a Durable Object's
// "exactly one live owner". All times come from Postgres's clock (now()), so
// hosts with skewed clocks still agree on who owns what.

import type pg from "pg";
import type { Lease, LeaseFence, SessionLeases } from "../../../spike/contracts/index.ts";

export class LeaseLost extends Error {
	constructor(lease: LeaseFence) {
		super(`lease on ${lease.sessionId} (fence ${lease.fence}) is no longer held by ${lease.owner}`);
		this.name = "LeaseLost";
	}
}

type Queryable = Pick<pg.ClientBase, "query">;

const row = (r: any): Lease => ({
	sessionId: r.session_id,
	owner: r.owner,
	ownerUrl: r.owner_url,
	fence: Number(r.fence),
	expiresAt: new Date(r.expires_at).getTime(),
});

export class PostgresLeases implements SessionLeases {
	constructor(private readonly db: Queryable) {}

	/** Take the lease if it is free or expired. A takeover increments the fence. */
	async acquire(sessionId: string, owner: string, ownerUrl: string, ttlMs: number): Promise<Lease | undefined> {
		const result = await this.db.query(
			`INSERT INTO harbour.session_leases AS l (session_id, owner, owner_url, fence, expires_at, acquired_at)
			 VALUES ($1, $2, $3, 1, now() + make_interval(secs => $4::double precision / 1000), now())
			 ON CONFLICT (session_id) DO UPDATE
			   SET owner = EXCLUDED.owner, owner_url = EXCLUDED.owner_url, fence = l.fence + 1,
			       expires_at = EXCLUDED.expires_at, acquired_at = now()
			   WHERE l.expires_at <= now()
			 RETURNING session_id, owner, owner_url, fence, expires_at`,
			[sessionId, owner, ownerUrl, ttlMs],
		);
		return result.rows[0] === undefined ? undefined : row(result.rows[0]);
	}

	async renew(lease: LeaseFence, ttlMs: number): Promise<Lease | undefined> {
		const result = await this.db.query(
			`UPDATE harbour.session_leases
			   SET expires_at = now() + make_interval(secs => $4::double precision / 1000)
			 WHERE session_id = $1 AND owner = $2 AND fence = $3 AND expires_at > now()
			 RETURNING session_id, owner, owner_url, fence, expires_at`,
			[lease.sessionId, lease.owner, lease.fence, ttlMs],
		);
		return result.rows[0] === undefined ? undefined : row(result.rows[0]);
	}

	async release(lease: LeaseFence): Promise<void> {
		await this.db.query(
			`UPDATE harbour.session_leases SET expires_at = now()
			 WHERE session_id = $1 AND owner = $2 AND fence = $3`,
			[lease.sessionId, lease.owner, lease.fence],
		);
	}

	async current(sessionId: string): Promise<Lease | undefined> {
		const result = await this.db.query(
			`SELECT session_id, owner, owner_url, fence, expires_at FROM harbour.session_leases
			 WHERE session_id = $1 AND expires_at > now()`,
			[sessionId],
		);
		return result.rows[0] === undefined ? undefined : row(result.rows[0]);
	}

	/**
	 * Inside a transaction: lock the lease row in share mode and throw unless
	 * this owner still holds it. A takeover's UPDATE waits for the lock, so a
	 * commit that passed this check finishes before anyone else can own the session.
	 */
	async check(lease: LeaseFence, db: Queryable = this.db): Promise<void> {
		const result = await db.query(
			`SELECT 1 FROM harbour.session_leases
			 WHERE session_id = $1 AND owner = $2 AND fence = $3 AND expires_at > now()
			 FOR SHARE`,
			[lease.sessionId, lease.owner, lease.fence],
		);
		if (result.rowCount === 0) throw new LeaseLost(lease);
	}

	/** Sessions with work to do whose lease is free: the takeover scan. */
	async orphans(limit = 20): Promise<string[]> {
		const result = await this.db.query(
			`SELECT s.id FROM harbour.sessions s
			 LEFT JOIN harbour.session_leases l ON l.session_id = s.id
			 WHERE (s.status = 'active' OR s.wake_at <= now())
			   AND (l.session_id IS NULL OR l.expires_at <= now())
			 ORDER BY s.updated_at LIMIT $1`,
			[limit],
		);
		return result.rows.map((r) => r.id as string);
	}

	/** Milliseconds until the next held lease on an active session expires, for a precise takeover wake-up. */
	async nextExpiryMs(): Promise<number | undefined> {
		const result = await this.db.query(
			`SELECT extract(epoch FROM (min(l.expires_at) - now())) * 1000 AS ms
			 FROM harbour.session_leases l JOIN harbour.sessions s ON s.id = l.session_id
			 WHERE s.status = 'active' AND l.expires_at > now()`,
		);
		const ms = result.rows[0]?.ms;
		return ms === null || ms === undefined ? undefined : Math.max(0, Number(ms));
	}
}
