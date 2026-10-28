// The session conformance suite over real sockets: the API and the host's callback endpoint each behind a Node HTTP
// server, the client on the global fetch. This checks what the in-process run cannot: that a closed event stream and
// an aborted callback reach the other side as a dropped connection.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Authentication, type Authenticator, authenticationError, type CallContext } from "@harbour/contracts";
import { bearerToken, createSessionApi, createSessionApiClient } from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";

type FetchHandler = (request: Request) => Promise<Response>;

/** Serves a fetch handler on 127.0.0.1; a client that disconnects aborts the request's signal. */
async function serve(handler: FetchHandler): Promise<{ readonly url: string; close(): Promise<void> }> {
	const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
		const controller = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) controller.abort();
		});
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", async () => {
			const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (typeof value === "string") headers.set(name, value);
			}
			const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
				method: incoming.method ?? "GET",
				headers,
				signal: controller.signal,
				...(body === undefined || incoming.method === "GET" ? {} : { body }),
			});
			const response = await handler(request);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.flushHeaders();
			if (response.body === null) {
				outgoing.end();
				return;
			}
			const reader = response.body.getReader();
			outgoing.on("close", () => void reader.cancel().catch(() => {}));
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					outgoing.write(value);
				}
			} catch {
				// The client went away.
			}
			outgoing.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

const tokenFor = (ctx: CallContext): string =>
	btoa(JSON.stringify({ actor: ctx.actor, organisationId: ctx.organisationId }));

const contextAuthenticator: Authenticator = {
	async authenticate(request) {
		const token = bearerToken(request);
		if (token === undefined) throw authenticationError("missing", "No credentials");
		return { ...(JSON.parse(atob(token)) as Authentication), method: "api_key" };
	},
};

registerRuntimeConformance(
	{ describe, expect, it },
	"session runtime over HTTP sockets",
	async (deps, use) => {
		const { models, script } = createScriptedModel();
		const memory = createMemoryRuntime({
			clock: deps.clock,
			audit: deps.audit,
			models,
			identity: deps.tenancy.identity,
			sandboxes: {
				releaseSession: async (_ctx, sessionId) => {
					deps.releaseSession(sessionId);
				},
			},
		});
		const endpoints = new Map<string, FetchHandler>();
		const host = await serve(async (request) => {
			const endpoint = endpoints.get(new URL(request.url).pathname);
			return endpoint === undefined ? new Response("no host here", { status: 404 }) : endpoint(request);
		});
		const api = createSessionApi({
			runtime: memory.runtime,
			history: memory.history,
			directory: memory.directory,
			profiles: memory.profiles,
			hostTools: memory.hostTools,
			authenticator: contextAuthenticator,
			allowCallbackUrl: (url) => url.origin === host.url,
		});
		const harbour = await serve(api.fetch);
		const client = createSessionApiClient({
			baseUrl: `${harbour.url}/v1`,
			credentials: (ctx) => ({ authorization: `Bearer ${tokenFor(ctx)}` }),
			hostCallbacks: {
				url: (hostId) => `${host.url}/tools/${hostId}`,
				serve: (hostId, endpoint) => {
					if (endpoint === undefined) endpoints.delete(`/tools/${hostId}`);
					else endpoints.set(`/tools/${hostId}`, endpoint);
				},
			},
		});
		try {
			await use({
				...client,
				model: script,
				releasedSessions: deps.releasedSessions,
				sessionEnd: memory.sessionEnd,
			});
		} finally {
			await api.close();
			await harbour.close();
			await host.close();
			await memory.close();
		}
	},
	{ projectAccess: true, history: true },
);
