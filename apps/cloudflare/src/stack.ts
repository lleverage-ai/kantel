/**
 * The M1 stack the gateway serves: identity, the session runtime, workspaces and the audit store, behind one
 * authenticator (#17).
 *
 * Each part is durable when its storage is given (`StackStorage`), and in memory otherwise:
 *
 * - `sql`: the identity directory and the audit store (D1 on Cloudflare);
 * - `sessions`: the session runtime, as the runtime lane's `SessionRuntimeDurableObjectCore` over the stack Durable
 *   Object's SQLite and alarm: its directory, profiles, host registrations and each session's Pi storage, and the
 *   alarm that resumes a session an evicted object left mid-run or whose sleep has fallen due;
 * - `workspaces`: workspace heads, versions and blobs (R2). A seed's git source is fetched as a GitHub tarball
 *   (`createGitHubTarballFetcher`, #81) over `StackOptions.gitFetch`;
 * - the sandboxes (`src/sandboxes.ts`): #94's tiers over those workspaces, the isolate on the chosen backend;
 * - `bootstrap`: which organisation, project and admin this deployment made, so a restart finds them, not new ones.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite` and an in-memory object store, and
 * `HarbourStack` hosts it in one Durable Object over the real bindings.
 */
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
	type LeaseEndReason,
	type Organisation,
	type Project,
	type ProjectAccess,
	type SystemContext,
	systemClock,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@harbour/identity/jwt";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createSqlIdentity, migrateIdentity } from "@harbour/identity/sql";
import type { DurableHosts, SessionRuntimeService } from "@harbour/runtime/core";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import {
	type DurableObjectTransaction,
	SessionRuntimeDurableObjectCore,
	type SqlStorageLike,
} from "@harbour/runtime-cloudflare";
import type { SqlDriver } from "@harbour/sql";
import { createGitHubTarballFetcher } from "@harbour/workspace/git-tarball";
import {
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	type StoredWorkspaces,
	type WorkspaceStore,
} from "@harbour/workspace/stored";
import { BOOTSTRAP_ORGANISATION, sqlBootstrapFinder } from "./bootstrap-sql.ts";
import type { GatewayConfig } from "./config.ts";
import { createEchoModels } from "./echo-model.ts";
import type { StackModels } from "./models.ts";
import {
	createStackSandboxes,
	DEFAULT_ISOLATE_BACKEND,
	type ExtraIsolateBackends,
	type IsolateBackendName,
	type StackSandboxes,
} from "./sandboxes.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: BOOTSTRAP_ORGANISATION,
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

/**
 * Finds what an unfinished bootstrap committed but never saved: the admin's user by email, the organisation that user
 * administers, and that organisation's first project. Durable identity has one (`sqlBootstrapFinder`).
 */
