/**
 * The harbour provider: the broker's `BrowserProvider` over Kantel's own browser runtime, instead of brwsr.dev. Each
 * browser is a coordinator on a host (src/runtime/coordinator.ts): a `KantelBrowser` Durable Object with a Container
 * on Cloudflare, or the self-hosted browser host's Docker container. The provider reaches either through one
 * `BrowserHostClient`, so it has no idea which.
 *
 * - `open` picks a new browser ID and starts it on the grant's context, `persist` and sites.
 * - `act`, `screenshot` and `release` are the coordinator's routes.
 * - `share` and `replay` make Kantel links (`<viewBase>/<browser>#<token>`, the token in the fragment so that no
 *   server or log ever sees it in a URL), not provider ones: a signed, short-lived view
 *   token (src/runtime/view-token.ts) that the gateway checks before it joins the viewer to the browser.
 * - `cdpUrl` is not a usable URL: CDP stays behind the host until an agent tool needs it.
 *
 * Portable: `fetch` and WebCrypto only.
 */
import {
	type BrowserPage,
	type BrowserProvider,
	type BrowserRunResult,
	type BrowserRunStatus,
	type BrowserScreenshot,
	type BrowserShareLink,
	type ErrorCode,
	KantelError,
} from "@kantel/contracts";
import { sitesWithConsent } from "../index.ts";
import { type BrowserViewMode, type BrowserViewSigner, MAX_VIEW_MINUTES } from "./view-token.ts";

/**
 * What the view page (`/browser/<browser>#<token>`, the console's `src/viewer/`) posts to the page embedding it once
 * its stream is over: the browser closed, or the link ran out. The same message brwsr's live page posts
 * (docs/design/browser-runtime.md), so an embedder handles both providers alike.
 */
export const KANTEL_VIEW_END_MESSAGE = "browserbase-disconnected";

/** How the provider reaches a browser's coordinator. `path` starts with `/` and is relative to the browser. */
export interface BrowserHostClient {
	fetch(browserId: string, path: string, init?: RequestInit): Promise<Response>;
}

export interface KantelBrowserProviderOptions {
	readonly host: BrowserHostClient;
	readonly views: BrowserViewSigner;
	/** Where view links point, such as `https://harbour.example.com/browser`; the token is appended. */
	readonly viewBase: string;
	readonly now?: () => number;
	/** A new browser's ID. Default: a random UUID. */
	readonly newId?: () => string;
}

export interface KantelBrowserProvider extends BrowserProvider {
	/** A view link for `browserId` (the provider session ID), as `share` and `replay` make them. */
	viewLink(browserId: string, mode: BrowserViewMode, minutes: number, control: boolean): Promise<BrowserShareLink>;
}

function codeFor(status: number, code: unknown): ErrorCode {
	const known = ["invalid", "not_found", "expired", "conflict", "unavailable", "exhausted"] as const;
	if (typeof code === "string" && (known as readonly string[]).includes(code)) return code as ErrorCode;
	if (status === 400) return "invalid";
	if (status === 404) return "not_found";
	if (status === 409 || status === 410) return "expired";
	return "unavailable";
}

function record(value: unknown): { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: unknown })
		: {};
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Reflex's page (a look, or `page` in an act's reply) as a `BrowserPage`. */
function parsePage(value: unknown, succeeded: boolean, did: string | undefined): BrowserPage {
	const raw = record(value);
	const elements = Array.isArray(raw.elements)
		? raw.elements.flatMap((item) => {
				const element = record(item);
				const id = typeof element.id === "number" ? String(element.id) : str(element.id);
				return id === "" ? [] : [{ id, describe: str(element.describe) }];
			})
		: [];
	return {
		url: str(raw.url),
		title: str(raw.title),
		text: str(raw.text),
		elements,
		succeeded,
		...(did === undefined ? {} : { did }),
	};
}

const RUN_STATUSES: readonly BrowserRunStatus[] = [
	"done",
	"stopped_before",
	"needs_supervisor",
	"aborted",
	"max_steps",
];
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Reflex's run result (and the look after it) as a `BrowserRunResult`: each step as the loop described it. */
export function parseRun(reply: { readonly [key: string]: unknown }): BrowserRunResult {
	const status = RUN_STATUSES.find((each) => each === reply.status) ?? "aborted";
	const steps = (Array.isArray(reply.steps) ? reply.steps : []).flatMap((item) => {
		const step = record(item);
		const did = str(step.did) || str(step.note);
		return did === "" ? [] : [`${step.by === "supervisor" ? "[you] " : ""}${did}`.slice(0, 300)];
	});
	const escalation = record(reply.escalation);
	const usage = record(reply.usage);
	const note = str(reply.note);
	const candidates = (Array.isArray(escalation.candidates) ? escalation.candidates : []).slice(0, 8).flatMap((item) => {
		const candidate = record(item);
		const id = str(candidate.id);
		return id === "" ? [] : [{ id, p: Math.round(num(candidate.p) * 100) / 100, describe: str(candidate.describe) }];
	});
	return {
		status,
		steps,
		...(note === "" ? {} : { note: note.slice(0, 500) }),
		...(status === "needs_supervisor" && str(escalation.reason) !== ""
			? { handBack: { reason: str(escalation.reason), detail: str(escalation.detail).slice(0, 500), candidates } }
			: {}),
		// The page is a look after the run, which always succeeds; how the run went is its status.
		page: parsePage(reply.page, true, undefined),
		usage: {
			decisions: num(usage.decisions),
			ms: Math.round(num(usage.ms)),
			...(typeof reply.model === "string" ? { model: reply.model } : {}),
		},
	};
}

