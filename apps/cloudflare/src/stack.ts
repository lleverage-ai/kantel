/**
 * The M1 stack the gateway serves: identity, the session runtime, workspaces and the audit store, behind one
 * authenticator (#17).
 *
 * Each part is durable when its storage is given (`StackStorage`), and in memory otherwise:
 *
 * - `sql`: the identity directory and the audit store (D1 on Cloudflare);
 * - `auditOutbox`: where components' audit events queue before a background drain takes them to that store (the stack
 *   object's own SQLite, `src/audit-outbox.ts`), so no request waits on an audit write;
 * - `sessions`: the session runtime, as the runtime lane's `SessionRuntimeDurableObjectCore` over the stack Durable
 *   Object's SQLite and alarm: its directory, profiles, host registrations and each session's Pi storage, and the
 *   alarm that resumes a session an evicted object left mid-run or whose sleep has fallen due;
 * - `workspaces`: workspace heads, versions and blobs (R2). A seed's git source is fetched as a GitHub tarball
 *   (`createGitHubTarballFetcher`, #81) over `StackOptions.gitFetch`;
 * - skills (#12): packages, revisions and pins in `sql`, each file's body in `skillObjects` (R2). A session pins what
 *   it may see on its first prompt, lists the skills its profile names (Pi's `<available_skills>` block,
 *   `renderSkillListings`) and reads them read-only at `/skills` on its workspace (`src/skills-mount.ts`);
 * - memory (#12): spaces, concepts and proposals in `sql`. A session whose profile names memory spaces gets their recall
 *   on its first prompt, in the store's default rendering, and the `memory_search` and `memory_read` tools
 *   (`src/session-memory.ts`);
 * - the sandboxes (`src/sandboxes.ts`): #94's tiers over those workspaces, the isolate on the chosen backend;
 * - `bootstrap`: which organisation, project and admin this deployment made, so a restart finds them, not new ones.
 * - the schedules (#23): their store on `sql` beside identity and audit, and `@harbour/schedules`' runner
 *   (`src/schedules.ts`) on the same alarm as the sessions: each alarm resumes the sessions that are due, then runs the
 *   schedules that are, then arms the alarm for whichever comes first.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite` and an in-memory object store, and
 * `HarbourStack` hosts it in one Durable Object over the real bindings.
 */

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import {
	type AgentProfile,
	type AuditSink,
	type AuditStore,
	type Authenticator,
	type BrowserProvider,
	type CallContext,
	type Clock,
	type IdentityDirectory,
	isHarbourError,
	type LeaseEndReason,
	type Memory,
	type Organisation,
	type Project,
	type ProjectAccess,
	type PromptLayer,
	type Schedule,
	type Schedules,
	type SessionRecord,
	type SignInMethod,
	type Skills,
	type SystemContext,
	systemClock,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@harbour/identity/jwt";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createMemoryPasskeyStores, createPasskeys, type Passkeys } from "@harbour/identity/passkey";
import { createSqlIdentity, createSqlPasskeyStores, migrateIdentity } from "@harbour/identity/sql";
import { defaultRecallRenderer } from "@harbour/memory";
import { createMemoryMemory } from "@harbour/memory/memory";
import { createSqlMemory, migrateMemory } from "@harbour/memory/sql";
import type { DurableHosts, SessionRuntimeService } from "@harbour/runtime/core";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import {
	type DurableObjectTransaction,
	SessionRuntimeDurableObjectCore,
	type SqlStorageLike,
} from "@harbour/runtime-cloudflare";
import type { CheckExecutor } from "@harbour/schedules/handlers";
import { createMemorySchedules } from "@harbour/schedules/memory";
import { createSqlSchedules, migrateSchedules } from "@harbour/schedules/sql";
import { createMemorySkills } from "@harbour/skills/memory";
import { renderSkillListings } from "@harbour/skills/sources";
import { createSqlSkills, migrateSkills, type ObjectBucket } from "@harbour/skills/sql";
import type { SqlDriver } from "@harbour/sql";
import type { ApprovalVault } from "@harbour/vault/approval-api";
import { createGitRefLister, type GitRefLister } from "@harbour/workspace/git-refs";
import { createGitHubTarballFetcher } from "@harbour/workspace/git-tarball";
import { createSkillsMountSource, sessionSkillVisibility } from "@harbour/workspace/mounts";
import {
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	type StoredWorkspaces,
	type WorkspaceStore,
} from "@harbour/workspace/stored";
import { migrateObjectAuditOutbox, type OutboxedAudit, outboxedAudit } from "./audit-outbox.ts";
import { BOOTSTRAP_ORGANISATION, sqlBootstrapFinder } from "./bootstrap-sql.ts";
import { BROWSER_TOOL_NAMES, createStackBrowser, type StackBrowser } from "./browser.ts";
import { CODEMODE_TOOL, type SessionCodemodeOptions, sessionCodemodeTool } from "./codemode.ts";
import { CODING_TOOLS, sessionCodingTools, sessionEnvironments, sessionWorkspaceId } from "./coding-tools.ts";
import type { GatewayConfig } from "./config.ts";
import { createEchoModels } from "./echo-model.ts";
import type { StackModels } from "./models.ts";
import { memoiseRoleOf } from "./role-memo.ts";
import {
	createStackSandboxes,
	DEFAULT_ISOLATE_BACKEND,
	type ExtraIsolateBackends,
	type IsolateBackendName,
	type NodeEngine,
	type StackSandboxes,
} from "./sandboxes.ts";
import { isolateCheckExecutor } from "./schedule-checks.ts";
import { type CloudflareScheduler, createCloudflareScheduler } from "./schedules.ts";
import { sessionMemory } from "./session-memory.ts";
import { SKILLS_MOUNT_ROOT, sessionSkillsMount } from "./skills-mount.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: BOOTSTRAP_ORGANISATION,
};

