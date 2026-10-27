// `pnpm dev`'s way to the session API: a Vite middleware that forwards /v1 to a local gateway
// (`pnpm --filter @harbour/cloudflare dev`, http://127.0.0.1:8787 by default) and signs each call in as the dev admin,
// with a token from the gateway's mock Access issuer (`/__dev/access-token`). Deployed, Cloudflare Access adds that
// header at the edge; this stands in for it on a laptop. Only `vite` (serve) uses it; nothing of it is in a build.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Plugin } from "vite";

const ACCESS_HEADER = "cf-access-jwt-assertion";
/** Hop-by-hop headers, and the ones fetch has already acted on, which mustn't be passed on. */
const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "host", "content-length", "content-encoding"]);
/** Dev tokens last an hour; a fresh one is fetched well before that. */
const TOKEN_MS = 30 * 60_000;

export function devGateway(target: string): Plugin {
	let token: { value: string; until: number } | undefined;
	const accessToken = async (fresh = false): Promise<string> => {
		if (!fresh && token !== undefined && token.until > Date.now()) return token.value;
		const response = await fetch(`${target}/__dev/access-token`);
		if (!response.ok) throw new Error(`the gateway's /__dev/access-token answered ${response.status}`);
		const body = (await response.json()) as { token: string };
		token = { value: body.token, until: Date.now() + TOKEN_MS };
		return token.value;
	};

	const forward = async (req: IncomingMessage, res: ServerResponse) => {
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || DROP.has(name)) continue;
			headers.set(name, Array.isArray(value) ? value.join(", ") : value);
		}
		const controller = new AbortController();
		res.on("close", () => controller.abort());
		// The API's request bodies are small JSON; held whole so a call can be sent twice.
		const chunks: Buffer[] = [];
		if (req.method !== "GET" && req.method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer);
		const send = async (fresh: boolean) => {
			headers.set(ACCESS_HEADER, await accessToken(fresh));
			return fetch(`${target}${req.url ?? "/"}`, {
				method: req.method ?? "GET",
				headers,
				signal: controller.signal,
				...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
			});
		};
		// The local gateway keeps its state, mock issuer included, in memory, and starts afresh when wrangler restarts
		// its object; a token from before then is refused, so a refusal is tried once more with a new one.
		let response = await send(false);
		if (response.status === 401) {
			await response.body?.cancel();
			response = await send(true);
		}
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

	return {
		name: "harbour-dev-gateway",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = req.url ?? "";
				if (path !== "/v1" && !path.startsWith("/v1/") && !path.startsWith("/v1?")) {
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
								message: `No Harbour gateway at ${target} (${reason instanceof Error ? reason.message : String(reason)}). Start one with pnpm --filter @harbour/cloudflare dev, or open the console with ?source=recorded.`,
							},
						}),
					);
				});
			});
		},
	};
}
