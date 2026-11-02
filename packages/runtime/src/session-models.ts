/**
 * The models a session may name (`SessionModels`), read off the session's own Pi `Models`: on Kantel, the model
 * gateway's config for the session (one model per route and per route override the project's policy allows); in a test,
 * whatever models the runtime was given. Pure, so the mapping is tested without a runtime.
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { KANTEL_MODEL_PROVIDER, KantelError, type ModelOption, type ModelThinking } from "@kantel/contracts";
import type { ResolvedModel } from "./index.ts";

const THINKING: readonly ModelThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isModelThinking(value: unknown): value is ModelThinking {
	return typeof value === "string" && (THINKING as readonly string[]).includes(value);
}

/**
 * Who serves a model, for grouping a picker, from the words in its ID and name. The gateway's config doesn't say (its
 * models are routes, all from the `harbour` provider), so it is read off the upstream's naming; unknown is undefined
 * and the picker shows the model ungrouped.
 */
const FAMILIES: readonly (readonly [RegExp, string])[] = [
	[/claude|anthropic|opus|sonnet|haiku/i, "Anthropic"],
	[/\bgpt|\bo[1-9]\b|codex|openai/i, "OpenAI"],
	[/gemini|gemma|google/i, "Google"],
	[/grok|xai/i, "xAI"],
	[/deepseek/i, "DeepSeek"],
	[/qwen/i, "Qwen"],
	[/kimi|moonshot/i, "Moonshot"],
	[/\bglm|zhipu|z\.ai/i, "Z.ai"],
	[/mistral|codestral|devstral/i, "Mistral"],
	[/llama|meta/i, "Meta"],
];

export function providerOf(model: Pick<Model<Api>, "id" | "name">): string | undefined {
	const words = `${model.id} ${model.name}`;
	return FAMILIES.find(([pattern]) => pattern.test(words))?.[1];
}

/** A model's `ModelOption.id`: the gateway's model ID on Kantel's provider, `<provider>/<id>` on any other. */
export function optionIdOf(model: Pick<Model<Api>, "provider" | "id">): string {
	return model.provider === KANTEL_MODEL_PROVIDER ? model.id : `${model.provider}/${model.id}`;
}

/** The model an option ID names in a session's `Models`, or undefined. */
export function modelOfOption(models: Models, id: string): Model<Api> | undefined {
	const kantel = models.getModel(KANTEL_MODEL_PROVIDER, id);
	if (kantel !== undefined) return kantel;
	const slash = id.indexOf("/");
	if (slash <= 0) return undefined;
	return models.getModel(id.slice(0, slash), id.slice(slash + 1));
}

/** The levels a model supports, as pi reads them off its `reasoning` and `thinkingLevelMap`. */
export function thinkingOf(model: Model<Api>): ModelThinking[] {
	return getSupportedThinkingLevels(model).filter(isModelThinking);
}

/** The level a model runs with when `level` is asked for: pi's `clampThinkingLevel`. */
export function clampThinking(model: Model<Api>, level: ModelThinking): ModelThinking {
	const clamped = clampThinkingLevel(model, level);
	return isModelThinking(clamped) ? clamped : "off";
}

/** The options for a session's models, in the catalogue's order, with the profile's model marked default. */
export function modelOptions(models: Models, profileModel: ResolvedModel): ModelOption[] {
	return models.getModels().map((model) => {
		const thinking = thinkingOf(model);
		const provider =
			model.provider === KANTEL_MODEL_PROVIDER ? providerOf(model) : models.getProvider(model.provider)?.name;
		const isDefault = model.provider === profileModel.provider && model.id === profileModel.modelId;
		return {
			id: optionIdOf(model),
			label: model.name,
			...(provider === undefined ? {} : { provider }),
			capabilities: {
				images: model.input.includes("image"),
				...(thinking.some((level) => level !== "off") ? { thinking } : {}),
			},
			...(isDefault ? { default: true } : {}),
		};
	});
}

/** A thinking level for a model that may not think: absent when it supports nothing but `off`. */
export function shownThinking(model: Model<Api> | undefined, level: ModelThinking): ModelThinking | undefined {
	if (model === undefined) return level;
	return thinkingOf(model).some((supported) => supported !== "off") ? clampThinking(model, level) : undefined;
}

/** A prompt's `model` and `thinking`, checked: an unknown model or a malformed level is `invalid`. */
export function requestedChoice(
	models: Models,
	input: { readonly model?: unknown; readonly thinking?: unknown },
): { readonly model?: Model<Api>; readonly thinking?: ModelThinking } {
	let model: Model<Api> | undefined;
	if (input.model !== undefined) {
		if (typeof input.model !== "string" || input.model === "")
			throw new KantelError("invalid", "model must be a model ID");
		model = modelOfOption(models, input.model);
		if (model === undefined) throw new KantelError("invalid", `This session can't use the model ${input.model}`);
	}
	if (input.thinking !== undefined && !isModelThinking(input.thinking)) {
		throw new KantelError("invalid", `Unknown thinking level ${String(input.thinking)}`);
	}
	return {
		...(model === undefined ? {} : { model }),
		...(input.thinking === undefined ? {} : { thinking: input.thinking }),
	};
}