/** The agent every new deployment has, so a session can be created before any host registers its own profiles. */
export const DEFAULT_AGENT_ID = "assistant";

/**
 * The prompt layer earlier releases wrote into the default profile on every start. Harbour adds no prompt of its own:
 * the prompt is the user's (their profile's `promptLayers`), and empty until they set one. A stored default profile
 * still carrying this exact layer has it removed on the next start; nothing else of the user's is touched.
 */
const RETIRED_DEFAULT_LAYER: PromptLayer = { name: "role", text: "You are a helpful assistant running on Harbour." };

/** The prompt layers the default profile keeps across starts: the user's own, without the retired layer. */
export function userPromptLayers(stored: AgentProfile | undefined): readonly PromptLayer[] {
	return (stored?.promptLayers ?? []).filter(
		(layer) => layer.name !== RETIRED_DEFAULT_LAYER.name || layer.text !== RETIRED_DEFAULT_LAYER.text,
	);
}

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
	/**
	 * The identity directory, the audit store, skills and memory. Their migrations run on every start; each is
	 * idempotent.
	 */
	readonly sql?: SqlDriver;
	/** Skill files' bodies, by their SHA-256 (`skills/org/<organisation>/<sha256>`). Needs `sql`. */
	readonly skillObjects?: ObjectBucket;
	/** The session runtime's store, each session's Pi storage and the alarm that resumes them. */
	readonly sessions?: SessionObjectStorage;
	readonly workspaces?: WorkspaceStore;
	readonly bootstrap?: BootstrapStore;
	/**
	 * With `sql`: components' audit events queue in this driver (the object's own SQLite, `objectSqlDriver`) and drain to
	 * the store in the background, kept alive by `background` (`ctx.waitUntil`). Left out, they go straight to the store.
	 */
	readonly auditOutbox?: { readonly driver: SqlDriver; readonly background: (work: Promise<unknown>) => void };
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
	/**
	 * The vault the approval API calls: the VaultDO over RPC (`approvalVaultOver`), or an in-process vault in tests. It
	 * checks only the organisation; the gateway makes the project checks with the runtime's access. Without it the
	 * gateway serves no approval API.
	 */
	readonly vault?: ApprovalVault;
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
	/** The compiled QuickJS module: with it, `node` runs plain JavaScript in the in-process isolate (`src/sandboxes.ts`). */
	readonly nodeEngine?: NodeEngine;
	/**
	 * The browser provider (brwsr, `src/browser.ts`), when the Worker has its key. With it the default profile has the
	 * browser's tools; without it sessions have none.
	 */
	readonly browserProvider?: BrowserProvider;
	/**
	 * Code mode (`src/codemode.ts`): the isolates scripts run in, through the Worker Loader. With it the default profile
	 * has the `codemode` tool, offered to every session that has other tools; without it sessions have none.
	 */
	readonly codemode?: SessionCodemodeOptions;
	/** Runs check schedules' commands. Default the isolate tier (`src/schedule-checks.ts`). */
	readonly checks?: CheckExecutor;
}

