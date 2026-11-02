// The model providers' stand-in host, in the page, for `source=recorded`: an organisation with nothing connected yet,
// which the person (an admin) can connect, test, set the default on and remove, all in memory. A test answers after a
// moment with a plausible list per provider; the key `bad`, or no key on a new connection, is refused as a provider
// would. `source=api` calls `/v1/model-providers` instead (`api/model-providers-http.ts`).

import {
	cloudflareAiGatewayBaseUrl,
	MODEL_PROVIDER_PRESETS,
	type ModelProvider,
	type ModelProviderConnection,
	type ModelProviderDefault,
	type ModelProviderInput,
	type ModelProviderModel,
	type ModelProvidersState,
} from "@kantel/contracts";
import { type ConsoleModelProviders, ModelProvidersApiError } from "../api/model-providers-http.ts";

const MODELS: { readonly [provider in ModelProvider]: readonly ModelProviderModel[] } = {
	openrouter: [
		{ id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", contextWindow: 1_000_000 },
		{ id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1", contextWindow: 200_000 },
		{ id: "openai/gpt-5", name: "OpenAI: GPT-5", contextWindow: 400_000 },
		{ id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini", contextWindow: 400_000 },
		{ id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", contextWindow: 1_048_576 },
		{ id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", contextWindow: 1_048_576 },
		{ id: "x-ai/grok-4", name: "xAI: Grok 4", contextWindow: 256_000 },
		{ id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek: DeepSeek V3.1", contextWindow: 163_840 },
		{ id: "meta-llama/llama-4-maverick", name: "Meta: Llama 4 Maverick", contextWindow: 1_048_576 },
		{ id: "mistralai/mistral-large-2411", name: "Mistral Large 2411", contextWindow: 131_072 },
		{ id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder", contextWindow: 262_144 },
		{ id: "moonshotai/kimi-k2", name: "MoonshotAI: Kimi K2", contextWindow: 131_072 },
	],
	cliproxyapi: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }, { id: "gemini-2.5-pro" }],
	litellm: [{ id: "gpt-5" }, { id: "claude-sonnet-4-5" }, { id: "gemini-2.5-flash" }, { id: "llama-3.3-70b" }],
	"cloudflare-ai-gateway": [
		{ id: "openai/gpt-5" },
		{ id: "anthropic/claude-sonnet-4-5" },
		{ id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
	],
};

/** How long a test takes to answer, as a provider's model list does. */
const TEST_MS = 600;

const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal === undefined) return;
		const stopped = signal;
		stopped.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(stopped.reason);
		});
	});

/** Where the input points, as the server works it out. */
function baseUrlOf(input: ModelProviderInput): string {
	const preset = MODEL_PROVIDER_PRESETS[input.provider];
	if (preset.baseUrl === "cloudflare") {
		return cloudflareAiGatewayBaseUrl(input.accountId ?? "", input.gatewayId ?? "default");
	}
	if (preset.baseUrl === "fixed") return preset.defaultBaseUrl ?? "";
	return input.baseUrl ?? preset.defaultBaseUrl ?? "";
}

function refuse(input: ModelProviderInput, saved: boolean): void {
	const label = MODEL_PROVIDER_PRESETS[input.provider].label;
	if (input.apiKey === "bad") {
		throw new ModelProvidersApiError("provider_refused", `${label} refused the key: 401 Unauthorized`);
	}
	if ((input.apiKey === undefined || input.apiKey === "") && !saved) {
		throw new ModelProvidersApiError("invalid_request", `${label} needs a key to connect.`);
	}
	if (MODEL_PROVIDER_PRESETS[input.provider].baseUrl === "cloudflare" && (input.accountId ?? "") === "") {
		throw new ModelProvidersApiError("invalid_request", "Cloudflare AI Gateway needs your Cloudflare account ID.");
	}
	if (MODEL_PROVIDER_PRESETS[input.provider].baseUrl === "url" && baseUrlOf(input) === "") {
		throw new ModelProvidersApiError("invalid_request", `${label} needs a base URL.`);
	}
}

export function createRecordedModelProviders(): ConsoleModelProviders {
	let connections: ModelProviderConnection[] = [];
	let chosen: ModelProviderDefault | undefined;
	const state = (): ModelProvidersState => ({
		configured: chosen !== undefined,
		canManage: true,
		connections: [...connections],
		...(chosen === undefined ? {} : { default: chosen }),
	});
	return {
		state: async () => state(),
		test: async (input, signal) => {
			await wait(TEST_MS, signal);
			const saved = connections.some((connection) => connection.id === input.connectionId);
			refuse(input, saved);
			return MODELS[input.provider];
		},
		save: async (id, input) => {
			const before = connections.find((connection) => connection.id === id);
			refuse(input, before !== undefined);
			const now = new Date().toISOString();
			const cloudflare = MODEL_PROVIDER_PRESETS[input.provider].baseUrl === "cloudflare";
			const saved: ModelProviderConnection = {
				id,
				provider: input.provider,
				baseUrl: baseUrlOf(input),
				...(cloudflare && input.accountId !== undefined ? { accountId: input.accountId } : {}),
				...(cloudflare ? { gatewayId: input.gatewayId ?? "default" } : {}),
				vaultItemId: before?.vaultItemId ?? `vlt_${id}`,
				createdAt: before?.createdAt ?? now,
				updatedAt: now,
			};
			connections = before === undefined ? [...connections, saved] : connections.map((c) => (c.id === id ? saved : c));
			return saved;
		},
		remove: async (id) => {
			connections = connections.filter((connection) => connection.id !== id);
			if (chosen?.connectionId === id) chosen = undefined;
		},
		models: async (id, signal) => {
			const connection = connections.find((candidate) => candidate.id === id);
			if (connection === undefined) throw new ModelProvidersApiError("not_found", `There's no connection ${id}.`);
			await wait(TEST_MS / 2, signal);
			return MODELS[connection.provider];
		},
		setDefault: async ({ connectionId, modelId }) => {
			if (!connections.some((connection) => connection.id === connectionId)) {
				throw new ModelProvidersApiError("not_found", `There's no connection ${connectionId}.`);
			}
			chosen = { connectionId, modelId, updatedAt: new Date().toISOString() };
			return chosen;
		},
	};
}
