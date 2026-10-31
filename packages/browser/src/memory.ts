import {
	type AccessCheck,
	type Actor,
	type AgentId,
	type AuditEventInput,
	type AuditSink,
	BROWSER_DECISION_MODELS,
	type Browser,
	type BrowserAction,
	type BrowserContext,
	type BrowserGoal,
	type BrowserGrant,
	type BrowserPage,
	type BrowserProvider,
	type BrowserRequest,
	type BrowserSession,
	type BrowserShareLink,
	type CallContext,
	type Clock,
	type GrantBrowserInput,
	KantelError,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ProjectId,
	requireSystem,
	type SessionEndHook,
	type SessionEndReason,
	type SessionId,
	type SystemContext,
	systemClock,
	systemContext,
} from "@kantel/contracts";

/** The broker appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("browser");

import {
	assertValidAction,
	assertValidGoal,
	assertValidSite,
	browserTeardown,
	EMBED_MINUTES,
	isSupervisor,
	type ParentOf,
	pageAllowed,
	SHARE_MINUTES,
	siteAllowed,
	siteCovered,
} from "./index.ts";

export interface MemoryBrowserOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** The provider behind the broker. Default: a fresh `createFakeBrowserProvider()`. */
	readonly provider?: BrowserProvider;
	/** A session's parent session. Default: no session has a parent, so only humans and services can grant. */
	readonly parentOf?: ParentOf;
	/**
	 * Project access (settled question 7). Without it the broker checks only the organisation; every target and every
	 * conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/** When given, the broker registers `endSession` with it once, as `browser`. */
	readonly sessionEnd?: SessionEndHook;
}

/** One browser session the fake provider opened. */
export interface FakeProviderSession {
	readonly providerSessionId: string;
	readonly providerContextId: string;
	readonly persist: boolean;
}

export interface FakeBrowserProvider {
	readonly provider: BrowserProvider;
	/** Every session the provider opened, in order, released or not. */
	opened(): readonly FakeProviderSession[];
	/** Provider session IDs opened and not yet released. */
	live(): readonly string[];
	/** Makes the next `times` releases throw, leaving their sessions live. */
	failReleases(times: number): void;
	/** Makes the next `open` wait until the returned function is called. */
	holdNextOpen(): () => void;
	/** Makes the next `click` in any browser land on `url`, as a link would. */
	nextClickLandsOn(url: string): void;
	/** The URL each live browser is on, by provider session ID. */
	urls(): { readonly [providerSessionId: string]: string };
	/** How many share links the provider made. */
	shares(): number;
	/** Every goal run the provider was asked for, in order. */
	runs(): readonly { readonly providerSessionId: string; readonly goal: BrowserGoal; readonly model: string }[];
}

/**
 * A provider that opens nothing real. Its CDP URLs are `wss://browser.invalid/<providerSessionId>`; each browser starts
 * on `about:blank`, `goto` moves it, a `click` (or a goal run) lands where `nextClickLandsOn` said (or stays), and every
 * page has one element, `1`. A goal run opens its `url`, if it has one, and ends `done`.
 */
