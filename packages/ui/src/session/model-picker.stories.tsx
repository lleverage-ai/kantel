import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { type ComposerModelOption, ModelPicker } from "./model-picker.tsx";
import { pickerFrame } from "./story-frames.ts";
import type { ThinkingLevel } from "./thinking-model.ts";

export default { title: "Session/Model picker" } satisfies StoryDefault;

const levels: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];
const model = (id: string, label: string, provider: string, extra: Partial<ComposerModelOption> = {}) =>
	({ id, label, provider, capabilities: { images: true, thinking: levels }, ...extra }) satisfies ComposerModelOption;

/** A deployed gateway's catalogue, in the gateway's order: the picker orders it. */
const live: ComposerModelOption[] = [
	model("default", "Claude Sonnet 5.5", "Anthropic", { default: true }),
	model("default:claude-sonnet-5", "Claude Sonnet 5", "Anthropic"),
	model("default:claude-opus-5-5", "Claude Opus 5.5", "Anthropic"),
	model("default:gpt-6-sol", "GPT-6 Sol", "OpenAI"),
	model("default:gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI"),
	model("default:claude-haiku-5-5", "Claude Haiku 5.5", "Anthropic"),
	model("default:gpt-5.6-luna", "GPT-5.6 Luna", "OpenAI"),
	model("default:claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic"),
	model("default:claude-opus-5", "Claude Opus 5", "Anthropic"),
	model("default:claude-opus-4-5", "Claude Opus 4.5", "Anthropic"),
	model("default:claude-sonnet-4-5", "Claude Sonnet 4.5", "Anthropic"),
	model("default:gpt-6-astra", "GPT-6 Astra", "OpenAI"),
	model("default:gpt-6.1-sol", "GPT-6.1 Sol", "OpenAI"),
	model("default:claude-haiku-4-5", "Claude Haiku 4.5", "Anthropic"),
	model("default:claude-opus-4-6", "Claude Opus 4.6", "Anthropic"),
	model("default:claude-fable-5", "Claude Fable 5", "Anthropic"),
	model("default:claude-fable-5-1", "Claude Fable 5.1", "Anthropic"),
	model("default:gpt-6-luna", "GPT-6 Luna", "OpenAI"),
	model("default:gpt-5.6-terra", "GPT-5.6 Terra", "OpenAI"),
	model("default:claude-opus-4-7", "Claude Opus 4.7", "Anthropic"),
	model("default:claude-opus-4-8", "Claude Opus 4.8", "Anthropic"),
];

/** Every provider with a mark, one without (its initial) and a model the project hasn't enabled. */
const mixed: ComposerModelOption[] = [
	model("anthropic/claude-opus-4-5", "Claude Opus 4.5", "Anthropic"),
	model("anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", "Anthropic", { default: true }),
	model("openai/gpt-5", "GPT-5", "OpenAI"),
	model("openai/gpt-5-mini", "GPT-5 mini", "OpenAI", { description: "Fast, for small edits" }),
	model("google/gemini-2.5-pro", "Gemini 2.5 Pro", "Google"),
	model("google/gemini-2.5-flash", "Gemini 2.5 Flash", "Google", {
		disabledReason: "Not enabled for this project",
	}),
	model("mistral/mistral-large-3", "Mistral Large 3", "Mistral"),
	model("deepseek/deepseek-v4", "DeepSeek V4", "DeepSeek"),
	model("xai/grok-5", "Grok 5", "xAI"),
];

/** Opens the picker once mounted, then types `query` into its search, as a person would. */
function Opened({ children, query }: { children: ReactNode; query?: string }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		frame.current?.querySelector<HTMLButtonElement>(".kt-model-trigger")?.click();
		if (query === undefined) return;
		const input = frame.current?.querySelector<HTMLInputElement>(".kt-model-search-input");
		if (input === null || input === undefined) return;
		// React tracks the value itself; set it through the prototype so the change event carries it.
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}, [query]);
	return (
		<div ref={frame} className={pickerFrame}>
			{children}
		</div>
	);
}

function Live({ models, initial }: { models: ComposerModelOption[]; initial?: string }) {
	const [value, setValue] = useState(initial);
	return <ModelPicker models={models} {...(value === undefined ? {} : { value })} onChange={setValue} />;
}

export const ProviderFirst: Story = () => (
	<Sheet
		title="Model picker, provider first"
		intro="The providers' marks down the side, the chosen model's provider's models beside them, newest and largest first. Click a mark, or press Left and Right in the empty search, to change provider. The catalogue is a deployed gateway's, in the gateway's own order; the picker orders it."
	>
		<Opened>
			<Live models={live} />
		</Opened>
	</Sheet>
);
ProviderFirst.storyName = "Provider first";

export const Searching: Story = () => (
	<Sheet
		title="Model picker, searching"
		intro="Typing searches every provider at once, grouped under each provider's mark; the rail fades the providers without a match. Clearing the search goes back to the provider of the model the keyboard reached."
	>
		<Opened query="sol">
			<Live models={live} />
		</Opened>
	</Sheet>
);

export const ManyProviders: Story = () => (
	<Sheet
		title="Model picker, every mark"
		intro="Anthropic, OpenAI, Google, Mistral and DeepSeek have their marks; xAI, without one, shows its initial. A model the project hasn't enabled shows dimmed with the reason."
	>
		<Opened>
			<Live models={mixed} initial="google/gemini-2.5-pro" />
		</Opened>
		<Section title="One provider: no rail">
			<Opened>
				<Live models={live.filter((entry) => entry.provider === "OpenAI")} />
			</Opened>
		</Section>
	</Sheet>
);
ManyProviders.storyName = "Every mark";
