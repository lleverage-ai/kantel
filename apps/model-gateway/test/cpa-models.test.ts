import { describe, expect, it } from "vitest";
import { type CpaModelChoice, chooseCpaModels, gatewayOffers } from "./cpa-models.ts";

const picked = (choices: readonly CpaModelChoice[]) =>
	Object.fromEntries(
		choices.map((choice) => [choice.api, "error" in choice ? `error: ${choice.error}` : choice.modelId]),
	);

describe("choosing the live CLIProxyAPI test's models", () => {
	it("asks the gateway's catalogue: a model pi-ai doesn't know isn't offered", () => {
		expect(gatewayOffers("anthropic-messages", "claude-sonnet-4-5")).toBe(true);
		// The model the first live run picked: CPA serves it, but pi-ai's catalogue has no entry for it.
		expect(gatewayOffers("anthropic-messages", "claude-sonnet-4-20250514")).toBe(false);
	});

	it("refuses a model set in the environment that the gateway won't offer, saying why", () => {
		const [messages] = chooseCpaModels(["claude-sonnet-4-20250514", "claude-sonnet-4-5", "gpt-5"], {
			KANTEL_CPA_MESSAGES_MODEL: "claude-sonnet-4-20250514",
		});
		expect(messages).toMatchObject({ api: "anthropic-messages" });
		expect("error" in messages! && messages.error).toMatch(/not in pi-ai's catalogue/);
	});

	it("refuses a model set in the environment that CPA doesn't list", () => {
		const [, responses] = chooseCpaModels(["gpt-5"], { KANTEL_CPA_RESPONSES_MODEL: "gpt-5.6-terra" });
		expect("error" in responses! && responses.error).toMatch(/not in this CPA's \/v1\/models listing/);
	});

	it("keeps a model set in the environment that CPA lists and pi-ai knows", () => {
		const choices = chooseCpaModels(["claude-opus-5-5", "gpt-5.6-terra"], {
			KANTEL_CPA_MESSAGES_MODEL: "claude-opus-5-5",
			KANTEL_CPA_RESPONSES_MODEL: "gpt-5.6-terra",
			KANTEL_CPA_COMPLETIONS_MODEL: "gpt-5.6-terra",
		});
		expect(choices.every((choice) => "source" in choice && choice.source === "env")).toBe(true);
		expect(picked(choices)).toEqual({
			"anthropic-messages": "claude-opus-5-5",
			"openai-responses": "gpt-5.6-terra",
			"openai-completions": "gpt-5.6-terra",
		});
	});

	it("takes the defaults when CPA lists them", () => {
		expect(picked(chooseCpaModels(["gemini-2.5-pro", "gpt-5", "claude-sonnet-4-5"], {}))).toEqual({
			"anthropic-messages": "claude-sonnet-4-5",
			"openai-responses": "gpt-5",
			"openai-completions": "gemini-2.5-pro",
		});
	});

	it("otherwise picks the first listed model pi-ai knows that suits each wire API, skipping unknown ones", () => {
		const listed = ["claude-sonnet-4-20250514", "house-model", "claude-opus-5-5", "gpt-5.6-terra"];
		expect(picked(chooseCpaModels(listed, {}))).toEqual({
			"anthropic-messages": "claude-opus-5-5",
			"openai-responses": "gpt-5.6-terra",
			"openai-completions": "gpt-5.6-terra",
		});
	});

	it("says so when CPA lists nothing usable for a wire API", () => {
		const [messages] = chooseCpaModels(["claude-sonnet-4-20250514", "gpt-5"], {});
		expect("error" in messages! && messages.error).toMatch(/lists no model pi-ai knows for anthropic-messages/);
	});
});
