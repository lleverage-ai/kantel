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
 * - the schedules (#23): their store on `sql` beside identity and audit, and `@kantel/schedules`' runner
 *   (`src/schedules.ts`) on the same alarm as the sessions: each alarm resumes the sessions that are due, then runs the
 *   schedules that are, then arms the alarm for whichever comes first.
 * - tool servers (docs/site/src/content/docs/api/tool-servers.md, experimental), when `StackOptions.toolServers` is
 *   given: the registry on `sql`, each server's tunnel in its own object (`src/tool-servers.ts`), and their tools in
 *   sessions.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite` and an in-memory object store, and
 * `KantelStack` hosts it in one Durable Object over the real bindings.
 */

import { createHash } from "node:crypto";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createMemoryAuditStore } from "@kantel/audit/memory";
import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import type { ConnectionsDeployment, CredentialStore, Fetch } from "@kantel/connections";
import { type CeilingStore, type ConnectionsService, createConnections } from "@kantel/connections";
import { connectionEgress } from "@kantel/connections/egress";
import {
	createMemoryConnectionsRepository,
	createSqlConnectionsRepository,
	migrateConnections,
} from "@kantel/connections/repository";
import { CONNECTION_TOOL_NAMES, connectionTools } from "@kantel/connections/tools";
import {
	type AgentProfile,
	type AuditSink,
	type AuditStore,
	type Authenticator,
	type BrowserProvider,
	type CallContext,
	type Clock,
	type ConnectionApprovals,
	DEFAULT_PROJECT_SETTINGS,
	type FileShares,
	type IdentityDirectory,
	isKantelError,
	type LeaseEndReason,
	type Memory,
	type ModelGateway,
	type Organisation,
	type Project,
	type ProjectAccess,
	type ProjectSettings,
	type PromptLayer,
	type PromptRules,
	type RecallRenderer,
	type Schedule,
	type Schedules,
	type SessionRecord,
	type SignInMethod,
	type Skills,
	type SystemContext,
	systemClock,
	systemContext,
	type UsageWriter,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@kantel/identity/jwt";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createMemoryPasskeyStores, createPasskeys, type Passkeys } from "@kantel/identity/passkey";
import { createSqlIdentity, createSqlPasskeyStores, migrateIdentity } from "@kantel/identity/sql";
import { defaultRecallRenderer } from "@kantel/memory";
import { createMemoryMemory } from "@kantel/memory/memory";
import { createSqlMemory, migrateMemory } from "@kantel/memory/sql";
import { createMemoryPromptRules } from "@kantel/rules/memory";
import { createSqlPromptRules, migrateRules } from "@kantel/rules/sql";
import type { DurableHosts, SessionRuntimeService } from "@kantel/runtime/core";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import {
	type DurableObjectTransaction,
	SessionRuntimeDurableObjectCore,
	type SqlStorageLike,
} from "@kantel/runtime-cloudflare";
import { CREATE_DOCUMENT_TOOL, createDocumentTool } from "@kantel/sandbox/documents";
import { createPresentFilesTool, PRESENT_FILES_TOOL } from "@kantel/sandbox/present-files";
import type { CheckExecutor } from "@kantel/schedules/handlers";
import { createMemorySchedules } from "@kantel/schedules/memory";
import { createSqlSchedules, migrateSchedules } from "@kantel/schedules/sql";
import type { SharingStore } from "@kantel/sharing";
import { createMemorySharing } from "@kantel/sharing/memory";
import { componentResolvers } from "@kantel/sharing/resolvers";
import { createSqlSharing, migrateSharing } from "@kantel/sharing/sql";
import { createMemorySkills } from "@kantel/skills/memory";
import { renderSkillListings } from "@kantel/skills/sources";
import { createMemoryObjectBucket, createSqlSkills, migrateSkills, type ObjectBucket } from "@kantel/skills/sql";
import type { SqlDriver } from "@kantel/sql";
import type { TunnelLinks } from "@kantel/tools/links";
import {
	createMemoryToolServerRepository,
	createSqlToolServerRepository,
	migrateToolServers,
} from "@kantel/tools/repository";
import { createToolServers, type ToolServersService } from "@kantel/tools/service";
import { sessionToolServers } from "@kantel/tools/session";
import type { ApprovalVault } from "@kantel/vault/approval-api";
import { createGitRefLister, type GitRefLister } from "@kantel/workspace/git-refs";
import { createGitHubTarballFetcher } from "@kantel/workspace/git-tarball";
import { createSkillsMountSource, sessionSkillVisibility } from "@kantel/workspace/mounts";
import { createSqlFileShares, migrateFileShares } from "@kantel/workspace/shares";
import {
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	type StoredWorkspaces,
	type WorkspaceStore,
} from "@kantel/workspace/stored";
import { type AttachmentStore, browserScreenshots, createAttachmentStore } from "./attachments.ts";
import { migrateObjectAuditOutbox, type OutboxedAudit, outboxedAudit } from "./audit-outbox.ts";
import { BOOTSTRAP_ORGANISATION, sqlBootstrapFinder } from "./bootstrap-sql.ts";
import { BROWSER_TOOL_NAMES, type BrowserGoalMode, createStackBrowser, type StackBrowser } from "./browser.ts";
import { CODEMODE_TOOL, type SessionCodemodeOptions, sessionCodemodeTool } from "./codemode.ts";
import { CODING_TOOLS, sessionCodingTools, sessionEnvironments, sessionWorkspaceId } from "./coding-tools.ts";
import type { GatewayConfig } from "./config.ts";
import type { SandboxContainers } from "./container-backend.ts";
import { createEchoModels } from "./echo-model.ts";
import { withKeyImports } from "./import-access.ts";
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
import { SUBAGENT_TOOL, sessionSubagentTool } from "./subagent.ts";
import { objectTunnelLinks, type TunnelObjectRpc } from "./tool-servers.ts";
import { objectUsage } from "./usage.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: BOOTSTRAP_ORGANISATION,
};

/** The agent every new deployment has, so a session can be created before any host registers its own profiles. */
export const DEFAULT_AGENT_ID = "assistant";

/**
 * The prompt layer earlier releases wrote into the default profile on every start. Kantel adds no prompt of its own:
 * the prompt is the user's (their profile's `promptLayers`), and empty until they set one. A stored default profile
 * still carrying this exact layer has it removed on the next start; nothing else of the user's is touched.
 */
/** The token refresh sweep (#328), run on the object's alarm. */
const REFRESH_SWEEP = systemContext("connections-sweep");

/** The connections component, reading a session's record for its connection tools. */
const CONNECTIONS_READER = { kind: "system", component: "connections" } as const;

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
	/** Files people attach to prompts (`attachments/<organisation>/<project>/<id>`, `src/attachments.ts`). */
	readonly attachmentObjects?: ObjectBucket;
	/** The session runtime's store, each session's Pi storage and the alarm that resumes them. */
	readonly sessions?: SessionObjectStorage;
	readonly workspaces?: WorkspaceStore;
	readonly bootstrap?: BootstrapStore;
	/**
	 * With `sql`: components' audit events queue in this driver (the object's own SQLite, `objectSqlDriver`) and drain to
	 * the store in the background, kept alive by `background` (`ctx.waitUntil`). Left out, they go straight to the store.
	 */
	readonly auditOutbox?: { readonly driver: SqlDriver; readonly background: (work: Promise<unknown>) => void };
	/**
	 * With `sql`: the model gateway's usage ledger, one row per model call, in this driver (the object's own SQLite),
	 * shipped to `usage_calls` in `sql` in the background (`src/usage.ts`). Left out, no usage rows are written.
	 */
	readonly usageLedger?: { readonly driver: SqlDriver; readonly background: (work: Promise<unknown>) => void };
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
	readonly models?: (deps: {
		readonly audit: AuditSink;
		readonly clock: Clock;
		/** The usage ledger's writer, with `storage.usageLedger`. */
		readonly usage?: UsageWriter;
	}) => StackModels;
	/** The isolate backend sessions run on. Default `in-process`. */
	readonly isolateBackend?: IsolateBackendName;
	/** Isolate backends beyond `in-process`, such as the Dynamic Worker one on Cloudflare. */
	readonly extraIsolateBackends?: ExtraIsolateBackends;
	/** The compiled QuickJS module: with it, `node` runs plain JavaScript in the in-process isolate (`src/sandboxes.ts`). */
	readonly nodeEngine?: NodeEngine;
	/** The sessions' container objects (`src/sandbox-object.ts`), when the deploy runs sandbox containers. */
	readonly sandboxContainers?: SandboxContainers;
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
	/**
	 * Offers the experimental `present_files` tool (`@kantel/sandbox/present-files`) to every session with a workspace:
	 * the files it presents show in the transcript as cards that open a viewer. With it comes `create_document`
	 * (`@kantel/sandbox/documents`), a document the person edits, presented the same way. Default off; the Worker turns
	 * them on unless KANTEL_PRESENT_FILES is `off`.
	 */
	readonly presentFiles?: boolean;
	/**
	 * Subagents (`src/subagent.ts`, experimental): with it the default profile has the `subagent` tool, offered to every
	 * session down to `MAX_SUBAGENT_DEPTH` levels of subagents, which hands a task to a child session of the same agent.
	 * Default off.
	 */
	readonly subagents?: boolean;
	/**
	 * Browser goal mode (`browser_run`, Reflex's goal loop; experimental): the platform's defaults, which each project's
	 * settings override (`IdentityDirectory.projectSettings`). A session of a project with goal mode on gets `browser_run`
	 * on its decision model, beside the other browser tools, when the browser provider has goal mode. Default off, Clef.
	 */
	readonly projectDefaults?: Required<ProjectSettings>;
	/** Runs check schedules' commands. Default the isolate tier (`src/schedule-checks.ts`). */
	readonly checks?: CheckExecutor;
	/**
	 * How the memory store renders recall, and so what fits its byte budgets (`src/recall-renderer.ts`). Default
	 * `defaultRecallRenderer`; a Sal deployment passes `salRecallRenderer()`.
	 */
	readonly recallRenderer?: RecallRenderer;
	/**
	 * Connections (epic #322): outside services and remote MCP servers people connect, with their tokens in the vault
	 * (`credentials`, the VaultDO over RPC). With it the gateway serves `/v1/connections/…` and every session has the
	 * connection tools (`@kantel/connections/tools`), which send from here, never from the sandbox.
	 */
	readonly connections?: StackConnections;
	/**
	 * Tool servers (docs/site/src/content/docs/api/tool-servers.md, experimental, `src/tool-servers.ts`): with it the
	 * registry is in `sql` (in memory without it), the gateway serves `/v1/tool-servers/…`, and a session's profile can
	 * name a server's tools. Without it there are no tables, no routes and no tools from servers.
	 */
	readonly toolServers?: StackToolServers;
}

export interface StackToolServers {
	/** The `KantelTunnel` object holding a server's tunnel, by the server's stored ID. */
	readonly tunnels: (toolServerId: string) => TunnelObjectRpc;
}

export interface StackConnections {
	readonly credentials: CredentialStore;
	/** Approvals bound to the exact request (#333): the VaultDO's, over RPC. A rule's `ask` waits on them. */
	readonly approvals?: ConnectionApprovals;
	readonly deployment: ConnectionsDeployment;
	readonly fetch?: Fetch;
	/** The organisation's ceiling, which bounds every connection rule: the VaultDO's. Absent: none. */
	readonly ceiling?: CeilingStore;
	/** Every session acting for a person is that person's alone (a deployment with one person). Default off. */
	readonly personal?: boolean;
}

export interface Stack {
	readonly identity: IdentityDirectory;
	readonly runtime: SessionRuntimeService;
	readonly workspaces: StoredWorkspaces;
	/** Lists a repository's branches for a new session's branch picker, over the same `fetch` seeds use. */
	readonly gitRefs: GitRefLister;
	/** The runtime's project access: who may do what in which project. */
	readonly access: ProjectAccess;
	/** Files people attach to prompts, which the runtime reads into the prompt's message (`src/attachments.ts`). */
	readonly attachments: AttachmentStore;
	/** The model gateway, for the console's connectors (`src/connectors.ts`); absent on the echo model. */
	readonly modelGateway?: () => Promise<ModelGateway>;
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
	/**
	 * Sharing resources across projects: shares, access requests, bindings and policies, read by `access` for every
	 * resource check.
	 */
	readonly sharing: SharingStore;
	/** Connections (epic #322), when the stack has them (`StackOptions.connections`). */
	readonly connections?: ConnectionsService;
	/** The tool servers registry, when the stack has them (`StackOptions.toolServers`). */
	readonly toolServers?: ToolServersService;
	/** Prompt rules, layered around a session's profile when it starts. */
	readonly rules: PromptRules;
	readonly authenticator: Authenticator;
	/** How people sign in here: Cloudflare Access when it is configured, else nobody does (API keys only). */
	readonly signIn: readonly SignInMethod[];
	/** What a project gets for each setting it didn't set: the platform's defaults (`StackOptions.projectDefaults`). */
	readonly projectDefaults: Required<ProjectSettings>;
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
	/** The shares of workspace files (a document, a PDF), with SQL storage only; absent in memory. */
	readonly shares?: FileShares;
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
		await migrateRules(driver);
		await migrateSchedules(driver);
		await migrateFileShares(driver);
		await migrateSharing(driver);
		if (options.connections !== undefined) await migrateConnections(driver);
		if (options.toolServers !== undefined) await migrateToolServers(driver);
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
		resource: (ctx, check) => lateAccess().resource(ctx, check),
		allowsResource: (ctx, check) => lateAccess().allowsResource(ctx, check),
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

	const usage =
		driver !== undefined && storage.usageLedger !== undefined
			? await objectUsage({
					ledger: storage.usageLedger.driver,
					store: driver,
					background: storage.usageLedger.background,
				})
			: undefined;
	const { gateway: modelGateway, ...models }: StackModels = options.models?.({
		audit,
		clock,
		...(usage === undefined ? {} : { usage: usage.writer }),
	}) ?? { models: createEchoModels() };
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
	const attachments = createAttachmentStore({
		objects: storage.attachmentObjects ?? createMemoryObjectBucket(),
		clock,
	});
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
					screenshots: browserScreenshots(attachments),
				});
	// Browser goal mode (`browser_run`): a session's project's settings over the platform's defaults, read as each
	// session's tools install, so a project's switch takes effect in its next sessions. Only with a provider that has it.
	const projectDefaults = options.projectDefaults ?? DEFAULT_PROJECT_SETTINGS;
	const goalModeFor = async (record: SessionRecord): Promise<{ run?: BrowserGoalMode }> => {
		if (options.browserProvider?.run === undefined) return {};
		let settings: ProjectSettings = {};
		if (record.projectId !== undefined) {
			settings = await identity
				.projectSettings(
					{ actor: { kind: "system", component: "cloudflare.browser" }, organisationId: record.organisationId },
					record.projectId,
				)
				.catch(() => ({}));
		}
		const on = (settings.browserGoalMode ?? projectDefaults.browserGoalMode) === "on";
		return on ? { run: { model: settings.browserDecisionModel ?? projectDefaults.browserDecisionModel } } : {};
	};
	// Skills and memory check project-owned records with the runtime's access (asked for per call, as the audit store
	// does), and audit into the one store. They are built before the runtime, which gives sessions what they hold: Kantel
	// adds no prompt of its own, so the listing is Pi's block of the skills a profile names, and recall is the memory
	// store's rendering (the stack's recall renderer, Kantel's default one unless it is given another), both placed by
	// the runtime before a session's first prompt. An API key with the `import` permission passes their
	// organisation-wide check for an import, and only for one (`./import-access.ts`), under the resource's sharing policy.
	const storeAccess = withKeyImports(auditAccess, identity, (ctx, organisationId, resource) =>
		sharing.policyOf(ctx, organisationId, resource),
	);
	const skillObjects = storage.skillObjects;
	const skills =
		driver === undefined || skillObjects === undefined
			? createMemorySkills({ clock, audit, access: storeAccess, mountRoot: SKILLS_MOUNT_ROOT })
			: createSqlSkills({
					driver,
					objects: skillObjects,
					clock,
					audit,
					access: storeAccess,
					mountRoot: SKILLS_MOUNT_ROOT,
				});
	// Shares across projects, read by the runtime's access for every resource check; their own checks are that access.
	// The vault lives in its own object here, so its items resolve there, not through this store (a follow-up).
	const sharingOptions = {
		clock,
		audit,
		access: lateAccess,
		resolvers: componentResolvers(() => ({
			skills,
			memory,
			...(builtWorkspaces === undefined ? {} : { workspaces: builtWorkspaces }),
		})),
	};
	const sharing =
		driver === undefined ? createMemorySharing(sharingOptions) : createSqlSharing({ driver, ...sharingOptions });
	// Connections: their records here (D1), their secrets in the vault. Their checks are the runtime's access. Each
	// connection's next refresh (#328) arms the object's alarm, once there is one; the alarm sweeps them.
	let armRefresh: ((at: number) => void) | undefined;
	const connections =
		options.connections === undefined
			? undefined
			: createConnections({
					repository:
						driver === undefined ? createMemoryConnectionsRepository() : createSqlConnectionsRepository(driver),
					credentials: options.connections.credentials,
					deployment: options.connections.deployment,
					access: lateAccess,
					audit,
					clock,
					...(options.connections.fetch === undefined ? {} : { fetch: options.connections.fetch }),
					...(options.connections.ceiling === undefined ? {} : { ceiling: options.connections.ceiling }),
					...(options.connections.approvals === undefined ? {} : { approvals: options.connections.approvals }),
					// Which connections a session may pick (#335): its record, read once the runtime exists.
					sessions: () => builtDirectory,
					// One stack object serves every request, so its in-process single flight covers them all; the lease (in
					// D1) is for an object restarted mid-refresh.
					refresh: { onDue: (at) => armRefresh?.(at) },
				});
	// Tool servers: their records here (D1), each tunnel in its own object. A server connecting or changing its tools
	// reaches the runtime's open sessions that name it, once there is a runtime.
	let changedTools: SessionRuntimeService["toolServerChanged"] | undefined;
	const toolServerOptions = options.toolServers;
	const toolServers: ToolServersService | undefined =
		toolServerOptions === undefined
			? undefined
			: createToolServers({
					repository: driver === undefined ? createMemoryToolServerRepository() : createSqlToolServerRepository(driver),
					access: lateAccess,
					audit,
					clock,
					links: () => tunnelLinks,
					onChange: (organisationId, server) => {
						changedTools?.(organisationId, server.name).catch((error: unknown) =>
							console.warn(`harbour: sessions naming tool server ${server.name} kept their tools`, error),
						);
					},
				});
	const tunnelLinks: TunnelLinks | undefined =
		toolServerOptions === undefined || toolServers === undefined
			? undefined
			: objectTunnelLinks({ tunnels: toolServerOptions.tunnels, lookup: (ref) => toolServers.lookup(ref) });
	const connectionToolsFor =
		connections === undefined
			? undefined
			: connectionTools({
					connections,
					...(options.connections?.personal === true ? { personal: true } : {}),
					// Who can see the session now, read on every call, so a change takes effect at once (#335).
					current: async (record) =>
						builtDirectory?.get({ actor: CONNECTIONS_READER, organisationId: record.organisationId }, record.id),
				});
	const renderer = options.recallRenderer ?? defaultRecallRenderer;
	const memory =
		driver === undefined
			? createMemoryMemory({ clock, audit, access: storeAccess, renderer })
			: createSqlMemory({ driver, clock, audit, access: storeAccess, renderer });
	const rules =
		driver === undefined
			? createMemoryPromptRules({ clock, audit, access: auditAccess })
			: createSqlPromptRules({ driver, clock, audit, access: auditAccess });
	// The `skills` mount source: `/skills` on a session's workspace shows the revisions the session pinned. A mount asked
	// for without a version pins the session's skills as its own project sees them, as the runtime does.
	let builtDirectory: SessionRuntimeService["directory"] | undefined;
	let builtProfiles: SessionRuntimeService["profiles"] | undefined;
	// The `subagent` tool creates and waits on sessions through the runtime, which is built after the tools are.
	let builtRuntime: SessionRuntimeService["runtime"] | undefined;
	const lateRuntime = (): SessionRuntimeService["runtime"] => {
		if (builtRuntime === undefined) throw new Error("the session runtime is not ready");
		return builtRuntime;
	};
	const skillsSource = createSkillsMountSource({
		skills,
		visibility: (ctx, sessionId) => {
			if (builtDirectory === undefined || builtProfiles === undefined) {
				throw new Error("the session directory is not ready");
			}
			return sessionSkillVisibility(builtDirectory, builtProfiles)(ctx, sessionId);
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
		sharing,
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
		// With `presentFiles`, a session on a workspace gets `present_files` and `create_document` for it too.
		tools: async (record: SessionRecord) => {
			const coding = codingToolsFor(record);
			const present =
				options.presentFiles === true && record.workspaceId !== undefined
					? [createPresentFilesTool(record.workspaceId), createDocumentTool(record.workspaceId)]
					: [];
			const linked = connectionToolsFor === undefined ? [] : connectionToolsFor(record);
			const tools =
				browser === undefined
					? [...coding, ...present, ...linked]
					: [...coding, ...present, ...browser.tools(record, await goalModeFor(record)), ...linked];
			const codemode = options.codemode;
			const withCodemode =
				codemode === undefined || tools.length === 0 ? tools : [...tools, sessionCodemodeTool(codemode, record)];
			// With subagents on, a session also gets `subagent` (`src/subagent.ts`), unless it is already as deep as subagents go.
			const subagent = options.subagents === true ? sessionSubagentTool(lateRuntime, record) : undefined;
			return subagent === undefined ? withCodemode : [...withCodemode, subagent];
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
		// Its prompt rules, fixed when it starts: platform, organisation, project, profile, then its user's.
		rules,
		// A prompt's attachments: what the model reads of each file uploaded to the session's project.
		attachments: attachments.reader,
		// A server's tools, for a session whose profile names them (`<server>/<tool>`, `<server>/*`).
		...(toolServers === undefined || tunnelLinks === undefined
			? {}
			: { toolServers: sessionToolServers({ service: toolServers, links: () => tunnelLinks }) }),
		// The transcript's tool images by reference, named by their SHA-256 and served from the session's own conversation
		// (`GET /v1/sessions/:id/images/:sha256`), so a snapshot carries no base64 (TASK-4223).
		toolImages: { hash: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex") },
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
		builtProfiles = runtime.profiles;
		builtRuntime = runtime.runtime;
		changedTools = (organisationId, serverName) => runtime.toolServerChanged(organisationId, serverName);
		// No browser outlives its session: closing or aborting one closes its browsers and ends its grants.
		if (browser !== undefined) runtime.sessionEnd.register("browser", browser.teardown);
		const gitFetch: typeof fetch = options.gitFetch ?? ((input, init) => fetch(input, init));
		// A git seed writes the last 50 commits, without blobs, as a shallow `.git` next to the tree, for the isolate's `git`
		// (src/sandboxes.ts), with the blobs of recent diffs. Best effort: a failed fetch seeds what it can (the tree alone,
		// or history without those blobs), and says why in the Worker's logs.
		const seeders = {
			git: createGitHubTarballFetcher({
				fetch: gitFetch,
				history: {
					onError: (error, source) =>
						console.warn(`harbour: the git history of ${source.repo}@${source.ref} was seeded only in part`, error),
				},
			}),
		};
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
			...(options.sandboxContainers === undefined ? {} : { containers: options.sandboxContainers }),
			// Placeholder-gated injection (#331): the isolate's curl reaches a connection's API with its placeholder.
			...(connections === undefined ? {} : { egress: connectionEgress({ connections }) }),
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
			if (isKantelError(error, "not_found")) return undefined;
			throw error;
		});
		// Organisation-wide, so it runs in every project and in organisation sessions; a project's own profile
		// still comes first there.
		const profile: AgentProfile = {
			id: DEFAULT_AGENT_ID,
			organisationId: organisation.id,
			name: "Assistant",
			model: { route: "default" },
			// The image model is the user's choice (the console's Models page), kept across starts: none until they pick one.
			...(stored?.imageModel === undefined ? {} : { imageModel: stored.imageModel }),
			// The prompt is the user's alone: what they set on this profile, kept across starts. Kantel adds none.
			promptLayers: userPromptLayers(stored),
			// The coding tools are offered in every session (each has a workspace, its own when it has no repository); the
			// browser's only when the stack has a provider; `codemode` when the stack has code mode. Tools describe themselves
			// through their schemas; Kantel adds no prompt about them.
			tools: [
				...CODING_TOOLS,
				...(options.presentFiles === true ? [PRESENT_FILES_TOOL, CREATE_DOCUMENT_TOOL] : []),
				...(browser === undefined ? [] : BROWSER_TOOL_NAMES),
				...(options.codemode === undefined ? [] : [CODEMODE_TOOL]),
				...(options.subagents === true ? [SUBAGENT_TOOL] : []),
				...(connections === undefined ? [] : CONNECTION_TOOL_NAMES),
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
		// Token refresh (#328): the alarm for the next connection due, now and whenever a refresh moves it.
		armRefresh = (at) => {
			void armAt(at).catch((error: unknown) =>
				console.error("harbour: arming the alarm for a token refresh failed", error),
			);
		};
		if (connections !== undefined) {
			await connections
				.nextRefreshAt(REFRESH_SWEEP)
				.then(armScheduler)
				.catch((error: unknown) => console.error("harbour: arming the token refresh at start failed", error));
		}

		return {
			identity,
			runtime,
			workspaces,
			gitRefs,
			access,
			attachments,
			...(modelGateway === undefined ? {} : { modelGateway }),
			sandboxes,
			environment,
			...(browser === undefined ? {} : { browser }),
			audit,
			skills,
			memory,
			sharing,
			...(connections === undefined ? {} : { connections }),
			...(toolServers === undefined ? {} : { toolServers }),
			rules,
			authenticator,
			signIn: options.config.access === undefined ? [] : ["cloudflare_access"],
			projectDefaults,
			passkeys,
			...(core === undefined ? {} : { hosts: runtime.hosts }),
			...(options.vault === undefined ? {} : { vault: options.vault }),
			schedules,
			...(driver === undefined ? {} : { shares: createSqlFileShares({ driver, workspaces, access, audit, clock }) }),
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
				// Then the tokens due for a refresh (#328), and the alarm for the next.
				if (connections !== undefined) {
					try {
						const swept = await connections.sweep(REFRESH_SWEEP);
						await armScheduler(swept.nextDueAt);
					} catch (error) {
						console.error("harbour: the token refresh sweep failed", error);
						await armAt(clock.now() + 60_000).catch(() => undefined);
					}
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
		const created = await identity.createOrganisation(BOOTSTRAP, { name: "Kantel", admin: { kind: "user", userId } });
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
