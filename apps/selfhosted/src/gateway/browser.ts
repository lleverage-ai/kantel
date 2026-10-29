// The browser behind the self-hosted gateway (#24, docs/design/browser-runtime.md): the same session browser as
// Cloudflare's (`@harbour/browser/session`: the broker, its tools, people's decisions, the console's links), over
// Harbour's own browsers on the self-hosted browser host (`src/browser/host.ts`), so a self-hosted Harbour needs no
// brwsr.dev. brwsr stays possible, with its key.
//
//   HARBOUR_BROWSER_PROVIDER     `harbour` or `brwsr`. Unset: `harbour` when a browser host is set, else `brwsr` when
//                                brwsr's key is, else the gateway has no browser
//   HARBOUR_BROWSER_HOST_URL     the browser host, such as http://browser-host:8790 (harbour)
//   HARBOUR_BROWSER_HOST_TOKEN   its bearer token, 32 characters or more (a secret; the host holds the same)
//   HARBOUR_BROWSER_VIEW_KEY     signs view links, 32 characters or more (a secret; the host holds the same)
//   HARBOUR_EMBED_ORIGINS        the origins (a host app's) that may frame the viewer page, besides the console
//   HARBOUR_BRWSR_API_KEY, HARBOUR_BRWSR_API_URL   brwsr.dev's project key and API (brwsr)
//
// A viewer's requests (`/v1/browser/view/{browser}/…`) carry their own token, checked here and again by the host,
// and go to the host with only the token and a socket's upgrade headers. The live socket is proxied message by message
// (`ws`, which Bun serves natively), since the viewer's page and its socket are on the console's origin.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { BRWSR_API_URL, createBrwsrProvider } from "@harbour/browser/brwsr";
import {
	BROWSER_VIEW_API,
	BROWSER_VIEW_BASE,
	browserProviderName,
	createBrowserViewSigner,
	createHarbourBrowserProvider,
	httpBrowserHost,
	VIEW_FORWARD_HEADERS,
	VIEW_PROTOCOL,
	viewClaims,
} from "@harbour/browser/runtime";
import { createSessionBrowser, type SessionBrowser } from "@harbour/browser/session";
import {
	type AuditSink,
	type BrowserProvider,
	type Clock,
	type ProjectAccess,
	type SessionRecord,
	systemClock,
} from "@harbour/contracts";
import type { SessionRuntimeOptions } from "@harbour/runtime/core";
import WebSocket, { WebSocketServer } from "ws";

/**
 * The sessions' browser over `provider`: the broker, its tools and the console's links. The deployment's context in an
 * organisation is registered by the gateway itself, a system actor, on the organisation's first grant.
 */
export function gatewaySessionBrowser(options: {
	readonly provider: BrowserProvider;
	readonly audit: AuditSink;
	readonly access: ProjectAccess;
	readonly clock?: Clock;
}): SessionBrowser {
	return createSessionBrowser({
		provider: options.provider,
		audit: options.audit,
		clock: options.clock ?? systemClock,
		access: options.access,
		admin: (organisationId) => ({ actor: { kind: "system", component: "selfhosted-browser" }, organisationId }),
	});
}

/** The runtime's tools with the browser's beside them: every session gets the browser's, bound to it. */
export function withBrowserTools(
	tools: SessionRuntimeOptions["tools"],
	browser: SessionBrowser | undefined,
): SessionRuntimeOptions["tools"] {
	if (browser === undefined) return tools;
	return (record: SessionRecord) => [...(tools?.(record) ?? []), ...browser.tools(record)];
}

export type GatewayBrowserConfig =
	| {
			readonly provider: "harbour";
			readonly hostUrl: string;
			readonly hostToken: string;
			readonly viewKey: string;
			readonly embedOrigins?: string;
	  }
	| { readonly provider: "brwsr"; readonly apiKey: string; readonly apiUrl?: string };

