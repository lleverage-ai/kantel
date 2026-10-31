/**
 * The browser in a deployment's sessions (#24): the broker (`./memory.ts`) over a provider (brwsr, or Harbour's own
 * browsers), its capabilities as the tools a session calls, a person's decision on an agent's request for a browser,
 * the console's live-view and replay links, and the session-end teardown. Both gateways run it: Cloudflare's stack
 * (apps/cloudflare) and the self-hosted gateway (apps/selfhosted). Portable.
 *
 * - **Keys.** Only the provider holds its key (brwsr's project key, or the browser host's token); no tool output,
 *   transcript or log carries it, and an agent never names a browser context.
 * - **Grants come from a person.** `browser_request` asks; the call waits while the console shows the person an Allow
 *   and a Decline on it, and the person's own call (`decide`) grants the sites the agent named, in this deployment's
 *   context, never written back (`persist: false`), for `GRANT_TIMEOUT_MS`. An agent can never grant to itself: the
 *   broker refuses it.
 * - **One lease per session.** Every browser is opened under a grant of its own session, and the runtime's session-end
 *   hook closes them all (and ends the grants) when the session is closed or aborted.
 * - **Goal mode.** `browser_run` hands a whole goal to Reflex's goal loop, on the decision model the session's project
 *   (or the platform) picks; a session has it only where goal mode is on (`tools(record, { run })`), beside the others.
 * - **What the model sees.** Each result's text, and a `browser_screenshot`'s image. A browser's CDP URL is left out.
 *   After a step that may change the page (`browser_open` at a URL, and every `browser_act` but `look`), a screenshot
 *   goes into the result's UI details, so the console shows the browser moving without spending the model's tokens on
 *   it. Every call on a browser also names it there (`details.browserSessionId`). With a `screenshots` store the step
 *   doesn't wait for it: the details name where it will be (`{ mimeType, url }`), and it is taken and stored after the
 *   step has answered; the browser's next call waits for it, so it shows the page as the step left it.
 * - **The live view and replay.** A person watching the session asks `liveView` for a watch-only link to one of its
 *   browsers, or `replay` for its recording; the links are minted for that person's call, as them (viewer on the session
 *   is enough), never for the agent or the model.
 * - **In memory**, as the sandboxes' leases are: a restart forgets grants and open browsers. The provider ends each
 *   browser at its grant's timeout whatever happens here.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
	type AuditSink,
	type Browser,
	type BrowserDecisionModel,
	type BrowserProvider,
	type BrowserShareLink,
	type CallContext,
	type CapabilityDefinition,
	type CapabilityHandler,
	type CapabilityResult,
	type Clock,
	HarbourError,
	type JsonValue,
	type ProjectAccess,
	type SessionId,
	type SessionRecord,
	type SessionTeardown,
} from "@harbour/contracts";
import {
	BROWSER_ACT_CAPABILITY,
	BROWSER_OPEN_CAPABILITY,
	BROWSER_REQUEST_CAPABILITY,
	BROWSER_RUN_CAPABILITY,
	browserCapabilities,
	browserCapabilityHandler,
	browserRunCapability,
} from "./capabilities.ts";
import { browserTeardown } from "./index.ts";
import { createMemoryBrowser } from "./memory.ts";

/** The name of the context sessions browse in: a profile of this deployment's own, never written back. */
export const BROWSER_CONTEXT_NAME = "harbour";
/** How long a granted browser may live. */
export const GRANT_TIMEOUT_MS = 30 * 60_000;
/** How long `browser_request` waits for a person before it gives up. */
export const DECISION_TIMEOUT_MS = 10 * 60_000;
/** How long a live-view link lasts: past a grant's whole life, so it ends with the browser, not before. */
export const LIVE_VIEW_MINUTES = 60;
/** A person's live-view link is handed out again while it has this long left, so a reload doesn't make another. */
const LIVE_VIEW_REUSE_MS = 10 * 60_000;

/** A capability's tool name: `browser.open` is `browser_open`, as model tool names have no dots. */
export const toolName = (capability: string): string => capability.replaceAll(".", "_");

/**
 * The tools a session with the browser may have, by name, for its profile's `tools`: `browser_run` too, which a session
 * is offered only where goal mode is on.
 */
