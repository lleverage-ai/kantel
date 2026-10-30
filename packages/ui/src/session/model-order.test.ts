import { describe, expect, it } from "vitest";
import { orderModels, parseModelName, providerOrder } from "./model-order.ts";

const labels = (models: readonly { label: string }[]) => models.map((model) => model.label);

// harbour.myslop.app's catalogue on 29 Oct 2026, in the order the gateway listed it.
const live = [
	{ label: "Claude Sonnet 5.5", provider: "Anthropic" },
	{ label: "Claude Sonnet 5", provider: "Anthropic" },
	{ label: "Claude Opus 5.5", provider: "Anthropic" },
	{ label: "GPT-6 Sol", provider: "OpenAI" },
	{ label: "GPT-5.6 Sol", provider: "OpenAI" },
	{ label: "Claude Haiku 5.5", provider: "Anthropic" },
	{ label: "GPT-5.6 Luna", provider: "OpenAI" },
	{ label: "Claude Sonnet 4.6", provider: "Anthropic" },
	{ label: "Claude Opus 5", provider: "Anthropic" },
	{ label: "Claude Opus 4.5", provider: "Anthropic" },
	{ label: "Claude Sonnet 4.5", provider: "Anthropic" },
	{ label: "GPT-6 Astra", provider: "OpenAI" },
	{ label: "GPT-6.1 Sol", provider: "OpenAI" },
	{ label: "Claude Haiku 4.5", provider: "Anthropic" },
	{ label: "Claude Opus 4.6", provider: "Anthropic" },
	{ label: "Claude Fable 5", provider: "Anthropic" },
	{ label: "Claude Fable 5.1", provider: "Anthropic" },
	{ label: "GPT-6 Luna", provider: "OpenAI" },
	{ label: "GPT-5.6 Terra", provider: "OpenAI" },
	{ label: "Claude Opus 4.7", provider: "Anthropic" },
	{ label: "Claude Opus 4.8", provider: "Anthropic" },
];

describe("parseModelName", () => {
	it("reads the family, version and size from a label", () => {
		expect(parseModelName("Claude Opus 4.5")).toMatchObject({ family: "claude", version: [4, 5], size: 8 });
		expect(parseModelName("GPT-6.1 Sol")).toMatchObject({ family: "gpt", version: [6, 1], size: 7 });
		expect(parseModelName("GPT-5.4")).toMatchObject({ family: "gpt", version: [5, 4], size: 5 });
		expect(parseModelName("o3-mini")).toMatchObject({ family: "o", version: [3], size: 1 });
		expect(parseModelName("Gemma 4 31B IT")).toMatchObject({ family: "gemma", version: [4], params: 31, extra: 1 });
	});

	it("takes the smaller of two size words, and marks previews, aliases and snapshots", () => {
		expect(parseModelName("Gemini 2.5 Flash-Lite").size).toBeLessThan(parseModelName("Gemini 2.5 Flash").size);
		expect(parseModelName("Gemini 3.1 Pro Preview").later).toBe(1);
		expect(parseModelName("Claude Haiku 4.5 (latest)").later).toBe(1);
		expect(parseModelName("GPT-4o (2024-05-13)")).toMatchObject({ version: [4], later: 1 });
		expect(parseModelName("Claude Haiku 4.5").later).toBe(0);
	});

	it("has no version for a label without one", () => {
		expect(parseModelName("Daybreak Blue").version).toEqual([]);
	});
});

describe("orderModels", () => {
	it("orders the live catalogue by provider, then newest version, then largest", () => {
		expect(labels(orderModels(live))).toEqual([
			"Claude Opus 5.5",
			"Claude Sonnet 5.5",
			"Claude Haiku 5.5",
			"Claude Fable 5.1",
			"Claude Fable 5",
			"Claude Opus 5",
			"Claude Sonnet 5",
			"Claude Opus 4.8",
			"Claude Opus 4.7",
			"Claude Opus 4.6",
			"Claude Sonnet 4.6",
			"Claude Opus 4.5",
			"Claude Sonnet 4.5",
			"Claude Haiku 4.5",
			"GPT-6.1 Sol",
			"GPT-6 Astra",
			"GPT-6 Sol",
			"GPT-6 Luna",
			"GPT-5.6 Sol",
			"GPT-5.6 Terra",
			"GPT-5.6 Luna",
		]);
	});

	it("puts a larger variant before the plain model and the plain model before smaller ones", () => {
		const openai = ["GPT-5.4 nano", "GPT-5.4 mini", "GPT-5.4", "GPT-5.4 Pro", "GPT-5.5"].map((label) => ({
			label,
			provider: "OpenAI",
		}));
		expect(labels(orderModels(openai))).toEqual(["GPT-5.5", "GPT-5.4 Pro", "GPT-5.4", "GPT-5.4 mini", "GPT-5.4 nano"]);
	});

	it("puts the family with the newest version first, and a stable model before its preview", () => {
		const models = [
			{ label: "o3", provider: "OpenAI" },
			{ label: "o3-pro", provider: "OpenAI" },
			{ label: "GPT-4.1 mini", provider: "OpenAI" },
			{ label: "GPT-5", provider: "OpenAI" },
			{ label: "Gemini 3.1 Pro Preview", provider: "Google" },
			{ label: "Gemini 3.1 Pro", provider: "Google" },
			{ label: "Gemini 2.5 Flash-Lite", provider: "Google" },
			{ label: "Gemini 2.5 Flash", provider: "Google" },
		];
		expect(labels(orderModels(models))).toEqual([
			"GPT-5",
			"GPT-4.1 mini",
			"o3-pro",
			"o3",
			"Gemini 3.1 Pro",
			"Gemini 3.1 Pro Preview",
			"Gemini 2.5 Flash",
			"Gemini 2.5 Flash-Lite",
		]);
	});

	it("keeps unversioned labels after the versioned ones, in the catalogue's order", () => {
		const models = [
			{ label: "Daybreak Red", provider: "OpenAI" },
			{ label: "GPT-5", provider: "OpenAI" },
			{ label: "Daybreak Blue", provider: "OpenAI" },
		];
		expect(labels(orderModels(models))).toEqual(["GPT-5", "Daybreak Red", "Daybreak Blue"]);
	});

	it("keeps each provider where it first appears, and a model without one in its own group", () => {
		const models = [
			{ label: "GPT-5", provider: "OpenAI" },
			{ label: "Local model" },
			{ label: "Claude Opus 4.5", provider: "Anthropic" },
			{ label: "GPT-5.1", provider: "OpenAI" },
		];
		expect(providerOrder(models)).toEqual(["OpenAI", "", "Anthropic"]);
		expect(labels(orderModels(models))).toEqual(["GPT-5.1", "GPT-5", "Local model", "Claude Opus 4.5"]);
	});
});
