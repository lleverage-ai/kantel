// The v6 renamed_classes migration (TASK-4492): HarbourStack and HarbourVault, the stack's and the vault's Durable
// Object classes as they were deployed before the rename, become KantelStack and KantelVault. Cloudflare moves every
// object and its storage to the new class when the deploy that carries the migration applies it, provided the
// bindings name the new class and the Worker exports it. These check the config and the exports agree on that.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { deployConfig, deployValues } from "../scripts/deploy-config.ts";

type Migration = {
	readonly tag: string;
	readonly new_sqlite_classes?: readonly string[];
	readonly renamed_classes?: readonly { readonly from: string; readonly to: string }[];
};
type Bindings = {
	readonly bindings: readonly { readonly name: string; readonly class_name: string; readonly script_name?: string }[];
};

const wranglerJsonc = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const { rawConfig } = experimental_readRawConfig({ config: wranglerJsonc });
const migrations = rawConfig.migrations as readonly Migration[];
const dev = (rawConfig.env as { dev: { durable_objects: Bindings } }).dev;
/** Code mode's sandbox Worker, whose class the main Worker binds by `script_name` (TASK-4580). */
const codemode = experimental_readRawConfig({
	config: fileURLToPath(new URL("../wrangler.codemode.jsonc", import.meta.url)),
}).rawConfig;

/** Every class the migrations leave live, in order: created, then renamed. */
function liveClasses(list: readonly Migration[]): Set<string> {
	const live = new Set<string>();
	for (const migration of list) {
		for (const name of migration.new_sqlite_classes ?? []) {
			expect(live.has(name), `${migration.tag} creates ${name} twice`).toBe(false);
			live.add(name);
		}
		for (const { from, to } of migration.renamed_classes ?? []) {
			expect(live.has(from), `${migration.tag} renames ${from}, which no earlier migration made`).toBe(true);
			expect(live.has(to), `${migration.tag} renames onto ${to}, which exists already`).toBe(false);
			live.delete(from);
			live.add(to);
		}
	}
	return live;
}

/** The names a Worker entry exports, as `export { A, B as C }` lists them. */
function exportedNames(file: string): Set<string> {
	const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
	const names = new Set<string>();
	for (const block of source.matchAll(/^export \{([^}]*)\}(?: from "[^"]+")?;/gm)) {
		for (const entry of (block[1] ?? "").replace(/\/\/[^\n]*/g, "").split(",")) {
			const name = entry
				.trim()
				.split(/\s+as\s+/)
				.pop();
			if (name !== undefined && name !== "") names.add(name);
		}
	}
	for (const match of source.matchAll(/^export class (\w+)/gm)) names.add(match[1] as string);
	return names;
}

describe("the stack's and the vault's Durable Object rename", () => {
	it("keeps the applied migrations as they were and renames in a new one, v6", () => {
		expect(migrations.slice(0, 2)).toEqual([
			{ tag: "v1", new_sqlite_classes: ["HarbourStack"] },
			{ tag: "v2", new_sqlite_classes: ["HarbourVault"] },
		]);
		expect(migrations.map((migration) => migration.tag)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
		// v7 adds the session objects after the rename.
		expect(migrations.at(-1)).toEqual({ tag: "v7", new_sqlite_classes: ["KantelSession"] });
		expect(migrations.at(-2)).toEqual({
			tag: "v6",
			renamed_classes: [
				{ from: "HarbourStack", to: "KantelStack" },
				{ from: "HarbourVault", to: "KantelVault" },
			],
		});
	});

	it("binds every class by a name the migrations leave live, in the deployed and the dev configs", () => {
		const live = liveClasses(migrations);
		expect([...live].sort()).toEqual([
			"HarbourBrowser",
			"HarbourSandbox",
			"KantelSession",
			"KantelStack",
			"KantelTunnel",
			"KantelVault",
		]);
		const deployed = deployConfig(rawConfig, deployValues({}, "dry-run")).durable_objects as Bindings;
		const sandboxClasses = liveClasses(codemode.migrations as readonly Migration[]);
		for (const { bindings } of [deployed, dev.durable_objects]) {
			const own = bindings.filter((binding) => binding.script_name === undefined);
			expect(own.map((binding) => binding.class_name).sort()).toEqual([...live].sort());
			// Another Worker's classes: only code mode's sandbox, by a class its own migrations leave live.
			const others = bindings.filter((binding) => binding.script_name !== undefined);
			expect(others).toEqual([
				{ name: "CODEMODE_SANDBOXES", class_name: "KantelCodemodeSandbox", script_name: codemode.name },
			]);
			for (const binding of others) expect(sandboxClasses.has(binding.class_name)).toBe(true);
		}
		expect(deployed.bindings).toContainEqual({ name: "STACK", class_name: "KantelStack" });
		expect(deployed.bindings).toContainEqual({ name: "VAULTS", class_name: "KantelVault" });
		expect(exportedNames("../src/codemode/worker.ts")).toContain("KantelCodemodeSandbox");
	});

	it("exports each bound class from the deployed and the dev Worker, and the renamed ones' old names too", () => {
		for (const entry of ["../src/index.ts", "../src/dev.ts"]) {
			const exported = exportedNames(entry);
			for (const name of liveClasses(migrations)) expect(exported, `${entry} exports ${name}`).toContain(name);
			// Aliases while the rename applies: the old names find the same classes.
			expect(exported).toContain("HarbourStack");
			expect(exported).toContain("HarbourVault");
		}
	});
});