export interface BootstrapFinder {
	/** The bootstrap's user with this email, or with no email when there is no admin email. */
	user(email: string | undefined): Promise<string | undefined>;
	organisation(userId: string): Promise<string | undefined>;
	project(organisationId: string): Promise<string | undefined>;
	/** Whether the directory still has the organisation a saved record names (it may have been reset). */
	organisationExists(organisationId: string): Promise<boolean>;
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

/** What the session runtime's core needs of the Durable Object hosting it: its SQLite, transactions and alarm. */
export interface SessionObjectStorage {
	/** The object's `ctx.storage.sql`. */
	readonly sql: SqlStorageLike;
	/** `(work) => ctx.storage.transaction(() => work())`. */
	readonly transaction: DurableObjectTransaction;
	readonly setAlarm: (scheduledTime: number) => Promise<void>;
	readonly getAlarm: () => Promise<number | null>;
}

/** Durable storage for the stack's parts. Each one left out is in memory, and gone when the stack is. */
export interface StackStorage {
	/** The identity directory and the audit store. Their migrations run on every start; each is idempotent. */
	readonly sql?: SqlDriver;
	/** The session runtime's store, each session's Pi storage and the alarm that resumes them. */
	readonly sessions?: SessionObjectStorage;
	readonly workspaces?: WorkspaceStore;
	readonly bootstrap?: BootstrapStore;
}

export interface StackOptions {
	readonly config: GatewayConfig;
	readonly clock?: Clock;
	/** Used to fetch Access's signing keys. Default the global `fetch`; tests and `wrangler dev` pass a mock issuer's. */
	readonly accessFetch?: typeof fetch;
	/**
	 * Fetches a seed's git ref from GitHub. Default the global `fetch`, which reads public repositories without
	 * credentials; tests pass a stand-in. Private repositories wait for the vault's egress `fetch`.
	 */
	readonly gitFetch?: typeof fetch;
	readonly storage?: StackStorage;
	/**
	 * The models sessions run on, given the stack's audit store for `model.call` events: the model gateway
	 * (`createGatewayModels`) when the Worker can reach CPA. Default the echo model.
	 */
	readonly models?: (deps: { readonly audit: AuditSink; readonly clock: Clock }) => StackModels;
	/** The isolate backend sessions run on. Default `in-process`. */
	readonly isolateBackend?: IsolateBackendName;
	/** Isolate backends beyond `in-process`, such as the Dynamic Worker one on Cloudflare. */
	readonly extraIsolateBackends?: ExtraIsolateBackends;
}

export interface Stack {
	readonly identity: IdentityDirectory;
	readonly runtime: SessionRuntimeService;
	readonly workspaces: StoredWorkspaces;
	/** The runtime's project access: who may do what in which project. */
	readonly access: ProjectAccess;
	readonly sandboxes: StackSandboxes;
	readonly audit: AuditStore;
	readonly authenticator: Authenticator;
	/** Host registrations that outlive the object (durable runtime only), for the session API. */
	readonly hosts?: DurableHosts;
	readonly organisation: Organisation;
	readonly project: Project;
	/** The organisation's first admin: the invited person, or a placeholder no one can sign in as. */
	readonly admin: CallContext;
	/** The object's alarm handler: resumes every session whose wake is due and arms the next. No-op in memory. */
	alarm(): Promise<void>;
	/** Closes every session's Harness (and the runtime's storage); their work stays stored. For tests and shutdown. */
	close(): Promise<void>;
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

	// Every component audits into one store, built before the runtime: the durable runtime resumes sessions as it starts,
	// and they may audit. The store's access check (for reads) is the runtime's, so it asks for it once there is one;
	// no read can arrive before then, as nothing serves requests until the stack is built.
	let runtimeAccess: ProjectAccess | undefined;
	const lateAccess = (): ProjectAccess => {
		if (runtimeAccess === undefined) throw new Error("project access is not ready");
		return runtimeAccess;
	};
	const auditAccess: ProjectAccess = {
		require: (ctx, check) => lateAccess().require(ctx, check),
		allows: (ctx, check) => lateAccess().allows(ctx, check),
	};
	const audit: AuditStore =
		driver === undefined
			? createMemoryAuditStore({ clock, access: auditAccess })
			: createSqlAuditStore({ driver, clock, access: auditAccess });

	const identity =
		driver === undefined ? createMemoryIdentity({ clock, audit }) : createSqlIdentity({ driver, clock, audit });

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

	const models: StackModels = options.models?.({ audit, clock }) ?? { models: createEchoModels() };
	// The sandboxes need the runtime's project access, and the runtime ends their leases when a session ends (its
	// `sandbox` teardown) and sweeps them on its alarm, so each reaches the other once both are built.
	let built: StackSandboxes | undefined;
	const lateSandboxes = (): StackSandboxes => {
		if (built === undefined) throw new Error("the sandboxes are not ready");
		return built;
	};
	const runtimeOptions = {
		clock,
		audit,
		identity,
		...models,
		sandboxes: {
			releaseSession: (ctx: CallContext, sessionId: string, reason?: LeaseEndReason) =>
				// A session can end while the stack is still starting (resumed and aborted), before any lease exists.
				built === undefined ? Promise.resolve() : lateSandboxes().releaseSession(ctx, sessionId, reason),
			sweep: async (ctx: SystemContext) => (built === undefined ? [] : lateSandboxes().sweep(ctx)),
		},
	};
	const sessions = storage.sessions;
	// The durable runtime opens its store, resumes what an earlier instance of the object left due, and arms the alarm.
	const core =
		sessions === undefined
			? undefined
			: new SessionRuntimeDurableObjectCore({
					...runtimeOptions,
					...sessions,
					authenticator,
					onAlarmError: (error) => console.error("harbour: arming the session alarm failed", error),
					onResumeError: (sessionId, error) => console.error(`harbour: resuming session ${sessionId} failed`, error),
				});

