/**
 * Session objects (`KANTEL_SESSION_OBJECTS=on`, experimental): each new session runs in its own Durable Object, a
 * `KantelSession` (`src/session-object.ts`), rather than in the one stack object, so long sessions running at once no
 * longer share one object's memory. This file is the part both sides share. Portable: no Cloudflare APIs.
 *
 * - **Homes.** The stack keeps which object each such session lives in (its home, the object's name) in its own
 *   SQLite (`createSessionHomes`). A session's children (subagents) live in its home too. A session with no home is
 *   the stack's own, as every session was before.
 * - **The directory stays in the stack.** A session object keeps its sessions' Pi storage and their wakes in its own
 *   SQLite; their records, profiles, submissions and the deployment's profiles and host registrations stay in the
 *   stack's store, which the object reads and writes over RPC (`remoteSessionStore`, `stackStoreCall`). So the
 *   stack's directory lists every session wherever it runs, and the stack never resumes a session it isn't home to:
 *   it never holds the wake.
 * - **Routing.** A request for a session with a home goes to that object: the Worker asks the stack for the home and
 *   sends it there itself while the switch is on, so the session's events don't pass through the stack, and the stack
 *   forwards whatever still reaches it (`sessionOfRequest`).
 */
import type { SessionId } from "@kantel/contracts";
import type { SessionStore, StoredSession } from "@kantel/runtime/store";

/** The switch: `on` starts every new session in its own `KantelSession` object. Anything else (the default) is off. */
export interface SessionObjectsVars {
	readonly KANTEL_SESSION_OBJECTS?: string;
}

export function sessionObjectsOn(vars: SessionObjectsVars): boolean {
	return (vars.KANTEL_SESSION_OBJECTS ?? "").trim() === "on";
}

/** The header the stack names a new session's home in when it forwards the create. */
export const SESSION_HOME_HEADER = "kantel-session-home";

/** The part of a Durable Object's `ctx.storage.sql` these tables use. */
export interface SyncSql {
	exec<T extends Record<string, string | number | null | ArrayBuffer>>(
		query: string,
		...bindings: (string | number | null)[]
	): { toArray(): T[] };
}

export interface SessionHomes {
	/** The object a session lives in, or `undefined` for one of the stack's own. */
	homeOf(sessionId: string): string | undefined;
	/** Records that a session lives in `home`. A session's home never changes. */
	record(sessionId: string, home: string): void;
}

const HOMES_TABLE = "kantel_session_homes";

/** The stack's table of homes, read through a map: homes are only ever added. */
export function createSessionHomes(sql: SyncSql): SessionHomes {
	sql.exec(`CREATE TABLE IF NOT EXISTS ${HOMES_TABLE} (session_id TEXT PRIMARY KEY, home TEXT NOT NULL)`);
	const known = new Map<string, string | null>();
	return {
		homeOf(sessionId) {
			const cached = known.get(sessionId);
			if (cached !== undefined) return cached ?? undefined;
			const row = sql
				.exec<{ home: string }>(`SELECT home FROM ${HOMES_TABLE} WHERE session_id = ?`, sessionId)
				.toArray()[0];
			// Only a found home is kept: a session created later, in an object, must not read as the stack's.
			if (row !== undefined) known.set(sessionId, row.home);
			return row?.home;
		},
		record(sessionId, home) {
			sql.exec(`INSERT OR IGNORE INTO ${HOMES_TABLE} (session_id, home) VALUES (?, ?)`, sessionId, home);
			known.set(sessionId, home);
		},
	};
}

/** The store methods a session object calls on the stack's store. Wakes stay in the object. */
export const REMOTE_STORE_METHODS = [
	"profile",
	"profiles",
	"putProfile",
	"session",
	"sessions",
	"createSession",
	"updateSession",
	"openSessions",
	"submission",
	"putSubmission",
	"host",
	"putHost",
	"deleteHost",
	"hosts",
	"toolPins",
	"putToolPin",
] as const satisfies readonly (keyof SessionStore)[];

export type RemoteStoreMethod = (typeof REMOTE_STORE_METHODS)[number];

const remoteMethods: ReadonlySet<string> = new Set(REMOTE_STORE_METHODS);

/**
 * The stack's side of a session object's store call: runs `method` on the stack's own store, and records the home of a
 * session the object creates. Only `REMOTE_STORE_METHODS`.
 */
