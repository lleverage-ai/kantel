/**
 * The browser on Cloudflare (#24): which provider the stack's broker uses, from the Worker's vars. The broker, its
 * session tools, people's decisions and the console's links are `@kantel/browser/session`, shared with the
 * self-hosted gateway. Portable (no `cloudflare:workers`), so the tests run it in Node over the fake provider.
 *
 * - **brwsr** (the default): brwsr.dev with its project key, the `KANTEL_BRWSR_API_KEY` Worker secret. Only the
 *   provider holds it.
 * - **harbour** (`KANTEL_BROWSER_PROVIDER=harbour`): Kantel's own browsers (docs/design/browser-runtime.md), a
 *   `KantelBrowser` object with a Container per browser, or a self-hosted browser host at `KANTEL_BROWSER_HOST_URL`.
 */
import { BRWSR_API_URL, createBrwsrProvider } from "@kantel/browser/brwsr";
import {
	BROWSER_VIEW_BASE,
	type BrowserHostClient,
	browserProviderName,
	createBrowserViewSigner,
	createKantelBrowserProvider,
	httpBrowserHost,
} from "@kantel/browser/runtime";
import type { BrowserProvider, ProjectSettings } from "@kantel/contracts";

export {
	BROWSER_CONTEXT_NAME,
	BROWSER_TOOL_NAMES,
	type BrowserDecision,
	type BrowserGoalMode,
	type BrowserLiveViewInput,
	createSessionBrowser as createStackBrowser,
	DECISION_TIMEOUT_MS,
	GRANT_TIMEOUT_MS,
	LIVE_VIEW_MINUTES,
	type SessionBrowser as StackBrowser,
	type SessionBrowserOptions as StackBrowserOptions,
	toolName,
} from "@kantel/browser/session";
export { BROWSER_VIEW_BASE };

export interface BrowserVars {
	/** brwsr's project key (a Worker secret). Without it sessions have no browser tools. */
	readonly KANTEL_BRWSR_API_KEY?: string;
	/** brwsr's API. Default `https://api.brwsr.dev`. */
	readonly KANTEL_BRWSR_API_URL?: string;
	/**
	 * Which provider the broker uses: `brwsr` (the default: brwsr.dev, with the key above) or `harbour`, Kantel's own
	 * browsers (docs/design/browser-runtime.md): a `KantelBrowser` object with a Container per browser, or the
	 * self-hosted browser host at `KANTEL_BROWSER_HOST_URL` when that is set.
	 */
	readonly KANTEL_BROWSER_PROVIDER?: string;
	/** Signs live-view, replay and embed links (harbour provider). A Worker secret. */
	readonly KANTEL_BROWSER_VIEW_KEY?: string;
	/** A self-hosted browser host, instead of the `KantelBrowser` objects, and its bearer token (a secret). */
	readonly KANTEL_BROWSER_HOST_URL?: string;
	readonly KANTEL_BROWSER_HOST_TOKEN?: string;
	/**
	 * The platform's default for browser goal mode (`browser_run`, experimental): `on` offers it to every project that
	 * hasn't switched it off in its settings; anything else (the default) only to those that switched it on.
	 */
	readonly KANTEL_BROWSER_GOAL_MODE?: string;
	/** The platform's default decision model for goal runs: `clef` (the default) or `jev`. A project may pick its own. */
	readonly KANTEL_BROWSER_DECISION_MODEL?: string;
}

/** The platform's defaults for projects' settings, from the Worker's vars: goal mode off and Clef unless they say so. */
export function projectDefaultsFrom(vars: BrowserVars): Required<ProjectSettings> {
	return {
		browserGoalMode: (vars.KANTEL_BROWSER_GOAL_MODE ?? "").trim() === "on" ? "on" : "off",
		browserDecisionModel: (vars.KANTEL_BROWSER_DECISION_MODEL ?? "").trim() === "jev" ? "jev" : "clef",
	};
}

/** The `KantelBrowser` objects, typed without workers-types so the Node tests can stand them in. */
export interface BrowserObjects<Id = unknown> {
	idFromName(name: string): Id;
	get(id: Id, options?: { locationHint?: string }): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** The brwsr provider over the Worker's key, or `undefined` when it has none. */
export function brwsrProviderFrom(
	vars: BrowserVars,
	options: { readonly fetch?: (input: string, init?: RequestInit) => Promise<Response> } = {},
): BrowserProvider | undefined {
	const apiKey = (vars.KANTEL_BRWSR_API_KEY ?? "").trim();
	if (apiKey === "") return undefined;
	const apiUrl = (vars.KANTEL_BRWSR_API_URL ?? "").trim();
	return createBrwsrProvider({
		apiKey,
		apiUrl: apiUrl === "" ? BRWSR_API_URL : apiUrl,
		userMetadata: { agent: "harbour" },
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
}

/**
 * The harbour provider, over the `KantelBrowser` objects (created in `locationHint`, beside their containers) or a
 * self-hosted browser host, or `undefined` when the Worker lacks what it needs (the view key, and the objects or a
 * host). Its links are relative (`/browser/<browser>#<token>`): the gateway makes an embed's absolute for the app
 * asking.
 */
export function kantelProviderFrom(
	vars: BrowserVars,
	options: { readonly browsers?: BrowserObjects; readonly locationHint?: string } = {},
): BrowserProvider | undefined {
	const viewKey = (vars.KANTEL_BROWSER_VIEW_KEY ?? "").trim();
	if (viewKey.length < 32) return undefined;
	const hostUrl = (vars.KANTEL_BROWSER_HOST_URL ?? "").trim();
	let host: BrowserHostClient;
	if (hostUrl !== "") {
		host = httpBrowserHost({ url: hostUrl, token: (vars.KANTEL_BROWSER_HOST_TOKEN ?? "").trim() });
	} else if (options.browsers !== undefined) {
		const browsers = options.browsers;
		host = {
			fetch: (browserId, path, init) =>
				browsers
					.get(
						browsers.idFromName(browserId),
						options.locationHint === undefined ? undefined : { locationHint: options.locationHint },
					)
					.fetch(`https://browser/browsers/${encodeURIComponent(browserId)}${path}`, init),
		};
	} else {
		return undefined;
	}
	return createKantelBrowserProvider({ host, views: createBrowserViewSigner(viewKey), viewBase: BROWSER_VIEW_BASE });
}

/** The provider `KANTEL_BROWSER_PROVIDER` names, or `undefined` when the Worker lacks what that one needs. */
export function browserProviderFrom(
	vars: BrowserVars,
	options: { readonly browsers?: BrowserObjects; readonly locationHint?: string } = {},
): BrowserProvider | undefined {
	return browserProviderName(vars.KANTEL_BROWSER_PROVIDER) === "harbour"
		? kantelProviderFrom(vars, options)
		: brwsrProviderFrom(vars);
}
