// The session conformance suite through the HTTP API: the in-memory runtime behind `createSessionApi`, reached only
// through `createSessionApiClient`, with host tools served over signed callbacks. Requests never leave the process:
// the client's fetch calls the API's handler, and the API's callback fetch calls the host's endpoint.
import { type Authentication, type Authenticator, authenticationError, type CallContext } from "@harbour/contracts";
import { bearerToken, createSessionApi, createSessionApiClient } from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { registerRuntimeConformance } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";

/** Test only: the token is the caller's actor and organisation, so the suite's contexts reach the server unchanged. */
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
	"session runtime over HTTP",
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
		const endpoints = new Map<string, (request: Request) => Promise<Response>>();
		const api = createSessionApi({
			runtime: memory.runtime,
			directory: memory.directory,
			profiles: memory.profiles,
			hostTools: memory.hostTools,
			authenticator: contextAuthenticator,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const endpoint = endpoints.get(new URL(request.url).pathname);
				return endpoint === undefined ? new Response("no host here", { status: 404 }) : endpoint(request);
			},
		});
		const client = createSessionApiClient({
			baseUrl: "https://harbour.test/v1",
			credentials: (ctx) => ({ authorization: `Bearer ${tokenFor(ctx)}` }),
			fetch: async (input, init) => api.fetch(new Request(input, init)),
			hostCallbacks: {
				url: (hostId) => `https://host.test/tools/${hostId}`,
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
			await memory.close();
		}
	},
	{ projectAccess: true },
);
