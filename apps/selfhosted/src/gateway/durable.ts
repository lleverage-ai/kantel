// The gateway's components on Postgres, in place of the in-memory ones. They share one schema (default
// `harbour_m1`):
//
//   audit       SQL audit store (@kantel/audit/sql, #70)
//   identity    SQL identity directory (@kantel/identity/sql, #83)
//   sign-in     email one-time PIN codes and Kantel sessions (@kantel/identity/sql, #93)
//   hosts       the compute plane's registry of hosts (@kantel/hosts/store), when it places sandboxes on hosts
//
// Their tables are `audit_*`, `identity_*` and `compute_*`. A database an older version used also holds the agent
// plane's tables (sessions, workspaces, skills, memory, sharing, connections, the vault and the rest) in this schema
// and beside it: they are left as they are, never read, written or dropped.
import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import { createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import { createSqlIdentity, createSqlOtpStores, migrateIdentity } from "@kantel/identity/sql";
import { postgresPoolDriver } from "@kantel/sql/postgres";
import pg from "pg";
import { parse } from "pg-connection-string";
import { deferredAccess, type GatewayComponents, identityAccess } from "./components.ts";
import { type ComputeHostsConfig, gatewayHosts } from "./compute.ts";

export interface DurableConfig {
	readonly databaseUrl: string;
	/** The Postgres schema every component's tables go in. */
	readonly schema: string;
	readonly log?: (message: string) => void;
	/** The compute plane's hosts (`compute.ts`), their registry in Postgres. Without it, there are none and no tables. */
	readonly computeHosts?: ComputeHostsConfig;
}

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The connection settings for `databaseUrl`, with `search_path` set for every connection: audit's and identity's tables
 * are unqualified. node-postgres lets a URL's `options` replace one passed beside the URL, so this does what it does
 * with a URL (parse it into the settings, unconverted, and let the client interpret them, `ssl=no-verify` included),
 * then appends the search path to the URL's own `options`, where the last `-c` wins.
 */
export function withSearchPath(databaseUrl: string, schema: string): pg.PoolConfig {
	if (!SCHEMA.test(schema)) throw new Error(`invalid schema name ${JSON.stringify(schema)}`);
	const parsed = parse(databaseUrl);
	const options = [parsed.options?.trim(), `-c search_path=${schema}`].filter(Boolean).join(" ");
	// The parsed settings are what pg.Client itself reads from a URL; their nulls mean "unset", as there.
	return { ...(parsed as pg.PoolConfig), options };
}

export async function createDurableGatewayComponents(config: DurableConfig): Promise<GatewayComponents> {
	if (!SCHEMA.test(config.schema)) throw new Error(`invalid schema name ${JSON.stringify(config.schema)}`);
	const log = config.log ?? ((message: string) => console.error(message));
	const closers: (() => Promise<void>)[] = [];
	const close = async () => {
		for (const closer of closers.splice(0).reverse()) await closer().catch((error) => log(`[gateway] close: ${error}`));
	};
	try {
		// The schema first, on a connection of its own: the pool's connections start with it on their search path.
		const setup = new pg.Client({ connectionString: config.databaseUrl });
		await setup.connect();
		try {
			await setup.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema}`);
		} finally {
			await setup.end();
		}
		const pool = new pg.Pool({ ...withSearchPath(config.databaseUrl, config.schema), max: 10 });
		closers.push(() => pool.end());
		pool.on("error", (error) => log(`[gateway] idle Postgres connection failed: ${error.message}`));

		const driver = postgresPoolDriver(pool);
		await migrateAudit(driver);
		await migrateIdentity(driver);
		if (config.computeHosts !== undefined) await migrateHosts(driver);
		const computeHosts =
			config.computeHosts === undefined
				? undefined
				: gatewayHosts(config.computeHosts, createSqlHostStore(driver), log);
		if (computeHosts !== undefined) closers.push(async () => computeHosts.close());

		const auditAccess = deferredAccess();
		const audit = createSqlAuditStore({ driver, access: auditAccess.access });
		const identity = createSqlIdentity({ driver, audit });
		auditAccess.set(identityAccess(identity, audit));

		return {
			identity,
			audit,
			otp: createSqlOtpStores(driver),
			...(computeHosts === undefined ? {} : { computeHosts }),
			bindings: {
				identity: "postgres",
				audit: "postgres",
				signIn: "postgres",
				...(computeHosts === undefined ? {} : { computeHosts: "postgres" }),
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