export interface Stack {
	readonly identity: IdentityDirectory;
	readonly runtime: SessionRuntimeService;
	readonly workspaces: StoredWorkspaces;
	/** Lists a repository's branches for a new session's branch picker, over the same `fetch` seeds use. */
	readonly gitRefs: GitRefLister;
	/** The runtime's project access: who may do what in which project. */
	readonly access: ProjectAccess;
	readonly sandboxes: StackSandboxes;
	/**
	 * A session's execution environment, as its tools get it (`src/coding-tools.ts`): its workspace, as its agent, and
	 * the stack's sandboxes for commands. `undefined` for a session without a workspace.
	 */
	readonly environment: (session: SessionRecord) => ExecutionEnv | undefined;
	/** The browser broker, its session tools and people's answers to browser requests, when the stack has a provider. */
	readonly browser?: StackBrowser;
	readonly audit: AuditStore;
	/** Agent Skills packages and their revisions (#12). */
	readonly skills: Skills;
	/** Memory spaces and their concepts (#12). */
	readonly memory: Memory;
	readonly authenticator: Authenticator;
	/** How people sign in here: Cloudflare Access when it is configured, else nobody does (API keys only). */
	readonly signIn: readonly SignInMethod[];
	/**
	 * People's passkeys (#132), in D1 with identity: the vault page asks for one before an approval once the person has
	 * registered one.
	 */
	readonly passkeys: Passkeys;
	/** Host registrations that outlive the object (durable runtime only), for the session API. */
	readonly hosts?: DurableHosts;
	/** The vault behind the approval API, when the stack has one (`StackOptions.vault`). */
	readonly vault?: ApprovalVault;
	/**
	 * The schedules store. A change that moves a schedule's next due time (create, update, resume) arms the alarm for it
	 * when that is sooner than the alarm already set.
	 */
	readonly schedules: Schedules;
	/** Runs due schedules; the alarm wakes it. */
	readonly scheduler: CloudflareScheduler;
	readonly organisation: Organisation;
	readonly project: Project;
	/** The organisation's first admin: the invited person, or a placeholder no one can sign in as. */
	readonly admin: CallContext;
	/**
	 * The object's alarm handler: resumes every session whose wake is due, runs every schedule that is, and arms the
	 * alarm for the next of either. In memory there is no alarm: it runs what is due and arms nothing.
	 */
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
		await migrateSkills(driver);
		await migrateMemory(driver);
		await migrateSchedules(driver);
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
	const store: AuditStore =
		driver === undefined
			? createMemoryAuditStore({ clock, access: auditAccess })
			: createSqlAuditStore({ driver, clock, access: auditAccess });
	let outboxed: OutboxedAudit | undefined;
	if (driver !== undefined && storage.auditOutbox !== undefined) {
		await migrateObjectAuditOutbox(storage.auditOutbox.driver);
		outboxed = outboxedAudit({ store, clock, ...storage.auditOutbox });
		// Whatever an earlier instance of the object queued and didn't get to the store.
		outboxed.kick();
	}
	const audit: AuditStore = outboxed ?? store;

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
	const passkeyStores = driver === undefined ? createMemoryPasskeyStores() : createSqlPasskeyStores(driver);
	const passkeys = createPasskeys({ ...passkeyStores, identity, clock, audit });

