// `pnpm dev`'s way to the session API: a Vite middleware that forwards /v1 to a local gateway
// (`pnpm --filter @kantel/cloudflare dev`, http://127.0.0.1:8787 by default) and signs each call in as the dev admin,
// with a token from the gateway's mock Access issuer (`/__dev/access-token`). Deployed, Cloudflare Access adds that
// header at the edge; this stands in for it on a laptop. Only `vite` (serve) uses it; nothing of it is in a build.
//
// WebSocket upgrades under /v1 (a session's events, a browser's live view) never reach a middleware: Node hands them
// to the server's `upgrade` listeners, and Vite's own (HMR) leaves any other one hanging, so the browser's socket
// stays CONNECTING and the session page on Connecting. The plugin forwards those upgrades too, signed in the same way.

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import type { Plugin } from "vite";

const ACCESS_HEADER = "cf-access-jwt-assertion";
/** Hop-by-hop headers, and the ones fetch has already acted on, which mustn't be passed on. */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "host", "content-length", "content-encoding"]);
/** The headers a refused upgrade's answer loses, as it is sent on with `connection: close` and no length. */
const REFUSAL_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);
const isApi = (path: string) => path === "/v1" || path.startsWith("/v1/") || path.startsWith("/v1?");
export function devGateway(target: string, email?: string): Plugin {
	// `KANTEL_DEV_EMAIL` (vite.config.ts) signs in as someone other than the dev admin, such as the viewer
	// `POST /__dev/vault-seed` invites, to see a forwarded vault request as they do.
	const tokenUrl = `${target}/__dev/access-token${email === undefined ? "" : `?email=${encodeURIComponent(email)}`}`;
	// A new token for every call. The local gateway keeps its state, mock issuer included, in memory and starts afresh
	// when wrangler restarts its object. A token from before a restart would be refused, and would make the new issuer's
	// keys be fetched before it has any, so its tokens are refused too until the key cache's 30-second cooldown ends.
	const accessToken = async (): Promise<string> => {
		const response = await fetch(tokenUrl);
		if (!response.ok) throw new Error(`the gateway's /__dev/access-token answered ${response.status}`);
		return ((await response.json()) as { token: string }).token;
	};

	const forward = async (req: IncomingMessage, res: ServerResponse) => {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || DROP.has(name)) continue;
			headers.set(name, Array.isArray(value) ? value.join(", ") : value);
		}
		const controller = new AbortController();
		res.on("close", () => controller.abort());
		headers.set(ACCESS_HEADER, await accessToken());
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const response = await fetch(`${target}${req.url ?? "/"}`, {
			method: req.method ?? "GET",
			headers,
			signal: controller.signal,
			...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
		} as RequestInit);
		const out: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (!DROP.has(name)) out[name] = value;
		});
		res.writeHead(response.status, out);
		if (response.body === null) res.end();
		else {
			const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
			// The page went away (an event stream closed) or the gateway did: end this response, not the dev server.
			body.on("error", () => res.destroy());
			body.pipe(res);
		}
	};

	// An upgrade goes to the gateway as it came, with the Access header added. The gateway's answer, a 101 or a refusal,
	// goes back to the browser as it came; after a 101 the two sockets are piped together until either ends.
	const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on("error", () => socket.destroy());
		const token = await accessToken();
		if (socket.destroyed) return;
		const url = new URL(req.url ?? "/", target);
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (value !== undefined && name !== "host") headers[name] = value;
		}
		headers[ACCESS_HEADER] = token;
		const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: req.method, headers });
		const statusLine = (status: number | undefined, text: string | undefined, raw: readonly string[]) => {
			const lines = [`HTTP/1.1 ${status ?? 502} ${text ?? ""}`];
			for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
			return `${lines.join("\r\n")}\r\n\r\n`;
		};
		outgoing.on("upgrade", (response, upstream, upstreamHead) => {
			upstream.on("error", () => socket.destroy());
			socket.on("close", () => upstream.destroy());
			upstream.on("close", () => socket.destroy());
			socket.write(statusLine(response.statusCode, response.statusMessage, response.rawHeaders));
			if (upstreamHead.length > 0) socket.write(upstreamHead);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		// The gateway refused the upgrade: pass its answer on, and the browser's socket fails (the console falls back).
		outgoing.on("response", (response) => {
			// Node has already undone any chunking, not any compression; the body runs until the socket closes.
			const kept: string[] = [];
			for (let i = 0; i < response.rawHeaders.length; i += 2) {
				const name = response.rawHeaders[i]!;
				if (REFUSAL_DROP.has(name.toLowerCase())) continue;
				kept.push(name, response.rawHeaders[i + 1]!);
			}
			socket.write(statusLine(response.statusCode, response.statusMessage, [...kept, "connection", "close"]));
			response.pipe(socket);
		});
		outgoing.on("error", () => socket.destroy());
		outgoing.end();
	};

	return {
		name: "kantel-dev-gateway",
		apply: "serve",
		configureServer(server) {
			server.httpServer?.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
				if (!isApi(req.url ?? "")) return;
				upgrade(req, socket, head).catch(() => socket.destroy());
			});
			server.middlewares.use((req, res, next) => {
				if (!isApi(req.url ?? "")) {
					next();
					return;
				}
				forward(req, res).catch((reason: unknown) => {
					if (res.headersSent) {
						res.destroy();
						return;
					}
					res.writeHead(502, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "unavailable",
								message: `No Kantel gateway at ${target} (${reason instanceof Error ? reason.message : String(reason)}). Start one with pnpm --filter @kantel/cloudflare dev, or open the console with ?source=recorded.`,
							},
						}),
					);
				});
			});
		},
	};
}
