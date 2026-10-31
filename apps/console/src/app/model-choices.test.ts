import { describe, expect, it } from "vitest";
import type { ModelChoices } from "../api/client.ts";
import { modelChoicesOf } from "../api/http.ts";
import { lastChoiceOf, sendChoice, withLastChoice } from "./model-choices.ts";

const choices: ModelChoices = {
	models: [
		{
			id: "default",
			label: "Claude Sonnet 5.5",
			provider: "Anthropic",
			capabilities: { images: true, thinking: ["off", "low", "medium", "high", "max"] },
			default: true,
		},
		{ id: "default:gpt-5", label: "GPT-5", capabilities: { thinking: ["minimal", "low", "medium", "high", "xhigh"] } },
		{ id: "default:grok-code-fast", label: "Grok Code Fast", capabilities: { images: false } },
	],
	model: "default",
	thinking: "medium",
	defaultThinking: "medium",
};

describe("sendChoice", () => {
	it("sends what the pickers show: the session's own until the person picks", () => {
		expect(sendChoice(choices, undefined, undefined)).toEqual({ model: "default", thinking: "medium" });
		expect(sendChoice(choices, "default:gpt-5", "high")).toEqual({ model: "default:gpt-5", thinking: "high" });
	});

	it("sends a level the model has, and none for a model that can't think", () => {
		expect(sendChoice(choices, "default:gpt-5", "max")).toEqual({ model: "default:gpt-5", thinking: "xhigh" });
		expect(sendChoice(choices, "default:grok-code-fast", "high")).toEqual({ model: "default:grok-code-fast" });
	});

	it("sends nothing without a catalogue", () => {
		expect(sendChoice(undefined, "default", "high")).toEqual({});
		expect(sendChoice({ models: [] }, "default", "high")).toEqual({});
	});
});

describe("withLastChoice", () => {
	it("preselects the person's last model and level for a new session", () => {
		expect(withLastChoice(choices, { model: "default:gpt-5", thinking: "high" })).toEqual({
			...choices,
			model: "default:gpt-5",
			thinking: "high",
		});
		// And sends it, clamped to the model, unless the person picks another.
		const last = withLastChoice(choices, { model: "default:gpt-5", thinking: "max" });
		expect(sendChoice(last, undefined, undefined)).toEqual({ model: "default:gpt-5", thinking: "xhigh" });
		expect(sendChoice(last, "default", "low")).toEqual({ model: "default", thinking: "low" });
	});

	it("keeps the agent's model when the last one isn't offered or is disabled, and still takes the level", () => {
		expect(withLastChoice(choices, { model: "gone", thinking: "low" })).toEqual({ ...choices, thinking: "low" });
		const disabled: ModelChoices = {
			...choices,
			models: choices.models.map((model) =>
				model.id === "default:gpt-5" ? { ...model, disabledReason: "Not configured" } : model,
			),
		};
		expect(withLastChoice(disabled, { model: "default:gpt-5" })).toEqual(disabled);
		expect(withLastChoice(choices, undefined)).toBe(choices);
		expect(withLastChoice(choices, {})).toEqual(choices);
	});
});

describe("lastChoiceOf", () => {
	it("keeps what a send carried, and the session's model for a send that names none", () => {
		expect(lastChoiceOf("default", { model: "default:gpt-5", thinking: "high" })).toEqual({
			model: "default:gpt-5",
			thinking: "high",
		});
		expect(lastChoiceOf("default:gpt-5", { thinking: "low" })).toEqual({ model: "default:gpt-5", thinking: "low" });
		expect(lastChoiceOf(undefined, {})).toBeUndefined();
	});
});

describe("modelChoicesOf", () => {
	it("reads a started session's lock", () => {
		expect(modelChoicesOf({ models: [], locked: true })).toEqual({ models: [], locked: true });
		expect(modelChoicesOf({ models: [], locked: false })).toEqual({ models: [] });
	});

	it("reads the API's model state", () => {
		expect(
			modelChoicesOf({
				models: choices.models,
				selected: { model: "default:gpt-5", thinking: "high" },
				defaults: { model: "default", thinking: "medium" },
			}),
		).toEqual({ ...choices, model: "default:gpt-5", thinking: "high" });
		expect(modelChoicesOf({ models: [] })).toEqual({ models: [] });
	});
});
