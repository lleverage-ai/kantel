// A started session's pickers: the model shown read-only with its lock and reason, the thinking menu with its
// prompt-cache note. Rendered to markup, so no browser is needed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ComposerModelOption, ModelPicker } from "./model-picker.tsx";
import { MODEL_LOCKED_REASON, THINKING_CACHE_NOTE } from "./thinking-model.ts";
import { ThinkingPicker } from "./thinking-picker.tsx";

const models: ComposerModelOption[] = [
	{ id: "default", label: "Claude Sonnet 5.5", provider: "Anthropic" },
	{ id: "default:gpt-5", label: "GPT-5", provider: "OpenAI" },
];

describe("a locked model picker", () => {
	it("shows the session's model read-only, with why, and no list to open", () => {
		const html = renderToStaticMarkup(
			createElement(ModelPicker, {
				models,
				value: "default:gpt-5",
				onChange: () => {},
				locked: MODEL_LOCKED_REASON,
				defaultOpen: true,
			}),
		);
		expect(html).toContain("GPT-5");
		expect(html).toContain('aria-disabled="true"');
		expect(html).toContain("data-locked");
		expect(html).toContain(`title="GPT-5, OpenAI. ${MODEL_LOCKED_REASON}"`);
		expect(html).not.toContain('role="listbox"');
		expect(html).not.toContain("Claude Sonnet 5.5");
	});

	it("opens as before when not locked", () => {
		const html = renderToStaticMarkup(
			createElement(ModelPicker, { models, value: "default", onChange: () => {}, defaultOpen: true }),
		);
		expect(html).not.toContain("data-locked");
		expect(html).toContain('role="listbox"');
		expect(html).toContain('aria-expanded="true"');
	});
});

describe("the thinking picker's note", () => {
	it("says under the levels that a change may cost the prompt cache, and every level stays a choice", () => {
		const html = renderToStaticMarkup(
			createElement(ThinkingPicker, {
				levels: ["off", "low", "high"],
				value: "low",
				onChange: () => {},
				note: THINKING_CACHE_NOTE,
				defaultOpen: true,
			}),
		);
		expect(html).toContain(THINKING_CACHE_NOTE);
		expect(html).toContain("aria-describedby");
		expect(html.match(/role="menuitemradio"/g)?.length).toBe(3);
		expect(html).not.toContain("aria-disabled");
	});

	it("has no note unless given one", () => {
		const html = renderToStaticMarkup(
			createElement(ThinkingPicker, { levels: ["off", "low"], value: "low", onChange: () => {}, defaultOpen: true }),
		);
		expect(html).not.toContain(THINKING_CACHE_NOTE);
	});
});
