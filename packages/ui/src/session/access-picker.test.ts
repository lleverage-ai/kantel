import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessPicker, chosenAccess } from "./access-picker.tsx";
import { ProviderIcon, providerMark } from "./provider-icon.tsx";

const options = [
	{ id: "supervised", label: "Supervised", disabledReason: "Not available yet" },
	{ id: "full-access", label: "Full access", description: "Runs commands without asking." },
];

describe("the access picker", () => {
	it("shows the chosen level, else the first that can be chosen", () => {
		expect(chosenAccess(options, "full-access")?.id).toBe("full-access");
		expect(chosenAccess(options, undefined)?.id).toBe("full-access");
		expect(chosenAccess(options, "nope")?.id).toBe("full-access");
		expect(chosenAccess([], undefined)).toBeUndefined();
	});

	it("is a lock, the level and a chevron, named for what it is", () => {
		const html = renderToStaticMarkup(createElement(AccessPicker, { options }));
		expect(html).toContain('aria-label="Access: Full access"');
		expect(html).toContain('title="Full access: Runs commands without asking."');
		expect(html).toContain("kt-access-trigger-chevron");
	});

	it("renders nothing without levels", () => {
		expect(renderToStaticMarkup(createElement(AccessPicker, { options: [] }))).toBe("");
	});
});

describe("a provider's mark", () => {
	it("knows Anthropic, OpenAI and Google by any case, and nothing else", () => {
		expect(providerMark("Anthropic")).toBe("anthropic");
		expect(providerMark("openai")).toBe("openai");
		expect(providerMark("Google Gemini")).toBe("google");
		expect(providerMark("xAI")).toBeUndefined();
		expect(providerMark(undefined)).toBeUndefined();
	});

	it("falls back to the spark", () => {
		expect(renderToStaticMarkup(createElement(ProviderIcon, { provider: "OpenAI" }))).toContain(
			'data-provider="openai"',
		);
		expect(renderToStaticMarkup(createElement(ProviderIcon, { provider: "xAI" }))).not.toContain("data-provider");
	});
});