export const BROWSER_TOOL_NAMES: readonly string[] = [...browserCapabilities, browserRunCapability].map((definition) =>
	toolName(definition.name),
);

/** Goal mode for one session: `browser_run` on this decision model. */
export interface BrowserGoalMode {
	readonly model: BrowserDecisionModel;
}

/** A provider that can find (or make) a context by name, as brwsr's can; any other uses the name as the ID. */
type ProviderWithContexts = BrowserProvider & {
	readonly contextId?: (name: string, signal?: AbortSignal) => Promise<string>;
};

export interface SessionBrowserOptions {
	readonly provider: ProviderWithContexts;
	readonly audit: AuditSink;
	readonly clock: Clock;
	/** The runtime's project access, asked for at call time (the browser is built before the runtime). */
	readonly access: ProjectAccess;
	/**
	 * Who registers the deployment's context in an organisation, on its first grant there: the bootstrap's admin (once
	 * there is one), or the deployment itself as a system actor.
	 */
	readonly admin: (organisationId: string) => CallContext;
	readonly decisionTimeoutMs?: number;
	/** Where the transcript's screenshots are kept, by reference. Without it each goes inline, taken inside its step. */
	readonly screenshots?: ScreenshotStore;
}

/** The transcript's screenshots as blobs: each stored once taken, and read by the URL given out before it was. */
export interface ScreenshotStore {
	/** Where screenshot `id` of this session will be read; undefined when the session's can't be kept here. */
	urlOf(record: SessionRecord, id: string): string | undefined;
	put(
		record: SessionRecord,
		id: string,
		image: { readonly mimeType: string; readonly bytes: Uint8Array },
	): Promise<void>;
}

/** The longest a browser's next call waits for the screenshot after its last step. */
export const SCREENSHOT_WAIT_MS = 8000;

export interface BrowserLiveViewInput {
	readonly sessionId: SessionId;
	/** The browser, as its tool items name it (`browser_open`'s `browserSessionId`). */
	readonly browserSessionId: string;
}

export interface BrowserDecision {
	readonly sessionId: SessionId;
	/** The `browser_request` call's ID, as its tool item names it. */
	readonly callId: string;
	readonly allow: boolean;
}

export interface SessionBrowser {
	readonly broker: Browser;
	/** The browser's tools for one session, bound to it: with `run`, `browser_run` on its model too. */
	tools(record: SessionRecord, options?: { readonly run?: BrowserGoalMode }): ToolRegistration[];
	/**
	 * A person's answer to a `browser_request` call that is waiting. Allowing grants the sites the agent asked for, as
	 * the caller (the broker checks they may supervise the session); either way the call returns to the agent. A call
	 * that is not waiting (answered already, or gone with a restart) is `not_found`.
	 */
	decide(ctx: CallContext, decision: BrowserDecision): Promise<{ readonly status: "granted" | "declined" }>;
	/**
	 * A watch-only live-view link to one of a session's open browsers, for the person asking (viewer on the session is
	 * enough; an agent is `forbidden`). A browser of another session is `not_found`; one that has closed is `expired`.
	 * The same person asking again for the same browser gets the same link while it has a while left.
	 */
	liveView(ctx: CallContext, input: BrowserLiveViewInput): Promise<BrowserShareLink>;
	/**
	 * A replay link to one of a session's browsers, open or closed, for the person asking (viewer on the session). A
	 * provider without recordings is `unavailable`; a browser without one `not_found`, past its retention `expired`.
	 */
	replay(ctx: CallContext, input: BrowserLiveViewInput): Promise<BrowserShareLink>;
	/** The runtime's `browser` teardown: closes the session's browsers and ends its grants. */
	readonly teardown: SessionTeardown;
}

interface Waiting {
	readonly record: SessionRecord;
	readonly requestId: string;
	readonly sites: readonly string[];
	settle(
		outcome: { readonly status: "granted"; readonly sites: readonly string[] } | { readonly status: "declined" },
	): void;
}

