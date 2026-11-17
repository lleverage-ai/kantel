// The gateway's components on Postgres, in place of the in-memory ones. They share one schema (default
// `harbour_m1`):
//
//   audit       SQL audit store (@kantel/audit/sql, #70)
//   identity    SQL identity directory (@kantel/identity/sql, #83)
//   sign-in     email one-time PIN codes and Kantel sessions (@kantel/identity/sql, #93)
//   compute     the compute API's records (@kantel/compute/sql): accounts, sandboxes, keys, webhooks and the rest,
//               so they outlast a restart and gateways over one database share them
//   hosts       the compute plane's registry of hosts (@kantel/hosts/store), when it places sandboxes on hosts
//   relay       tunnel tickets and exposed ports (@kantel/hosts/relay-store), hashed, with hosts
//   cluster     the live gateway replicas and which holds each host's connection (@kantel/hosts/cluster), with hosts
//   live        sandboxes' changes for the consoles watching other replicas, NOTIFY'd on the schema's channel
//               (live-relay.ts); no table
//
// Their tables are `audit_*`, `identity_*` and `compute_*`. A database an older version used also holds the agent
// plane's tables (sessions, workspaces, skills, memory, sharing, connections, the vault and the rest) in this schema
// and beside it: they are left as they are, never read, written or dropped.
import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createSqlClusterStore } from "@kantel/hosts/cluster";
import { createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import { createSqlHostReleasesStore } from "@kantel/hosts/releases";
import { createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import { createSqlIdentity, createSqlOtpStores, migrateIdentity } from "@kantel/identity/sql";
import type { SqlDriver } from "@kantel/sql";
import { postgresFailure, postgresPoolDriver, postgresRenewingPool } from "@kantel/sql/postgres";
import pg from "pg";
import { parse } from "pg-connection-string";
import { createGatewayCluster, type GatewayCluster } from "./cluster.ts";
import { deferredAccess, type GatewayComponents, identityAccess } from "./components.ts";
import { type ComputeHostsConfig, gatewayHosts } from "./compute.ts";
import { freshLookupStream } from "./fresh-socket.ts";
import { postgresLiveRelay } from "./live-relay.ts";

export interface DurableConfig {
	readonly databaseUrl: string;
	/** The Postgres schema every component's tables go in. */
	readonly schema: string;
	readonly log?: (message: string) => void;
	/** The compute plane's hosts (`compute.ts`), their registry in Postgres. Without it, there are none and no tables. */
	readonly computeHosts?: ComputeHostsConfig;
	/** Where other gateway replicas reach this one (`cluster.ts`), with `computeHosts`. */
	readonly replicaUrl?: string;
	/** The replicas' heartbeat and how long one may miss it; tests shorten them. */
	readonly cluster?: { readonly heartbeatMs?: number; readonly staleMs?: number };
	/** How long to wait on Postgres; `DATABASE_TIMEOUTS` for any left out. */
	readonly timeouts?: Partial<DatabaseTimeouts>;
	/**
	 * The pauses between attempts to reach Postgres at start, while it can't be reached or is read-only; the last
	 * repeats, with no limit. Tests shorten them.
	 */
	readonly startRetryMs?: readonly number[];
	/** The pauses before a call that failed before Postgres could have applied it is tried again (`postgresPoolDriver`). */
	readonly callRetryMs?: readonly number[];
}

/**
 * How long the gateway waits on Postgres, in milliseconds; 0 turns one off. Each is a setting (main.ts): a call during a
 * failover or restart fails within about these, rather than hanging, and the gateway carries on once Postgres is back.
 */
export interface DatabaseTimeouts {
	/** To open a connection, or to get one from the pool when all are busy (KANTEL_DATABASE_CONNECT_TIMEOUT_MS). */
	readonly connectMs: number;
	/**
	 * For a statement: Postgres cancels one that runs longer (`statement_timeout`), and the gateway gives up on one with
	 * no answer 5 s after that, as on a connection whose server is gone (KANTEL_DATABASE_STATEMENT_TIMEOUT_MS). Not for
	 * the migrations at start, which may build an index on a large table.
	 */
	readonly statementMs: number;
	/** Postgres closes a connection left in a transaction this long (`idle_in_transaction_session_timeout`). */
	readonly idleInTransactionMs: number;
	/** TCP keepalive on every connection, starting after this long idle (KANTEL_DATABASE_KEEPALIVE_MS). */
	readonly keepAliveMs: number;
}

export const DATABASE_TIMEOUTS: DatabaseTimeouts = {
	connectMs: 5_000,
	statementMs: 30_000,
	idleInTransactionMs: 30_000,
	keepAliveMs: 10_000,
};

/** How long past `statement_timeout` the gateway waits for an answer before it gives up on the connection. */
const ANSWER_GRACE_MS = 5_000;
/** The pauses between attempts to reach Postgres at start; the last repeats. */
const START_RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000];
/** The pauses before a call is tried again: twice, quickly, so a call during an outage still fails within seconds. */
const CALL_RETRY_MS = [100, 1_000];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * The advisory lock `CREATE SCHEMA` takes, so gateways starting together on an empty database don't race to create it:
 * two `CREATE SCHEMA IF NOT EXISTS` at once can both try, and one fail. Each component's migration takes a lock of its
 * own (audit 7316102022, identity 7316102023, compute 7316102020, hosts 7316102024, relay 7316102021).
 */
const SCHEMA_LOCK = 7316102025;

/**
 * The connection settings for `databaseUrl`, with `search_path` set for every connection: audit's and identity's tables
 * are unqualified. node-postgres lets a URL's `options` replace one passed beside the URL, so this does what it does
 * with a URL (parse it into the settings, unconverted, and let the client interpret them, `ssl=no-verify` included),
 * then appends the search path to the URL's own `options`, where the last `-c` wins.
 */
export function withSearchPath(databaseUrl: string, schema: string, defaults: readonly string[] = []): pg.PoolConfig {
	if (!SCHEMA.test(schema)) throw new Error(`invalid schema name ${JSON.stringify(schema)}`);
	const parsed = parse(databaseUrl);
	// `defaults` first, so the URL's own `-c` settings win over them, and the search path last.
	const options = [...defaults, parsed.options?.trim(), `-c search_path=${schema}`].filter(Boolean).join(" ");
	// The parsed settings are what pg.Client itself reads from a URL; their nulls mean "unset", as there.
	return { ...(parsed as pg.PoolConfig), options };
}

/**
 * `withSearchPath`'s settings with `timeouts`: the connect timeout and keepalive, and, with `statements`, the statement
 * and idle-in-transaction timeouts, which a URL's own `options` override.
 */
export function connectionSettings(
	databaseUrl: string,
	schema: string,
	timeouts: DatabaseTimeouts,
	{ statements = true }: { readonly statements?: boolean } = {},
): pg.PoolConfig {
	const defaults = statements
		? [
				`-c statement_timeout=${timeouts.statementMs}`,
				`-c idle_in_transaction_session_timeout=${timeouts.idleInTransactionMs}`,
			]
		: [`-c idle_in_transaction_session_timeout=${timeouts.idleInTransactionMs}`];
	return {
		...withSearchPath(databaseUrl, schema, defaults),
		// A fresh lookup of the host for each connection: Bun keeps a failed one (fresh-socket.ts).
		stream: freshLookupStream,
		connectionTimeoutMillis: timeouts.connectMs,
		keepAlive: timeouts.keepAliveMs > 0,
		keepAliveInitialDelayMillis: timeouts.keepAliveMs,
		...(statements && timeouts.statementMs > 0 ? { query_timeout: timeouts.statementMs + ANSWER_GRACE_MS } : {}),
	};
}

/**
 * Gives each of the pool's connections a listener for its errors. `pg` emits one on a connection that breaks between
 * statements; the pool listens only while the connection is idle, so a break while it was lent (between a batch's
 * statements, say) had no listener and was thrown out of the process. The call using it fails on its next statement,
 * and the driver closes it.
 */
function quietly(pool: pg.Pool): void {
	pool.on("connect", (client) => client.on("error", () => undefined));
}

/**
 * The schema and every component's tables, on a pool of one connection of its own with no statement timeout (an index
 * on a large table can take a while). Each step is idempotent and takes an advisory lock, so gateways starting together
 * take turns, and a start that failed half way can run it all again.
 */
async function migrate(config: DurableConfig, timeouts: DatabaseTimeouts): Promise<void> {
	const pool = new pg.Pool({
		...connectionSettings(config.databaseUrl, config.schema, timeouts, { statements: false }),
		max: 1,
	});
	pool.on("error", () => undefined);
	quietly(pool);
	try {
		const driver: SqlDriver = postgresPoolDriver(pool);
		// The schema first: the gateway's connections start with it on their search path.
		await driver.batch([
			{ sql: `SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})` },
			{ sql: `CREATE SCHEMA IF NOT EXISTS ${config.schema}` },
		]);
		await migrateAudit(driver);
		await migrateIdentity(driver);
		await migrateComputeStore(driver);
		if (config.computeHosts !== undefined) {
			await migrateHosts(driver);
			await migrateRelay(driver);
		}
	} finally {
		await pool.end();
	}
}

/**
 * Runs `migrate` until it succeeds. While Postgres can't be reached, is starting or shutting down, or is read-only (a
 * standby, before a failover settles), it waits and tries again with backoff, with no limit, rather than exiting; any
 * other error (a wrong password, a missing database) is thrown.
 */
async function migrateOnceReachable(
	config: DurableConfig,
	timeouts: DatabaseTimeouts,
	log: (message: string) => void,
): Promise<void> {
	const retry = config.startRetryMs ?? START_RETRY_MS;
	for (let failures = 0; ; failures++) {
		try {
			await migrate(config, timeouts);
			if (failures > 0) log("[gateway] Postgres is reachable again; starting");
			return;
		} catch (error) {
			const failure = postgresFailure(error);
			if (failure === "other") throw error;
			const wait = retry[Math.min(failures, retry.length - 1)] ?? 1_000;
			const why = failure === "readOnly" ? "is read-only" : "can't be reached";
			log(`[gateway] Postgres ${why} (${(error as Error).message}); trying again in ${wait} ms`);
			await pause(wait);
		}
	}
}

export async function createDurableGatewayComponents(config: DurableConfig): Promise<GatewayComponents> {
	if (!SCHEMA.test(config.schema)) throw new Error(`invalid schema name ${JSON.stringify(config.schema)}`);
	const log = config.log ?? ((message: string) => console.error(message));
	const closers: (() => Promise<void>)[] = [];
	const close = async () => {
		for (const closer of closers.splice(0).reverse()) await closer().catch((error) => log(`[gateway] close: ${error}`));
	};
	const timeouts = { ...DATABASE_TIMEOUTS, ...config.timeouts };
	try {
		await migrateOnceReachable(config, timeouts, log);
		// A call sends up to three statements at once (the compute API's reads that don't depend on each other), so a few
		// connections stay open while idle: opening one costs more than the statements it carries (about 15-25 ms here,
		// against about 1 ms a statement), and `pg` closes idle ones after 10 s, which a call after a quiet spell paid for.
		// When one turns out broken or read-only (after a restart or failover), the pool is replaced: its other connections
		// are to the same old server.
		const pool = postgresRenewingPool(
			() => {
				const created = new pg.Pool({
					...connectionSettings(config.databaseUrl, config.schema, timeouts),
					min: 4,
					max: 10,
				});
				created.on("error", (error) => log(`[gateway] idle Postgres connection failed: ${error.message}`));
				quietly(created);
				return created;
			},
			{
				onRenew: (why) =>
					log(`[gateway] a Postgres connection broke or is read-only (${(why as Error)?.message}); opening new ones`),
			},
		);
		closers.push(() => pool.end());

		const driver = postgresPoolDriver(pool, {
			retryMs: config.callRetryMs ?? CALL_RETRY_MS,
			onConnectionLost: (error) => pool.renew(error),
		});
		const computeStore = createSqlComputeStore(driver);
		// Replicas over this database share the hosts: each records the hosts connected to it, and sends calls for the
		// others' to them.
		let cluster: GatewayCluster | undefined;
		if (config.computeHosts !== undefined) {
			cluster = await createGatewayCluster({
				store: createSqlClusterStore(driver),
				url: config.replicaUrl ?? new URL(config.computeHosts.publicUrl).origin,
				log,
				...config.cluster,
			});
		}
		const computeHosts =
			config.computeHosts === undefined
				? undefined
				: gatewayHosts(
						config.computeHosts,
						createSqlHostStore(driver),
						log,
						cluster?.cluster,
						// A release check on one replica has every replica read the release again.
						createSqlHostReleasesStore(driver),
					);
		if (computeHosts !== undefined) closers.push(async () => computeHosts.close());
		if (cluster !== undefined) {
			const started = cluster.cluster;
			await started.start();
			// Closed first: the other replicas stop sending calls here before the hosts' connections close.
			closers.push(() => started.stop());
			log(
				`[gateway] replica ${started.replicaId}, reached by other replicas at ${config.replicaUrl ?? "its public URL"}`,
			);
		}

		// Sandboxes' live changes reach the consoles watching any replica over the database (live-relay.ts).
		const liveRelay = postgresLiveRelay({
			schema: config.schema,
			query: (text, values) => pool.query(text, [...values]),
			connect: () => new pg.Client(connectionSettings(config.databaseUrl, config.schema, timeouts)),
			log,
		});
		closers.push(async () => liveRelay.stop());

		// One check at a time, on the pool every call uses, so it fails when calls would: a database that is down, or a
		// pool with no connection to give. The pool has no timeouts of its own, so `/readyz` bounds the wait, and a check
		// still waiting is shared by those after it rather than piling more on the pool.
		let checking: Promise<void> | undefined;
		const ready = () => {
			checking ??= (async () => {
				await pool.query("SELECT 1");
			})().finally(() => {
				checking = undefined;
			});
			return checking;
		};

		const auditAccess = deferredAccess();
		const audit = createSqlAuditStore({ driver, access: auditAccess.access });
		const identity = createSqlIdentity({ driver, audit });
		auditAccess.set(identityAccess(identity, audit));

		return {
			identity,
			audit,
			otp: createSqlOtpStores(driver),
			computeStore,
			liveRelay,
			...(computeHosts === undefined ? {} : { computeHosts, relayStore: createSqlRelayStore(driver) }),
			...(cluster === undefined ? {} : { cluster }),
			bindings: {
				identity: "postgres",
				audit: "postgres",
				signIn: "postgres",
				computeStore: "postgres",
				...(computeHosts === undefined
					? {}
					: { computeHosts: "postgres", computeRelay: "postgres", computeCluster: "postgres" }),
			},
			ready,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
