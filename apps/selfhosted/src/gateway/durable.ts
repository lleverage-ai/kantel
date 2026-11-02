// The gateway's components on the stack's own services: the real implementations the lanes merged, in place of the
// in-memory ones. All of them share one Postgres schema (default `harbour_m1`, apart from the spike's `kantel`), and the
// workspaces keep their trees in S3 (MinIO in compose).
//
//   audit       SQL audit store on Postgres (@kantel/audit/sql, #70)
//   identity    SQL identity directory on Postgres (@kantel/identity/sql, #83)
//   sign-in     email one-time PIN codes and Kantel sessions on Postgres (@kantel/identity/sql, #93)
//   passkeys    people's passkeys and their single-use challenges on Postgres (@kantel/identity/sql, #132)
//   runtime     SQL session store and each session's Pi Durable tables (@kantel/runtime/sql, #69), on one Postgres
//               connection through PostgresSqliteDatabase; unfinished runs resume on start. Host registrations are
//               kept in the store with their callback and served over it (callbackHostHandlers, #158), so a host
//               app's tools, such as its worker's, still answer after a restart without it registering again
//   workspaces  Postgres heads and versions, S3 trees, keyed (@kantel/selfhosted-workspace, #72)
//   sandboxes   a session's coding tools (#196, sandboxes.ts): the file tools on those workspaces directly, `bash`
//               in an in-process isolate leased on its first command
//   vault       the vault engine over the Postgres vault store (@kantel/vault-selfhosted, #75), in its own schema
//               (`<schema>_vault`), values sealed with KANTEL_VAULT_CIPHER_KEY; no vault without that key
//   skills      packages, revisions and session pins on Postgres, each file's body in S3 by its SHA-256 under their own
//               prefix (@kantel/skills/sql, #12); a session's pins are mounted read-only at `/skills` (skills-memory.ts)
//   memory      spaces, concepts and proposals on Postgres (@kantel/memory/sql, #12); recall and the memory tools
//   usage       one row per model call in `usage_calls` on Postgres (@kantel/usage, usage.ts), shipped to
//               ClickHouse too when KANTEL_CLICKHOUSE_URL is set; KANTEL_USAGE=off writes none
//
// Their tables do not collide: `audit_*`, `identity_*` (sign-in's `identity_otp_codes` and `identity_sessions` too),
// `kantel_*` and `pi_<session>_*`, `workspace_heads` and `workspace_versions`, `skill_*` and `memory_*`. Sessions are
// on the echo model unless the gateway is given CPA (`modelGateway`, models.ts).
import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import { connectionEgress } from "@kantel/connections/egress";
import { createSqlConnectionsRepository, migrateConnections } from "@kantel/connections/repository";
import { type BrowserProvider, KantelError } from "@kantel/contracts";
import { createSqlEnvironmentStore, migrateEnvironments } from "@kantel/environments/sql";
import { createPasskeys } from "@kantel/identity/passkey";
import { createSqlIdentity, createSqlOtpStores, createSqlPasskeyStores, migrateIdentity } from "@kantel/identity/sql";
import { createSqlMemory, migrateMemory } from "@kantel/memory/sql";
import { createSqlPromptRules, migrateRules } from "@kantel/rules/sql";
import { createSessionRuntime, type SessionRuntimeOptions } from "@kantel/runtime/core";
import { callbackHostHandlers } from "@kantel/runtime/http";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import {
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	pgDatabase,
} from "@kantel/selfhosted-workspace";
import { componentResolvers } from "@kantel/sharing/resolvers";
import { createSqlSharing, migrateSharing } from "@kantel/sharing/sql";
import { createSqlSkills, migrateSkills } from "@kantel/skills/sql";
import { postgresPoolDriver } from "@kantel/sql/postgres";
import { createSqlToolServerRepository, migrateToolServers } from "@kantel/tools/repository";
import { createAesGcmCipher } from "@kantel/vault/cipher";
import { createVault, type KantelVault } from "@kantel/vault/engine";
import { createPostgresVaultStore } from "@kantel/vault-selfhosted";
import type { StoredWorkspaces } from "@kantel/workspace/stored";
import pg from "pg";
import { parse } from "pg-connection-string";
import { PostgresSqliteDatabase } from "../pi-postgres.ts";
import { gatewaySessionBrowser, withBrowserTools } from "./browser.ts";
import { createEchoModels, deferredAccess, type GatewayComponents, type ModelGatewaySource } from "./components.ts";
import { type GatewayConnectionsConfig, gatewayConnections } from "./connections.ts";
import { type GatewayEnvironmentsConfig, gatewayEnvironments } from "./environments.ts";
import { createModelProviders, createSqlModelProviderStore, migrateModelProviders } from "./model-providers.ts";
import { createGatewaySandboxes, SANDBOX_BINDING } from "./sandboxes.ts";
import { sessionContextOptions, skillsMountSource, withOwnWorkspaces } from "./skills-memory.ts";
import { gatewayToolServers } from "./tool-servers.ts";
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
		/** Key prefix for workspace objects in the bucket, so the gateway can share the spike's. */
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
	/** Connections (`connections.ts`), in Postgres with their secrets in the vault. Without it, or a vault, none. */
	readonly connections?: GatewayConnectionsConfig;
	/** Tool servers (`tool-servers.ts`), the registry in Postgres. Without it, there are none and no tables. */
	readonly toolServers?: boolean;
	/** Environments (`environments.ts`), in Postgres. Without it, there are none and no tables. */
	readonly environments?: GatewayEnvironmentsConfig;
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
		await migrateSharing(driver);
		await migrateRules(driver);
		// Connections need the vault, so none without its key.
		const connectionsOn = config.connections !== undefined && config.vaultCipherKey !== undefined;
		if (connectionsOn) await migrateConnections(driver);
		if (config.toolServers === true) await migrateToolServers(driver);
		if (config.environments !== undefined) await migrateEnvironments(driver);
		const usage = config.usage === undefined ? undefined : await selfHostedUsage(driver, config.usage, log);
		if (usage !== undefined) closers.push(() => usage.close());
		const auditAccess = deferredAccess();
		const audit = createSqlAuditStore({ driver, access: auditAccess.access });
		const identity = createSqlIdentity({ driver, audit });
		const linked =
			!connectionsOn || config.connections === undefined
				? undefined
				: gatewayConnections({
						config: config.connections,
						repository: createSqlConnectionsRepository(driver),
						audit,
						access: () => auditAccess.access,
						log,
					});
		// The refresh sweep (#328) stops before the database closes.
		if (linked !== undefined) closers.push(() => linked.close());
		const toolServers =
			config.toolServers === true
				? gatewayToolServers({
						repository: createSqlToolServerRepository(driver),
						audit,
						access: () => auditAccess.access,
						log,
					})
				: undefined;
		// Built before the runtime so a session it resumes has `bash`'s `env`; the store is Postgres, so a restart still
		// knows its machines and stops them when they idle.
		const environments =
			config.environments === undefined
				? undefined
				: gatewayEnvironments({
						config: config.environments,
						store: createSqlEnvironmentStore(driver),
						storeName: "postgres",
						audit,
						access: () => auditAccess.access,
						log,
					});
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
		const rules = createSqlPromptRules({ driver, audit, access: auditAccess.access });
		let workspaces: StoredWorkspaces | undefined;
		// The vault is built after the runtime (it needs its access), so it is asked for per call.
		let sharedVault: KantelVault | undefined;
		const sharing = createSqlSharing({
			driver,
			audit,
			access: auditAccess.access,
			resolvers: componentResolvers(() => ({
				skills,
				memory,
				...(sharedVault === undefined ? {} : { vault: sharedVault }),
				...(workspaces === undefined ? {} : { workspaces }),
			})),
		});
		const lateWorkspaces = () => {
			if (workspaces === undefined) throw new KantelError("unavailable", "The gateway's workspaces are not ready");
			return workspaces;
		};

		const db = await PostgresSqliteDatabase.open({ connectionString: config.databaseUrl, schema: config.schema });
		closers.push(() => db.close());
		const gatewaySandboxes = createGatewaySandboxes();
		// The vault needs the runtime's access check; the model gateway reads it only at its first call.
		let vault: KantelVault | undefined;
		const modelGateway = config.models === undefined ? config.modelGateway : undefined;
		const models = config.models ??
			modelGateway?.build({ vault: () => vault, audit, ...(usage === undefined ? {} : { usage: usage.writer }) }) ?? {
				models: createEchoModels(),
			};
		const runtime = withOwnWorkspaces(
			createSessionRuntime({
				...gatewaySandboxes.runtimeOptions,
				...(toolServers === undefined ? {} : { toolServers: toolServers.runtimeOption }),
				tools: (() => {
					const own =
						environments === undefined
							? gatewaySandboxes.runtimeOptions.tools
							: environments.withTools(gatewaySandboxes.runtimeOptions.tools);
					return linked === undefined
						? withBrowserTools(own, browser)
						: linked.withTools(withBrowserTools(own, browser));
				})(),
				store: await createSqlSessionStore(db),
				storage: (session) => sqlPiStorage(db, session.id),
				audit,
				identity,
				sharing,
				...models,
				...sessionContextOptions({ skills, memory, workspaces: lateWorkspaces }),
				rules,
				// The session API's own defaults for its callbacks: the global fetch and a ten-minute call.
				hostHandler: callbackHostHandlers(),
				onResumeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not resume: ${error}`),
				onWakeError: (sessionId, error) => log(`[gateway] session ${sessionId} did not wake: ${error}`),
			}),
			lateWorkspaces,
		);
		closers.push(() => runtime.close());
		if (browser !== undefined) runtime.sessionEnd.register("browser", browser.teardown);
		if (environments !== undefined) runtime.sessionEnd.register("environments", environments.teardown);
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
			sources: [
				skillsMountSource(
					skills,
					() => runtime.directory,
					() => runtime.profiles,
				),
			],
		});
		if (config.vaultCipherKey !== undefined) {
			const store = createPostgresVaultStore({ db: pool, schema: `${config.schema}_vault` });
			await store.migrate();
			vault = createVault({ store, cipher: createAesGcmCipher({ key: config.vaultCipherKey }), audit, access });
			sharedVault = vault;
		}
		const connections = vault === undefined ? undefined : linked?.attach(vault, runtime.directory);
		// Organisations' own inference (`model-providers.ts`): only with the vault, where their keys go.
		const providersGateway = vault === undefined ? undefined : modelGateway?.providers;
		if (providersGateway !== undefined) await migrateModelProviders(driver);
		const modelProviders =
			providersGateway === undefined
				? undefined
				: createModelProviders({
						store: createSqlModelProviderStore(driver),
						access: () => access,
						vault: () => vault,
						gateway: providersGateway,
					});
		// Placeholder-gated injection (#331): the isolate's curl reaches a connection's API with its placeholder.
		const sandboxes = gatewaySandboxes.attach({
			workspaces,
			access,
			audit,
			...(connections === undefined ? {} : { egress: connectionEgress({ connections }) }),
		});
		const heldToolServers = toolServers?.attach(runtime);
		const heldEnvironments = environments?.attach();
		if (heldEnvironments !== undefined) closers.push(() => heldEnvironments.close());

		const resumed = await runtime.resume();
		if (resumed > 0) log(`[gateway] resumed ${resumed} session(s) left mid-run`);

		return {
			identity,
			audit,
			runtime,
			workspaces,
			skills,
			memory,
			sharing,
			rules,
			sandboxes,
			hosts: runtime.hosts,
			otp: createSqlOtpStores(driver),
			passkeys: createPasskeys({ ...createSqlPasskeyStores(driver), identity, audit }),
			...(vault === undefined ? {} : { vault }),
			...(modelGateway === undefined ? {} : { assistantRoute: modelGateway.route }),
			...(modelProviders === undefined ? {} : { modelProviders }),
			...(browser === undefined ? {} : { browser }),
			...(connections === undefined ? {} : { connections }),
			...(heldToolServers === undefined ? {} : { toolServers: heldToolServers }),
			...(heldEnvironments === undefined ? {} : { environments: heldEnvironments }),
			bindings: {
				browser: config.browserBinding ?? (browser === undefined ? "none" : "given"),
				connections: connections === undefined ? "off" : "postgres + vault",
				...(heldToolServers === undefined ? {} : { toolServers: "postgres (experimental)" }),
				...(heldEnvironments === undefined ? {} : { environments: heldEnvironments.binding }),
				vault: vault === undefined ? "off (no KANTEL_VAULT_CIPHER_KEY)" : "postgres",
				identity: "postgres",
				audit: "postgres",
				runtime: `postgres session store and Pi Durable tables (${
					config.models !== undefined ? "given models" : modelGateway !== undefined ? "model gateway" : "echo model"
				})`,
				workspaces: "postgres + s3",
				skills: "postgres + s3",
				memory: "postgres",
				rules: "postgres",
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
