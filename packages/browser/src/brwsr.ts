/**
 * The brwsr provider: the broker's `BrowserProvider` over brwsr.dev (tvdavies/brwsr), a Browserbase-compatible
 * browser service. It holds the brwsr project key; nothing it returns carries it.
 *
 * - `open` starts a keepAlive session on the grant's context (Browserbase's `POST /v1/sessions`), so the agent may
 *   disconnect and reconnect over CDP; the broker owns the lease and releases it (`REQUEST_RELEASE`).
 * - `act` runs one model-free Reflex step in the session's container (`/brwsr/v1/sessions/{id}/reflex/act` and
 *   `/reflex/look`), which needs only the project key.
 * - `screenshot` captures the page over a short-lived CDP connection.
 * - `share` makes a live-view link with control (`/brwsr/v1/sessions/{id}/shares`).
 *
 * Portable: `fetch` and `WebSocket` only, no Node APIs.
 */
import {
	type BrowserAction,
	type BrowserPage,
	type BrowserProvider,
	type BrowserScreenshot,
	type BrowserShareLink,
	type ErrorCode,
	HarbourError,
} from "@harbour/contracts";

export const BRWSR_API_URL = "https://api.brwsr.dev";

/** brwsr's own bounds on a session's `timeout`, in seconds. */
export const BRWSR_MIN_TIMEOUT_S = 60;
export const BRWSR_MAX_TIMEOUT_S = 21_600;

export interface BrwsrProviderOptions {
	/** The brwsr project key (`x-bb-api-key`). */
	readonly apiKey: string;
	/** Default `https://api.brwsr.dev`. */
	readonly apiUrl?: string;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	/** Opens the CDP connection a screenshot uses. Default: the global `WebSocket`. */
	readonly webSocket?: (url: string) => WebSocket;
	/** Shown on each session in brwsr's dashboard, such as `{ agent: "harbour" }`. Never a secret. */
	readonly userMetadata?: { readonly [key: string]: string };
	/** How long one API request or CDP command may take. Default 60 s. */
	readonly requestTimeoutMs?: number;
}

export interface BrwsrBrowserProvider extends BrowserProvider {
	/**
	 * The ID of the brwsr context named `name`, made if there is none yet, for an operator's `putContext`. Names are
	 * unique per brwsr project, whatever their case.
	 */
	contextId(name: string, signal?: AbortSignal): Promise<string>;
}

/** A brwsr HTTP status as a Harbour error code. `session` marks calls on one session, where 404 and 409 mean it ended. */
function codeFor(status: number, session: boolean): ErrorCode {
	if (status === 400 || status === 422) return "invalid";
	if (session && (status === 404 || status === 409 || status === 410)) return "expired";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 429) return "exhausted";
	return "unavailable";
}

function record(value: unknown): { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: unknown })
		: {};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Reflex's page (`look`, or `page` in an act's reply) as a `BrowserPage`. */
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

/** The body of a Reflex act for a step other than `look`. */
function reflexBody(action: Exclude<BrowserAction, { readonly kind: "look" }>): { readonly [key: string]: string } {
	switch (action.kind) {
		case "goto":
			return { verb: "goto", url: action.url };
		case "click":
		case "check":
			return { verb: action.kind, element: action.element };
		case "fill":
		case "select":
			return { verb: action.kind, element: action.element, value: action.value };
		case "press":
			return { verb: "press", key: action.key };
		case "scroll":
		case "wait":
			return { verb: action.kind };
	}
}

