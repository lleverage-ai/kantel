import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxState } from "./compute-model.ts";
import { QUICK_SANDBOX, sandboxesShown, showsCpu } from "./sandboxes-page.tsx";
import { SettingsFrame } from "./settings-nav.tsx";

const box = (name: string, state: SandboxState): Sandbox => ({
	id: `sbx_${name}`,
	name,
	hostname: "",
	accountId: "org_test",
	kind: "microvm",
	size: "medium",
	state,
	createdAt: 0,
	createdBy: "",
	usage: [],
});

describe("the sandboxes list", () => {
	const samples = [0.1, 0.4, 0.2];

	it("draws CPU only while a sandbox runs or has just failed, never a flat line for a stopped one", () => {
		expect(showsCpu({ state: "running", usage: samples })).toBe(true);
		expect(showsCpu({ state: "stopping", usage: samples })).toBe(true);
		expect(showsCpu({ state: "error", usage: samples })).toBe(true);
		for (const state of ["stopped", "paused", "starting"] as const)
			expect(showsCpu({ state, usage: samples })).toBe(false);
		// Nothing to draw yet.
		expect(showsCpu({ state: "running", usage: [] })).toBe(false);
		expect(showsCpu({ state: "running", usage: [0.3] })).toBe(false);
	});

	it("makes New's sandbox with New sandbox's defaults: a medium microVM that stops after an hour", () => {
		expect(QUICK_SANDBOX).toEqual({ kind: "microvm", size: "medium", autoStopMinutes: 60 });
	});

	it("filters by state and by a trimmed, case-blind search, and shows everything with no search", () => {
		const all = [
			box("api-server", "running"),
			box("API-worker", "paused"),
			box("eval", "error"),
			box("web", "stopped"),
		];
		const names = (list: readonly Sandbox[]) => list.map((each) => each.name);
		expect(names(sandboxesShown(all, "all", ""))).toEqual(["api-server", "API-worker", "eval", "web"]);
		expect(names(sandboxesShown(all, "all", "  api "))).toEqual(["api-server", "API-worker"]);
		// Paused counts as stopped; a failed one only under Error.
		expect(names(sandboxesShown(all, "stopped", ""))).toEqual(["API-worker", "web"]);
		expect(names(sandboxesShown(all, "error", ""))).toEqual(["eval"]);
		expect(names(sandboxesShown(all, "running", "api"))).toEqual(["api-server"]);
	});
});

describe("Settings' navigation", () => {
	// Crossing the phone breakpoint must not remount the settings page (losing a draft or a new key's secret), so the
	// page sits in the same elements in both layouts and only their classes change.
	it("keeps the page in the same elements on a phone and a wide screen", () => {
		const items = [{ id: "keys", label: "API keys", href: "#keys", selected: true }];
		const skeleton = (narrow: boolean) =>
			renderToStaticMarkup(
				// It has no hooks, so it can be called as it is.
				SettingsFrame({ items, narrow, children: createElement("form", { id: "page" }, "The page") }),
			).replace(/ class="[^"]*"/g, "");
		expect(skeleton(true)).toBe(skeleton(false));
		expect(skeleton(true)).toContain('<form id="page">');
	});
});
