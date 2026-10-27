/**
 * Paging stays fast at 100k events: the SQL store pages by `seq` on indexes that lead with the organisation, so a page
 * deep in the log, a session's page and an access-filtered page each cost about what the first page does.
 */
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import {
	type AuditEventInput,
	type CallContext,
	type ProjectAccess,
	type ProjectId,
	systemContext,
} from "@harbour/contracts";
import type { SqlDriver, SqlValue } from "@harbour/sql";
import { nodeSqliteDatabase, pgliteDatabase, postgresDatabase, type TestDatabaseKind } from "@harbour/sql/testing";
import { describe, expect, it } from "vitest";

const EVENTS = 100_000;
const PROJECTS = 10;
const SESSIONS = 1_000;
const ORGANISATION = "org_scale";
const SEED_BATCH = 1_000;
/** Every page here takes under 10 ms on each target locally; this leaves room for a slow CI runner. */
const PAGE_BUDGET_MS = 100;

const kinds: TestDatabaseKind[] = [pgliteDatabase, nodeSqliteDatabase];
const url = process.env.HARBOUR_TEST_POSTGRES_URL;
if (url !== undefined && url !== "") kinds.push(postgresDatabase(url));

const caller: CallContext = { actor: { kind: "human", userId: "auditor" }, organisationId: ORGANISATION };

/** Viewer on the even projects and organisation-wide; nothing else. */
const access: ProjectAccess = {
	async allows(_ctx, check) {
		return check.projectId === undefined || Number(check.projectId.slice(1)) % 2 === 0;
	},
	async require(ctx, check) {
		if (!(await this.allows(ctx, check))) throw new Error("forbidden");
		return check.projectId === undefined ? {} : { projectId: check.projectId as ProjectId };
	},
} as ProjectAccess;

function event(index: number): AuditEventInput {
	const session = index % SESSIONS;
	return {
		id: `evt-${index}`,
		at: 1_000_000 + index,
		source: index % 3 === 0 ? "vault" : "session",
		type: index % 3 === 0 ? "vault.injected" : "session.message",
		actor: { kind: "agent", agentId: `agent-${session}`, sessionId: `ses-${session}` },
		organisationId: ORGANISATION,
		projectId: `p${session % PROJECTS}`,
		sessionId: `ses-${session}`,
		data: { index },
	};
}

/** A driver that remembers the last `SELECT` it ran, so the test can ask the database how it planned it. */
function recording(driver: SqlDriver) {
	let last: { sql: string; params: readonly SqlValue[] } | undefined;
	const wrapped: SqlDriver = {
		dialect: driver.dialect,
		query(sql, params = []) {
			if (sql.startsWith("SELECT seq")) last = { sql, params };
			return driver.query(sql, params);
		},
		batch: (statements) => driver.batch(statements),
	};
	/** The plan of the last page query, as text. */
	async function plan(): Promise<string> {
		if (last === undefined) throw new Error("no page query yet");
		const rows = await driver.query(
			`${driver.dialect === "postgres" ? "EXPLAIN" : "EXPLAIN QUERY PLAN"} ${last.sql}`,
			last.params,
		);
		return rows.map((row) => String(driver.dialect === "postgres" ? Object.values(row)[0] : row.detail)).join("\n");
	}
	return { driver: wrapped, plan };
}

/**
 * Whether a plan walks the events table instead of seeking into it. SQLite must `SEARCH` it, never `SCAN` it, even by
 * an index. Postgres must not `Seq Scan` it; it may walk the `seq` index under a `LIMIT` when the rows it wants are
 * dense, as here, and its statistics decide that.
 */
function scansTable(plan: string): boolean {
	return /Seq Scan on audit_events|SCAN audit_events\b/.test(plan);
}

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
	const started = performance.now();
	const result = await run();
	return { result, ms: performance.now() - started };
}

