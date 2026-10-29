import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderIcon, providerInitial, providerMark } from "./provider-icon.tsx";

describe("providerMark", () => {
	it("knows the providers it has marks for, by what the catalogue calls them", () => {
		expect(providerMark("Mistral AI")).toBe("mistral");
		expect(providerMark("Meta")).toBe("meta");
		expect(providerMark("DeepSeek")).toBe("deepseek");
		expect(providerMark("OpenRouter")).toBe("openrouter");
		expect(providerMark("Metadata Inc")).toBeUndefined();
	});
});

describe("ProviderIcon", () => {
	it("shows a provider without a mark as its initial on the rail, and the spark elsewhere", () => {
		expect(providerInitial("xAI")).toBe("X");
		expect(providerInitial("  ")).toBeUndefined();
		const rail = renderToStaticMarkup(createElement(ProviderIcon, { provider: "xAI", fallback: "initial" }));
		expect(rail).toContain("hb-provider-initial");
		expect(rail).toContain(">X<");
		const button = renderToStaticMarkup(createElement(ProviderIcon, { provider: "xAI" }));
		expect(button).not.toContain("hb-provider-initial");
	});

	it("keeps the spark for a model without a provider, even on the rail", () => {
		const markup = renderToStaticMarkup(createElement(ProviderIcon, { provider: "", fallback: "initial" }));
		expect(markup).not.toContain("hb-provider-initial");
	});
});
