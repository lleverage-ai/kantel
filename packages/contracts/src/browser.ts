/**
 * Browser capability. Harbour holds the browser provider's key (brwsr acts for a whole project), so an agent never
 * chooses a browser context. A browser grant names the context, whether the session may persist it, a timeout and the
 * allowed sites. A supervisor or a human sets it, when the session is created or when the agent asks. The agent gets
 * only a session-scoped CDP URL, and every browser session is a lease that ends with its agent session.
 *
 * "Supervisor" means a human, a service (a host app such as Sal), or an agent acting in the parent session of the
 * session the grant is for. An agent can never grant to its own session, and an agent supervisor can only pass on, no
 * wider, a context it holds through an active grant of its own.
 *
 * Project access (settled question 7): a context owned by a project, and every grant, request and browser session (through
 * its agent session), belong to that project, and the broker checks the caller's role there on every call.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	OrganisationId,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	SystemContext,
	Timestamp,
} from "./common.ts";
import type { SessionEndReason } from "./session.ts";

/** A stored browser profile at the provider (a brwsr context): cookies, storage, sign-ins. */
export interface BrowserContext {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly owner: OwnerRef;
	/** Human name, such as `sal` or `lleverage-staging`. */
	readonly name: string;
	/** The provider's own ID for it. Never shown to agents. */
	readonly providerContextId: string;
	readonly createdAt: Timestamp;
}

export interface BrowserGrant {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	readonly contextId: string;
	/** Whether browser sessions under this grant may write the context back (sign-ins persist). */
	readonly persist: boolean;
	/** The longest a browser session under this grant may live. */
	readonly timeoutMs: number;
	/** Hosts the browser may visit: exact (`github.com`) or a leading wildcard (`*.github.com`). */
	readonly allowedSites: readonly string[];
	readonly grantedBy: Actor;
	readonly createdAt: Timestamp;
	readonly status: "active" | "revoked" | "ended";
	/** Set when the grant answers an agent's request. */
	readonly requestId?: string;
	/** The grant this one was passed on from, when an agent supervisor granted it; it ends when that one does. */
	readonly parentGrantId?: string;
}

/** An agent asking for a browser. It names what it needs, never a context. */
export interface BrowserRequest {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	readonly reason: string;
	readonly sites: readonly string[];
	readonly status: "pending" | "granted" | "declined";
	readonly createdAt: Timestamp;
}

export interface BrowserSession {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly grantId: string;
	readonly sessionId: SessionId;
	readonly contextId: string;
	readonly persisting: boolean;
	/** A CDP URL scoped to this browser session only. */
	readonly cdpUrl: string;
	readonly status: "open" | "closed";
	readonly openedAt: Timestamp;
	/** `openedAt + grant.timeoutMs`; past it the session is closed as `timeout`. */
	readonly expiresAt: Timestamp;
	readonly closedAt?: Timestamp;
	readonly endReason?: "closed" | "timeout" | "session_ended" | "aborted" | "revoked";
}

/** The provider behind the broker, such as brwsr. Implementations hold the provider key; nothing else sees it. */
export interface BrowserProvider {
	open(input: {
		readonly providerContextId: string;
		readonly persist: boolean;
		readonly timeoutMs: number;
	}): Promise<{ readonly providerSessionId: string; readonly cdpUrl: string }>;
	release(providerSessionId: string): Promise<void>;
}

export interface GrantBrowserInput {
	readonly sessionId: SessionId;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly contextId: string;
	readonly persist: boolean;
	readonly timeoutMs: number;
	readonly allowedSites: readonly string[];
	readonly requestId?: string;
}

export interface Browser {
	/** Humans and services only. */
	putContext(
		ctx: CallContext,
		input: { readonly owner: OwnerRef; readonly name: string; readonly providerContextId: string },
	): Promise<BrowserContext>;
	/** Humans and services only: agents never see the list of contexts. */
	listContexts(ctx: CallContext, page?: PageRequest): Promise<Page<BrowserContext>>;
	/** An agent asks for a browser for its own session. */
	request(
		ctx: CallContext,
		input: { readonly reason: string; readonly sites: readonly string[] },
	): Promise<BrowserRequest>;
	/**
	 * Grants a context to a session. Refused (`refused`, audited as `browser.grant.refused`) when the actor is an agent
	 * that is not acting in the target session's parent, including an agent granting to its own session. An agent in the
	 * parent session may only pass on a context it holds through an active grant of its own (the parent grant), no wider:
	 * `persist` only if the parent's is, a `timeoutMs` no greater, and sites the parent's cover. Revoking or ending a
	 * grant ends every grant passed on from it, the same way.
	 */
	grant(ctx: CallContext, input: GrantBrowserInput): Promise<BrowserGrant>;
	revokeGrant(ctx: CallContext, grantId: string): Promise<BrowserGrant>;
	/** The grants of the agent's own session (for agents) or of any session (for humans and services). */
	listGrants(ctx: CallContext, filter: { readonly sessionId?: SessionId }): Promise<readonly BrowserGrant[]>;
	/**
	 * Opens a browser under a grant of the caller's session. If `contextId` is given and the grant does not hold it, the
	 * call is `refused`. Only one persisting browser session may be open per context at a time (`conflict`).
	 */
	open(ctx: CallContext, input: { readonly grantId: string; readonly contextId?: string }): Promise<BrowserSession>;
	/** Whether the browser session may visit `url` under its grant. */
	checkSite(ctx: CallContext, browserSessionId: string, url: string): Promise<{ readonly allow: boolean }>;
	close(ctx: CallContext, browserSessionId: string): Promise<BrowserSession>;
	/**
	 * The session-end teardown: closes every open browser session of an agent session (with `reason` as its end reason)
	 * and ends its grants and the grants passed on from them. `session_ended` also declines its pending requests; after
	 * `aborted` they stay pending and the session may acquire grants again. Idempotent: when the session holds nothing
	 * more, it changes and audits nothing. A worker call (settled question 13): any actor but `system` is `forbidden`.
	 */
	endSession(ctx: SystemContext, sessionId: SessionId, reason: SessionEndReason): Promise<void>;
	get(ctx: CallContext, browserSessionId: string): Promise<BrowserSession>;
}