describe("scansTable", () => {
	it("flags table and index scans, and passes index searches", () => {
		expect(scansTable("Seq Scan on audit_events  (cost=0.00..2500.00 rows=1000 width=200)")).toBe(true);
		expect(scansTable("SCAN audit_events")).toBe(true);
		expect(scansTable("SCAN audit_events USING INDEX audit_events_by_time")).toBe(true);
		expect(
			scansTable("SEARCH audit_events USING INDEX audit_events_by_project (organisation_id=? AND project_id=?)"),
		).toBe(false);
		expect(scansTable("Index Scan using audit_events_by_session on audit_events")).toBe(false);
		expect(scansTable("SCAN json_each VIRTUAL TABLE INDEX 1:")).toBe(false);
	});
});

for (const kind of kinds) {
	describe(`SQL audit store at ${EVENTS.toLocaleString("en-GB")} events on ${kind.name}`, () => {
		it("pages quickly at the start, deep in the log, by session, newest first and filtered by access", {
			timeout: 300_000,
		}, async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				const recorder = recording(database.driver);
				const store = createSqlAuditStore({ driver: recorder.driver, access });
				const plans: Record<string, string> = {};
				const page = async <T>(name: string, run: () => Promise<T>) => {
					const result = await timed(run);
					plans[name] = await recorder.plan();
					return result;
				};
				const system = systemContext("audit.relay");
				for (let start = 0; start < EVENTS; start += SEED_BATCH) {
					await store.append(
						system,
						Array.from({ length: SEED_BATCH }, (_, offset) => event(start + offset)),
					);
				}

				// Postgres plans from table statistics, which autovacuum keeps in a running service; a table loaded a moment ago
				// has none yet.
				await database.driver.query("ANALYZE");
				// Warm the connection and the caches once, as a running service would be.
				await store.query(caller, { projectId: "p0" }, { limit: 1 });

				const first = await page("first", () => store.query(caller, { projectId: "p0" }, { limit: 100 }));
				expect(first.result.items).toHaveLength(100);
				expect(first.result.items[0]?.id).toBe("evt-0");

				// The page after a cursor near the end of the log.
				const deepCursor = String(EVENTS - 2_000);
				const deep = await page("deep", () =>
					store.query(caller, { projectId: "p0" }, { limit: 100, cursor: deepCursor }),
				);
				expect(deep.result.items).toHaveLength(100);
				expect(deep.result.items.every((row) => row.seq > EVENTS - 2_000 && row.projectId === "p0")).toBe(true);

				const session = await page("session", () => store.query(caller, { sessionId: "ses-420" }, { limit: 100 }));
				expect(session.result.items).toHaveLength(100);
				expect(session.result.items.every((row) => row.sessionId === "ses-420")).toBe(true);

				const newest = await page("newest", () =>
					store.query(caller, { projectId: "p2", newestFirst: true }, { limit: 100 }),
				);
				expect(newest.result.items[0]?.id).toBe(`evt-${EVENTS - PROJECTS + 2}`);

				// No project or session: only the even projects' rows, cut into pages in SQL.
				const unscoped = await page("unscoped", () =>
					store.query(caller, { type: "vault." }, { limit: 100, cursor: String(EVENTS / 2) }),
				);
				expect(unscoped.result.items).toHaveLength(100);
				expect(
					unscoped.result.items.every(
						(row) => row.type === "vault.injected" && Number(row.projectId?.slice(1)) % 2 === 0,
					),
				).toBe(true);

				const timings = {
					first: first.ms,
					deep: deep.ms,
					session: session.ms,
					newest: newest.ms,
					unscoped: unscoped.ms,
				};
				for (const [name, ms] of Object.entries(timings)) {
					expect(ms, `${name} page took ${ms.toFixed(1)} ms`).toBeLessThan(PAGE_BUDGET_MS);
					expect(scansTable(plans[name] ?? ""), `${name} page plan:\n${plans[name]}`).toBe(false);
				}

				// Walking one session's whole history, page by page, sees each of its rows once.
				let cursor: string | undefined;
				const seen = new Set<string>();
				do {
					const page = await store.query(
						caller,
						{ sessionId: "ses-7" },
						{ limit: 30, ...(cursor === undefined ? {} : { cursor }) },
					);
					for (const row of page.items) seen.add(row.id);
					cursor = page.nextCursor;
				} while (cursor !== undefined);
				expect(seen.size).toBe(EVENTS / SESSIONS);
			} finally {
				await database.close();
			}
		});
	});
}