export function createKantelBrowserProvider(options: KantelBrowserProviderOptions): KantelBrowserProvider {
	const now = options.now ?? Date.now;
	const newId = options.newId ?? (() => crypto.randomUUID());
	const viewBase = options.viewBase.replace(/\/+$/, "");

	async function call(browserId: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
		let response: Response;
		try {
			response = await options.host.fetch(browserId, path, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			if (signal?.aborted === true) throw new KantelError("aborted", "The browser call was cancelled");
			throw new KantelError(
				"unavailable",
				`The browser host could not be reached: ${error instanceof Error ? error.name : "error"}`,
			);
		}
		const text = await response.text();
		let parsed: unknown = null;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = null;
		}
		if (!response.ok) {
			const error = record(record(parsed).error);
			throw new KantelError(
				codeFor(response.status, error.code),
				str(error.message).slice(0, 300) || `The browser host answered ${response.status}`,
			);
		}
		return parsed;
	}

	async function viewLink(browserId: string, mode: BrowserViewMode, minutes: number, control: boolean) {
		const expiresAt = now() + Math.min(MAX_VIEW_MINUTES, Math.max(1, minutes)) * 60_000;
		const token = await options.views.sign({
			browser: browserId,
			mode,
			control: mode === "live" && control,
			expiresAt,
		});
		const url = `${viewBase}/${encodeURIComponent(browserId)}#${token}`;
		return { url, expiresAt, embed: { url, endMessage: KANTEL_VIEW_END_MESSAGE } };
	}

	return {
		async open(input) {
			const browserId = newId();
			await call(browserId, "POST", "/start", {
				contextId: input.providerContextId,
				persist: input.persist,
				timeoutMs: input.timeoutMs,
				// The browser's own guard admits the consent page a grant's site redirects through, as the broker does.
				sites: sitesWithConsent(input.allowedSites ?? []),
			});
			return { providerSessionId: browserId, cdpUrl: `harbour-browser:${browserId}` };
		},

		async release(browserId) {
			let reply: unknown;
			try {
				reply = await call(browserId, "POST", "/release");
			} catch (error) {
				if (error instanceof KantelError && (error.code === "expired" || error.code === "not_found")) return;
				throw error;
			}
			// What the coordinator stored, for `browser.recording.stored`: counts only, each checked.
			const stored = record(record(reply).recording);
			const count = (value: unknown) =>
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
			const pages = count(stored.pages);
			const frames = count(stored.frames);
			const durationMs = count(stored.durationMs);
			const expiresAt = count(stored.expiresAt);
			if (pages === undefined || frames === undefined || durationMs === undefined || expiresAt === undefined) return;
			return { recording: { pages, frames, durationMs, expiresAt } };
		},

		async act(browserId, action, signal) {
			if (action.kind === "look")
				return parsePage(await call(browserId, "GET", "/look", undefined, signal), true, undefined);
			const reply = record(await call(browserId, "POST", "/act", { action }, signal));
			const did = typeof reply.did === "string" ? reply.did : undefined;
			const page =
				reply.page === undefined || reply.page === null
					? await call(browserId, "GET", "/look", undefined, signal)
					: reply.page;
			return parsePage(page, reply.success === true, did);
		},

		async run(browserId, goal, runOptions, signal): Promise<BrowserRunResult> {
			const reply = record(await call(browserId, "POST", "/run", { goal, model: runOptions.model }, signal));
			return parseRun(reply);
		},

		async screenshot(browserId, signal): Promise<BrowserScreenshot> {
			const shot = record(await call(browserId, "GET", "/screenshot", undefined, signal));
			if (typeof shot.data !== "string" || shot.data === "") {
				throw new KantelError("unavailable", "The browser returned no screenshot");
			}
			return {
				mimeType: shot.mimeType === "image/png" ? "image/png" : "image/jpeg",
				data: shot.data,
				url: str(shot.url),
				title: str(shot.title),
			};
		},

		async share(browserId, minutes, signal, shareOptions) {
			const status = record(await call(browserId, "GET", "/status", undefined, signal));
			if (status.status !== "running") throw new KantelError("expired", "The browser has ended");
			const link = await viewLink(browserId, "live", minutes, shareOptions?.control ?? true);
			const ends = Number(status.expiresAt);
			// A link never outlives its browser.
			return Number.isFinite(ends) && ends < link.expiresAt ? { ...link, expiresAt: ends } : link;
		},

		async replay(browserId, minutes, signal) {
			const manifest = record(await call(browserId, "GET", "/recording", undefined, signal));
			if (manifest.status === "none") throw new KantelError("not_found", "This browser has no recording");
			return viewLink(browserId, "replay", minutes, false);
		},

		viewLink,
	};
}

/** A host client over HTTP: the self-hosted browser host, from a gateway that is not on the same machine. */
export function httpBrowserHost(options: {
	readonly url: string;
	readonly token: string;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): BrowserHostClient {
	const base = options.url.replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	return {
		fetch(browserId, path, init = {}) {
			const headers = new Headers(init.headers);
			headers.set("authorization", `Bearer ${options.token}`);
			return doFetch(`${base}/browsers/${encodeURIComponent(browserId)}${path}`, { ...init, headers });
		},
	};
}
