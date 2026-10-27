/**
 * The M1 stack the gateway serves: identity, the session runtime, workspaces and the audit store, behind one
 * authenticator (#17).
 *
 * Each part is durable when its storage is given (`StackStorage`), and in memory otherwise:
 *
 * - `sql`: the identity directory and the audit store (D1 on Cloudflare);
 * - `sessions`: the runtime's directory, profiles and each session's Pi storage (the stack Durable Object's SQLite);
 * - `workspaces`: workspace heads, versions and blobs (R2);
 * - `bootstrap`: which organisation, project and admin this deployment made, so a restart finds them, not new ones.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite` and an in-memory object store, and
 * `HarbourStack` hosts it in one Durable Object over the real bindings.
 */
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import {
	type AgentProfile,
	type AuditSink,
	type AuditStore,
	type Authenticator,
	type CallContext,
	type Clock,
	type IdentityDirectory,
	type Organisation,
	type Project,
	systemClock,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@harbour/identity/jwt";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createSqlIdentity, migrateIdentity } from "@harbour/identity/sql";
import { createSessionRuntime, type SessionRuntimeService } from "@harbour/runtime/core";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import type { SqlDriver } from "@harbour/sql";
import type { KeyedWorkspaces } from "@harbour/workspace";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { createStoredWorkspaces, type WorkspaceStore } from "@harbour/workspace/stored";
import type { GatewayConfig } from "./config.ts";
import { createEchoModels } from "./echo-model.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: "bootstrap",
};

/** The agent every new deployment has, so a session can be created before any host registers its own profiles. */
export const DEFAULT_AGENT_ID = "assistant";

/** What the bootstrap made, saved after each step so a restart (or a retry after a failed start) reuses it. */
export interface BootstrapRecord {
	readonly userId?: string;
	readonly organisationId?: string;
	readonly projectId?: string;
}

export interface BootstrapStore {
	load(): Promise<BootstrapRecord>;
	save(record: BootstrapRecord): Promise<void>;
}

export function createMemoryBootstrapStore(): BootstrapStore {
	let saved: BootstrapRecord = {};
	return {
		load: async () => saved,
		save: async (record) => {
			saved = record;
		},
	};
}

/** Durable storage for the stack's parts. Each one left out is in memory, and gone when the stack is. */
export interface StackStorage {
	/** The identity directory and the audit store. Their migrations run on every start; each is idempotent. */
	readonly sql?: SqlDriver;
	/** The session runtime's store and each session's Pi storage. The stack does not close it. */
	readonly sessions?: SqliteDatabase;
	readonly workspaces?: WorkspaceStore;
	readonly bootstrap?: BootstrapStore;
}

export interface StackOptions {
	readonly config: GatewayConfig;
	readonly clock?: Clock;
	/** Used to fetch Access's signing keys. Default the global `fetch`; tests and `wrangler dev` pass a mock issuer's. */
	readonly accessFetch?: typeof fetch;
	readonly storage?: StackStorage;
}

export interface Stack {
	readonly identity: IdentityDirectory;
	readonly runtime: SessionRuntimeService;
	readonly workspaces: KeyedWorkspaces;
	readonly audit: AuditStore;
	readonly authenticator: Authenticator;
	readonly organisation: Organisation;
	readonly project: Project;
	/** The organisation's first admin: the invited person, or a placeholder no one can sign in as. */
	readonly admin: CallContext;
}

/**
 * Builds the stack and bootstraps one organisation with one project, its first admin (invited by email when the config
 * names one) and the default agent profile.
 */
export async function createStack(options: StackOptions): Promise<Stack> {
	const clock = options.clock ?? systemClock;
	const storage = options.storage ?? {};
	const driver = storage.sql;
	if (driver !== undefined) {
		await migrateIdentity(driver);
		await migrateAudit(driver);
	}

	// Every component audits into one store. The store's own access check comes from the runtime, which is built after
	// identity, so the sink forwards to the store once it exists.
	let store: AuditStore | undefined;
	const sink: AuditSink = {
		async append(ctx, events) {
			if (store === undefined) throw new Error("audit store not ready");
			await store.append(ctx, events);
		},
	};

	const identity =
		driver === undefined
			? createMemoryIdentity({ clock, audit: sink })
			: createSqlIdentity({ driver, clock, audit: sink });
	const runtimeOptions = { clock, audit: sink, identity, models: createEchoModels() };
	const sessions = storage.sessions;
	const runtime =
		sessions === undefined
			? createMemoryRuntime(runtimeOptions)
			: createSessionRuntime({
					...runtimeOptions,
					store: await createSqlSessionStore(sessions),
					storage: (session) => sqlPiStorage(sessions, session.id),
				});
	const access = runtime.access;
	if (access === undefined) throw new Error("the runtime was built without project access");
	store =
		driver === undefined ? createMemoryAuditStore({ clock, access }) : createSqlAuditStore({ driver, clock, access });
	const workspaces =
		storage.workspaces === undefined
			? createMemoryWorkspaces({ clock, audit: sink, access })
			: createStoredWorkspaces({ store: storage.workspaces, clock, audit: sink, access });

	const providers: SignInProvider[] = [];
	if (options.config.access !== undefined) {
		providers.push(
			cloudflareAccessProvider({
				teamDomain: options.config.access.teamDomain,
				audience: options.config.access.audience,
				...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }),
				clock,
			}),
		);
	}
	const authenticator = createAuthenticator({ identity, providers });

	const { organisation, project, admin } = await bootstrap(
		identity,
		storage.bootstrap ?? createMemoryBootstrapStore(),
		options.config.adminEmail,
	);
	const profile: AgentProfile = {
		id: DEFAULT_AGENT_ID,
		organisationId: organisation.id,
		projectId: project.id,
		name: "Assistant",
		model: { route: "default" },
		promptLayers: [{ name: "role", text: "You are a helpful assistant running on Harbour." }],
		tools: [],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	};
	await runtime.profiles.put(admin, profile);

	return { identity, runtime, workspaces, audit: store, authenticator, organisation, project, admin };
}

/**
 * The deployment's one organisation, its first admin and its default project: made on the first start, and found again
 * on every later one. Each step is saved as it completes, so a start that fails half way resumes rather than making a
 * second organisation. The admin is invited by email when the config names one; changing the email later does not
 * change who was invited.
 */
async function bootstrap(
	identity: IdentityDirectory,
	store: BootstrapStore,
	adminEmail: string | undefined,
): Promise<{ organisation: Organisation; project: Project; admin: CallContext }> {
	let record = await store.load();
	const remember = async (step: BootstrapRecord): Promise<void> => {
		record = { ...record, ...step };
		await store.save(record);
	};

	let userId = record.userId;
	if (userId === undefined) {
		const user = await identity.createUser(BOOTSTRAP, {
			name: adminEmail ?? "Bootstrap admin",
			...(adminEmail === undefined ? {} : { email: adminEmail }),
		});
		userId = user.id;
		await remember({ userId });
	}

	let organisationId = record.organisationId;
	if (organisationId === undefined) {
		const created = await identity.createOrganisation(BOOTSTRAP, { name: "Harbour", admin: { kind: "user", userId } });
		organisationId = created.id;
		await remember({ organisationId });
	}

	const admin: CallContext = { actor: { kind: "human", userId }, organisationId };
	let projectId = record.projectId;
	if (projectId === undefined) {
		projectId = (await identity.createProject(admin, { name: "Default" })).id;
		await remember({ projectId });
	}

	const organisation = await identity.getOrganisation(admin, organisationId);
	const project = await identity.getProject(admin, projectId);
	return { organisation, project, admin };
}