export function createBrwsrProvider(options: BrwsrProviderOptions): BrwsrBrowserProvider {
	const apiUrl = (options.apiUrl ?? BRWSR_API_URL).replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const openSocket = options.webSocket ?? ((url: string) => new WebSocket(url));
	const timeoutMs = options.requestTimeoutMs ?? 60_000;
	if (options.apiKey.trim().length === 0) throw new HarbourError("invalid", "The brwsr provider needs a project key");

	async function request(
		method: string,
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
		session: boolean,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(timeoutMs);
		let response: Response;
		try {
			response = await doFetch(`${apiUrl}${path}`, {
				method,
				headers: {
					"x-bb-api-key": options.apiKey,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
			});
		} catch (error) {
			if (signal?.aborted === true) throw new HarbourError("aborted", `brwsr ${method} was cancelled`);
			throw new HarbourError("unavailable", `brwsr could not be reached: ${errorName(error)}`);
		}
		const text = await response.text();
		let parsed: unknown = null;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = null;
		}
		if (!response.ok) {
			const raw = record(parsed);
			const message = (str(raw.message) || str(raw.error) || `HTTP ${response.status}`).slice(0, 300);
			throw new HarbourError(codeFor(response.status, session), `brwsr: ${message}`, { status: response.status });
		}
		return parsed;
	}

	const sessionPath = (providerSessionId: string) => `/v1/sessions/${encodeURIComponent(providerSessionId)}`;
	const brwsrPath = (providerSessionId: string) => `/brwsr/v1/sessions/${encodeURIComponent(providerSessionId)}`;

	async function findContext(name: string, signal: AbortSignal | undefined): Promise<string | undefined> {
		const found = await request("GET", `/v1/contexts?name=${encodeURIComponent(name)}`, undefined, signal, false);
		const first = Array.isArray(found) ? record(found[0]) : {};
		return typeof first.id === "string" ? first.id : undefined;
	}

	async function release(providerSessionId: string): Promise<void> {
		try {
			await request("POST", sessionPath(providerSessionId), { status: "REQUEST_RELEASE" }, undefined, true);
		} catch (error) {
			// Already gone is released.
			if (error instanceof HarbourError && error.code === "expired") return;
			throw error;
		}
	}

	return {
		async open(input) {
			const seconds = Math.min(BRWSR_MAX_TIMEOUT_S, Math.max(BRWSR_MIN_TIMEOUT_S, Math.ceil(input.timeoutMs / 1000)));
			const created = record(
				await request(
					"POST",
					"/v1/sessions",
					{
						keepAlive: true,
						timeout: seconds,
						browserSettings: { context: { id: input.providerContextId, persist: input.persist } },
						...(options.userMetadata === undefined ? {} : { userMetadata: options.userMetadata }),
					},
					undefined,
					false,
				),
			);
			const providerSessionId = str(created.id);
			if (providerSessionId === "") throw new HarbourError("unavailable", "brwsr returned a session with no ID");
			const cdpUrl = str(created.connectUrl);
			if (cdpUrl === "") {
				await release(providerSessionId).catch(() => undefined);
				throw new HarbourError("unavailable", "brwsr returned a session with no CDP URL");
			}
			return { providerSessionId, cdpUrl };
		},

		release,

		async act(providerSessionId, action, signal) {
			if (action.kind === "look") {
				return parsePage(
					await request("GET", `${brwsrPath(providerSessionId)}/reflex/look`, undefined, signal, true),
					true,
					undefined,
				);
			}
			const reply = record(
				await request("POST", `${brwsrPath(providerSessionId)}/reflex/act`, reflexBody(action), signal, true),
			);
			const succeeded = reply.success === true;
			const did = typeof reply.did === "string" ? reply.did : undefined;
			const page =
				reply.page === undefined || reply.page === null
					? await request("GET", `${brwsrPath(providerSessionId)}/reflex/look`, undefined, signal, true)
					: reply.page;
			return parsePage(page, succeeded, did);
		},

		async screenshot(providerSessionId, signal) {
			const session = record(await request("GET", sessionPath(providerSessionId), undefined, signal, true));
			const connectUrl = str(session.connectUrl);
			if (str(session.status) !== "RUNNING" || connectUrl === "") {
				throw new HarbourError("expired", `brwsr session ${providerSessionId} is not running`);
			}
			return captureScreenshot(openSocket(connectUrl), timeoutMs, signal);
		},

		async share(providerSessionId, minutes, signal) {
			const raw = record(
				await request("POST", `${brwsrPath(providerSessionId)}/shares`, { control: true, minutes }, signal, true),
			);
			const url = str(raw.url);
			if (!url.startsWith("https://")) throw new HarbourError("unavailable", "brwsr returned no share link");
			const expiresAt = Date.parse(str(raw.expiresAt));
			const link: BrowserShareLink = { url, ...(Number.isFinite(expiresAt) ? { expiresAt } : {}) };
			return link;
		},

		async contextId(name, signal) {
			if (name.trim().length === 0) throw new HarbourError("invalid", "A brwsr context needs a name");
			const found = await findContext(name, signal);
			if (found !== undefined) return found;
			try {
				const made = record(await request("POST", "/v1/contexts", { name }, signal, false));
				if (typeof made.id === "string") return made.id;
			} catch (error) {
				// Made meanwhile by another caller: look it up again.
				if (!(error instanceof HarbourError && error.code === "conflict")) throw error;
			}
			const again = await findContext(name, signal);
			if (again === undefined) throw new HarbourError("unavailable", `brwsr made no context named ${name}`);
			return again;
		},
	};
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "error";
}

