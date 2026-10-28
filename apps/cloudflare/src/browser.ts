/**
 * The browser on Cloudflare (#24): the broker (`@harbour/browser`) over brwsr, its capabilities as the tools a session
 * calls, a person's decision on an agent's request for a browser, and the session-end teardown. Portable (no
 * `cloudflare:workers`), so the tests run it in Node over the fake provider.
 *
 * - **The key.** brwsr's project key is the `HARBOUR_BRWSR_API_KEY` Worker secret. Only the provider holds it; no tool
 *   output, transcript or log carries it, and an agent never names a browser context.
 * - **Grants come from a person.** `browser_request` asks; the call waits while the console shows the person an Allow
 *   and a Decline on it, and the person's own call (`decide`) grants the sites the agent named, in this deployment's
 *   context, never written back (`persist: false`), for `GRANT_TIMEOUT_MS`. An agent can never grant to itself: the
 *   broker refuses it.
 * - **One lease per session.** Every browser is opened under a grant of its own session, and the runtime's session-end
 *   hook closes them all (and ends the grants) when the session is closed or aborted.
 * - **What the model sees.** Each result's text, and a `browser_screenshot`'s image. A browser's CDP URL is left out:
 *   a session here has no code that could use it. After a step that may change the page (`browser_open` at a URL, and
 *   every `browser_act` but `look`), a screenshot goes into the result's UI details, so the console shows the browser
 *   moving without spending the model's tokens on it.
 * - **In memory**, as the sandboxes' leases are: a restarted object forgets its grants and open browsers. brwsr ends
 *   each browser at its grant's timeout whatever happens here.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { browserTeardown } from "@harbour/browser";
import { BRWSR_API_URL, createBrwsrProvider } from "@harbour/browser/brwsr";
import {
	BROWSER_ACT_CAPABILITY,
	BROWSER_OPEN_CAPABILITY,
	BROWSER_REQUEST_CAPABILITY,
	BROWSER_SCREENSHOT_CAPABILITY,
	browserCapabilities,
	browserCapabilityHandler,
} from "@harbour/browser/capabilities";
import { createMemoryBrowser } from "@harbour/browser/memory";
import {
	type AuditSink,
	type Browser,
	type BrowserProvider,
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

export interface BrowserVars {
	/** brwsr's project key (a Worker secret). Without it sessions have no browser tools. */
	readonly HARBOUR_BRWSR_API_KEY?: string;
	/** brwsr's API. Default `https://api.brwsr.dev`. */
	readonly HARBOUR_BRWSR_API_URL?: string;
}

/** The name of the brwsr context sessions browse in: a profile of this deployment's own, never written back. */
export const BROWSER_CONTEXT_NAME = "harbour";
/** How long a granted browser may live. */
export const GRANT_TIMEOUT_MS = 30 * 60_000;
/** How long `browser_request` waits for a person before it gives up. */
export const DECISION_TIMEOUT_MS = 10 * 60_000;

/** A capability's tool name: `browser.open` is `browser_open`, as model tool names have no dots. */
export const toolName = (capability: string): string => capability.replaceAll(".", "_");

/** The tools a session with the browser has, by name, for its profile's `tools`. */
export const BROWSER_TOOL_NAMES: readonly string[] = browserCapabilities.map((definition) => toolName(definition.name));

