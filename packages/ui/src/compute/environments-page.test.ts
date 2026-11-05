// The Environments pages on a deployment with no secrets key (`EnvironmentsSource.protectedValues: false`): they say
// up front that protected variables and secret files aren't supported, and offer neither, so nobody makes an
// environment for a protected value the deployment would then refuse.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	EnvironmentsPage,
	FilesSection,
	NO_PROTECTED_VALUES_TEXT,
	VariableDialog,
	VariablesSection,
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