/**
 * Connects over CDP, attaches to the session's page (the first that is not blank, else the first), captures it as a
 * JPEG and disconnects. The connection is keepAlive-safe: brwsr keeps the browser after it closes.
 */
async function captureScreenshot(
	socket: WebSocket,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<BrowserScreenshot> {
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let next = 0;
	const failAll = (error: Error) => {
		for (const waiting of pending.values()) waiting.reject(error);
		pending.clear();
	};
	const onAbort = () => {
		failAll(new HarbourError("aborted", "The screenshot was cancelled"));
		socket.close();
	};
	const onClose = () => failAll(new HarbourError("unavailable", "The browser's CDP connection closed"));
	// Listeners rather than `on*` properties: Cloudflare's WebSocket has only `addEventListener`.
	const onMessage = (event: { readonly data: unknown }) => {
		let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
		try {
			message = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const waiting = pending.get(message.id);
		if (waiting === undefined) return;
		pending.delete(message.id);
		if (message.error !== undefined) {
			waiting.reject(new HarbourError("unavailable", `CDP: ${str(message.error.message) || "error"}`));
		} else {
			waiting.resolve(message.result ?? {});
		}
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new HarbourError("unavailable", "The browser's CDP connection did not open in time")),
				timeoutMs,
			);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new HarbourError("unavailable", "Could not connect to the browser over CDP"));
			});
			if (signal?.aborted === true) reject(new HarbourError("aborted", "The screenshot was cancelled"));
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.addEventListener("message", onMessage);
		socket.addEventListener("close", onClose);
		const send = (method: string, params: object, sessionId?: string): Promise<{ readonly [key: string]: unknown }> => {
			next += 1;
			const id = next;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new HarbourError("unavailable", `CDP ${method} timed out`));
				}, timeoutMs);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer);
						resolve(record(value));
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
				socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
			});
		};
		const { targetInfos } = await send("Target.getTargets", {});
		const pages = (Array.isArray(targetInfos) ? targetInfos : [])
			.map(record)
			.filter((target) => target.type === "page" && !str(target.url).startsWith("devtools://"));
		const target = pages.find((candidate) => str(candidate.url) !== "about:blank") ?? pages[0];
		if (target === undefined) throw new HarbourError("expired", "The browser has no open page");
		const attached = await send("Target.attachToTarget", { targetId: str(target.targetId), flatten: true });
		const pageSession = str(attached.sessionId);
		if (pageSession === "") throw new HarbourError("unavailable", "Could not attach to the browser's page");
		const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75 }, pageSession);
		const data = str(shot.data);
		if (data === "") throw new HarbourError("unavailable", "The browser returned no screenshot");
		return { url: str(target.url), title: str(target.title), mimeType: "image/jpeg", data };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		socket.removeEventListener("close", onClose);
		socket.removeEventListener("message", onMessage);
		failAll(new HarbourError("aborted", "The CDP connection was closed"));
		try {
			socket.close();
		} catch {
			// Already closed.
		}
	}
}
