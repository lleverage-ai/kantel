/**
 * The isolate's way out (#331): every request a command's `curl` or `wget` makes goes through the deployment's
 * `IsolateEgress`, which the connections service's egress gate implements (`connectionEgress` in
 * `@kantel/connections/egress`). The sandbox holds placeholders, never credentials; the gate puts a credential on
 * only for a placeholder the session may use, to one of its connection's hosts.
 *
 * This module adapts it to just-bash's `fetch` option, following redirects as curl does: a hop to another origin
 * drops the `Authorization`, `Cookie` and `Proxy-Authorization` headers, so a placeholder never follows a redirect off
 * its host. Every hop goes through the gate again.
 */
import type { CallContext, SandboxLease } from "@kantel/contracts";

/** One outbound request as the sandbox made it. Header names are lower case. */
export interface EgressRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: Uint8Array;
	readonly signal?: AbortSignal;
}

export interface EgressResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
	readonly url: string;
}

export type EgressFetch = (request: EgressRequest) => Promise<EgressResponse>;

/** What one command's network goes through. */
export interface IsolateEgress {
	/**
	 * For one command on a lease: the fetch its HTTP clients use, and the environment variables it gets (connection
	 * placeholders, never a secret). Read per command, so a connection added or a share stopped counts from the next one.
	 */
	forCommand(input: { readonly ctx: CallContext; readonly lease: SandboxLease }): Promise<{
		readonly fetch: EgressFetch;
		readonly env?: { readonly [name: string]: string };
	}>;
}

/** just-bash's `SecureFetch` options and result, as its `fetch` option takes them. */
export interface ShellFetchOptions {
	method?: string;
	headers?: Headers | Record<string, string>;
	body?: string | Uint8Array;
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
	redirectChain?: { status: number; statusText: string; headers: Record<string, string>; url: string }[];
}

export type ShellFetch = (url: string, options?: ShellFetchOptions) => Promise<ShellFetchResult>;

const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Headers that never follow a redirect to another origin, as curl drops them. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function headerPairs(headers: ShellFetchOptions["headers"]): [string, string][] {
	if (headers === undefined) return [];
	const out: [string, string][] = [];
	if (headers instanceof Headers) {
		for (const [name, value] of headers) out.push([name.toLowerCase(), value]);
	} else for (const [name, value] of Object.entries(headers)) out.push([name.toLowerCase(), value]);
	return out;
}

/** just-bash's `fetch` over the egress, following redirects as curl does. */
export function shellFetch(egress: EgressFetch, outer?: AbortSignal): ShellFetch {
	return async (url, options = {}) => {
		const signals = [AbortSignal.timeout(Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS))];
		if (options.signal !== undefined) signals.push(options.signal);
		if (outer !== undefined) signals.push(outer);
		const signal = AbortSignal.any(signals);
		let method = (options.method ?? "GET").toUpperCase();
		let headers = headerPairs(options.headers);
		let body = typeof options.body === "string" ? new TextEncoder().encode(options.body) : options.body;
		let target = url;
		const chain: NonNullable<ShellFetchResult["redirectChain"]> = [];
		const limit = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
		for (;;) {
			const response = await egress({
				method,
				url: target,
				headers,
				...(body === undefined ? {} : { body }),
				signal,
			});
			const location = response.headers.location;
			if (options.followRedirects !== true || !REDIRECTS.has(response.status) || location === undefined) {
				return {
					status: response.status,
					statusText: response.statusText,
					headers: { ...response.headers },
					body: response.body,
					url: response.url,
					...(chain.length === 0 ? {} : { redirectChain: chain }),
				};
			}
			if (chain.length >= limit) throw new Error(`Too many redirects (max ${limit})`);
			chain.push({
				status: response.status,
				statusText: response.statusText,
				headers: { ...response.headers },
				url: target,
			});
			const next = new URL(location, target);
			if (next.origin !== new URL(target).origin) headers = headers.filter(([name]) => !CREDENTIAL_HEADERS.has(name));
			// 303, and a 301 or 302 after a POST, turn into a GET with no body, as curl and browsers do.
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
				method = "GET";
				body = undefined;
				headers = headers.filter(([name]) => name !== "content-type" && name !== "content-length");
			}
			target = next.href;
		}
	};
}
