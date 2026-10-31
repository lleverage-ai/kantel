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
	/** The session's project; absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
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

/**
 * One step in an open browser, as `browser.act` takes it: model-free, on element IDs from the last page read
 * (`look`). `scroll` scrolls down by most of a screen; `wait` lets the page settle; `slide` moves a slider (a range
 * input or `role=slider`) to `value`, a number in the slider's own units, a percentage or the reading it shows (such as
 * `09:00`). A step never takes a credential: signing in is a human's step, through a share link.
 */
export type BrowserAction =
	| { readonly kind: "look" }
	| { readonly kind: "goto"; readonly url: string }
	| { readonly kind: "click"; readonly element: string }
	| { readonly kind: "fill"; readonly element: string; readonly value: string }
	| { readonly kind: "select"; readonly element: string; readonly value: string }
	| { readonly kind: "check"; readonly element: string }
	| { readonly kind: "slide"; readonly element: string; readonly value: string }
	| { readonly kind: "press"; readonly key: string }
	| { readonly kind: "scroll" }
	| { readonly kind: "wait" };

export type BrowserActionKind = BrowserAction["kind"];

/** The page a browser is on after a step: its readable text and the elements a next step can name. */
export interface BrowserPage {
	readonly url: string;
	readonly title: string;
	readonly text: string;
	/** Interactive elements: an ID for `click`, `fill`, `select` and `check`, and what the element is. */
	readonly elements: readonly { readonly id: string; readonly describe: string }[];
	/** Whether the step did what it was asked (always `true` for `look`). */
	readonly succeeded: boolean;
	/** What the step did, in the provider's words, such as `click link "Learn more"`. */
	readonly did?: string;
}

/**
 * The System One decision model a goal run (`run`) makes its choices on: Cloudflare's Clef (through the deployment's
 * Workers AI binding) or TypeSafe's Jev (with the deployment's key). A project picks one, or takes the platform's.
 */
export type BrowserDecisionModel = "clef" | "jev";
export const BROWSER_DECISION_MODELS: readonly BrowserDecisionModel[] = ["clef", "jev"];

/**
 * A goal for the browser's fast loop (Reflex's goal mode): it reads the page and acts on its own, a decision model
 * choosing each step, until the goal is met, it reaches `stopBefore`, or it is unsure and hands back. It never fills
 * payment details or presses a final pay or purchase button.
 */
export interface BrowserGoal {
	/** What to achieve, in a sentence. */
	readonly goal: string;
	/** Values it may type or pick, by name, such as `{ from: "Manchester", to: "Amsterdam" }`. Never a credential. */
	readonly data?: { readonly [name: string]: string };
	/** Where to stop without going further, such as "the page asks for passenger details". */
	readonly stopBefore?: string;
	/** An address on the grant's sites to open first. */
	readonly url?: string;
	/** Steps before it hands back, 1 to 60. Default the provider's (25). */
	readonly maxSteps?: number;
}

export type BrowserRunStatus = "done" | "stopped_before" | "needs_supervisor" | "aborted" | "max_steps";

/** How a goal run ended, what it did, and the page it left the browser on. */
export interface BrowserRunResult {
	readonly status: BrowserRunStatus;
	/** Each step it took, in the provider's words, oldest first. */
	readonly steps: readonly string[];
	/** Why it stopped or handed back, when it says. */
	readonly note?: string;
	/** When it handed back (`needs_supervisor`): why, and its best guesses for the next step, as element IDs. */
	readonly handBack?: {
		readonly reason: string;
		readonly detail: string;
		readonly candidates: readonly { readonly id: string; readonly p: number; readonly describe: string }[];
	};
	/** The page it ended on, with element IDs for `act`. */
	readonly page: BrowserPage;
	/** What the decision model cost: calls, and the model's name as the provider gives it. */
	readonly usage: { readonly decisions: number; readonly model?: string; readonly ms: number };
}

export interface BrowserScreenshot {
	readonly url: string;
	readonly title: string;
	readonly mimeType: "image/png" | "image/jpeg";
	/** Base64. */
	readonly data: string;
}

/** A link that opens the browser's live view (with control, or watch-only) without signing in to the provider. */
export interface BrowserShareLink {
	readonly url: string;
	readonly expiresAt?: Timestamp;
	/**
	 * How to put the link's view in another page's iframe, when the provider supports it: the URL to embed (such as the
	 * link without the provider's own chrome) and the message the embedded page posts to its parent once its stream is
	 * over. Provider-specific details stay here, so a client only knows "an embeddable page".
	 */
	readonly embed?: { readonly url: string; readonly endMessage?: string };
}

/** What a recording provider stored of a browser that has ended: counts and retention only, never a frame or a page. */
export interface BrowserReleased {
	readonly recording?: {
		readonly pages: number;
		readonly frames: number;
		readonly durationMs: number;
		/** When the recording is deleted. */
		readonly expiresAt: Timestamp;
	};
}

