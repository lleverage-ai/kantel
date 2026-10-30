// The gateway's components on the stack's own services: the real implementations the lanes merged, in place of the
// in-memory ones. All of them share one Postgres schema (default `harbour_m1`, apart from M0's `harbour`), and the
// workspaces keep their trees in S3 (MinIO in compose).
//
//   audit       SQL audit store on Postgres (@harbour/audit/sql, #70)
//   identity    SQL identity directory on Postgres (@harbour/identity/sql, #83)
//   sign-in     email one-time PIN codes and Harbour sessions on Postgres (@harbour/identity/sql, #93)
//   passkeys    people's passkeys and their single-use challenges on Postgres (@harbour/identity/sql, #132)
//   runtime     SQL session store and each session's Pi Durable tables (@harbour/runtime/sql, #69), on one Postgres
//               connection through PostgresSqliteDatabase; unfinished runs resume on start. Host registrations are
//               kept in the store with their callback and served over it (callbackHostHandlers, #158), so a host
//               app's tools, such as Sal's worker's, still answer after a restart without it registering again
//   workspaces  Postgres heads and versions, S3 trees, keyed (@harbour/selfhosted-workspace, #72)
//   sandboxes   a session's coding tools (#196, sandboxes.ts): the file tools on those workspaces directly, `bash`
//               in an in-process isolate leased on its first command
//   vault       the vault engine over the Postgres vault store (@harbour/vault-selfhosted, #75), in its own schema
//               (`<schema>_vault`), values sealed with HARBOUR_VAULT_CIPHER_KEY; no vault without that key
//   skills      packages, revisions and session pins on Postgres, each file's body in S3 by its SHA-256 under their own
//               prefix (@harbour/skills/sql, #12); a session's pins are mounted read-only at `/skills` (skills-memory.ts)
//   memory      spaces, concepts and proposals on Postgres (@harbour/memory/sql, #12); recall and the memory tools
//   usage       one row per model call in `usage_calls` on Postgres (@harbour/usage, usage.ts), shipped to
//               ClickHouse too when HARBOUR_CLICKHOUSE_URL is set; HARBOUR_USAGE=off writes none
//
// Their tables do not collide: `audit_*`, `identity_*` (sign-in's `identity_otp_codes` and `identity_sessions` too),
// `harbour_*` and `pi_<session>_*`, `workspace_heads` and `workspace_versions`, `skill_*` and `memory_*`. Sessions are
// on the echo model unless the gateway is given CPA (`modelGateway`, models.ts).
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import { type BrowserProvider, HarbourError } from "@harbour/contracts";
import { createPasskeys } from "@harbour/identity/passkey";
import { createSqlIdentity, createSqlOtpStores, createSqlPasskeyStores, migrateIdentity } from "@harbour/identity/sql";
import { createSqlMemory, migrateMemory } from "@harbour/memory/sql";
import { createSessionRuntime, type SessionRuntimeOptions } from "@harbour/runtime/core";
import { callbackHostHandlers } from "@harbour/runtime/http";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import {
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	pgDatabase,
} from "@harbour/selfhosted-workspace";
import { createSqlSkills, migrateSkills } from "@harbour/skills/sql";
import { postgresPoolDriver } from "@harbour/sql/postgres";
import { createAesGcmCipher } from "@harbour/vault/cipher";
import { createVault, type HarbourVault } from "@harbour/vault/engine";
import { createPostgresVaultStore } from "@harbour/vault-selfhosted";
import type { StoredWorkspaces } from "@harbour/workspace/stored";
import pg from "pg";
import { parse } from "pg-connection-string";
import { PostgresSqliteDatabase } from "../pi-postgres.ts";
import { gatewaySessionBrowser, withBrowserTools } from "./browser.ts";
import { createEchoModels, deferredAccess, type GatewayComponents, type ModelGatewaySource } from "./components.ts";
import { createGatewaySandboxes, SANDBOX_BINDING } from "./sandboxes.ts";
import { sessionContextOptions, skillsMountSource, withOwnWorkspaces } from "./skills-memory.ts";
import { selfHostedUsage, type UsageConfig } from "./usage.ts";

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
		/** Key prefix for skill files' bodies in the same bucket. Default `m1/skills/`. */
		readonly skillsPrefix?: string;
	};
	/** The vault's 256-bit cipher key, base64. Without it the gateway has no vault. */
	readonly vaultCipherKey?: string;
	readonly log?: (message: string) => void;
	/** The sessions' models. Default the echo model. */
	readonly models?: Pick<SessionRuntimeOptions, "models" | "resolveModel">;
	/** Sessions on the model gateway (`models.ts`), reading CPA's key through the vault; when `models` is unset. */
	readonly modelGateway?: ModelGatewaySource;
	/** The sessions' browser provider (`browser.ts`). Without it, sessions have no browser. */
	readonly browserProvider?: BrowserProvider;
	/** What `/v1/deployment` says backs the browser. */
	readonly browserBinding?: string;
	/** Usage rows for model calls (`usage.ts`); left out, none are written. */
	readonly usage?: UsageConfig;
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
		await migrateSkills(driver);
		await migrateMemory(driver);
		const usage = config.usage === undefined ? undefined : await selfHostedUsage(driver, config.usage, log);
		if (usage !== undefined) closers.push(() => usage.close());
		const auditAccess = deferredAccess();
		const audit = createSqlAuditStore({ driver, access: auditAccess.access });
		const identity = createSqlIdentity({ driver, audit });
		// In memory, as the sandboxes' leases are; built before the runtime so a session it resumes has its tools.
		const browser =
			config.browserProvider === undefined
				? undefined
				: gatewaySessionBrowser({ provider: config.browserProvider, audit, access: auditAccess.access });

		// Skills and memory check project access with the runtime's check, which they reach only when called. Skill files'
		// bodies go in the workspaces' bucket under a prefix of their own.
		const skillObjects = createS3Objects({ ...config.s3, prefix: config.s3.skillsPrefix ?? "m1/skills/" });
		await skillObjects.ensureBucket();
		const skills = createSqlSkills({ driver, objects: skillObjects, audit, access: auditAccess.access });
		const memory = createSqlMemory({ driver, audit, access: auditAccess.access });
		let workspaces: StoredWorkspaces | undefined;
		const lateWorkspaces = () => {
			if (workspaces === undefined) throw new HarbourError("unavailable", "The gateway's workspaces are not ready");
			return workspaces;
		};

		const db = await PostgresSqliteDatabase.open({ connectionString: config.databaseUrl, schema: config.schema });
		closers.push(() => db.close());
		const gatewaySandboxes = createGatewaySandboxes();
		// The vault needs the runtime's access check; the model gateway reads it only at its first call.
		let vault: HarbourVault | undefined;
		const modelGateway = config.models === undefined ? config.modelGateway : undefined;
		const models = config.models ??
			modelGateway?.build({ vault: () => vault, audit, ...(usage === undefined ? {} : { usage: usage.writer }) }) ?? {
				models: createEchoModels(),
			};
		const runtime = withOwnWorkspaces(
			createSessionRuntime({
				...gatewaySandboxes.runtimeOptions,
				tools: withBrowserTools(gatewaySandboxes.runtimeOptions.tools, browser),
				store: await createSqlSessionStore(db),
				storage: (session) => sqlPiStorage(db, session.id),
				audit,
				identity,
				...models,
				...sessionContextOptions({ skills, memory, workspaces: lateWorkspaces }),
				// The session API's own defaults for its callbacks: the global fetch and a ten-minute call.
				hostHandler: callbackHostHandlers(),
				onResumeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not resume: ${error}`),
				onWakeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not wake: ${error}`),
			}),
			lateWorkspaces,
		);
		closers.push(() => runtime.close());
		if (browser !== undefined) runtime.sessionEnd.register("browser", browser.teardown);
		const access = runtime.access;
		if (access === undefined) throw new Error("the runtime built no project-access check");
		auditAccess.set(access);

		const objects = createS3Objects(config.s3);
		await objects.ensureBucket();
		const workspaceDb = pgDatabase(pool);
		await migrateWorkspaceStore(workspaceDb, config.schema);
		workspaces = createSelfHostedWorkspaces({
			db: workspaceDb,
			objects,
			schema: config.schema,
			audit,
			access,
			sources: [skillsMountSource(skills, () => runtime.directory)],
		});
		const sandboxes = gatewaySandboxes.attach({ workspaces, access, audit });

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
			skills,
			memory,
			sandboxes,
			hosts: runtime.hosts,
			otp: createSqlOtpStores(driver),
			passkeys: createPasskeys({ ...createSqlPasskeyStores(driver), identity, audit }),
			...(vault === undefined ? {} : { vault }),
			...(modelGateway === undefined ? {} : { assistantRoute: modelGateway.route }),
			...(browser === undefined ? {} : { browser }),
			bindings: {
				browser: config.browserBinding ?? (browser === undefined ? "none" : "given"),
				vault: vault === undefined ? "off (no HARBOUR_VAULT_CIPHER_KEY)" : "postgres",
				identity: "postgres",
				audit: "postgres",
				runtime: `postgres session store and Pi Durable tables (${
					config.models !== undefined ? "given models" : modelGateway !== undefined ? "model gateway" : "echo model"
				})`,
				workspaces: "postgres + s3",
				skills: "postgres + s3",
				memory: "postgres",
				usage: usage?.binding ?? "off",
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
