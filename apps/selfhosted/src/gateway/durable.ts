// The gateway's components on the stack's own services: the real implementations the lanes merged, in place of the
// in-memory ones. All of them share one Postgres schema (default `harbour_m1`, apart from M0's `harbour`), and the
// workspaces keep their trees in S3 (MinIO in compose).
//
//   audit       SQL audit store on Postgres (@harbour/audit/sql, #70)
//   identity    SQL identity directory on Postgres (@harbour/identity/sql, #83)
//   sign-in     email one-time PIN codes and Harbour sessions on Postgres (@harbour/identity/sql, #93)
//   runtime     SQL session store and each session's Pi Durable tables (@harbour/runtime/sql, #69), on one Postgres
//               connection through PostgresSqliteDatabase; unfinished runs resume on start. Host registrations are
//               kept in the store with their callback and served over it (callbackHostHandlers, #158), so a host
//               app's tools, such as Sal's worker's, still answer after a restart without it registering again
//   workspaces  Postgres heads and versions, S3 trees, keyed (@harbour/selfhosted-workspace, #72)
//   sandboxes   a session's coding tools (#196, sandboxes.ts): the file tools on those workspaces directly, `bash`
//               in an in-process isolate leased on its first command
//   vault       the vault engine over the Postgres vault store (@harbour/vault-selfhosted, #75), in its own schema
//               (`<schema>_vault`), values sealed with HARBOUR_VAULT_CIPHER_KEY; no vault without that key
//
// Their tables do not collide: `audit_*`, `identity_*` (sign-in's `identity_otp_codes` and `identity_sessions` too), `harbour_*` and `pi_<session>_*`, `workspace_heads` and
// `workspace_versions`. The model is still the echo model until the model gateway (M1-BE9) lands.
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import { createSqlIdentity, createSqlOtpStores, migrateIdentity } from "@harbour/identity/sql";
import { createSessionRuntime, type SessionRuntimeOptions } from "@harbour/runtime/core";
import { callbackHostHandlers } from "@harbour/runtime/http";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import {
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	pgDatabase,
} from "@harbour/selfhosted-workspace";
import { postgresPoolDriver } from "@harbour/sql/postgres";
import { createAesGcmCipher } from "@harbour/vault/cipher";
import { createVault, type HarbourVault } from "@harbour/vault/engine";
import { createPostgresVaultStore } from "@harbour/vault-selfhosted";
import pg from "pg";
import { parse } from "pg-connection-string";
import { PostgresSqliteDatabase } from "../pi-postgres.ts";
import { createEchoModels, deferredAccess, type GatewayComponents } from "./components.ts";
import { createGatewaySandboxes, SANDBOX_BINDING } from "./sandboxes.ts";

export interface DurableConfig {
	readonly databaseUrl: string;
	/** The Postgres schema every component's tables go in. */
	readonly schema: string;
	readonly s3: {
		readonly endpoint: string;
		readonly bucket: string;
		readonly accessKeyId: string;
		readonly secretAccessKey: string;
		readonly region?: string;
		/** Key prefix for workspace objects in the bucket, so the gateway can share M0's. */
		readonly prefix: string;
	};
	/** The vault's 256-bit cipher key, base64. Without it the gateway has no vault. */
	readonly vaultCipherKey?: string;
	readonly log?: (message: string) => void;
	/** The sessions' models. Default the echo model. */
	readonly models?: Pick<SessionRuntimeOptions, "models" | "resolveModel">;
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
		const auditAccess = deferredAccess();
		const audit = createSqlAuditStore({ driver, access: auditAccess.access });
		const identity = createSqlIdentity({ driver, audit });

		const db = await PostgresSqliteDatabase.open({ connectionString: config.databaseUrl, schema: config.schema });
		closers.push(() => db.close());
		const gatewaySandboxes = createGatewaySandboxes();
		const runtime = createSessionRuntime({
			...gatewaySandboxes.runtimeOptions,
			store: await createSqlSessionStore(db),
			storage: (session) => sqlPiStorage(db, session.id),
			audit,
			identity,
			...(config.models ?? { models: createEchoModels() }),
			// The session API's own defaults for its callbacks: the global fetch and a ten-minute call.
			hostHandler: callbackHostHandlers(),
			onResumeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not resume: ${error}`),
			onWakeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not wake: ${error}`),
		});
		closers.push(() => runtime.close());
		const access = runtime.access;
		if (access === undefined) throw new Error("the runtime built no project-access check");
		auditAccess.set(access);

		const objects = createS3Objects(config.s3);
		await objects.ensureBucket();
		const workspaceDb = pgDatabase(pool);
		await migrateWorkspaceStore(workspaceDb, config.schema);
		const workspaces = createSelfHostedWorkspaces({
			db: workspaceDb,
			objects,
			schema: config.schema,
			audit,
			access,
		});
		const sandboxes = gatewaySandboxes.attach({ workspaces, access, audit });

		let vault: HarbourVault | undefined;
		if (config.vaultCipherKey !== undefined) {
			const store = createPostgresVaultStore({ db: pool, schema: `${config.schema}_vault` });
			await store.migrate();
			vault = createVault({ store, cipher: createAesGcmCipher({ key: config.vaultCipherKey }), audit, access });
		}

		const resumed = await runtime.resume();
		if (resumed > 0) log(`[gateway] resumed ${resumed} session(s) left mid-run`);

		return {
			identity,
			audit,
			runtime,
			workspaces,
			sandboxes,
			hosts: runtime.hosts,
			otp: createSqlOtpStores(driver),
			...(vault === undefined ? {} : { vault }),
			bindings: {
				vault: vault === undefined ? "off (no HARBOUR_VAULT_CIPHER_KEY)" : "postgres",
				identity: "postgres",
				audit: "postgres",
				runtime: "postgres session store and Pi Durable tables (echo model)",
				workspaces: "postgres + s3",
				sandboxes: SANDBOX_BINDING,
				signIn: "postgres",
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
