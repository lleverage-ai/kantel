/**
 * The stack the Cloudflare gateway serves: the identity directory and the audit store, behind one authenticator.
 *
 * Kantel is a compute plane now. The agent plane this stack used to host (sessions, workspaces, models, connections,
 * rules and approvals, the vault, skills, memory, schedules, sharing, tool servers and browsers) was removed; it is
 * kept in git history on the `agent-plane-archive` branch and the `agent-plane-archive-2026-11-03` tag (`e496aeb2`).
 * Its tables in D1, its objects in R2 and its Durable Objects' storage are left as they are and never read.
 *
 * Each part is durable when its storage is given (`StackStorage`), and in memory otherwise:
 *
 * - `sql`: the identity directory and the audit store (D1 on Cloudflare);
 * - `auditOutbox`: where audit events queue before a background drain takes them to that store (the stack object's own
 *   SQLite, `src/audit-outbox.ts`), so no request waits on an audit write;
 * - `bootstrap`: which organisation, project and admin this deployment made, so a restart finds them, not new ones.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite`, and `KantelStack` hosts it in one
 * Durable Object over the real bindings.
 */
import { createMemoryAuditStore } from "@kantel/audit/memory";
import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import {
	type AuditStore,
	type Authenticator,
	type CallContext,
	type Clock,
	createProjectAccess,
	type IdentityDirectory,
	KantelError,
	type Organisation,
	type Project,
	type ProjectAccess,
	type SignInMethod,
	systemClock,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@kantel/identity/jwt";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createSqlIdentity, migrateIdentity } from "@kantel/identity/sql";
import type { SqlDriver } from "@kantel/sql";
import { migrateObjectAuditOutbox, type OutboxedAudit, outboxedAudit } from "./audit-outbox.ts";
import { BOOTSTRAP_ORGANISATION, sqlBootstrapFinder } from "./bootstrap-sql.ts";
import type { GatewayConfig } from "./config.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: BOOTSTRAP_ORGANISATION,
};

/** A sign-in this slow is logged: a new isolate's first one fetches what later ones have cached. */
const SLOW_SIGN_IN_MS = 150;

/** `authenticator`, logging each sign-in that takes `SLOW_SIGN_IN_MS` or longer, with the path it was for. */
function timedSignIn(authenticator: Authenticator): Authenticator {
	return {
		async authenticate(request) {
			const started = performance.now();
			try {
				return await authenticator.authenticate(request);
			} finally {
				const ms = Math.round(performance.now() - started);
				if (ms >= SLOW_SIGN_IN_MS) {
					const path = "url" in request && typeof request.url === "string" ? new URL(request.url).pathname : "";
					console.log(`kantel: sign-in took ${ms} ms`, path);
				}
			}
		},
	};
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

/** Durable storage for the stack's parts. Each one left out is in memory, and gone when the stack is. */
export interface StackStorage {
	/** The identity directory and the audit store. Their migrations run on every start; each is idempotent. */
	readonly sql?: SqlDriver;
	readonly bootstrap?: BootstrapStore;
	/**
	 * With `sql`: audit events queue in this driver (the object's own SQLite, `objectSqlDriver`) and drain to the store in
	 * the background, kept alive by `background` (`ctx.waitUntil`). Left out, they go straight to the store.
	 */
	readonly auditOutbox?: { readonly driver: SqlDriver; readonly background: (work: Promise<unknown>) => void };
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
	/** Who may do what in which project: the directory's roles. There are no sessions to check. */
	readonly access: ProjectAccess;
	readonly audit: AuditStore;
	readonly authenticator: Authenticator;
	/** How people sign in here: Cloudflare Access when it is configured, else nobody does (API keys only). */
	readonly signIn: readonly SignInMethod[];
	readonly organisation: Organisation;
	readonly project: Project;
	/** The organisation's first admin: the invited person, or a placeholder no one can sign in as. */
	readonly admin: CallContext;
	/** How long each part of the start took, in ms, for the object's start log. */
	readonly startedIn: Readonly<Record<string, number>>;
}

/** Builds the stack and bootstraps one organisation with one project and its first admin (invited by email). */
export async function createStack(options: StackOptions): Promise<Stack> {
	const clock = options.clock ?? systemClock;
	const storage = options.storage ?? {};
	const driver = storage.sql;
	const startedIn: Record<string, number> = {};
	let phaseStart = performance.now();
	const phase = (name: string) => {
		const now = performance.now();
		startedIn[name] = Math.round(now - phaseStart);
		phaseStart = now;
	};
	if (driver !== undefined) {
		await migrateIdentity(driver);
		await migrateAudit(driver);
	}
	phase("migrations");

	// The audit store's access check (for reads) is built from the directory, which audits into the store: each asks for
	// the other once both are built, and nothing serves requests until then.
	let builtAccess: ProjectAccess | undefined;
	const lateAccess = (): ProjectAccess => {
		if (builtAccess === undefined) throw new Error("project access is not ready");
		return builtAccess;
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
	builtAccess = createProjectAccess({
		identity,
		sessions: {
			get: async () => {
				throw new KantelError("not_found", "This deployment has no sessions");
			},
		},
		audit,
		clock,
	});

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
	const authenticator = timedSignIn(createAuthenticator({ identity, providers }));
	phase("identity and audit");

	const { organisation, project, admin } = await bootstrap({
		identity,
		store: storage.bootstrap ?? createMemoryBootstrapStore(),
		...(driver === undefined ? {} : { finder: sqlBootstrapFinder(driver) }),
		adminEmail: options.config.adminEmail,
		adminName: options.config.adminName,
	});
	phase("bootstrap");

	return {
		identity,
		access: builtAccess,
		audit,
		authenticator,
		signIn: options.config.access === undefined ? [] : ["cloudflare_access"],
		organisation,
		project,
		admin,
		startedIn,
	};
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
		console.warn("kantel: the saved bootstrap names an organisation identity no longer has; bootstrapping again");
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
