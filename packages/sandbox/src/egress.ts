/**
 * The isolate's egress gate (#331): every request the shell's `curl` or `wget` sends is put to the connections service
 * first (`SandboxEgress`), the same on Cloudflare and self-hosted, since both run this shell.
 *
 * - `pass`: nothing of a connection's in it, so it goes out as it is (`upstream`), with no credential.
 * - `respond`: the service sent it with the connection's credential in the placeholder's place; the sandbox gets the
 *   answer with the credential cut out. A redirect is given back, not followed.
 *
 * A redirect `curl -L` follows is a request of its own: each hop is put to the gate again, never sent past it.
 * - `refuse`: nothing went out; the sandbox gets an HTTP 403 whose JSON body is an `EgressRefusal`.
 *
 * If the gate can't decide (the service is down), nothing goes out: an `unavailable` refusal, never a pass.
 */
import {
	type CallContext,
	type EgressRefusal,
	egressRefusalResponse,
	type SandboxEgress,
	type SandboxEgressRequest,
	type SessionId,
} from "@kantel/contracts";

/** What just-bash's `curl` and `wget` call (its `SecureFetch`), restated so this module needs only its shape. */
export interface ShellFetchOptions {
	method?: string;
	headers?: Headers | Record<string, string>;
	body?: string | Uint8Array<ArrayBuffer>;
	followRedirects?: boolean;
	timeoutMs?: number;
	maxRedirects?: number;
	signal?: AbortSignal;
}
export interface ShellFetchResult {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: Uint8Array;
	url: string;
	redirectChain?: Array<{ status: number; statusText: string; headers: Record<string, string> }>;
}
export type ShellFetch = (url: string, options?: ShellFetchOptions) => Promise<ShellFetchResult>;

/** A session's egress, bound to the call that runs the command. */
export interface BoundEgress {
	readonly egress: SandboxEgress;
	readonly ctx: CallContext;
	readonly sessionId: SessionId;
}

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 20;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function headerRecord(headers: Headers | Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (headers === undefined) return out;
	const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
	for (const [name, value] of entries) out[name.toLowerCase()] = String(value);
	return out;
}

function bodyBytes(body: string | Uint8Array | undefined): Uint8Array | undefined {
	if (body === undefined) return undefined;
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * A plain fetch for what passes the gate: redirects followed when asked (each hop carries nothing of a connection's,
 * since the first didn't), a timeout, and a size limit.
 */
export function plainShellFetch(fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)): ShellFetch {
	return async (url, options = {}) => {
		const timeout = AbortSignal.timeout(Math.min(options.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS));
		const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
		const chain: NonNullable<ShellFetchResult["redirectChain"]> = [];
		let current = url;
		let method = (options.method ?? "GET").toUpperCase();
		let body = bodyBytes(options.body);
		const headers = headerRecord(options.headers);
		const most = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
		for (let hop = 0; ; hop += 1) {
			const response = await fetcher(current, {
				method,
				headers,
				...(body === undefined || method === "GET" || method === "HEAD"
					? {}
					: { body: body as Uint8Array<ArrayBuffer> }),
				redirect: "manual",
				signal,
			});
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				responseHeaders[name] = value;
			});
			const location = response.headers.get("location");
			if (options.followRedirects === true && location !== null && response.status >= 300 && response.status < 400) {
				if (hop >= most) throw new Error(`Too many redirects (max ${most})`);
				await response.body?.cancel().catch(() => undefined);
				chain.push({ status: response.status, statusText: response.statusText, headers: responseHeaders });
				current = new URL(location, current).href;
				if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
					method = "GET";
					body = undefined;
				}
				continue;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > MAX_RESPONSE_BYTES)
				throw new Error(`Response too large (max ${MAX_RESPONSE_BYTES} bytes)`);
			return {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body: bytes,
				url: current,
				...(chain.length === 0 ? {} : { redirectChain: chain }),
			};
		}
	};
}

function refusalResult(url: string, refusal: EgressRefusal): ShellFetchResult {
	const response = egressRefusalResponse(refusal);
	return {
		status: response.status,
		statusText: "Forbidden",
		headers: { ...response.headers },
		body: new TextEncoder().encode(response.body),
		url,
	};
}

/** The shell's fetch with the gate in front of it, every redirect hop included. */
export function gatedShellFetch(bound: BoundEgress, upstream: ShellFetch = plainShellFetch()): ShellFetch {
	const once = gatedOnce(bound, upstream);
	return async (url, options = {}) => {
		const most = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
		const chain: NonNullable<ShellFetchResult["redirectChain"]> = [];
		let current = url;
		let method = (options.method ?? "GET").toUpperCase();
		let body = options.body;
		for (let hop = 0; ; hop += 1) {
			const { result, credentialed } = await once(current, {
				...options,
				method,
				body,
				followRedirects: false,
			});
			const location = result.headers.location;
			const redirect = result.status >= 300 && result.status < 400 && location !== undefined;
			// A credentialed answer's redirect is given back: the credential doesn't follow it anywhere.
			if (options.followRedirects !== true || !redirect || credentialed) {
				return chain.length === 0 ? result : { ...result, redirectChain: chain };
			}
			if (hop >= most) throw new Error(`Too many redirects (max ${most})`);
			chain.push({ status: result.status, statusText: result.statusText, headers: result.headers });
			current = new URL(location, current).href;
			if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST")) {
				method = "GET";
				body = undefined;
			}
		}
	};
}

/** One request through the gate, redirects not followed. */
function gatedOnce(
	bound: BoundEgress,
	upstream: ShellFetch,
): (url: string, options: ShellFetchOptions) => Promise<{ result: ShellFetchResult; credentialed: boolean }> {
	return async (url, options) => {
		const body = bodyBytes(options.body);
		const request: SandboxEgressRequest = {
			method: (options.method ?? "GET").toUpperCase(),
			url,
			headers: headerRecord(options.headers),
			...(body === undefined ? {} : { body }),
		};
		let verdict: Awaited<ReturnType<SandboxEgress["decide"]>>;
		try {
			verdict = await bound.egress.decide(bound.ctx, bound.sessionId, request);
		} catch {
			return {
				result: refusalResult(url, {
					error: "unavailable",
					message: "Kantel couldn't check this request, so nothing was sent. Try again shortly.",
				}),
				credentialed: false,
			};
		}
		switch (verdict.outcome) {
			case "pass":
				return { result: await upstream(url, options), credentialed: false };
			case "refuse":
				return { result: refusalResult(url, verdict.refusal), credentialed: false };
			case "respond": {
				const { response } = verdict;
				return {
					result: {
						status: response.status,
						statusText: response.statusText ?? "",
						headers: {
							...response.headers,
							...(response.truncated === true ? { "x-kantel-truncated": "true" } : {}),
						},
						body: response.body,
						url,
					},
					credentialed: true,
				};
			}
		}
	};
}
