// The proposed model catalogue and prompt attachments (session.ts): additive, so every existing caller and runtime
// still compiles, and a `ModelOption` can be read straight off what the model gateway already lists for a session.
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	ModelGatewayModel,
	ModelOption,
	ModelThinking,
	PromptAttachment,
	PromptInput,
	SessionModels,
	SessionRuntime,
} from "../src/index.ts";

/** How a catalogue service could describe one gateway model for a picker. */
function optionOf(model: ModelGatewayModel, provider: string, sessionRoute: string): ModelOption {
	const thinking = Object.entries(model.thinkingLevelMap ?? {})
		.filter(([, value]) => value !== null)
		.map(([level]) => level as ModelThinking);
	return {
		id: model.id,
		label: model.name,
		provider,
		capabilities: { images: model.input.includes("image"), ...(thinking.length > 0 ? { thinking } : {}) },
		...(model.id === sessionRoute ? { default: true } : {}),
	};
}

const sonnet: ModelGatewayModel = {
	id: "default",
	name: "Claude Sonnet 4.5",
	reasoning: true,
	thinkingLevelMap: { off: null, low: "1024", high: "16384" },
	input: ["text", "image"],
	output: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

describe("the proposed model catalogue and attachments", () => {
	it("keeps a prompt with only text and a requestId valid", () => {
		const before: PromptInput = { text: "Run the suite", requestId: "r1" };
		expect(before.attachments).toBeUndefined();
		expect(before.model).toBeUndefined();
		expectTypeOf<{ text: string; requestId?: string }>().toExtend<PromptInput>();
	});

	it("carries attachments and a chosen model on a prompt", () => {
		const pasted: PromptAttachment = {
			id: "upload-1",
			name: "pasted-text.txt",
			type: "text/plain",
			size: 39_000,
			kind: "text",
		};
		const input: PromptInput = { text: "", attachments: [pasted], model: "fast" };
		expect(input.attachments?.[0]?.kind).toBe("text");
		expectTypeOf<PromptAttachment["kind"]>().toEqualTypeOf<"image" | "file" | "text">();
	});

	it("reads a model option off the gateway's config for the session", () => {
		const option = optionOf(sonnet, "Anthropic", "default");
		expect(option).toEqual({
			id: "default",
			label: "Claude Sonnet 4.5",
			provider: "Anthropic",
			capabilities: { images: true, thinking: ["low", "high"] },
			default: true,
		});
		const textOnly = optionOf({ ...sonnet, id: "fast:grok-code-fast", input: ["text"] }, "xAI", "default");
		expect(textOnly.capabilities?.images).toBe(false);
		expect(textOnly.default).toBeUndefined();
	});

	it("is a separate interface, so no SessionRuntime has to implement it", () => {
		expectTypeOf<SessionRuntime>().not.toHaveProperty("listModels");
		expectTypeOf<SessionModels["listModels"]>().returns.resolves.toEqualTypeOf<readonly ModelOption[]>();
	});
});
