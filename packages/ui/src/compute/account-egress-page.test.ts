import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsView, settingsKey } from "./account-egress-page.tsx";
import type { ProxySettings } from "./compute-model.ts";

const proxy = (authSet: boolean): ProxySettings => ({
	accountId: "org_test",
	enabled: true,
	policy: "open",
	allow: [],
	deny: [],
	logRequests: true,
	upstream: { url: "https://gateway.example.com:8443", authSet },
});

const render = (settings: ProxySettings, busy: string | undefined) =>
	renderToStaticMarkup(
		createElement(SettingsView, {
			proxy: settings,
			busy,
			onSave: async () => true,
			onTurnOff: () => {},
			onTurnOn: () => {},
		}),
	);

/** The opening tag of the button whose label is `text`. */
const buttonTag = (html: string, text: string) =>
	[...html.matchAll(/(<button[^>]*>)(.*?)<\/button>/g)].find(
		(match) => match[2]?.replace(/<[^>]*>/g, "") === text,
	)?.[1] ?? "missing";
const inputs = (html: string) => html.match(/<input[^>]*>/g) ?? [];
// The attributes, not the class list's disabled: variants.
const DISABLED = /\sdisabled=""/;
const READ_ONLY = /\sreadOnly=""/i;

describe("Egress's settings while a save runs", () => {
	it("can't be changed, so starting the form again from what was saved drops nothing", () => {
		const set = render(proxy(true), "settings");
		for (const input of inputs(set)) expect(input).toMatch(READ_ONLY);
		expect(buttonTag(set, "Replace")).toMatch(DISABLED);
		expect(buttonTag(set, "Remove")).toMatch(DISABLED);
		expect(set).toMatch(/<button[^>]*role="switch"[^>]*\sdisabled=""/);

		const unset = render(proxy(false), "settings");
		expect(inputs(unset)).toHaveLength(2);
		for (const input of inputs(unset)) expect(input).toMatch(READ_ONLY);
	});

	it("is editable otherwise, another change running included", () => {
		for (const busy of [undefined, "policy"]) {
			const html = render(proxy(true), busy);
			for (const input of inputs(html)) expect(input).not.toMatch(READ_ONLY);
			expect(buttonTag(html, "Replace")).toMatch(/^<button/);
			expect(buttonTag(html, "Replace")).not.toMatch(DISABLED);
		}
	});
});

describe("the settings form's identity", () => {
	it("stays when only the proxy is turned on or off, so the draft survives", () => {
		const on = proxy(true);
		expect(settingsKey({ ...on, enabled: false })).toBe(settingsKey(on));
	});

	it("changes when a saved setting does, so a save starts the form again", () => {
		const base = proxy(true);
		expect(settingsKey({ ...base, upstream: { url: "https://other.example.com", authSet: true } })).not.toBe(
			settingsKey(base),
		);
		expect(settingsKey(proxy(false))).not.toBe(settingsKey(base));
		expect(settingsKey({ ...base, logRequests: false })).not.toBe(settingsKey(base));
	});
});