/** The brwsr provider over the Worker's key, or `undefined` when it has none. */
export function brwsrProviderFrom(
	vars: BrowserVars,
	options: { readonly fetch?: (input: string, init?: RequestInit) => Promise<Response> } = {},
): BrowserProvider | undefined {
	const apiKey = (vars.HARBOUR_BRWSR_API_KEY ?? "").trim();
	if (apiKey === "") return undefined;
	const apiUrl = (vars.HARBOUR_BRWSR_API_URL ?? "").trim();
	return createBrwsrProvider({
		apiKey,
		apiUrl: apiUrl === "" ? BRWSR_API_URL : apiUrl,
		userMetadata: { agent: "harbour" },
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
}

/** A provider that can find (or make) a context by name, as brwsr's can; any other uses the name as the ID. */
type ProviderWithContexts = BrowserProvider & {
	readonly contextId?: (name: string, signal?: AbortSignal) => Promise<string>;
};

export interface StackBrowserOptions {
	readonly provider: ProviderWithContexts;
	readonly audit: AuditSink;
	readonly clock: Clock;
	/** The runtime's project access, asked for at call time (the browser is built before the runtime). */
	readonly access: ProjectAccess;
	/** Who registers the deployment's context: the bootstrap's admin, once there is one. */
	readonly admin: () => CallContext;
	readonly decisionTimeoutMs?: number;
}

export interface BrowserDecision {
	readonly sessionId: SessionId;
	/** The `browser_request` call's ID, as its tool item names it. */
	readonly callId: string;
	readonly allow: boolean;
}

export interface StackBrowser {
	readonly broker: Browser;
	/** The browser's tools for one session, bound to it. */
	tools(record: SessionRecord): ToolRegistration[];
	/**
	 * A person's answer to a `browser_request` call that is waiting. Allowing grants the sites the agent asked for, as
	 * the caller (the broker checks they may supervise the session); either way the call returns to the agent. A call
	 * that is not waiting (answered already, or gone with a restart) is `not_found`.
	 */
	decide(ctx: CallContext, decision: BrowserDecision): Promise<{ readonly status: "granted" | "declined" }>;
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

export function createStackBrowser(options: StackBrowserOptions): StackBrowser {
	const { provider, clock } = options;
	const decisionTimeoutMs = options.decisionTimeoutMs ?? DECISION_TIMEOUT_MS;
	const broker = createMemoryBrowser({ provider, audit: options.audit, clock, access: options.access });
	const handler: CapabilityHandler = browserCapabilityHandler({ browser: broker });
	const waiting = new Map<string, Waiting>();
	const waitKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

	// The deployment's context, registered once per organisation on its first grant.
	const contexts = new Map<string, Promise<string>>();
	const contextFor = (organisationId: string): Promise<string> => {
		let made = contexts.get(organisationId);
		if (made === undefined) {
			made = (async () => {
				const admin = options.admin();
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

	/** A capability result as the model's content: its text, and the image a screenshot returned. */
	const toPi = (result: CapabilityResult, images: readonly { mimeType: string; data: string }[] = []) => {
		const output = isObject(result.output) ? result.output : {};
		const text = typeof output.text === "string" ? output.text : JSON.stringify(result.output);
		const image = isObject(output.image) ? output.image : undefined;
		const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
			{ type: "text", text },
		];
		if (image !== undefined && typeof image.mimeType === "string" && typeof image.data === "string") {
			content.push({ type: "image", mimeType: image.mimeType, data: image.data });
		}
		return {
			output: content,
			isError: result.isError === true,
			...(images.length === 0 ? {} : { details: { images: images.map((each) => ({ ...each })) } }),
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

	const toolFor = (definition: CapabilityDefinition, record: SessionRecord): ToolRegistration =>
		defineTool({
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
				if (result.isError === true) return toPi(result);
				// A screenshot for the transcript after a step that may have moved the page.
				const args_ = isObject(args as JsonValue) ? (args as { readonly [key: string]: JsonValue }) : {};
				let shown: string | undefined;
				if (definition.name === BROWSER_OPEN_CAPABILITY && typeof args_.url === "string") {
					shown = typeof output.browserSessionId === "string" ? output.browserSessionId : undefined;
				} else if (definition.name === BROWSER_ACT_CAPABILITY && args_.action !== "look") {
					shown = typeof args_.browserSessionId === "string" ? args_.browserSessionId : undefined;
				}
				if (shown === undefined || definition.name === BROWSER_SCREENSHOT_CAPABILITY) return toPi(result);
				return toPi(result, await uiShot(record, shown, signal));
			},
		});

	return {
		broker,
		tools: (record) => browserCapabilities.map((definition) => toolFor(definition, record)),
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
		teardown: browserTeardown(broker),
	};
}