/** The gateway's browser from its environment, or `undefined` for none. Refuses a harbour setup missing a part. */
export function browserConfig(env: NodeJS.ProcessEnv = process.env): GatewayBrowserConfig | undefined {
	const read = (name: string) => env[name]?.trim() ?? "";
	const hostUrl = read("HARBOUR_BROWSER_HOST_URL").replace(/\/+$/, "");
	const apiKey = read("HARBOUR_BRWSR_API_KEY");
	const named = read("HARBOUR_BROWSER_PROVIDER");
	const provider = named !== "" ? browserProviderName(named) : hostUrl !== "" ? "harbour" : "brwsr";
	if (provider === "brwsr") {
		if (apiKey === "") return undefined;
		const apiUrl = read("HARBOUR_BRWSR_API_URL");
		return { provider, apiKey, ...(apiUrl === "" ? {} : { apiUrl }) };
	}
	const hostToken = read("HARBOUR_BROWSER_HOST_TOKEN");
	const viewKey = read("HARBOUR_BROWSER_VIEW_KEY");
	if (hostUrl === "") throw new Error("HARBOUR_BROWSER_PROVIDER=harbour needs HARBOUR_BROWSER_HOST_URL");
	if (!/^https?:\/\//.test(hostUrl)) throw new Error("HARBOUR_BROWSER_HOST_URL must be an http(s) URL");
	if (hostToken.length < 32) throw new Error("HARBOUR_BROWSER_HOST_TOKEN must be 32 characters or more");
	if (viewKey.length < 32) throw new Error("HARBOUR_BROWSER_VIEW_KEY must be 32 characters or more");
	const embedOrigins = read("HARBOUR_EMBED_ORIGINS");
	return { provider, hostUrl, hostToken, viewKey, ...(embedOrigins === "" ? {} : { embedOrigins }) };
}

/** What `/v1/deployment` says backs the browser. */
export function browserBinding(config: GatewayBrowserConfig | undefined): string {
	if (config === undefined) return "none";
	return config.provider === "harbour" ? "harbour (self-hosted browser host)" : "brwsr";
}

/** The broker's provider for the configuration. Harbour's links are relative (`/browser/<browser>#<token>`). */
export function gatewayBrowserProvider(
	config: GatewayBrowserConfig,
	options: { readonly fetch?: typeof fetch } = {},
): BrowserProvider {
	if (config.provider === "brwsr") {
		return createBrwsrProvider({
			apiKey: config.apiKey,
			apiUrl: config.apiUrl ?? BRWSR_API_URL,
			userMetadata: { agent: "harbour" },
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		});
	}
	return createHarbourBrowserProvider({
		host: httpBrowserHost({
			url: config.hostUrl,
			token: config.hostToken,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		}),
		views: createBrowserViewSigner(config.viewKey),
		viewBase: BROWSER_VIEW_BASE,
	});
}

/** Whether `path` is a viewer's request, which carries its own token and is no API caller's. */
export const isViewPath = (path: string): boolean => path.startsWith(BROWSER_VIEW_API);

const viewRefused = () =>
	Response.json(
		{ error: { code: "expired", message: "This view link has expired or is not valid" } },
		{ status: 401, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
	);

export interface BrowserViews {
	/** A viewer's HTTP request (status, a recording's manifest or chunk), passed to the host once its token checks out. */
	fetch(request: Request): Promise<Response>;
	/** A viewer's live socket: proxied to the host once its token checks out, else refused. */
	upgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** The viewers' routes, for a harbour configuration. */
export function createBrowserViews(
	config: Extract<GatewayBrowserConfig, { provider: "harbour" }>,
	options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): BrowserViews {
	const signer = createBrowserViewSigner(config.viewKey);
	const send = options.fetch ?? fetch;
	const now = options.now ?? (() => Date.now());
	const sockets = new WebSocketServer({
		noServer: true,
		// The host answers the view protocol; so does this end, and nothing else.
		handleProtocols: (offered) => (offered.has(VIEW_PROTOCOL) ? VIEW_PROTOCOL : false),
	});

	const forwarded = (from: Headers): Headers => {
		const headers = new Headers();
		for (const name of VIEW_FORWARD_HEADERS) {
			const value = from.get(name);
			if (value !== null) headers.set(name, value);
		}
		return headers;
	};

	return {
		async fetch(request) {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return Response.json({ error: { code: "invalid", message: "GET only" } }, { status: 405 });
			}
			if ((await viewClaims(request, signer, now())) === undefined) return viewRefused();
			const url = new URL(request.url);
			const headers = forwarded(request.headers);
			headers.delete("upgrade");
			headers.delete("connection");
			const answer = await send(`${config.hostUrl}${url.pathname}${url.search}`, { method: request.method, headers });
			const out = new Headers(answer.headers);
			out.set("referrer-policy", "no-referrer");
			return new Response(answer.body, { status: answer.status, headers: out });
		},
		upgrade(incoming, socket, head) {
			const refuse = (status: number, text: string) => {
				socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			};
			const path = incoming.url ?? "/";
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (typeof value === "string") headers.set(name, value);
			}
			const asRequest = new Request(`http://gateway${path}`, { headers });
			void viewClaims(asRequest, signer, now()).then(
				(checked) => {
					if (checked === undefined) return refuse(401, "Unauthorized");
					const offered = (headers.get("sec-websocket-protocol") ?? "")
						.split(",")
						.map((each) => each.trim())
						.filter((each) => each !== "");
					const upstreamHeaders: { [name: string]: string } = {};
					const authorization = headers.get("authorization");
					if (authorization !== null) upstreamHeaders.authorization = authorization;
					const target = `${config.hostUrl.replace(/^http/, "ws")}${path}`;
					const upstream = new WebSocket(target, offered, { headers: upstreamHeaders });
					const early: { data: WebSocket.RawData; binary: boolean }[] = [];
					let viewer: WebSocket | undefined;
					// The host refusing the upgrade is an `error` too (Bun's `ws` has no `unexpected-response`).
					upstream.on("error", () => {
						if (viewer === undefined) refuse(502, "Bad Gateway");
						else viewer.close(1011, "The browser host went away");
					});
					upstream.on("open", () => {
						sockets.handleUpgrade(incoming, socket, head, (accepted) => {
							viewer = accepted;
							accepted.on("message", (data, binary) => {
								if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
							});
							accepted.on("close", (code) => upstream.close(validClose(code)));
							accepted.on("error", () => upstream.terminate());
							for (const each of early.splice(0)) accepted.send(each.data, { binary: each.binary });
						});
					});
					upstream.on("message", (data, binary) => {
						if (viewer === undefined) early.push({ data, binary });
						else if (viewer.readyState === WebSocket.OPEN) viewer.send(data, { binary });
					});
					upstream.on("close", (code, reason) => viewer?.close(validClose(code), reason.toString()));
				},
				() => refuse(500, "Internal Server Error"),
			);
		},
	};
}

/** A close code a socket may send on: the reserved ones (1005, 1006, 1015) become a normal close. */
function validClose(code: number): number {
	return code === 1000 ||
		(code >= 3000 && code < 5000) ||
		(code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)
		? code
		: 1000;
}
