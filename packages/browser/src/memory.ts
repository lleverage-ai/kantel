import {
	type Actor,
	type AgentId,
	type AuditEventInput,
	type AuditSink,
	type Browser,
	type BrowserContext,
	type BrowserGrant,
	type BrowserProvider,
	type BrowserRequest,
	type BrowserSession,
	type CallContext,
	type Clock,
	HarbourError,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectId,
	type SessionId,
	systemClock,
} from "@harbour/contracts";
import { assertValidSite, isSupervisor, type ParentOf, siteAllowed } from "./index.ts";

export interface MemoryBrowserOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** The provider behind the broker. Default: a fresh `createFakeBrowserProvider()`. */
	readonly provider?: BrowserProvider;
	/** A session's parent session. Default: no session has a parent, so only humans and services can grant. */
	readonly parentOf?: ParentOf;
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
}

/** A provider that opens nothing real. Its CDP URLs are `wss://browser.invalid/<providerSessionId>`. */
export function createFakeBrowserProvider(): FakeBrowserProvider {
	const opened: FakeProviderSession[] = [];
	const live = new Set<string>();
	return {
		provider: {
			async open(input) {
				const providerSessionId = `fake_${crypto.randomUUID()}`;
				opened.push({ providerSessionId, providerContextId: input.providerContextId, persist: input.persist });
				live.add(providerSessionId);
				return { providerSessionId, cdpUrl: `wss://browser.invalid/${providerSessionId}` };
			},
			async release(providerSessionId) {
				live.delete(providerSessionId);
			},
		},
		opened: () => [...opened],
		live: () => [...live],
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
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
}

type EndReason = NonNullable<BrowserSession["endReason"]>;
type AgentActor = Extract<Actor, { readonly kind: "agent" }>;

const BROKER_ACTOR: Actor = { kind: "system", component: "browser" };

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function requireAgent(ctx: CallContext, what: string): AgentActor {
	if (ctx.actor.kind !== "agent") throw new HarbourError("forbidden", `Only an agent can ${what}`);
	return ctx.actor;
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function assertNonEmpty(value: string, label: string): void {
	if (value.trim().length === 0) throw new HarbourError("invalid", `${label} cannot be empty`);
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

	const contexts = new Map<string, StoredContext>();
	const grants = new Map<string, StoredGrant>();
	const requests = new Map<string, StoredRequest>();
	const sessions = new Map<string, StoredSession>();
	/** `<organisationId> <contextId>` → the browser session holding the context's one persisting slot. */
	const persistingSlots = new Map<string, string>();

	const slotKey = (organisationId: OrganisationId, contextId: string) => `${organisationId} ${contextId}`;

	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append([{ ...event, at: clock.now(), source: "browser" }]);
	}

	/** A retry of the same call (same `requestId`) keeps one refusal row; calls without one each get a row. */
	function refusalId(ctx: CallContext, what: string): string {
		return `browser:${what}:refused:${ctx.requestId ?? crypto.randomUUID()}`;
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
			await provider.release(stored.providerSessionId);
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

	async function runAll(work: readonly (() => Promise<void>)[]): Promise<void> {
		for (const step of work) await step();
	}

	/** Closes every open browser session past its `expiresAt` as `timeout`. Runs at the start of every call. */
	async function sweep(): Promise<void> {
		const now = clock.now();
		const work: (() => Promise<void>)[] = [];
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
			throw new HarbourError("not_found", `No browser grant ${grantId}`);
		}
		return stored;
	}

	/** A browser session the caller may see: any in its organisation for humans and services, its own for an agent. */
	function sessionFor(ctx: CallContext, browserSessionId: string): StoredSession {
		const stored = sessions.get(browserSessionId);
		if (
			stored === undefined ||
			stored.session.organisationId !== ctx.organisationId ||
			(ctx.actor.kind === "agent" && stored.session.sessionId !== ctx.actor.sessionId)
		) {
			throw new HarbourError("not_found", `No browser session ${browserSessionId}`);
		}
		return stored;
	}

	return {
		async putContext(ctx, input) {
			await sweep();
			forbidAgent(ctx, "create browser contexts");
			const owner = input.owner;
			if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "A browser context must be owned within the caller's organisation");
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
			return paginate(own, page);
		},

		async request(ctx, input) {
			await sweep();
			const actor = requireAgent(ctx, "ask for a browser");
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
			if (!isSupervisor(ctx.actor, input.sessionId, parentOf)) {
				await emit({
					id: refusalId(ctx, "grant"),
					type: "browser.grant.refused",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					projectId: input.projectId,
					sessionId: input.sessionId,
					agentId: input.agentId,
					data: {
						contextId: input.contextId,
						reason:
							ctx.actor.kind === "agent" && ctx.actor.sessionId === input.sessionId
								? "An agent cannot grant a browser context to its own session"
								: "Only a human, a service or an agent in the parent session can grant a browser context",
					},
				});
				throw new HarbourError("refused", "Only a supervisor can choose a browser context for a session");
			}
			const context = contexts.get(input.contextId);
			if (context === undefined || context.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", `No browser context ${input.contextId}`);
			}
			assertNonEmpty(input.sessionId, "A session ID");
			assertNonEmpty(input.projectId, "A project ID");
			assertNonEmpty(input.agentId, "An agent ID");
			if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
				throw new HarbourError("invalid", "timeoutMs must be a positive integer");
			}
			if (input.allowedSites.length === 0) throw new HarbourError("invalid", "A grant needs at least one site");
			for (const site of input.allowedSites) assertValidSite(site);
			let answered: StoredRequest | undefined;
			if (input.requestId !== undefined) {
				answered = requests.get(input.requestId);
				if (answered === undefined || answered.request.organisationId !== ctx.organisationId) {
					throw new HarbourError("not_found", `No browser request ${input.requestId}`);
				}
				if (answered.request.sessionId !== input.sessionId || answered.request.agentId !== input.agentId) {
					throw new HarbourError("invalid", "The request was made by another session or agent");
				}
				if (answered.request.status !== "pending") {
					throw new HarbourError(
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
			if (!isSupervisor(ctx.actor, stored.grant.sessionId, parentOf)) {
				throw new HarbourError("forbidden", "Only a supervisor can revoke a browser grant");
			}
			if (stored.grant.status !== "active") return stored.grant;
			stored.grant = { ...stored.grant, status: "revoked" };
			const work: (() => Promise<void>)[] = [];
			for (const session of sessions.values()) {
				if (session.session.grantId === grantId && session.session.status === "open") {
					work.push(closeSession(session, "revoked", ctx.actor));
				}
			}
			const revoked = stored.grant;
			await emit({
				id: `browser:grant:${grantId}:revoked`,
				type: "browser.grant.revoked",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...grantFields(revoked),
				subject: { kind: "browser.grant", id: grantId },
			});
			await runAll(work);
			return revoked;
		},

		async listGrants(ctx, filter) {
			await sweep();
			const sessionId = ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined;
			return [...grants.values()]
				.map((stored) => stored.grant)
				.filter(
					(grant) =>
						grant.organisationId === ctx.organisationId &&
						(sessionId === undefined || grant.sessionId === sessionId) &&
						(filter.sessionId === undefined || grant.sessionId === filter.sessionId),
				);
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
				throw new HarbourError("not_found", `No browser grant ${input.grantId}`);
			}
			const grant = stored.grant;
			if (grant.status !== "active") throw new HarbourError("expired", `Browser grant ${grant.id} is ${grant.status}`);
			if (input.contextId !== undefined && input.contextId !== grant.contextId) {
				await emit({
					id: refusalId(ctx, "session"),
					type: "browser.session.refused",
					actor,
					organisationId: ctx.organisationId,
					...grantFields(grant),
					subject: { kind: "browser.grant", id: grant.id },
					data: { askedContextId: input.contextId, reason: "The grant does not hold this context" },
				});
				throw new HarbourError("refused", "An agent cannot choose a browser context its grant does not hold");
			}
			const context = contexts.get(grant.contextId)!.context;
			const key = slotKey(grant.organisationId, grant.contextId);
			const id = newId("bsession");
			if (grant.persist) {
				if (persistingSlots.has(key)) {
					throw new HarbourError("conflict", "A persisting browser session is already open on this context");
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
				});
			} catch (error) {
				freeSlot();
				throw error;
			}
			// The grant may have been revoked or ended while the provider was opening.
			const current = stored.grant;
			if (current.status !== "active") {
				freeSlot();
				await provider.release(opened.providerSessionId);
				throw new HarbourError("expired", `Browser grant ${grant.id} is ${current.status}`);
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
			if (stored.session.status !== "open") return { allow: false };
			const grant = grants.get(stored.session.grantId)!.grant;
			return { allow: siteAllowed(grant.allowedSites, url) };
		},

		async close(ctx, browserSessionId) {
			await sweep();
			const stored = sessionFor(ctx, browserSessionId);
			if (stored.session.status === "closed") return stored.session;
			const finish = closeSession(stored, "closed", ctx.actor);
			const closed = stored.session;
			await finish();
			return closed;
		},

		async endSession(sessionId: SessionId, _reason) {
			await sweep();
			const work: (() => Promise<void>)[] = [];
			for (const stored of sessions.values()) {
				if (stored.session.sessionId === sessionId && stored.session.status === "open") {
					work.push(closeSession(stored, "session_ended", BROKER_ACTOR));
				}
			}
			for (const stored of grants.values()) {
				if (stored.grant.sessionId !== sessionId || stored.grant.status !== "active") continue;
				stored.grant = { ...stored.grant, status: "ended" };
				const ended = stored.grant;
				work.push(() =>
					emit({
						id: `browser:grant:${ended.id}:ended`,
						type: "browser.grant.ended",
						actor: BROKER_ACTOR,
						organisationId: ended.organisationId,
						...grantFields(ended),
						subject: { kind: "browser.grant", id: ended.id },
					}),
				);
			}
			for (const stored of requests.values()) {
				if (stored.request.sessionId === sessionId && stored.request.status === "pending") {
					stored.request = { ...stored.request, status: "declined" };
				}
			}
			await runAll(work);
		},

		async get(ctx, browserSessionId) {
			await sweep();
			return sessionFor(ctx, browserSessionId).session;
		},
	};
}