const isObject = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A capability's description with its tool names, as the model calls them. */
const describe = (definition: CapabilityDefinition): string =>
	definition.name === BROWSER_REQUEST_CAPABILITY
		? "Ask a person for a browser for this session, saying why and which sites. The call waits until they allow or decline it; once allowed, browser_open works on those sites."
		: definition.description.replace(/browser\.(\w+)/g, "browser_$1");

export function createSessionBrowser(options: SessionBrowserOptions): SessionBrowser {
	const { provider, clock } = options;
	const decisionTimeoutMs = options.decisionTimeoutMs ?? DECISION_TIMEOUT_MS;
	const broker = createMemoryBrowser({ provider, audit: options.audit, clock, access: options.access });
	const stepHandler: CapabilityHandler = browserCapabilityHandler({ browser: broker });
	const waiting = new Map<string, Waiting>();
	const waitKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

	// The deployment's context, registered once per organisation on its first grant.
	const contexts = new Map<string, Promise<string>>();
	const contextFor = (organisationId: string): Promise<string> => {
		let made = contexts.get(organisationId);
		if (made === undefined) {
			made = (async () => {
				const admin = options.admin(organisationId);
				const providerContextId =
					provider.contextId === undefined ? BROWSER_CONTEXT_NAME : await provider.contextId(BROWSER_CONTEXT_NAME);
				const context = await broker.putContext(admin, {
					owner: { kind: "organisation", organisationId },
					name: BROWSER_CONTEXT_NAME,
					providerContextId,
				});
				return context.id;
			})();
			// A failure is not kept: the next grant tries again.
			made.catch(() => contexts.delete(organisationId));
			contexts.set(organisationId, made);
		}
		return made;
	};

	const agentContext = (record: SessionRecord, signal?: AbortSignal): CallContext => ({
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
		projectId: record.projectId,
		...(signal === undefined ? {} : { signal }),
	});

	/** A screenshot for the transcript, or nothing when it can't be taken (the step still answers). */
	const uiShot = async (record: SessionRecord, browserSessionId: string, signal?: AbortSignal) => {
		try {
			const shot = await broker.screenshot(agentContext(record, signal), browserSessionId);
			return [{ mimeType: shot.mimeType, data: shot.data }];
		} catch {
			return [];
		}
	};

	/**
	 * Each browser's calls, in turn: a call waits for the one before it on the same browser, the screenshot after it
	 * included, so the screenshot shows the page as that step left it, even when the model sent both calls at once (an
	 * act and the close after it). The wait is at most SCREENSHOT_WAIT_MS.
	 */
	const lanes = new Map<string, Promise<void>>();
	const within = async (prior: Promise<void> | undefined) => {
		if (prior === undefined) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([prior, new Promise<void>((resolve) => (timer = setTimeout(resolve, SCREENSHOT_WAIT_MS)))]);
		clearTimeout(timer);
	};
	const inLane = (browserSessionId: string, turn: Promise<void>) => {
		lanes.set(browserSessionId, turn);
		void turn.then(() => {
			if (lanes.get(browserSessionId) === turn) lanes.delete(browserSessionId);
		});
	};
	/** Takes a call's turn on a browser once the call before it is done; the call ends its turn with what it returns. */
	const takeTurn = async (browserSessionId: string) => {
		const prior = lanes.get(browserSessionId);
		let end: () => void = () => undefined;
		inLane(browserSessionId, new Promise<void>((resolve) => (end = resolve)));
		await within(prior);
		return end;
	};
	/** The screenshot after a step, by reference when there is a store: taken and stored once the step has answered. */
	const laterShot = (record: SessionRecord, browserSessionId: string) => {
		const store = options.screenshots;
		const id = crypto.randomUUID();
		const url = store?.urlOf(record, id);
		if (store === undefined || url === undefined) return undefined;
		const taking = (async () => {
			const shot = await broker.screenshot(agentContext(record), browserSessionId);
			const bytes = Uint8Array.from(atob(shot.data), (char) => char.charCodeAt(0));
			await store.put(record, id, { mimeType: shot.mimeType, bytes });
		})()
			// A screenshot that can't be taken or kept is left out, as inline: the transcript shows none for the step.
			.catch(() => undefined);
		return { images: [{ mimeType: "image/jpeg", url }], taking };
	};

	// Each person's live-view links, by browser: handed out again while they last, so a reload makes no new one.
	const liveViews = new Map<string, BrowserShareLink>();

	/**
	 * A capability result as the model's content: its text, and the image a screenshot returned. The UI details (never
	 * the model's) carry the transcript's screenshots and the browser the call used.
	 */
	const toPi = (
		result: CapabilityResult,
		images: readonly ({ mimeType: string; data: string } | { mimeType: string; url: string })[] = [],
		browserSessionId?: string,
	) => {
		const output = isObject(result.output) ? result.output : {};
		const text = typeof output.text === "string" ? output.text : JSON.stringify(result.output);
		const image = isObject(output.image) ? output.image : undefined;
		const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
			{ type: "text", text },
		];
		if (image !== undefined && typeof image.mimeType === "string" && typeof image.data === "string") {
			content.push({ type: "image", mimeType: image.mimeType, data: image.data });
		}
		const details = {
			...(images.length === 0 ? {} : { images: images.map((each) => ({ ...each })) }),
			...(browserSessionId === undefined ? {} : { browserSessionId }),
		};
		return {
			output: content,
			isError: result.isError === true,
			...(Object.keys(details).length === 0 ? {} : { details }),
		};
	};

	/** Waits for a person's answer to the request, the call's abort, or the timeout. */
	const awaitDecision = (
		record: SessionRecord,
		callId: string,
		requestId: string,
		sites: readonly string[],
		signal?: AbortSignal,
	) =>
		new Promise<
			| { readonly status: "granted"; readonly sites: readonly string[] }
			| { readonly status: "declined" }
			| { readonly status: "timeout" }
		>((resolve, reject) => {
			const key = waitKey(record.id, callId);
			const done = () => {
				waiting.delete(key);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				done();
				reject(new HarbourError("aborted", "The browser request was aborted"));
			};
			const timer = setTimeout(() => {
				done();
				resolve({ status: "timeout" });
			}, decisionTimeoutMs);
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			waiting.set(key, {
				record,
				requestId,
				sites,
				settle: (outcome) => {
					done();
					resolve(outcome);
				},
			});
		});

	const toolFor = (
		definition: CapabilityDefinition,
		record: SessionRecord,
		run?: BrowserGoalMode,
	): ToolRegistration => {
		const handler: CapabilityHandler =
			run === undefined ? stepHandler : browserCapabilityHandler({ browser: broker, runModel: run.model });
		return defineTool({
			name: toolName(definition.name),
			description: describe(definition),
			parameters: Type.Unsafe<{ [key: string]: JsonValue }>({ ...definition.inputSchema }),
			replay: definition.replay === "safe" ? "safe" : "unsafe",
			execute: async (args, api, context) => {
				const signal = context.abortSignal;
				const invocation = {
					callId: api.callId,
					capability: definition.name,
					version: definition.version,
					args: args as JsonValue,
					organisationId: record.organisationId,
					projectId: record.projectId,
					sessionId: record.id,
					agentId: record.agentId,
				};
				// The browser's call before this one first, its screenshot included.
				const named = (args as { browserSessionId?: unknown } | undefined)?.browserSessionId;
				const endTurn = typeof named === "string" ? await takeTurn(named) : undefined;
				let shot: Promise<void> | undefined;
				try {
					return await step();
				} finally {
					if (endTurn !== undefined) void (shot ?? Promise.resolve()).then(endTurn);
				}

				async function step() {
					const result = await handler(invocation, signal ?? new AbortController().signal);
					const output = isObject(result.output) ? result.output : {};
					if (definition.name === BROWSER_REQUEST_CAPABILITY && result.isError !== true) {
						const requestId = typeof output.requestId === "string" ? output.requestId : undefined;
						if (requestId === undefined) return toPi(result);
						const sites = Array.isArray((args as { sites?: unknown }).sites)
							? ((args as { sites: unknown[] }).sites.filter((site) => typeof site === "string") as string[])
							: [];
						const decision = await awaitDecision(record, api.callId, requestId, sites, signal);
						const text =
							decision.status === "granted"
								? `A person allowed a browser for ${decision.sites.join(", ")}. browser_open works now.`
								: decision.status === "declined"
									? "A person declined the browser request."
									: `No one answered the browser request within ${Math.round(decisionTimeoutMs / 60_000)} minutes.`;
						return { output: [{ type: "text" as const, text }], isError: decision.status !== "granted" };
					}
					// The browser the call used: the one it opened, or the one it named.
					const args_ = isObject(args as JsonValue) ? (args as { readonly [key: string]: JsonValue }) : {};
					const used =
						definition.name === BROWSER_OPEN_CAPABILITY || definition.name === BROWSER_RUN_CAPABILITY
							? typeof output.browserSessionId === "string"
								? output.browserSessionId
								: undefined
							: typeof args_.browserSessionId === "string"
								? args_.browserSessionId
								: undefined;
					if (result.isError === true) return toPi(result, [], used);
					// A screenshot for the transcript after a step that may have moved the page.
					const moved =
						(definition.name === BROWSER_OPEN_CAPABILITY && typeof args_.url === "string") ||
						(definition.name === BROWSER_ACT_CAPABILITY && args_.action !== "look") ||
						definition.name === BROWSER_RUN_CAPABILITY;
					if (!moved || used === undefined) return toPi(result, [], used);
					const later = laterShot(record, used);
					if (later === undefined) return toPi(result, await uiShot(record, used, signal), used);
					shot = later.taking;
					// A browser just opened has no lane yet: its first screenshot starts one.
					if (endTurn === undefined) inLane(used, later.taking);
					return toPi(result, later.images, used);
				}
			},
		});
	};

	return {
		broker,
		tools: (record, toolOptions) => [
			...browserCapabilities.map((definition) => toolFor(definition, record)),
			...(toolOptions?.run === undefined ? [] : [toolFor(browserRunCapability, record, toolOptions.run)]),
		],
		async decide(ctx, decision) {
			const key = waitKey(decision.sessionId, decision.callId);
			const entry = waiting.get(key);
			if (entry === undefined || entry.record.organisationId !== ctx.organisationId) {
				throw new HarbourError("not_found", "No browser request is waiting on that call");
			}
			if (!decision.allow) {
				// Only someone who could grant may decline: the same project check the grant makes.
				await options.access.require(ctx, {
					projectId: entry.record.projectId,
					sessionId: entry.record.id,
					needed: "operator",
					operation: "browser.grant",
				});
				entry.settle({ status: "declined" });
				return { status: "declined" };
			}
			const contextId = await contextFor(entry.record.organisationId);
			await broker.grant(ctx, {
				sessionId: entry.record.id,
				projectId: entry.record.projectId,
				agentId: entry.record.agentId,
				contextId,
				persist: false,
				timeoutMs: GRANT_TIMEOUT_MS,
				allowedSites: [...entry.sites],
				requestId: entry.requestId,
			});
			entry.settle({ status: "granted", sites: entry.sites });
			return { status: "granted" };
		},
		async liveView(ctx, input) {
			// The broker checks the caller may view the browser's session, and hides another organisation's browser.
			const session = await broker.get(ctx, input.browserSessionId);
			if (session.sessionId !== input.sessionId) {
				throw new HarbourError("not_found", "No such browser in this session");
			}
			if (session.status !== "open") throw new HarbourError("expired", "The browser has closed");
			const now = clock.now();
			for (const [key, link] of liveViews) {
				if ((link.expiresAt ?? 0) - now <= LIVE_VIEW_REUSE_MS) liveViews.delete(key);
			}
			const key = `${JSON.stringify(ctx.actor)}\u0000${session.id}`;
			const kept = liveViews.get(key);
			if (kept !== undefined) return kept;
			const link = await broker.share(ctx, session.id, { watch: true, minutes: LIVE_VIEW_MINUTES });
			// A link with no expiry said is never handed out twice.
			if (link.expiresAt !== undefined) liveViews.set(key, link);
			return link;
		},
		async replay(ctx, input) {
			const session = await broker.get(ctx, input.browserSessionId);
			if (session.sessionId !== input.sessionId) {
				throw new HarbourError("not_found", "No such browser in this session");
			}
			return broker.replay(ctx, session.id, { minutes: LIVE_VIEW_MINUTES });
		},
		teardown: browserTeardown(broker),
	};
}
