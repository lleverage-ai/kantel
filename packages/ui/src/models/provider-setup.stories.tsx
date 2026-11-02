import { MODEL_PROVIDER_PRESETS, type ModelProvider, type ModelProviderModel } from "@kantel/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	ProviderSetup,
	type ProviderSetupFields,
	type ProviderSetupProps,
	type ProviderTestState,
} from "./provider-setup.tsx";

export default { title: "Models/Provider setup" } satisfies StoryDefault;

const EMPTY: ProviderSetupFields = { baseUrl: "", accountId: "", gatewayId: "", apiKey: "" };

const OPENROUTER_MODELS: readonly ModelProviderModel[] = [
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
];

/** The form with working fields, a test that answers after a moment and a save that does. */
function Live({
	variant = "onboarding",
	initial,
	keySaved,
}: {
	variant?: ProviderSetupProps["variant"];
	initial?: ModelProvider;
	keySaved?: boolean;
}) {
	const [provider, setProvider] = useState<ModelProvider | undefined>(initial);
	const [fields, setFields] = useState<ProviderSetupFields>(
		initial === undefined
			? EMPTY
			: { ...EMPTY, baseUrl: MODEL_PROVIDER_PRESETS[initial].defaultBaseUrl ?? "", gatewayId: "default" },
	);
	const [test, setTest] = useState<ProviderTestState>({ status: "idle" });
	const [defaultModel, setDefaultModel] = useState<string>();
	const [saving, setSaving] = useState(false);
	return (
		<ProviderSetup
			variant={variant}
			{...(provider === undefined ? {} : { provider })}
			onProvider={(next) => {
				setProvider(next);
				setFields({ ...EMPTY, baseUrl: MODEL_PROVIDER_PRESETS[next].defaultBaseUrl ?? "", gatewayId: "default" });
				setTest({ status: "idle" });
				setDefaultModel(undefined);
			}}
			fields={fields}
			onField={(name, value) => {
				setFields((now) => ({ ...now, [name]: value }));
				setTest({ status: "idle" });
			}}
			{...(keySaved === undefined ? {} : { keySaved })}
			test={test}
			onTest={() => {
				setTest({ status: "running" });
				setTimeout(() => {
					setTest(
						fields.apiKey === "bad" || (fields.apiKey === "" && keySaved !== true)
							? { status: "error", message: "The provider refused the key (401 Unauthorized)" }
							: { status: "ok", models: OPENROUTER_MODELS },
					);
				}, 600);
			}}
			{...(defaultModel === undefined ? {} : { defaultModel })}
			onDefaultModel={setDefaultModel}
			saving={saving}
			onSave={() => {
				setSaving(true);
				setTimeout(() => setSaving(false), 800);
			}}
			onSkip={() => {}}
			onCancel={() => {}}
		/>
	);
}

/** First run, nothing picked yet: the four providers. */
export const Picker: Story = () => <Live />;

/** Every state on a working form: pick a provider, type a key (`bad` fails) and test it. */
export const Interactive: Story = () => <Live initial="cliproxyapi" />;

/** OpenRouter tested: its models listed, one picked as the default, ready to save. */
export const OpenRouterTested: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="openrouter"
		fields={{ ...EMPTY, baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-0000" }}
		test={{ status: "ok", models: OPENROUTER_MODELS }}
		defaultModel="anthropic/claude-sonnet-4.5"
		onSkip={() => {}}
	/>
);

/** Cloudflare AI Gateway: the account and gateway, and the address they make. */
export const AiGateway: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="cloudflare-ai-gateway"
		fields={{ ...EMPTY, accountId: "0123456789abcdef0123456789abcdef", gatewayId: "default" }}
		test={{ status: "idle" }}
		onSkip={() => {}}
	/>
);

/** The test failed: what the provider said. */
export const TestFailed: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="litellm"
		fields={{ ...EMPTY, baseUrl: "http://host.docker.internal:4000/v1", apiKey: "sk-bad" }}
		test={{ status: "error", message: "LiteLLM refused the key: 401 Authentication Error" }}
		onSkip={() => {}}
	/>
);

export const Testing: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="cliproxyapi"
		fields={{ ...EMPTY, baseUrl: "http://host.docker.internal:8317/v1", apiKey: "cpa-key" }}
		test={{ status: "running" }}
		onSkip={() => {}}
	/>
);

/** Saving, and a save that failed. */
export const Saving: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="openrouter"
		fields={{ ...EMPTY, apiKey: "sk-or-v1-0000" }}
		test={{ status: "ok", models: OPENROUTER_MODELS.slice(0, 4) }}
		defaultModel="openai/gpt-5"
		saving
		onSkip={() => {}}
	/>
);

export const SaveFailed: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="openrouter"
		fields={{ ...EMPTY, apiKey: "sk-or-v1-0000" }}
		test={{ status: "ok", models: OPENROUTER_MODELS.slice(0, 4) }}
		defaultModel="openai/gpt-5"
		saveError="The vault refused the key: it is over 4 KB"
		onSkip={() => {}}
	/>
);

/** The provider answered with an empty list. */
export const NoModels: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="litellm"
		fields={{ ...EMPTY, baseUrl: "http://host.docker.internal:4000/v1", apiKey: "sk-1234" }}
		test={{ status: "ok", models: [] }}
		onSkip={() => {}}
	/>
);

/** On the Models page: the card alone, with Cancel; editing a saved connection keeps its key. */
export const Settings: Story = () => <Live variant="settings" initial="openrouter" keySaved />;

/** Someone who isn't an organisation admin: shown, but nothing works. */
export const ReadOnly: Story = () => (
	<ProviderSetup
		variant="onboarding"
		provider="openrouter"
		fields={EMPTY}
		test={{ status: "idle" }}
		readOnlyReason="Connecting a model needs an organisation admin."
		onSkip={() => {}}
	/>
);
