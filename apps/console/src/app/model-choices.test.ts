import { describe, expect, it } from "vitest";
import type { ModelChoices } from "../api/client.ts";
import { modelChoicesOf } from "../api/http.ts";
import { sendChoice } from "./model-choices.ts";

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

describe("modelChoicesOf", () => {
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