	try {
		const runtime = core === undefined ? createMemoryRuntime(runtimeOptions) : await core.ready;
		const access = runtime.access;
		if (access === undefined) throw new Error("the runtime was built without project access");
		runtimeAccess = access;
		const seeders = {
			git: createGitHubTarballFetcher({ fetch: options.gitFetch ?? ((input, init) => fetch(input, init)) }),
		};
		const workspaces = createStoredWorkspaces({
			store: storage.workspaces ?? createMemoryWorkspaceStore(),
			clock,
			audit,
			access,
			seeders,
		});
		built = createStackSandboxes({
			workspaces,
			access,
			audit,
			clock,
			backend: options.isolateBackend ?? DEFAULT_ISOLATE_BACKEND,
			...(options.extraIsolateBackends === undefined ? {} : { extraBackends: options.extraIsolateBackends }),
		});
		const sandboxes = built;

		const { organisation, project, admin } = await bootstrap({
			identity,
			store: storage.bootstrap ?? createMemoryBootstrapStore(),
			...(driver === undefined ? {} : { finder: sqlBootstrapFinder(driver) }),
			adminEmail: options.config.adminEmail,
		});
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

		return {
			identity,
			runtime,
			workspaces,
			access,
			sandboxes,
			audit,
			authenticator,
			...(core === undefined ? {} : { hosts: runtime.hosts }),
			organisation,
			project,
			admin,
			alarm: async () => {
				await core?.alarm();
			},
			close: async () => {
				await (core === undefined ? runtime.close() : core.close());
			},
		};
	} catch (error) {
		// The next request retries the start with a new core; this one must not keep sessions open or arm the alarm.
		await core?.close().catch(() => undefined);
		throw error;
	}
}

/**
 * The deployment's one organisation, its first admin and its default project: made on the first start, and found again
 * on every later one. Each step is saved as it completes. A step identity committed but the record never saved (the
 * start failed in between) is found by the finder rather than made twice, and a record naming an organisation that
 * no longer exists (the directory was reset) is dropped and the bootstrap run again. The admin is invited
 * by email when the config names one; changing the email later does not change who was invited.
 */
async function bootstrap(options: {
	readonly identity: IdentityDirectory;
	readonly store: BootstrapStore;
	readonly finder?: BootstrapFinder;
	readonly adminEmail: string | undefined;
}): Promise<{ organisation: Organisation; project: Project; admin: CallContext }> {
	const { store, finder } = options;
	let saved = await store.load();
	if (
		finder !== undefined &&
		saved.organisationId !== undefined &&
		!(await finder.organisationExists(saved.organisationId))
	) {
		console.warn("harbour: the saved bootstrap names an organisation identity no longer has; bootstrapping again");
		saved = {};
		await store.save(saved);
	}
	return bootstrapOnce(options, saved);
}

async function bootstrapOnce(
	options: {
		readonly identity: IdentityDirectory;
		readonly store: BootstrapStore;
		readonly finder?: BootstrapFinder;
		readonly adminEmail: string | undefined;
	},
	saved: BootstrapRecord,
): Promise<{ organisation: Organisation; project: Project; admin: CallContext }> {
	const { identity, store, finder, adminEmail } = options;
	let record = saved;
	const remember = async (step: BootstrapRecord): Promise<void> => {
		record = { ...record, ...step };
		await store.save(record);
	};

	let userId = record.userId ?? (await finder?.user(adminEmail));
	if (userId === undefined) {
		const user = await identity.createUser(BOOTSTRAP, {
			name: adminEmail ?? "Bootstrap admin",
			...(adminEmail === undefined ? {} : { email: adminEmail }),
		});
		userId = user.id;
	}
	if (record.userId !== userId) await remember({ userId });

	let organisationId = record.organisationId ?? (await finder?.organisation(userId));
	if (organisationId === undefined) {
		const created = await identity.createOrganisation(BOOTSTRAP, { name: "Harbour", admin: { kind: "user", userId } });
		organisationId = created.id;
	}
	if (record.organisationId !== organisationId) await remember({ organisationId });

	const admin: CallContext = { actor: { kind: "human", userId }, organisationId };
	let projectId = record.projectId ?? (await finder?.project(organisationId));
	if (projectId === undefined) {
		projectId = (await identity.createProject(admin, { name: "Default" })).id;
	}
	if (record.projectId !== projectId) await remember({ projectId });

	const organisation = await identity.getOrganisation(admin, organisationId);
	const project = await identity.getProject(admin, projectId);
	return { organisation, project, admin };
}
