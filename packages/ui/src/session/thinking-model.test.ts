import { describe, expect, it } from "vitest";
import { chosenThinking, clampThinking, isThinkingLevel, offeredLevels, stepThinking } from "./thinking-model.ts";

describe("offeredLevels", () => {
	it("keeps the known levels in order", () => {
		expect(offeredLevels(["high", "off", "bogus", "low", "high"])).toEqual(["off", "low", "high"]);
	});

	it("offers nothing for a model that can't think", () => {
		expect(offeredLevels(undefined)).toEqual([]);
		expect(offeredLevels([])).toEqual([]);
		expect(offeredLevels(["off"])).toEqual([]);
	});
});

describe("clampThinking", () => {
	const anthropic = offeredLevels(["off", "low", "medium", "high", "max"]);
	const openai = offeredLevels(["minimal", "low", "medium", "high", "xhigh"]);

	it("keeps a supported level", () => {
		expect(clampThinking(anthropic, "medium")).toBe("medium");
	});

	it("moves an unsupported level to the nearest above, then below", () => {
		expect(clampThinking(anthropic, "xhigh")).toBe("max");
		expect(clampThinking(anthropic, "minimal")).toBe("low");
		expect(clampThinking(openai, "max")).toBe("xhigh");
		expect(clampThinking(openai, "off")).toBe("minimal");
	});

	it("has nothing for a model that can't think, and the lowest level when nothing was asked", () => {
		expect(clampThinking([], "high")).toBeUndefined();
		expect(clampThinking(openai, undefined)).toBe("minimal");
	});
});

describe("chosenThinking", () => {
	const levels = offeredLevels(["off", "low", "medium", "high"]);

	it("prefers the choice, then the default", () => {
		expect(chosenThinking(levels, "high", "low")).toBe("high");
		expect(chosenThinking(levels, undefined, "low")).toBe("low");
		expect(chosenThinking(levels, undefined, undefined)).toBe("off");
	});
});

describe("stepThinking", () => {
	const levels = offeredLevels(["low", "medium", "high"]);

	it("cycles up and down, wrapping", () => {
		expect(stepThinking(levels, "medium", 1)).toBe("high");
		expect(stepThinking(levels, "high", 1)).toBe("low");
		expect(stepThinking(levels, "low", -1)).toBe("high");
		expect(stepThinking(levels, undefined, 1)).toBe("low");
		expect(stepThinking([], "low", 1)).toBeUndefined();
	});
});

describe("isThinkingLevel", () => {
	it("knows pi's levels", () => {
		expect(isThinkingLevel("xhigh")).toBe(true);
		expect(isThinkingLevel("extreme")).toBe(false);
		expect(isThinkingLevel(3)).toBe(false);
	});
});
