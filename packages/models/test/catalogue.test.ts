import type { ModelConnector } from "@kantel/contracts";
import {
	CATALOGUE_RETRY_MS,
	type CatalogueKeys,
	createModelCatalogue,
	findPiModel,
	parseCatalogueListing,
	upstreamModel,
} from "@kantel/models/catalogue";
import { catalogueUrl, upstreamBaseUrl } from "@kantel/models/presets";
import { ManualClock } from "@kantel/testing/harness";
import { describe, expect, it, vi } from "vitest";

const scope = { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "sess-1" };

function connector(overrides: Partial<ModelConnector> = {}): ModelConnector {
	return {
		id: "cpa",
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		baseUrl: "http://cpa.internal:8317/v1",
		vaultItemId: "item-cpa",
		catalogue: { refresh: "gateway" },
		createdAt: 0,
		updatedAt: 1,
		...overrides,
	};
}

describe("parseCatalogueListing", () => {
	it("reads OpenAI, Anthropic, OpenRouter and LiteLLM listings", () => {
		expect(parseCatalogueListing({ data: [{ id: "gpt-5", object: "model" }] })).toEqual([{ id: "gpt-5" }]);
		expect(
			parseCatalogueListing({
				data: [{ id: "claude-x", display_name: "Claude X", max_input_tokens: 200000, max_tokens: 64000 }],
			}),
		).toEqual([{ id: "claude-x", name: "Claude X", contextWindow: 200000, maxTokens: 64000 }]);
		expect(
			parseCatalogueListing({
				data: [
					{
						id: "anthropic/claude-x",
						name: "Claude X",
						context_length: 200000,
						top_provider: { max_completion_tokens: 32000 },
						pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
					},
				],
			}),
		).toEqual([
			{
				id: "anthropic/claude-x",
				name: "Claude X",
				contextWindow: 200000,
				maxTokens: 32000,
				rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			},
		]);
		expect(
			parseCatalogueListing({
				data: [
					{
						model_name: "lleverage-default",
						model_info: {
							max_input_tokens: 100000,
							max_output_tokens: 8000,
							input_cost_per_token: 1e-6,
							output_cost_per_token: 2e-6,
						},
					},
				],
			}),
		).toEqual([
			{
				id: "lleverage-default",
				contextWindow: 100000,
				maxTokens: 8000,
				rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
		]);
		expect(parseCatalogueListing({ nope: true })).toEqual([]);
		expect(parseCatalogueListing({ data: [{ id: "" }, null, 3] })).toEqual([]);
	});
});

describe("upstreamModel", () => {
	it("joins pi's catalogue by ID, the preset choosing the wire API and base URL", () => {
		const claude = upstreamModel(connector(), "claude-sonnet-4-5");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.model.baseUrl).toBe("http://cpa.internal:8317");
		expect(claude?.model.provider).toBe("cliproxyapi");
		expect(claude?.model.contextWindow).toBe(200_000);
		expect(upstreamModel(connector(), "gpt-5")?.api).toBe("openai-responses");
		expect(upstreamModel(connector(), "gpt-5")?.model.baseUrl).toBe("http://cpa.internal:8317/v1");
		expect(upstreamModel(connector(), "gemini-2.5-pro")?.api).toBe("openai-completions");
	});

	it("borrows metadata through override.canonical, overrides winning over the listing and pi", () => {
		const litellm = connector({
			preset: "litellm",
			catalogue: {
				refresh: "gateway",
				overrides: { "house-sonnet": { canonical: "claude-sonnet-4-5", maxTokens: 1000, name: "House" } },
			},
		});
		const offered = upstreamModel(litellm, "house-sonnet", {
			id: "house-sonnet",
			contextWindow: 150_000,
			maxTokens: 2000,
		});
		expect(offered?.model).toMatchObject({
			id: "house-sonnet",
			name: "House",
			api: "anthropic-messages",
			contextWindow: 150_000,
			maxTokens: 1000,
			reasoning: true,
		});
		expect(offered?.model.cost.input).toBe(3);
	});

	it("offers a model with no pi match only when an override gives its limits", () => {
		expect(upstreamModel(connector(), "mystery-model")).toBeUndefined();
		const described = connector({
			catalogue: { refresh: "static", overrides: { "mystery-model": { contextWindow: 8000, maxTokens: 1000 } } },
		});
		expect(upstreamModel(described, "mystery-model")?.model).toMatchObject({ contextWindow: 8000, reasoning: false });
	});

	it("finds pi models by provider prefix and in the preset's own catalogue first", () => {
		expect(findPiModel("anthropic/claude-sonnet-4.5", "openrouter")?.provider).toBe("openrouter");
		expect(findPiModel("anthropic/claude-sonnet-4-5")?.provider).toBe("anthropic");
		expect(findPiModel("no-such-model")).toBeUndefined();
	});

	it("places the catalogue and the APIs under the connector's root", () => {
		expect(catalogueUrl(connector())).toBe("http://cpa.internal:8317/v1/models");
		expect(catalogueUrl(connector({ preset: "litellm", baseUrl: "https://llm.example.com/v1/" }))).toBe(
			"https://llm.example.com/model/info",
		);
		expect(catalogueUrl(connector({ preset: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }))).toBe(
			"https://openrouter.ai/api/v1/models",
		);
		expect(upstreamBaseUrl("https://api.anthropic.com", "anthropic-messages")).toBe("https://api.anthropic.com");
	});
});

