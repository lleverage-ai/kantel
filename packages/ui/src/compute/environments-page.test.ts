// The Environments pages on a deployment with no secrets key (`EnvironmentsSource.protectedValues: false`): they say
// up front that protected variables and secret files aren't supported, and offer neither, so nobody makes an
// environment for a protected value the deployment would then refuse.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EnvironmentVariable } from "./compute-model.ts";
import {
	dialogProtection,
	EnvironmentsPage,
	FilesSection,
	NO_PROTECTED_VALUES_TEXT,
	VariableDialog,
	VariablesSection,
	variableMenu,
} from "./environments-page.tsx";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";

const list = (noProtectedValues: boolean) =>
	renderToStaticMarkup(
		createElement(EnvironmentsPage, {
			source: createComputeFixtures({ noProtectedValues }).environments,
			account: LLEVERAGE,
			environmentHref: (id: string) => `#${id}`,
			now: FIXTURE_NOW,
		}),
	);

/** The labels of the page's buttons, their markup taken off. */
const buttons = (html: string): string[] =>
	[...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => (match[1] ?? "").replace(/<[^>]*>/g, ""));

const noop = () => {};

async function sections(noProtectedValues: boolean) {
	const source = createComputeFixtures({ noProtectedValues });
	const env = await source.environments.get("env_backend");
	const canProtect = source.environments.protectedValues !== false;
	return renderToStaticMarkup(
		createElement(
			"div",
			null,
			createElement(VariablesSection, {
				env,
				now: FIXTURE_NOW,
				canProtect,
				onAdd: noop,
				onEdit: noop,
				onRotate: noop,
				onRemove: noop,
			}),
			createElement(FilesSection, {
				env,
				now: FIXTURE_NOW,
				canAdd: canProtect,
				onAdd: noop,
				onReplace: noop,
				onRemove: noop,
			}),
		),
	);
}

const dialog = (canProtect: boolean) =>
	renderToStaticMarkup(
		createElement(VariableDialog, { protect: false, canProtect, taken: [], onClose: noop, onSave: async () => {} }),
	);

describe("Environments on a deployment that keeps no protected values", () => {
	it("say so on the list, before anyone makes one", () => {
		expect(list(true)).toContain(NO_PROTECTED_VALUES_TEXT.replace(/'/g, "&#x27;"));
		expect(list(false)).not.toContain("doesn&#x27;t support protected variables");
	});

	it("offer no protected variable and no secret file to add", async () => {
		const without = buttons(await sections(true));
		expect(without).toContain("Add variable");
		expect(without).not.toContain("Add protected variable");
		expect(without).not.toContain("Add file");
		const offered = buttons(await sections(false));
		expect(offered).toContain("Add protected variable");
		expect(offered).toContain("Add file");
	});

	it("never turn a protected variable kept from before plain: it can only be removed", () => {
		const kept: EnvironmentVariable = {
			name: "GH_TOKEN",
			protected: true,
			bindings: [{ host: "api.github.com", pathPrefixes: [], methods: [] }],
			updatedAt: FIXTURE_NOW,
		};
		const plain: EnvironmentVariable = {
			name: "LOG_LEVEL",
			protected: false,
			value: "debug",
			bindings: [],
			updatedAt: 0,
		};
		const actions = { edit: noop, rotate: noop, remove: noop };
		const ids = (variable: EnvironmentVariable, canProtect: boolean) =>
			variableMenu(variable, canProtect, actions)
				.filter((entry) => entry.kind === "item")
				.map((entry) => entry.id);
		// Without the key: no edit or rotation that would be refused, or save it plain; removing it still works.
		expect(ids(kept, false)).toEqual(["remove"]);
		expect(ids(plain, false)).toEqual(["edit", "remove"]);
		expect(ids(kept, true)).toEqual(["edit", "rotate", "remove"]);
		expect(ids(plain, true)).toEqual(["edit", "remove"]);

		// Should its dialog open anyway, it stays protected, with its Protected switch.
		expect(dialogProtection(kept, undefined, false)).toEqual({ protect: true, canProtect: true });
		expect(dialogProtection(kept, undefined, true)).toEqual({ protect: true, canProtect: true });
		// A new variable is plain without the key, whatever was asked; with it, as asked.
		expect(dialogProtection(undefined, true, false)).toEqual({ protect: false, canProtect: false });
		expect(dialogProtection(undefined, true, true)).toEqual({ protect: true, canProtect: true });
		expect(dialogProtection(plain, undefined, false)).toEqual({ protect: false, canProtect: false });
		const editing = renderToStaticMarkup(
			createElement(VariableDialog, {
				variable: kept,
				...dialogProtection(kept, undefined, false),
				taken: [],
				onClose: noop,
				onSave: async () => {},
			}),
		);
		expect(editing).toContain("Protected");
		expect(editing).toContain("kph_ placeholder");
	});

	it("offer only removal for a secret file kept from before", async () => {
		const source = createComputeFixtures();
		const env = await source.environments.get("env_backend");
		expect(env.files.length).toBeGreaterThan(0);
		const html = (canAdd: boolean) =>
			renderToStaticMarkup(
				createElement(FilesSection, { env, now: FIXTURE_NOW, canAdd, onAdd: noop, onReplace: noop, onRemove: noop }),
			);
		// The files are still listed either way.
		expect(html(false)).toContain(env.files[0]?.path ?? "");
		expect(buttons(html(false))).not.toContain("Add file");
	});

	it("leave the Protected switch out of Add variable", () => {
		expect(dialog(false)).not.toContain("Protected");
		expect(dialog(true)).toContain("Protected");
	});

	it("are refused by the sample source as the API refuses them", async () => {
		const source = createComputeFixtures({ noProtectedValues: true });
		expect(source.environments.protectedValues).toBe(false);
		const env = await source.environments.get("env_backend");
		expect(env.variables.some((variable) => variable.protected)).toBe(false);
		await expect(
			source.environments.setVariable(env.id, {
				name: "GH_TOKEN",
				protected: true,
				value: "secret",
				bindings: [{ host: "api.github.com", pathPrefixes: [], methods: [] }],
			}),
		).rejects.toThrow(/doesn't support protected variables/);
		await expect(
			source.environments.setFile(env.id, { path: "/home/user/.npmrc", mode: 0o600, content: "x" }),
		).rejects.toThrow(/doesn't support/);
		const plain = await source.environments.setVariable(env.id, {
			name: "LOG_LEVEL",
			protected: false,
			value: "debug",
			bindings: [],
		});
		expect(plain.variables.find((variable) => variable.name === "LOG_LEVEL")?.value).toBe("debug");
	});
});
