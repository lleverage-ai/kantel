import type { ModelProviderConnection, ModelProvidersState } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { apiModelProviders, ModelProvidersApiError } from "./model-providers-http.ts";

const CONNECTION: ModelProviderConnection = {
	id: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	vaultItemId: "vlt_1",
	createdAt: "2026-11-01T00:00:00Z",
	updatedAt: "2026-11-01T00:00:00Z",
};

const STATE: ModelProvidersState = {
	configured: true,
	canManage: true,
	connections: [CONNECTION],
	default: { connectionId: "openrouter", modelId: "openai/gpt-5" },
};

const MODELS = { items: [{ id: "openai/gpt-5", name: "GPT-5" }] };

describe("the model providers' seam", () => {
	it("calls each route with its method and body, and reads the answers", async () => {
		const seen: string[] = [];
		const headers: (Record<string, string> | undefined)[] = [];
		const providers = apiModelProviders({
			headers: () => ({ authorization: "Bearer t" }),
			fetch: async (input, init) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				seen.push(`${method} ${url} ${init?.body ?? ""}`);
				headers.push(init?.headers as Record<string, string> | undefined);
				if (method === "DELETE") return new Response(null, { status: 204 });
				if (url.endsWith("/model-providers")) return Response.json(STATE);
				if (url.endsWith("/test") || url.endsWith("/models")) return Response.json(MODELS);
				if (url.endsWith("/default")) return Response.json({ connectionId: "openrouter", modelId: "openai/gpt-5" });
				return Response.json(CONNECTION);
			},
		});
		expect(await providers.state()).toEqual(STATE);
		expect(await providers.test({ provider: "openrouter", apiKey: "sk-or" })).toEqual(MODELS.items);
		expect(await providers.test({ provider: "openrouter", connectionId: "openrouter" })).toEqual(MODELS.items);
		expect(await providers.save("openrouter", { provider: "openrouter", apiKey: "sk-or" })).toEqual(CONNECTION);
		expect(await providers.models("my connection")).toEqual(MODELS.items);
		expect(await providers.setDefault({ connectionId: "openrouter", modelId: "openai/gpt-5" })).toEqual({
			connectionId: "openrouter",
			modelId: "openai/gpt-5",
		});
		await expect(providers.remove("openrouter")).resolves.toBeUndefined();
		expect(seen).toEqual([
			"GET /v1/model-providers ",
			'POST /v1/model-providers/test {"provider":"openrouter","apiKey":"sk-or"}',
			'POST /v1/model-providers/test {"provider":"openrouter","connectionId":"openrouter"}',
			'PUT /v1/model-providers/connections/openrouter {"provider":"openrouter","apiKey":"sk-or"}',
			"GET /v1/model-providers/connections/my%20connection/models ",
			'PUT /v1/model-providers/default {"connectionId":"openrouter","modelId":"openai/gpt-5"}',
			"DELETE /v1/model-providers/connections/openrouter ",
		]);
		expect(headers[0]).toMatchObject({ accept: "application/json", authorization: "Bearer t" });
		expect(headers[0]).not.toHaveProperty("content-type");
		expect(headers[1]).toMatchObject({ "content-type": "application/json", authorization: "Bearer t" });
	});

	it("rejects with the API's code and message, and says when the sign-in has ended", async () => {
		let signedOut = 0;
		const providers = apiModelProviders({
			baseUrl: "https://kantel.example/v1",
			onUnauthenticated: () => {
				signedOut += 1;
			},
			fetch: async (input) => {
				const url = String(input);
				if (url.endsWith("/test")) {
					return Response.json(
						{ error: { code: "provider_refused", message: "OpenRouter refused the key" } },
						{ status: 422 },
					);
				}
				if (url.endsWith("/default")) return new Response("upstream gone", { status: 502, statusText: "Bad Gateway" });
				return Response.json({ error: { code: "unauthenticated", message: "Sign in again" } }, { status: 401 });
			},
		});
		const refused = await providers.test({ provider: "openrouter", apiKey: "bad" }).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(ModelProvidersApiError);
		expect(refused).toMatchObject({ code: "provider_refused", message: "OpenRouter refused the key" });
		const gone = await providers.setDefault({ connectionId: "x", modelId: "y" }).catch((error: unknown) => error);
		expect(gone).toMatchObject({ code: "unavailable", message: "502 Bad Gateway" });
		const ended = await providers.state().catch((error: unknown) => error);
		expect(ended).toMatchObject({ code: "unauthenticated" });
		expect(signedOut).toBe(1);
	});

	it("doesn't read a body from a 204", async () => {
		const providers = apiModelProviders({
			fetch: async () => {
				const response = new Response(null, { status: 204 });
				Object.defineProperty(response, "json", {
					value: () => {
						throw new Error("read a 204's body");
					},
				});
				return response;
			},
		});
		await expect(providers.remove("litellm")).resolves.toBeUndefined();
	});
});