describe("createModelCatalogue", () => {
	function setup(respond: () => Response | Promise<Response>) {
		const clock = new ManualClock();
		let reads = 0;
		let dropped = 0;
		let fetches = 0;
		const keys: CatalogueKeys = {
			async key() {
				reads += 1;
				return "sk-cat";
			},
			drop() {
				dropped += 1;
			},
		};
		const catalogue = createModelCatalogue({
			keys,
			clock,
			ttlMs: 1000,
			fetch: async () => {
				fetches += 1;
				return respond();
			},
		});
		return { clock, catalogue, counts: () => ({ reads, dropped, fetches }) };
	}

	const listing = () =>
		new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }, { id: "mystery" }] }));

	it("refreshes from the upstream once per TTL, deduplicating concurrent refreshes", async () => {
		const { clock, catalogue, counts } = setup(listing);
		const [a, b] = await Promise.all([catalogue.offered(connector(), scope), catalogue.offered(connector(), scope)]);
		expect([...a.keys()]).toEqual(["claude-sonnet-4-5", "gpt-5"]);
		expect([...b.keys()]).toEqual([...a.keys()]);
		expect(counts().fetches).toBe(1);
		await catalogue.offered(connector(), scope);
		expect(counts().fetches).toBe(1);
		clock.advance(1000);
		await catalogue.offered(connector(), scope);
		expect(counts().fetches).toBe(2);
		await catalogue.offered(connector({ updatedAt: 2 }), scope);
		expect(counts().fetches).toBe(3);
	});

	it("limits to include, and falls back to include and overrides while the upstream fails", async () => {
		const { catalogue, counts } = setup(() => new Response("nope", { status: 401 }));
		const limited = connector({
			catalogue: { refresh: "gateway", include: ["gpt-5"], overrides: { local: { contextWindow: 1, maxTokens: 1 } } },
		});
		expect([...(await catalogue.offered(limited, scope)).keys()]).toEqual(["gpt-5"]);
		expect(counts().dropped).toBe(1);
		const ok = setup(listing);
		expect([...(await ok.catalogue.offered(limited, scope)).keys()]).toEqual(["gpt-5"]);
	});

	it("waits before retrying a failed refresh, keeping the last listing meanwhile", async () => {
		let fail = false;
		const { clock, catalogue, counts } = setup(() => (fail ? new Response("down", { status: 503 }) : listing()));
		expect((await catalogue.offered(connector(), scope)).size).toBe(2);
		fail = true;
		clock.advance(1000);
		expect((await catalogue.offered(connector(), scope)).size).toBe(2);
		expect(counts().fetches).toBe(2);
		clock.advance(5000);
		await catalogue.offered(connector(), scope);
		expect(counts().fetches).toBe(2);
		clock.advance(5000);
		await catalogue.offered(connector(), scope);
		expect(counts().fetches).toBe(3);
	});

	it("redacts the key from listed names and drops models whose ID holds it", async () => {
		const { catalogue } = setup(
			() =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "claude-sonnet-4-5", name: "Claude via sk-cat" },
							{ id: "echo-sk-cat", name: "Echo" },
						],
					}),
				),
		);
		const echoing = connector({
			catalogue: { refresh: "gateway", overrides: { "echo-sk-cat": { contextWindow: 1000, maxTokens: 100 } } },
		});
		const offered = await catalogue.offered(echoing, scope);
		expect(offered.get("claude-sonnet-4-5")?.model.name).toBe("Claude via [kantel:redacted]");
		expect([...offered.keys()]).toEqual(["claude-sonnet-4-5"]);
	});

	it("bounds a refresh by its timeout, and lets a caller abort its wait without ending the refresh", async () => {
		const clock = new ManualClock();
		const seen: AbortSignal[] = [];
		let answer: (() => void) | undefined;
		const catalogue = createModelCatalogue({
			keys: { key: async () => "sk-cat", drop() {} },
			clock,
			refreshTimeoutMs: 300,
			fetch: async (_input, init) => {
				const signal = init?.signal as AbortSignal;
				seen.push(signal);
				await new Promise<void>((resolve, reject) => {
					answer = resolve;
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				return listing();
			},
		});
		const limited = connector({ catalogue: { refresh: "gateway", include: ["gpt-5"] } });
		const started = Date.now();
		expect([...(await catalogue.offered(limited, scope)).keys()]).toEqual(["gpt-5"]);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(seen[0]?.aborted).toBe(true);

		clock.advance(CATALOGUE_RETRY_MS);
		const caller = new AbortController();
		const waiting = catalogue.offered(connector(), scope, caller.signal);
		const other = catalogue.offered(connector(), scope);
		await vi.waitFor(() => expect(seen).toHaveLength(2), { interval: 1 });
		caller.abort(new Error("gone"));
		await expect(waiting).rejects.toThrow("gone");
		expect(seen[1]?.aborted).toBe(false);
		answer?.();
		expect([...(await other).keys()]).toEqual(["claude-sonnet-4-5", "gpt-5"]);
		await expect(catalogue.offered(connector(), scope, caller.signal)).rejects.toThrow("gone");
	});

	it("reads no upstream for a static catalogue", async () => {
		const { catalogue, counts } = setup(listing);
		const fixed = connector({ catalogue: { refresh: "static", include: ["claude-sonnet-4-5"] } });
		expect([...(await catalogue.offered(fixed, scope)).keys()]).toEqual(["claude-sonnet-4-5"]);
		expect(counts()).toEqual({ reads: 0, dropped: 0, fetches: 0 });
	});
});