export async function stackStoreCall(
	store: SessionStore,
	homes: SessionHomes,
	home: string,
	method: string,
	args: readonly unknown[],
): Promise<unknown> {
	if (!remoteMethods.has(method)) throw new Error(`No such session store method: ${method}`);
	if (method === "createSession") {
		const session = args[0] as Omit<StoredSession, "sequence">;
		// Recorded first: once the record is in the directory, a request for it must find its home.
		homes.record(session.record.id, home);
		return store.createSession(session);
	}
	const call = store[method as RemoteStoreMethod] as (...callArgs: unknown[]) => Promise<unknown>;
	return call.apply(store, [...args]);
}

/** Calls one of the stack store's methods over RPC. */
export type StoreCall = (method: RemoteStoreMethod, args: readonly unknown[]) => Promise<unknown>;

/** The part of chord's `SqliteDatabase` facade the wakes table uses. */
export interface WakeDatabase {
	run(sql: string, ...params: (string | number | null)[]): Promise<void>;
	all<T extends object>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
	get<T extends object>(sql: string, ...params: (string | number | null)[]): Promise<T | undefined>;
}

const WAKES_TABLE = "kantel_home_wakes";

/**
 * A session object's store: its sessions' wakes in the object's own SQLite, so its alarm resumes them after an
 * eviction and the stack never does; everything else is the stack's store, over `call`.
 */
export async function remoteSessionStore(call: StoreCall, database: WakeDatabase): Promise<SessionStore> {
	await database.run(
		`CREATE TABLE IF NOT EXISTS ${WAKES_TABLE} (session_id TEXT PRIMARY KEY, wake_at INTEGER NOT NULL)`,
	);
	const wakeOf = async (sessionId: string) =>
		(await database.get<{ wake_at: number }>(`SELECT wake_at FROM ${WAKES_TABLE} WHERE session_id = ?`, sessionId))
			?.wake_at;
	const withWake = async (stored: StoredSession | undefined): Promise<StoredSession | undefined> => {
		if (stored === undefined) return undefined;
		const wakeAt = await wakeOf(stored.record.id);
		const { wakeAt: _theirs, ...rest } = stored;
		return wakeAt === undefined ? rest : { ...rest, wakeAt: Number(wakeAt) };
	};
	const remote =
		<M extends RemoteStoreMethod>(method: M) =>
		(...args: Parameters<SessionStore[M]>) =>
			call(method, args) as ReturnType<SessionStore[M]>;
	return {
		profile: remote("profile"),
		profiles: remote("profiles"),
		putProfile: remote("putProfile"),
		session: async (sessionId) => withWake(await remote("session")(sessionId)),
		sessions: remote("sessions"),
		createSession: remote("createSession"),
		updateSession: remote("updateSession"),
		openSessions: remote("openSessions"),
		async setWake(sessionId, at) {
			if (at === undefined) await database.run(`DELETE FROM ${WAKES_TABLE} WHERE session_id = ?`, sessionId);
			else {
				await database.run(
					`INSERT INTO ${WAKES_TABLE} (session_id, wake_at) VALUES (?, ?)
					 ON CONFLICT(session_id) DO UPDATE SET wake_at = excluded.wake_at`,
					sessionId,
					at,
				);
			}
		},
		async wakeable(before) {
			const rows = await database.all<{ session_id: string; wake_at: number }>(
				`SELECT session_id, wake_at FROM ${WAKES_TABLE} WHERE wake_at <= ? ORDER BY wake_at`,
				before,
			);
			const due: StoredSession[] = [];
			for (const row of rows) {
				const stored = await remote("session")(row.session_id as SessionId);
				if (stored !== undefined && !stored.closed) due.push({ ...stored, wakeAt: Number(row.wake_at) });
			}
			return due;
		},
		async nextWake(after) {
			const row = await database.get<{ at: number | null }>(
				`SELECT MIN(wake_at) AS at FROM ${WAKES_TABLE} WHERE wake_at > ?`,
				after,
			);
			return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
		},
		submission: remote("submission"),
		putSubmission: remote("putSubmission"),
		host: remote("host"),
		putHost: remote("putHost"),
		deleteHost: remote("deleteHost"),
		hosts: remote("hosts"),
		toolPins: remote("toolPins"),
		putToolPin: remote("putToolPin"),
	};
}

/** `/v1/sessions/{id}` and everything under it: the session's ID. */
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)(?:\/|$)/;

export function sessionIdOfPath(path: string): string | undefined {
	const match = SESSION_PATH.exec(path);
	if (match === null) return undefined;
	try {
		return decodeURIComponent(match[1]!);
	} catch {
		return undefined;
	}
}

/** Where a new session is created. */
export const SESSIONS_PATH = "/v1/sessions";
