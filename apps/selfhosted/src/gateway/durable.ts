// The gateway's components on the stack's own services: the real implementations the lanes merged, in place of the
// in-memory ones. All of them share one Postgres schema (default `harbour_m1`, apart from M0's `harbour`), and the
// workspaces keep their trees in S3 (MinIO in compose).
//
//   audit       SQL audit store on Postgres (@harbour/audit/sql, #70)
//   identity    SQL identity directory on Postgres (@harbour/identity/sql, #83)
//   runtime     SQL session store and each session's Pi Durable tables (@harbour/runtime/sql, #69), on one Postgres
//               connection through PostgresSqliteDatabase; unfinished runs resume on start
//   workspaces  Postgres heads and versions, S3 trees, keyed (@harbour/selfhosted-workspace, #72)
//
// Their tables do not collide: `audit_*`, `identity_*`, `harbour_*` and `pi_<session>_*`, `workspace_heads` and
// `workspace_versions`. The model is still the echo model until the model gateway (M1-BE9) lands.
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import { createSqlIdentity, migrateIdentity } from "@harbour/identity/sql";
import { createSessionRuntime } from "@harbour/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import {
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	pgDatabase,
} from "@harbour/selfhosted-workspace";
import { postgresPoolDriver } from "@harbour/sql/postgres";
import pg from "pg";
import { PostgresSqliteDatabase } from "../pi-postgres.ts";
import { createEchoModels, deferredAccess, type GatewayComponents } from "./components.ts";

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
	readonly log?: (message: string) => void;
}

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

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
		const pool = new pg.Pool({
			connectionString: config.databaseUrl,
			max: 10,
			options: `-c search_path=${config.schema}`,
		});
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
		const runtime = createSessionRuntime({
			store: await createSqlSessionStore(db),
			storage: (session) => sqlPiStorage(db, session.id),
			audit,
			identity,
			models: createEchoModels(),
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

		const resumed = await runtime.resume();
		if (resumed > 0) log(`[gateway] resumed ${resumed} session(s) left mid-run`);

		return {
			identity,
			audit,
			runtime,
			workspaces,
			bindings: {
				identity: "postgres",
				audit: "postgres",
				runtime: "postgres session store and Pi Durable tables (echo model)",
				workspaces: "postgres + s3",
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