export function createFakeBrowserProvider(): FakeBrowserProvider {
	const opened: FakeProviderSession[] = [];
	const live = new Map<string, { url: string }>();
	let releasesToFail = 0;
	let hold: Promise<void> | undefined;
	let landing: string | undefined;
	let shares = 0;
	const runs: { providerSessionId: string; goal: BrowserGoal; model: string }[] = [];
	const liveSession = (providerSessionId: string) => {
		const browser = live.get(providerSessionId);
		if (browser === undefined) throw new KantelError("expired", `The fake browser ${providerSessionId} has ended`);
		return browser;
	};
	const pageAt = (url: string, action: BrowserAction): BrowserPage => ({
		url,
		title: `Fake page at ${url}`,
		text: `The fake page at ${url}.`,
		elements: [{ id: "1", describe: "link" }],
		succeeded: true,
		did: action.kind,
	});
	return {
		provider: {
			async open(input) {
				const held = hold;
				hold = undefined;
				if (held !== undefined) await held;
				const providerSessionId = `fake_${crypto.randomUUID()}`;
				opened.push({ providerSessionId, providerContextId: input.providerContextId, persist: input.persist });
				live.set(providerSessionId, { url: "about:blank" });
				return { providerSessionId, cdpUrl: `wss://browser.invalid/${providerSessionId}` };
			},
			async release(providerSessionId) {
				if (releasesToFail > 0) {
					releasesToFail -= 1;
					throw new Error(`The fake provider failed to release ${providerSessionId}`);
				}
				live.delete(providerSessionId);
			},
			async act(providerSessionId, action) {
				const browser = liveSession(providerSessionId);
				if (action.kind === "goto") browser.url = action.url;
				if (action.kind === "click" && landing !== undefined) {
					browser.url = landing;
					landing = undefined;
				}
				return pageAt(browser.url, action);
			},
			// A goal run: opens `url` if given, then lands where `landOn()` said (once) and reports the goal met.
			async run(providerSessionId, goal, options) {
				const browser = liveSession(providerSessionId);
				if (goal.url !== undefined) browser.url = goal.url;
				if (landing !== undefined) {
					browser.url = landing;
					landing = undefined;
				}
				runs.push({ providerSessionId, goal, model: options.model });
				return {
					status: "done",
					steps: [`goal: ${goal.goal}`],
					page: pageAt(browser.url, { kind: "look" }),
					usage: { decisions: 1, model: options.model, ms: 1 },
				};
			},
			async screenshot(providerSessionId) {
				const browser = liveSession(providerSessionId);
				return {
					url: browser.url,
					title: `Fake page at ${browser.url}`,
					mimeType: "image/png",
					data: btoa(`fake screenshot of ${browser.url}`),
				};
			},
			async share(providerSessionId, minutes, _signal, options) {
				liveSession(providerSessionId);
				shares += 1;
				const watch = options?.control === false ? "&watch=1" : "";
				return { url: `https://browser.invalid/share/${providerSessionId}?minutes=${minutes}${watch}` };
			},
		},
		opened: () => [...opened],
		live: () => [...live.keys()],
		urls: () => Object.fromEntries([...live].map(([id, browser]) => [id, browser.url])),
		shares: () => shares,
		runs: () => [...runs],
		nextClickLandsOn(url) {
			landing = url;
		},
		failReleases(times) {
			releasesToFail = times;
		},
		holdNextOpen() {
			let release!: () => void;
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

interface StoredContext {
	readonly organisationId: OrganisationId;
	readonly context: BrowserContext;
}

interface StoredGrant {
	grant: BrowserGrant;
}

interface StoredRequest {
	request: BrowserRequest;
}

interface StoredSession {
	session: BrowserSession;
	readonly providerSessionId: string;
	/** Absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
	readonly agentId: AgentId;
}

/** A provider session to release, with what its audit rows name. */
interface PendingRelease {
	readonly providerSessionId: string;
	readonly browserSessionId: string;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	/** Release attempts so far; each failed one is audited once. */
	attempts: number;
}

type EndReason = NonNullable<BrowserSession["endReason"]>;
type AgentActor = Extract<Actor, { readonly kind: "agent" }>;
/** Why `grant` refused, as audited in `browser.grant.refused`. */
type GrantRefusal = "own_session" | "not_supervisor" | "no_parent_grant" | "wider_than_parent";

const BROKER_ACTOR: Actor = { kind: "system", component: "browser" };

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new KantelError("forbidden", `An agent cannot ${what}`);
}

function requireAgent(ctx: CallContext, what: string): AgentActor {
	if (ctx.actor.kind !== "agent") throw new KantelError("forbidden", `Only an agent can ${what}`);
	return ctx.actor;
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new KantelError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function assertNonEmpty(value: string, label: string): void {
	if (value.trim().length === 0) throw new KantelError("invalid", `${label} cannot be empty`);
}

/** Whether a grant of `input` would be no wider than `parent`: persist, timeout and sites. */
function noWiderThan(parent: BrowserGrant, input: GrantBrowserInput): boolean {
	return (
		(!input.persist || parent.persist) &&
		input.timeoutMs <= parent.timeoutMs &&
		input.allowedSites.every((site) => siteCovered(parent.allowedSites, site))
	);
}

/**
 * The reference `Browser` broker: everything in maps. Provider context IDs stay in the context records, which only
 * humans and services can list; agents see grants and browser sessions, neither of which carries one.
 */
export function createMemoryBrowser(options: MemoryBrowserOptions = {}): Browser {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const provider = options.provider ?? createFakeBrowserProvider().provider;
	const parentOf: ParentOf = options.parentOf ?? (() => undefined);
	const access = options.access;

	const contexts = new Map<string, StoredContext>();
	const grants = new Map<string, StoredGrant>();
	const requests = new Map<string, StoredRequest>();
	const sessions = new Map<string, StoredSession>();
	/** `<organisationId> <contextId>` → the browser session holding the context's one persisting slot. */
	const persistingSlots = new Map<string, string>();
	/** Provider sessions whose release failed, by provider session ID; every sweep retries them. */
	const pendingReleases = new Map<string, PendingRelease>();

	const slotKey = (organisationId: OrganisationId, contextId: string) => `${organisationId} ${contextId}`;

	/** Resolves when the actor may make the call in the project (`forbidden` otherwise); without `access`, always. */
	async function requireAccess(ctx: CallContext, check: AccessCheck): Promise<void> {
		if (access !== undefined) await access.require(ctx, check);
	}

	/** Whether the actor may see a record of `check`'s project or session; without `access`, always. */
	async function mayView(ctx: CallContext, check: Pick<AccessCheck, "projectId" | "sessionId">): Promise<boolean> {
		return access === undefined || (await access.allows(ctx, { ...check, needed: "viewer" }));
	}

	/** The project and agent session a browser session belongs to, for its access checks. */
	function browserSessionScope(stored: StoredSession): Pick<AccessCheck, "projectId" | "sessionId" | "subject"> {
		return {
			projectId: stored.projectId,
			sessionId: stored.session.sessionId,
			subject: { kind: "browser.session", id: stored.session.id },
		};
	}

	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [{ ...event, at: clock.now(), source: "browser" }]);
	}

	/**
	 * A retry of the same call (same `requestId`) refused for the same session, operation and target keeps one row;
	 * calls without a `requestId` each get a row.
	 */
	function refusalId(ctx: CallContext, operation: string, sessionId: SessionId, target: string): string {
		return `browser:${operation}:refused:${sessionId}:${target}:${ctx.requestId ?? crypto.randomUUID()}`;
	}

	/**
	 * Releases a provider session. A failure never reaches the caller: it is audited once per attempt as
	 * `browser.session.release_failed` and the session waits in `pendingReleases` for the next sweep.
	 */
	async function release(pending: PendingRelease): Promise<void> {
		pending.attempts += 1;
		const attempt = pending.attempts;
		try {
			const released = await provider.release(pending.providerSessionId);
			const recording = released === undefined ? undefined : released.recording;
			if (recording !== undefined) {
				// Counts and retention only; the replay link is made per viewer and never audited. One per browser.
				await emit({
					id: `browser:session:${pending.browserSessionId}:recording_stored`,
					type: "browser.recording.stored",
					actor: BROKER_ACTOR,
					organisationId: pending.organisationId,
					projectId: pending.projectId,
					sessionId: pending.sessionId,
					agentId: pending.agentId,
					subject: { kind: "browser.session", id: pending.browserSessionId },
					data: { ...recording },
				}).catch(() => undefined);
			}
			return;
		} catch {
			pendingReleases.set(pending.providerSessionId, pending);
		}
		// Best effort: the session is still pending, so the next failed attempt is audited again.
		await emit({
			id: `browser:session:${pending.browserSessionId}:release_failed:${attempt}`,
			type: "browser.session.release_failed",
			actor: BROKER_ACTOR,
			organisationId: pending.organisationId,
			projectId: pending.projectId,
			sessionId: pending.sessionId,
			agentId: pending.agentId,
			subject: { kind: "browser.session", id: pending.browserSessionId },
			data: { attempt },
		}).catch(() => undefined);
	}

	function grantFields(grant: BrowserGrant): Pick<AuditEventInput, "projectId" | "sessionId" | "agentId"> {
		return { projectId: grant.projectId, sessionId: grant.sessionId, agentId: grant.agentId };
	}

	/**
	 * Closes a browser session now and returns the follow-up work (release at the provider, audit). Every state change
	 * happens here, synchronously, so callers can close many sessions before their first await.
	 */
	function closeSession(stored: StoredSession, endReason: EndReason, actor: Actor): () => Promise<void> {
		const session = stored.session;
		stored.session = { ...session, status: "closed", closedAt: clock.now(), endReason };
		const key = slotKey(session.organisationId, session.contextId);
		if (persistingSlots.get(key) === session.id) persistingSlots.delete(key);
		return async () => {
			await release({
				providerSessionId: stored.providerSessionId,
				browserSessionId: session.id,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				attempts: 0,
			});
			await emit({
				id: `browser:session:${session.id}:closed`,
				type: "browser.session.closed",
				actor,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				subject: { kind: "browser.session", id: session.id },
				data: { grantId: session.grantId, contextId: session.contextId, endReason },
			});
		};
	}

	/** Runs every step, each independently of the others' failures, then rethrows the first failure if any. */
	async function runAll(work: readonly (() => Promise<void>)[]): Promise<void> {
		const results = await Promise.allSettled(work.map((step) => step()));
		const failed = results.find((result) => result.status === "rejected");
		if (failed !== undefined) throw failed.reason;
	}

	/**
	 * Ends a grant as `revoked` or `ended` and, transitively, every active grant passed on from it, closing their open
	 * browser sessions. Every state change happens here, synchronously; the returned work releases and audits.
	 */
	function endGrant(
		stored: StoredGrant,
		status: "revoked" | "ended",
		endReason: EndReason,
		actor: Actor,
	): (() => Promise<void>)[] {
		stored.grant = { ...stored.grant, status };
		const ended = stored.grant;
		const work: (() => Promise<void>)[] = [];
		for (const session of sessions.values()) {
			if (session.session.grantId === ended.id && session.session.status === "open") {
				work.push(closeSession(session, endReason, actor));
			}
		}
		work.push(() =>
			emit({
				id: `browser:grant:${ended.id}:${status}`,
				type: `browser.grant.${status}`,
				actor,
				organisationId: ended.organisationId,
				...grantFields(ended),
				subject: { kind: "browser.grant", id: ended.id },
				...(ended.parentGrantId === undefined ? {} : { data: { parentGrantId: ended.parentGrantId } }),
			}),
		);
		for (const child of grants.values()) {
			if (child.grant.parentGrantId === ended.id && child.grant.status === "active") {
				work.push(...endGrant(child, status, endReason, actor));
			}
		}
		return work;
	}

	/**
	 * Retries failed provider releases and closes every open browser session past its `expiresAt` as `timeout`. Runs
	 * at the start of every call.
	 */
	async function sweep(): Promise<void> {
		const now = clock.now();
		const work: (() => Promise<void>)[] = [];
		for (const pending of pendingReleases.values()) work.push(() => release(pending));
		pendingReleases.clear();
		for (const stored of sessions.values()) {
			if (stored.session.status === "open" && now >= stored.session.expiresAt) {
				work.push(closeSession(stored, "timeout", BROKER_ACTOR));
			}
		}
		await runAll(work);
	}

	function grantFor(organisationId: OrganisationId, grantId: string): StoredGrant {
		const stored = grants.get(grantId);
		if (stored === undefined || stored.grant.organisationId !== organisationId) {
			throw new KantelError("not_found", `No browser grant ${grantId}`);
		}
		return stored;
	}

	/** An open browser session and its grant, or `expired` when the session is closed. */
	function openGrant(stored: StoredSession): BrowserGrant {
		if (stored.session.status !== "open") {
			throw new KantelError("expired", `Browser session ${stored.session.id} is closed`);
		}
		return grants.get(stored.session.grantId)!.grant;
	}

	/**
	 * Audits a page off the grant's sites as `browser.site.refused`, naming only the host (a URL may hold a token), and
	 * returns the `refused` error to throw.
	 */
	/** A URL's host only (a whole URL may hold a token), or `""`. */
	function hostOf(url: string): string {
		try {
			return new URL(url).hostname;
		} catch {
			return "";
		}
	}

	async function refuseSite(
		ctx: CallContext,
		stored: StoredSession,
		step: string,
		url: string,
		why: "asked" | "landed",
	): Promise<KantelError> {
		let host = "";
		try {
			host = new URL(url).hostname;
		} catch {
			host = "";
		}
		const session = stored.session;
		await emit({
			id: refusalId(ctx, "site", session.sessionId, `session:${session.id}:${step}`),
			type: "browser.site.refused",
			actor: ctx.actor,
			organisationId: session.organisationId,
			projectId: stored.projectId,
			sessionId: session.sessionId,
			agentId: stored.agentId,
			subject: { kind: "browser.session", id: session.id },
			data: { step, host, why },
		});
		return new KantelError(
			"refused",
			why === "asked"
				? `${host || url} is not one of this browser's sites`
				: `The page went to ${host || "a page"}, which is not one of this browser's sites, so the browser was sent back to a blank page`,
		);
	}

	/** A browser session the caller may see: any in its organisation for humans and services, its own for an agent. */
	function sessionFor(ctx: CallContext, browserSessionId: string): StoredSession {
		const stored = sessions.get(browserSessionId);
		if (
			stored === undefined ||
			stored.session.organisationId !== ctx.organisationId ||
			(ctx.actor.kind === "agent" && stored.session.sessionId !== ctx.actor.sessionId)
		) {
			throw new KantelError("not_found", `No browser session ${browserSessionId}`);
		}
		return stored;
	}

	const browser: Browser = {
		async putContext(ctx, input) {
			await sweep();
			forbidAgent(ctx, "create browser contexts");
			const owner = input.owner;
			if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
				throw new KantelError("invalid", "A browser context must be owned within the caller's organisation");
			}
			// A project's context needs operator on the project, an organisation's operator across the organisation.
			if (owner.kind === "project") {
				await requireAccess(ctx, { projectId: owner.projectId, needed: "operator", operation: "browser.putContext" });
			} else if (owner.kind === "organisation") {
				await requireAccess(ctx, { needed: "operator", operation: "browser.putContext" });
			}
			assertNonEmpty(input.name, "A context name");
			assertNonEmpty(input.providerContextId, "A provider context ID");
			const context: BrowserContext = {
				id: newId("bctx"),
				organisationId: ctx.organisationId,
				owner,
				name: input.name,
				providerContextId: input.providerContextId,
				createdAt: clock.now(),
			};
			contexts.set(context.id, { organisationId: ctx.organisationId, context });
			await emit({
				id: `browser:context:${context.id}:created`,
				type: "browser.context.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "browser.context", id: context.id },
				data: { name: context.name },
			});
			return context;
		},

		async listContexts(ctx, page) {
			await sweep();
			forbidAgent(ctx, "list browser contexts");
			const own = [...contexts.values()]
				.filter((stored) => stored.organisationId === ctx.organisationId)
				.map((stored) => stored.context);
			const visible: BrowserContext[] = [];
			for (const context of own) {
				const owner = context.owner;
				if (owner.kind !== "project" || (await mayView(ctx, { projectId: owner.projectId }))) visible.push(context);
			}
			return paginate(visible, page);
		},

		async request(ctx, input) {
			await sweep();
			const actor = requireAgent(ctx, "ask for a browser");
			await requireAccess(ctx, { sessionId: actor.sessionId, needed: "operator", operation: "browser.request" });
			assertNonEmpty(input.reason, "A browser request's reason");
			for (const site of input.sites) assertValidSite(site);
			const request: BrowserRequest = {
				id: newId("breq"),
				organisationId: ctx.organisationId,
				sessionId: actor.sessionId,
				agentId: actor.agentId,
				reason: input.reason,
				sites: [...input.sites],
				status: "pending",
				createdAt: clock.now(),
			};
			requests.set(request.id, { request });
			await emit({
				id: `browser:request:${request.id}:created`,
				type: "browser.request.created",
				actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				sessionId: actor.sessionId,
				agentId: actor.agentId,
				subject: { kind: "browser.request", id: request.id },
				data: { reason: request.reason, sites: [...request.sites] },
			});
			return request;
		},

		async grant(ctx, input) {
			await sweep();
			const refuse = async (reason: GrantRefusal, message: string): Promise<never> => {
				await emit({
					id: refusalId(ctx, "grant", input.sessionId, `context:${input.contextId}`),
					type: "browser.grant.refused",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					projectId: input.projectId,
					sessionId: input.sessionId,
					agentId: input.agentId,
					data: { contextId: input.contextId, reason },
				});
				throw new KantelError("refused", message);
			};
			// A project's grant is checked on the project; an organisation session's on the organisation.
			const onProject = (projectId: ProjectId | undefined): AccessCheck => ({
				...(projectId === undefined ? {} : { projectId }),
				needed: "operator",
				operation: "browser.grant",
				subject: { kind: "browser.context", id: input.contextId },
			});
			// An agent is checked on the project first, so an agent of another project is `forbidden` while one in the
			// project that does not supervise the session still gets the supervisor rule's `refused`.
			if (ctx.actor.kind === "agent") await requireAccess(ctx, onProject(input.projectId));
			if (!isSupervisor(ctx.actor, input.sessionId, parentOf)) {
				return refuse(
					ctx.actor.kind === "agent" && ctx.actor.sessionId === input.sessionId ? "own_session" : "not_supervisor",
					"Only a supervisor can choose a browser context for a session",
				);
			}
			const context = contexts.get(input.contextId);
			if (context === undefined || context.organisationId !== ctx.organisationId) {
				throw new KantelError("not_found", `No browser context ${input.contextId}`);
			}
			await requireAccess(ctx, { ...onProject(input.projectId), sessionId: input.sessionId });
			const owner = context.context.owner;
			if (owner.kind === "project") await requireAccess(ctx, onProject(owner.projectId));
			assertNonEmpty(input.sessionId, "A session ID");
			if (input.projectId !== undefined) assertNonEmpty(input.projectId, "A project ID");
			assertNonEmpty(input.agentId, "An agent ID");
			if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
				throw new KantelError("invalid", "timeoutMs must be a positive integer");
			}
			if (input.allowedSites.length === 0) throw new KantelError("invalid", "A grant needs at least one site");
			for (const site of input.allowedSites) assertValidSite(site);
			// An agent supervisor passes on, no wider, a context it holds through an active grant of its own.
			let parentGrant: BrowserGrant | undefined;
			if (ctx.actor.kind === "agent") {
				const holder = ctx.actor;
				const held = [...grants.values()]
					.map((stored) => stored.grant)
					.filter(
						(grant) =>
							grant.organisationId === ctx.organisationId &&
							grant.sessionId === holder.sessionId &&
							grant.agentId === holder.agentId &&
							grant.contextId === input.contextId &&
							grant.status === "active",
					);
				if (held.length === 0) {
					return refuse("no_parent_grant", "An agent can only pass on a browser context it holds");
				}
				parentGrant = held.find((grant) => noWiderThan(grant, input));
				if (parentGrant === undefined) {
					return refuse("wider_than_parent", "An agent cannot pass on a browser grant wider than its own");
				}
			}
			let answered: StoredRequest | undefined;
			if (input.requestId !== undefined) {
				answered = requests.get(input.requestId);
				if (answered === undefined || answered.request.organisationId !== ctx.organisationId) {
					throw new KantelError("not_found", `No browser request ${input.requestId}`);
				}
				if (answered.request.sessionId !== input.sessionId || answered.request.agentId !== input.agentId) {
					throw new KantelError("invalid", "The request was made by another session or agent");
				}
				if (answered.request.status !== "pending") {
					throw new KantelError(
						"conflict",
						`Browser request ${input.requestId} is already ${answered.request.status}`,
					);
				}
			}
			const grant: BrowserGrant = {
				id: newId("bgrant"),
				organisationId: ctx.organisationId,
				projectId: input.projectId,
				sessionId: input.sessionId,
				agentId: input.agentId,
				contextId: input.contextId,
				persist: input.persist,
				timeoutMs: input.timeoutMs,
				allowedSites: [...input.allowedSites],
				grantedBy: ctx.actor,
				createdAt: clock.now(),
				status: "active",
				...(input.requestId === undefined ? {} : { requestId: input.requestId }),
				...(parentGrant === undefined ? {} : { parentGrantId: parentGrant.id }),
			};
			grants.set(grant.id, { grant });
			if (answered !== undefined) answered.request = { ...answered.request, status: "granted" };
			await emit({
				id: `browser:grant:${grant.id}:created`,
				type: "browser.grant.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...grantFields(grant),
				subject: { kind: "browser.grant", id: grant.id },
				data: {
					contextId: grant.contextId,
					persist: grant.persist,
					timeoutMs: grant.timeoutMs,
					allowedSites: [...grant.allowedSites],
					...(grant.requestId === undefined ? {} : { requestId: grant.requestId }),
					...(grant.parentGrantId === undefined ? {} : { parentGrantId: grant.parentGrantId }),
				},
			});
			if (answered !== undefined) {
				await emit({
					id: `browser:request:${answered.request.id}:granted`,
					type: "browser.request.granted",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...grantFields(grant),
					subject: { kind: "browser.request", id: answered.request.id },
					data: { grantId: grant.id },
				});
			}
			return grant;
		},

		async revokeGrant(ctx, grantId) {
			await sweep();
			const stored = grantFor(ctx.organisationId, grantId);
			await requireAccess(ctx, {
				projectId: stored.grant.projectId,
				sessionId: stored.grant.sessionId,
				needed: "operator",
				operation: "browser.revokeGrant",
				subject: { kind: "browser.grant", id: stored.grant.id },
			});
			if (!isSupervisor(ctx.actor, stored.grant.sessionId, parentOf)) {
				throw new KantelError("forbidden", "Only a supervisor can revoke a browser grant");
			}
			if (stored.grant.status !== "active") return stored.grant;
			const work = endGrant(stored, "revoked", "revoked", ctx.actor);
			const revoked = stored.grant;
			await runAll(work);
			return revoked;
		},

		async listGrants(ctx, filter) {
			await sweep();
			const sessionId = ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined;
			// An agent lists only its own session's grants, so naming another session finds none.
			if (sessionId !== undefined && filter.sessionId !== undefined && filter.sessionId !== sessionId) return [];
			if (filter.sessionId !== undefined) {
				await requireAccess(ctx, { sessionId: filter.sessionId, needed: "viewer", operation: "browser.listGrants" });
			}
			const listed: BrowserGrant[] = [];
			for (const { grant } of [...grants.values()]) {
				if (
					grant.organisationId === ctx.organisationId &&
					(sessionId === undefined || grant.sessionId === sessionId) &&
					(filter.sessionId === undefined || grant.sessionId === filter.sessionId) &&
					(filter.sessionId !== undefined ||
						(await mayView(ctx, { projectId: grant.projectId, sessionId: grant.sessionId })))
				) {
					listed.push(grant);
				}
			}
			return listed;
		},

		async open(ctx, input) {
			await sweep();
			const actor = requireAgent(ctx, "open a browser");
			const stored = grants.get(input.grantId);
			if (
				stored === undefined ||
				stored.grant.organisationId !== ctx.organisationId ||
				stored.grant.sessionId !== actor.sessionId ||
				stored.grant.agentId !== actor.agentId
			) {
				throw new KantelError("not_found", `No browser grant ${input.grantId}`);
			}
			await requireAccess(ctx, {
				projectId: stored.grant.projectId,
				sessionId: stored.grant.sessionId,
				needed: "operator",
				operation: "browser.open",
				subject: { kind: "browser.grant", id: stored.grant.id },
			});
			const grant = stored.grant;
			if (grant.status !== "active") throw new KantelError("expired", `Browser grant ${grant.id} is ${grant.status}`);
			if (input.contextId !== undefined && input.contextId !== grant.contextId) {
				await emit({
					id: refusalId(ctx, "session", actor.sessionId, `grant:${grant.id}`),
					type: "browser.session.refused",
					actor,
					organisationId: ctx.organisationId,
					...grantFields(grant),
					subject: { kind: "browser.grant", id: grant.id },
					data: { askedContextId: input.contextId, reason: "The grant does not hold this context" },
				});
				throw new KantelError("refused", "An agent cannot choose a browser context its grant does not hold");
			}
			const context = contexts.get(grant.contextId)!.context;
			const key = slotKey(grant.organisationId, grant.contextId);
			const id = newId("bsession");
			if (grant.persist) {
				if (persistingSlots.has(key)) {
					throw new KantelError("conflict", "A persisting browser session is already open on this context");
				}
				persistingSlots.set(key, id);
			}
			const freeSlot = () => {
				if (persistingSlots.get(key) === id) persistingSlots.delete(key);
			};
			let opened: { readonly providerSessionId: string; readonly cdpUrl: string };
			try {
				opened = await provider.open({
					providerContextId: context.providerContextId,
					persist: grant.persist,
					timeoutMs: grant.timeoutMs,
					allowedSites: grant.allowedSites,
				});
			} catch (error) {
				freeSlot();
				throw error;
			}
			// The grant may have been revoked or ended while the provider was opening.
			const current = stored.grant;
			if (current.status !== "active") {
				freeSlot();
				await release({
					providerSessionId: opened.providerSessionId,
					browserSessionId: id,
					organisationId: grant.organisationId,
					projectId: grant.projectId,
					sessionId: grant.sessionId,
					agentId: grant.agentId,
					attempts: 0,
				});
				throw new KantelError("expired", `Browser grant ${grant.id} is ${current.status}`);
			}
			const openedAt = clock.now();
			const session: BrowserSession = {
				id,
				organisationId: grant.organisationId,
				grantId: grant.id,
				sessionId: grant.sessionId,
				contextId: grant.contextId,
				persisting: grant.persist,
				cdpUrl: opened.cdpUrl,
				status: "open",
				openedAt,
				expiresAt: openedAt + grant.timeoutMs,
			};
			sessions.set(id, {
				session,
				providerSessionId: opened.providerSessionId,
				projectId: grant.projectId,
				agentId: grant.agentId,
			});
			await emit({
				id: `browser:session:${id}:opened`,
				type: "browser.session.opened",
				actor,
				organisationId: grant.organisationId,
				...grantFields(grant),
				subject: { kind: "browser.session", id },
				data: {
					grantId: grant.id,
					contextId: grant.contextId,
					persisting: grant.persist,
					expiresAt: session.expiresAt,
				},
			});
			return session;
		},

		async checkSite(ctx, browserSessionId, url) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "viewer", operation: "browser.checkSite" });
			if (stored.session.status !== "open") return { allow: false };
			const grant = grants.get(stored.session.grantId)!.grant;
			return { allow: siteAllowed(grant.allowedSites, url) };
		},

		async close(ctx, browserSessionId) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "operator", operation: "browser.close" });
			if (stored.session.status === "closed") return stored.session;
			const finish = closeSession(stored, "closed", ctx.actor);
			const closed = stored.session;
			await finish();
			return closed;
		},

		async act(ctx, browserSessionId, action) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "operator", operation: "browser.act" });
			const grant = openGrant(stored);
			assertValidAction(action);
			if (action.kind === "goto" && !siteAllowed(grant.allowedSites, action.url)) {
				throw await refuseSite(ctx, stored, action.kind, action.url, "asked");
			}
			const page = await provider.act(stored.providerSessionId, action, ctx.signal);
			if (!pageAllowed(grant.allowedSites, page.url)) {
				// Never hand back a page off the grant: blank the browser first. A blank that fails still refuses.
				await provider
					.act(stored.providerSessionId, { kind: "goto", url: "about:blank" }, ctx.signal)
					.catch(() => undefined);
				throw await refuseSite(ctx, stored, action.kind, page.url, "landed");
			}
			// Every step that may move or change the page, by its verb and the host it ended on: never a value typed or a whole
			// URL (either may hold a secret). A look changes nothing and isn't audited.
			if (action.kind !== "look") {
				const session = stored.session;
				await emit({
					id: `browser:session:${session.id}:step:${ctx.requestId ?? crypto.randomUUID()}`,
					type: "browser.session.step",
					actor: ctx.actor,
					organisationId: session.organisationId,
					projectId: stored.projectId,
					sessionId: session.sessionId,
					agentId: stored.agentId,
					subject: { kind: "browser.session", id: session.id },
					data: { step: action.kind, host: hostOf(page.url), succeeded: page.succeeded },
				});
			}
			return page;
		},

		async run(ctx, browserSessionId, goal, options) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "operator", operation: "browser.run" });
			const grant = openGrant(stored);
			assertValidGoal(goal);
			if (!(BROWSER_DECISION_MODELS as readonly unknown[]).includes(options.model)) {
				throw new KantelError("invalid", `A goal run's model is ${BROWSER_DECISION_MODELS.join(" or ")}`);
			}
			if (provider.run === undefined) {
				throw new KantelError("unavailable", "This deployment's browsers have no goal mode; use browser_act");
			}
			if (goal.url !== undefined && !siteAllowed(grant.allowedSites, goal.url)) {
				throw await refuseSite(ctx, stored, "run", goal.url, "asked");
			}
			const result = await provider.run(stored.providerSessionId, goal, { model: options.model }, ctx.signal);
			if (!pageAllowed(grant.allowedSites, result.page.url)) {
				// As `act`: never hand back a page off the grant. A blank that fails still refuses.
				await provider
					.act(stored.providerSessionId, { kind: "goto", url: "about:blank" }, ctx.signal)
					.catch(() => undefined);
				throw await refuseSite(ctx, stored, "run", result.page.url, "landed");
			}
			// The run as one event, by how it ended, its steps and the host it ended on: never the goal or its data.
			const session = stored.session;
			await emit({
				id: `browser:session:${session.id}:run:${ctx.requestId ?? crypto.randomUUID()}`,
				type: "browser.session.run",
				actor: ctx.actor,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				subject: { kind: "browser.session", id: session.id },
				data: {
					status: result.status,
					steps: result.steps.length,
					decisions: result.usage.decisions,
					model: options.model,
					host: hostOf(result.page.url),
				},
			});
			return result;
		},

		async screenshot(ctx, browserSessionId) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "operator", operation: "browser.screenshot" });
			const grant = openGrant(stored);
			const shot = await provider.screenshot(stored.providerSessionId, ctx.signal);
			if (!pageAllowed(grant.allowedSites, shot.url)) {
				throw await refuseSite(ctx, stored, "screenshot", shot.url, "landed");
			}
			return shot;
		},

		async share(ctx, browserSessionId, input) {
			await sweep();
			forbidAgent(ctx, "make a browser share link");
			const stored = sessionFor(ctx, browserSessionId);
			// A watch-only link shows what a viewer of the session may already see, live; control needs an operator.
			const watch = input?.watch === true;
			await requireAccess(ctx, {
				...browserSessionScope(stored),
				needed: watch ? "viewer" : "operator",
				operation: "browser.share",
			});
			const minutes = input?.minutes ?? SHARE_MINUTES[0];
			if (!(SHARE_MINUTES as readonly number[]).includes(minutes)) {
				throw new KantelError("invalid", `A share link lasts ${SHARE_MINUTES.join(" or ")} minutes`);
			}
			openGrant(stored);
			const link = await provider.share(stored.providerSessionId, minutes, ctx.signal, { control: !watch });
			const session = stored.session;
			await emit({
				id: `browser:session:${session.id}:shared:${ctx.requestId ?? crypto.randomUUID()}`,
				type: "browser.session.shared",
				actor: ctx.actor,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				subject: { kind: "browser.session", id: session.id },
				data: watch ? { minutes, watch } : { minutes },
			});
			return link;
		},

		async replay(ctx, browserSessionId, input) {
			await sweep();
			forbidAgent(ctx, "make a browser replay link");
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "viewer", operation: "browser.replay" });
			const minutes = input?.minutes ?? SHARE_MINUTES[0];
			if (!(SHARE_MINUTES as readonly number[]).includes(minutes)) {
				throw new KantelError("invalid", `A replay link lasts ${SHARE_MINUTES.join(" or ")} minutes`);
			}
			if (provider.replay === undefined) {
				throw new KantelError("unavailable", "This deployment's browser provider keeps no recordings");
			}
			const link = await provider.replay(stored.providerSessionId, minutes, ctx.signal);
			const session = stored.session;
			await emit({
				id: `browser:session:${session.id}:replayed:${ctx.requestId ?? crypto.randomUUID()}`,
				type: "browser.session.shared",
				actor: ctx.actor,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				subject: { kind: "browser.session", id: session.id },
				data: { minutes, replay: true },
			});
			return link;
		},

		async embed(ctx, browserSessionId, input) {
			await sweep();
			forbidAgent(ctx, "make a browser embed link");
			const mode = input?.mode;
			if (mode !== "live" && mode !== "replay") throw new KantelError("invalid", "An embed is live or replay");
			const minutes = input.minutes ?? EMBED_MINUTES.default;
			if (!Number.isInteger(minutes) || minutes < EMBED_MINUTES.min || minutes > EMBED_MINUTES.max) {
				throw new KantelError(
					"invalid",
					`An embed link lasts ${EMBED_MINUTES.min} to ${EMBED_MINUTES.max} whole minutes`,
				);
			}
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "viewer", operation: "browser.embed" });
			let link: BrowserShareLink;
			if (mode === "live") {
				openGrant(stored);
				// Watch-only: an outside app's viewer never drives the browser.
				link = await provider.share(stored.providerSessionId, minutes, ctx.signal, { control: false });
			} else {
				if (provider.replay === undefined) {
					throw new KantelError("unavailable", "This deployment's browser provider keeps no recordings");
				}
				link = await provider.replay(stored.providerSessionId, minutes, ctx.signal);
			}
			const session = stored.session;
			await emit({
				id: `browser:session:${session.id}:embedded:${ctx.requestId ?? crypto.randomUUID()}`,
				type: "browser.session.embedded",
				actor: ctx.actor,
				organisationId: session.organisationId,
				projectId: stored.projectId,
				sessionId: session.sessionId,
				agentId: stored.agentId,
				subject: { kind: "browser.session", id: session.id },
				data: { mode, minutes },
			});
			return link;
		},

		async endSession(ctx: SystemContext, sessionId: SessionId, reason: SessionEndReason) {
			await requireSystem(ctx, "browser.endSession", { ...(audit === undefined ? {} : { audit }), clock });
			// A failing sweep (its audit, say) must not keep this session's browsers and grants alive: end them first,
			// then report the sweep's failure.
			let sweepFailure: { readonly error: unknown } | undefined;
			try {
				await sweep();
			} catch (error) {
				sweepFailure = { error };
			}
			const work: (() => Promise<void>)[] = [];
			for (const stored of sessions.values()) {
				if (stored.session.sessionId === sessionId && stored.session.status === "open") {
					work.push(closeSession(stored, reason, BROKER_ACTOR));
				}
			}
			for (const stored of grants.values()) {
				if (stored.grant.sessionId === sessionId && stored.grant.status === "active") {
					work.push(...endGrant(stored, "ended", reason, BROKER_ACTOR));
				}
			}
			// An aborted session stays usable, so its pending requests can still be answered.
			if (reason === "session_ended") {
				for (const stored of requests.values()) {
					if (stored.request.sessionId === sessionId && stored.request.status === "pending") {
						stored.request = { ...stored.request, status: "declined" };
					}
				}
			}
			await runAll(work);
			if (sweepFailure !== undefined) throw sweepFailure.error;
		},

		async get(ctx, browserSessionId) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			await requireAccess(ctx, { ...browserSessionScope(stored), needed: "viewer", operation: "browser.get" });
			return stored.session;
		},
	};
	if (options.sessionEnd !== undefined) {
		// The hook's context is a system one, which `endSession` requires.
		options.sessionEnd.register("browser", browserTeardown(browser));
	}
	return browser;
}