/** The provider behind the broker, such as brwsr. Implementations hold the provider key; nothing else sees it. */
export interface BrowserProvider {
	open(input: {
		readonly providerContextId: string;
		readonly persist: boolean;
		readonly timeoutMs: number;
		/** The grant's sites, for a provider that also enforces them inside the browser (Harbour's own runtime does). */
		readonly allowedSites?: readonly string[];
	}): Promise<{ readonly providerSessionId: string; readonly cdpUrl: string }>;
	/**
	 * Ends the browser; a persisting one saves its context. A session already gone is not an error. A provider that
	 * records says what it stored, once the recording is complete.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: a provider that records nothing keeps its plain `async` release.
	release(providerSessionId: string): Promise<BrowserReleased | undefined | void>;
	/** One step in the browser, then the page it is on. A browser that has ended is `expired`. */
	act(providerSessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserPage>;
	/** The page as it is now. A browser that has ended is `expired`. */
	screenshot(providerSessionId: string, signal?: AbortSignal): Promise<BrowserScreenshot>;
	/**
	 * A goal run on `model` (Reflex's goal mode), then how it ended and the page it is on. A provider without goal mode
	 * leaves it out. A browser that has ended is `expired`.
	 */
	run?(
		providerSessionId: string,
		goal: BrowserGoal,
		options: { readonly model: BrowserDecisionModel },
		signal?: AbortSignal,
	): Promise<BrowserRunResult>;
	/**
	 * A live-view link that lasts `minutes`: with control, or watch-only when `options.control` is `false` (its viewer's
	 * input never reaches the browser). A browser that has ended is `expired`.
	 */
	share(
		providerSessionId: string,
		minutes: number,
		signal?: AbortSignal,
		options?: { readonly control?: boolean },
	): Promise<BrowserShareLink>;
	/**
	 * A link to the browser's recording that lasts `minutes`, open or ended, while the recording is kept. A provider
	 * that records nothing leaves it out. No recording is `not_found`; one past its retention is `expired`.
	 */
	replay?(providerSessionId: string, minutes: number, signal?: AbortSignal): Promise<BrowserShareLink>;
}

export interface GrantBrowserInput {
	readonly sessionId: SessionId;
	/** The session's project; absent for an organisation-scoped session. */
	readonly projectId?: ProjectId;
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
	 * One step in an open browser session, then the page it is on. The session's own agent, or a supervisor with
	 * operator on its agent session. A `goto` off the grant's sites is `refused` before the browser moves; a step that
	 * lands off them sends the browser to `about:blank` and is `refused`, so the page is never returned. Both are audited
	 * as `browser.site.refused`. A closed session is `expired`.
	 */
	act(ctx: CallContext, browserSessionId: string, action: BrowserAction): Promise<BrowserPage>;
	/** The page as it is now, for the same callers as `act`. A page off the grant's sites is `refused`. */
	screenshot(ctx: CallContext, browserSessionId: string): Promise<BrowserScreenshot>;
	/**
	 * A goal run in an open browser session on `options.model`, for the same callers as `act`, under the same site rules:
	 * a `url` off the grant's sites is `refused` before it starts, and a run that ends off them sends the browser to
	 * `about:blank` and is `refused`. A provider without goal mode is `unavailable`. Audited as `browser.session.run` with
	 * its status, step count and the host it ended on, never the goal or its data.
	 */
	run(
		ctx: CallContext,
		browserSessionId: string,
		goal: BrowserGoal,
		options: { readonly model: BrowserDecisionModel },
	): Promise<BrowserRunResult>;
	/**
	 * A live-view link with control, for a human's step such as signing in or a CAPTCHA. Humans and services only (an
	 * agent is `forbidden`), with operator on the agent session. `minutes` is 15 or 60 (default 15); anything else is `invalid`. The link never
	 * outlives the browser session. Audited as
	 * `browser.session.shared`, never with the link.
	 *
	 * With `watch: true` the link is watch-only, so a person can follow the agent's browser as it works (the console's
	 * live view): its viewer's input never reaches the browser, and viewer on the agent session is enough. Still humans
	 * and services only, audited the same way with `watch: true`.
	 */
	share(
		ctx: CallContext,
		browserSessionId: string,
		input?: { readonly minutes?: number; readonly watch?: boolean },
	): Promise<BrowserShareLink>;
	/**
	 * The session-end teardown: closes every open browser session of an agent session (with `reason` as its end reason)
	 * and ends its grants and the grants passed on from them. `session_ended` also declines its pending requests; after
	 * `aborted` they stay pending and the session may acquire grants again. Idempotent: when the session holds nothing
	 * more, it changes and audits nothing. A worker call (settled question 13): any actor but `system` is `forbidden`.
	 */
	endSession(ctx: SystemContext, sessionId: SessionId, reason: SessionEndReason): Promise<void>;
	/**
	 * A link to a browser session's recording, open or closed, for humans and services with viewer on its agent session
	 * (an agent is `forbidden`). `minutes` is 15 or 60 (default 15). A provider without recordings is `unavailable`; no
	 * recording is `not_found`, and one past its retention `expired`. Audited as `browser.session.shared` with
	 * `replay: true`, never with the link.
	 */
	replay(ctx: CallContext, browserSessionId: string, input?: { readonly minutes?: number }): Promise<BrowserShareLink>;
	/**
	 * A link for an outside app to frame (the embed API): `live`, a watch-only view of an open browser session (a closed
	 * one is `expired`), or `replay`, its recording (as `replay` answers). Never with control. Humans and services with
	 * viewer on its agent session; an agent is `forbidden`. `minutes` is a whole number from 5 to 60 (default 15).
	 * Audited as `browser.session.embedded` with the mode and minutes, never with the link.
	 */
	embed(
		ctx: CallContext,
		browserSessionId: string,
		input: { readonly mode: "live" | "replay"; readonly minutes?: number },
	): Promise<BrowserShareLink>;
	get(ctx: CallContext, browserSessionId: string): Promise<BrowserSession>;
}