	const models: StackModels = options.models?.({ audit, clock }) ?? { models: createEchoModels() };
	// The sandboxes need the runtime's project access, and the runtime ends their leases when a session ends (its
	// `sandbox` teardown) and sweeps them on its alarm, so each reaches the other once both are built.
	let built: StackSandboxes | undefined;
	const lateSandboxes = (): StackSandboxes => {
		if (built === undefined) throw new Error("the sandboxes are not ready");
		return built;
	};
	let builtWorkspaces: StoredWorkspaces | undefined;
	const environment = sessionEnvironments({
		sandboxes: () => lateSandboxes().sandboxes,
		workspaces: () => lateWorkspaces(),
	});
	const lateWorkspaces = (): StoredWorkspaces => {
		if (builtWorkspaces === undefined) throw new Error("the workspaces are not ready");
		return builtWorkspaces;
	};
	// The browser is built before the runtime, so a session the runtime resumes as it starts has its tools; it asks for the
	// runtime's access, and for the bootstrap's admin, only when a call needs them.
	let bootstrapAdmin: CallContext | undefined;
	const browser =
		options.browserProvider === undefined
			? undefined
			: createStackBrowser({
					provider: options.browserProvider,
					audit,
					clock,
					access: auditAccess,
					admin: () => {
						if (bootstrapAdmin === undefined) throw new Error("the bootstrap is not finished");
						return bootstrapAdmin;
					},
				});
	// Skills and memory check project-owned records with the runtime's access (asked for per call, as the audit store
	// does), and audit into the one store. They are built before the runtime, which gives sessions what they hold: Harbour
	// adds no prompt of its own, so the listing is Pi's block of the skills a profile names, and recall is the memory
	// store's default rendering, both placed by the runtime before a session's first prompt.
	const skillObjects = storage.skillObjects;
	const skills =
		driver === undefined || skillObjects === undefined
			? createMemorySkills({ clock, audit, access: auditAccess, mountRoot: SKILLS_MOUNT_ROOT })
			: createSqlSkills({
					driver,
					objects: skillObjects,
					clock,
					audit,
					access: auditAccess,
					mountRoot: SKILLS_MOUNT_ROOT,
				});
	const memory =
		driver === undefined
			? createMemoryMemory({ clock, audit, access: auditAccess, renderer: defaultRecallRenderer })
			: createSqlMemory({ driver, clock, audit, access: auditAccess, renderer: defaultRecallRenderer });
	// The `skills` mount source: `/skills` on a session's workspace shows the revisions the session pinned. A mount asked
	// for without a version pins the session's skills as its own project sees them, as the runtime does.
	let builtDirectory: SessionRuntimeService["directory"] | undefined;
	const skillsSource = createSkillsMountSource({
		skills,
		visibility: (ctx, sessionId) => {
			if (builtDirectory === undefined) throw new Error("the session directory is not ready");
			return sessionSkillVisibility(builtDirectory)(ctx, sessionId);
		},
	});
	const workspaceStore = storage.workspaces ?? createMemoryWorkspaceStore();
	const codingToolsFor = sessionCodingTools();
	const runtimeOptions = {
		clock,
		audit,
		// The runtime's project access (and so the workspaces', sandboxes' and audit reads') asks for a role per item;
		// one lookup per request is enough (`src/role-memo.ts`).
		identity: memoiseRoleOf(identity, { clock }),
		...models,
		sandboxes: {
			releaseSession: (ctx: CallContext, sessionId: string, reason?: LeaseEndReason) =>
				// A session can end while the stack is still starting (resumed and aborted), before any lease exists.
				built === undefined ? Promise.resolve() : lateSandboxes().releaseSession(ctx, sessionId, reason),
			sweep: async (ctx: SystemContext) => (built === undefined ? [] : lateSandboxes().sweep(ctx)),
		},
		// A session on a workspace gets the coding tools its profile names (`src/coding-tools.ts`): the file tools work on
		// the workspace directly, and `bash` leases an isolate on its first command, not before.
		// With a browser provider, every session also gets the browser's tools, bound to it (`src/browser.ts`).
		// With code mode, a session that has any of those gets `codemode` too, whose scripts call them; its isolate is loaded
		// by the first script, not before (`src/codemode.ts`).
		tools: (record: SessionRecord) => {
			const tools =
				browser === undefined ? codingToolsFor(record) : [...codingToolsFor(record), ...browser.tools(record)];
			const codemode = options.codemode;
			return codemode === undefined || tools.length === 0 ? tools : [...tools, sessionCodemodeTool(codemode, record)];
		},
		environment,
		// A session started without a workspace (no repository) gets its own, which its first file tool or command
		// creates; until then it is only an ID, so a session that only talks costs no storage.
		defaultWorkspaceId: sessionWorkspaceId,
		// On its first prompt a session pins the skills it may see, mounts them at `/skills` on its workspace and lists those
		// its profile names. Without skills in the profile nothing is pinned, mounted or listed.
		skills: {
			store: skills,
			render: (listings: Parameters<typeof renderSkillListings>[0]) => renderSkillListings(listings),
			mount: sessionSkillsMount({
				workspaces: () => lateWorkspaces(),
				store: workspaceStore,
				source: skillsSource,
				access: lateAccess,
				now: () => clock.now(),
			}),
			mountRoot: SKILLS_MOUNT_ROOT,
		},
		// A session whose profile names memory spaces is given their recall on its first prompt, and the memory tools.
		memory: sessionMemory(memory),
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
		builtDirectory = runtime.directory;
		// No browser outlives its session: closing or aborting one closes its browsers and ends its grants.
		if (browser !== undefined) runtime.sessionEnd.register("browser", browser.teardown);
		const gitFetch: typeof fetch = options.gitFetch ?? ((input, init) => fetch(input, init));
		const seeders = { git: createGitHubTarballFetcher({ fetch: gitFetch }) };
		const gitRefs = createGitRefLister({ fetch: gitFetch });
		const workspaces = createStoredWorkspaces({
			store: workspaceStore,
			clock,
			audit,
			access,
			seeders,
			sources: [skillsSource],
		});
		builtWorkspaces = workspaces;
		built = createStackSandboxes({
			workspaces,
			access,
			audit,
			clock,
			backend: options.isolateBackend ?? DEFAULT_ISOLATE_BACKEND,
			...(options.extraIsolateBackends === undefined ? {} : { extraBackends: options.extraIsolateBackends }),
			...(options.nodeEngine === undefined ? {} : { nodeEngine: options.nodeEngine }),
		});
		const sandboxes = built;

		const { organisation, project, admin } = await bootstrap({
			identity,
			store: storage.bootstrap ?? createMemoryBootstrapStore(),
			...(driver === undefined ? {} : { finder: sqlBootstrapFinder(driver) }),
			adminEmail: options.config.adminEmail,
			adminName: options.config.adminName,
		});
		bootstrapAdmin = admin;
		const stored = await runtime.profiles.get(admin, DEFAULT_AGENT_ID).catch((error: unknown) => {
			if (isHarbourError(error, "not_found")) return undefined;
			throw error;
		});
		const profile: AgentProfile = {
			id: DEFAULT_AGENT_ID,
			organisationId: organisation.id,
			projectId: project.id,
			name: "Assistant",
			model: { route: "default" },
			// The prompt is the user's alone: what they set on this profile, kept across starts. Harbour adds none.
			promptLayers: userPromptLayers(stored),
			// The coding tools are offered in every session (each has a workspace, its own when it has no repository); the
			// browser's only when the stack has a provider; `codemode` when the stack has code mode. Tools describe themselves
			// through their schemas; Harbour adds no prompt about them.
			tools: [
				...CODING_TOOLS,
				...(browser === undefined ? [] : BROWSER_TOOL_NAMES),
				...(options.codemode === undefined ? [] : [CODEMODE_TOOL]),
			],
			// The skills the session lists and the memory spaces it recalls from are the user's too, kept across starts: none
			// until they set some.
			skills: stored?.skills ?? [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: stored?.memoryScopes ?? [],
		};
		await runtime.profiles.put(admin, profile);

		const store: Schedules =
			driver === undefined
				? createMemorySchedules({ clock, audit, access })
				: createSqlSchedules({ driver, clock, audit, access });
		const scheduler = createCloudflareScheduler({
			schedules: store,
			runtime: runtime.runtime,
			directory: runtime.directory,
			clock,
			organisationId: organisation.id,
			defaultProjectId: project.id,
			defaultAgentId: DEFAULT_AGENT_ID,
			checks:
				options.checks ??
				isolateCheckExecutor({
					defaultProjectId: project.id,
					agentId: DEFAULT_AGENT_ID,
					runtime: runtime.runtime,
					workspaces,
					sandboxes: () => sandboxes.sandboxes,
				}),
			onError: (error) => console.warn("harbour: the scheduler carried on past an error", error),
		});
		/** Arms the alarm for `at` unless one is set sooner (and not already spent). Without an alarm, does nothing. */
		const armAt = async (at: number): Promise<void> => {
			if (sessions === undefined) return;
			const armed = await sessions.getAlarm();
			if (armed !== null && armed > clock.now() && armed <= at) return;
			await sessions.setAlarm(at);
		};
		const armFor = async (schedule: Schedule): Promise<Schedule> => {
			if (schedule.status === "active" && schedule.nextDueAt !== undefined) {
				await armAt(schedule.nextDueAt).catch((error: unknown) =>
					console.error("harbour: arming the alarm for a schedule failed", error),
				);
			}
			return schedule;
		};
		const schedules: Schedules = {
			pause: (ctx, id) => store.pause(ctx, id),
			end: (ctx, id) => store.end(ctx, id),
			get: (ctx, id) => store.get(ctx, id),
			list: (ctx, filter, page) => store.list(ctx, filter, page),
			preview: (ctx, id, n) => store.preview(ctx, id, n),
			tick: (ctx) => store.tick(ctx),
			claim: (ctx, runner, leaseMs) => store.claim(ctx, runner, leaseMs),
			renew: (ctx, id, runner, leaseMs) => store.renew(ctx, id, runner, leaseMs),
			complete: (ctx, id, runner, outcome) => store.complete(ctx, id, runner, outcome),
			reportCheck: (ctx, id, runner, report) => store.reportCheck(ctx, id, runner, report),
			listOccurrences: (ctx, id, page) => store.listOccurrences(ctx, id, page),
			create: async (ctx, input) => armFor(await store.create(ctx, input)),
			update: async (ctx, id, input) => armFor(await store.update(ctx, id, input)),
			resume: async (ctx, id) => armFor(await store.resume(ctx, id)),
		};
		const armScheduler = async (next: number | undefined): Promise<void> => {
			if (next !== undefined) await armAt(next);
		};
		// A deploy or an eviction keeps the alarm, but a schedule made while it was lost would otherwise wait for one.
		await scheduler
			.nextWakeAt()
			.then(armScheduler)
			.catch((error: unknown) => console.error("harbour: arming the scheduler at start failed", error));

		return {
			identity,
			runtime,
			workspaces,
			gitRefs,
			access,
			sandboxes,
			environment,
			...(browser === undefined ? {} : { browser }),
			audit,
			skills,
			memory,
			authenticator,
			signIn: options.config.access === undefined ? [] : ["cloudflare_access"],
			passkeys,
			...(core === undefined ? {} : { hosts: runtime.hosts }),
			...(options.vault === undefined ? {} : { vault: options.vault }),
			schedules,
			scheduler,
			organisation,
			project,
			admin,
			alarm: async () => {
				outboxed?.kick();
				// The sessions first: their core re-arms the alarm for its next wake, and the scheduler then brings it forward
				// if a schedule is due sooner. A failure in one doesn't keep the other from running.
				let failure: unknown;
				await core?.alarm().catch((error: unknown) => {
					failure = error;
				});
				try {
					const { nextWakeAt } = await scheduler.wake();
					await armScheduler(nextWakeAt);
				} catch (error) {
					console.error("harbour: the scheduler's wake failed", error);
					// Try again soon rather than never: a store that was briefly unreachable shouldn't stop every schedule.
					await armAt(clock.now() + 60_000).catch(() => undefined);
				}
				if (failure !== undefined) throw failure;
			},
			close: async () => {
				await (core === undefined ? runtime.close() : core.close());
				// What's queued stays queued if this fails; the next start drains it.
				await outboxed?.drain().catch(() => undefined);
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
	readonly adminName: string | undefined;
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
		readonly adminName: string | undefined;
	},
	saved: BootstrapRecord,
): Promise<{ organisation: Organisation; project: Project; admin: CallContext }> {
	const { identity, store, finder, adminEmail, adminName } = options;
	let record = saved;
	const remember = async (step: BootstrapRecord): Promise<void> => {
		record = { ...record, ...step };
		await store.save(record);
	};

	let userId = record.userId ?? (await finder?.user(adminEmail));
	if (userId === undefined) {
		const user = await identity.createUser(BOOTSTRAP, {
			name: adminName ?? adminEmail ?? "Bootstrap admin",
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
