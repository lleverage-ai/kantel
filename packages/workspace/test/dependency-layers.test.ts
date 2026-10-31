import type { CallContext } from "@kantel/contracts";
import { packTar, unpackArchive } from "@kantel/workspace/archive";
import {
	createArchiveDependencyLayers,
	createMemoryLayerObjects,
	layerOutputs,
} from "@kantel/workspace/dependency-layers";
import { createMemoryWorkspaces } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("packTar", () => {
	it("round-trips files with modes and long paths through unpackArchive", async () => {
		const long = `node_modules/${"deep/".repeat(30)}index.js`;
		const files = [
			{ path: "node_modules/a/index.js", content: encoder.encode("a\n"), mode: 0o644 },
			{ path: "node_modules/.bin/a", content: encoder.encode("#!/bin/sh\n"), mode: 0o755 },
			{ path: long, content: encoder.encode("x".repeat(1000)), mode: 0o644 },
			{ path: "empty", content: new Uint8Array(), mode: 0o644 },
		];
		const back = await unpackArchive(packTar(files), { url: "test" });
		expect(back.map((file) => [file.path, decoder.decode(file.content), file.mode])).toEqual(
			// Only the executable bit is kept, as in git tarballs.
			files.map((file) => [file.path, decoder.decode(file.content), file.mode === 0o755 ? 0o755 : undefined]),
		);
	});
});

describe("archive dependency layers", () => {
	it("selects node_modules by default, or the step's outputs", () => {
		const byDefault = layerOutputs({ step: { run: "x", key: [] } });
		expect(["node_modules/a", "packages/x/node_modules/b", "src/node_modules.ts"].map(byDefault)).toEqual([
			true,
			true,
			false,
		]);
		const named = layerOutputs({ step: { run: "x", key: [], outputs: [".venv/"] } });
		expect([".venv/bin/python", ".venvx/a"].map(named)).toEqual([true, false]);
	});

	it("saves a step's outputs under its key and restores them into another workspace as one version", async () => {
		const workspaces = createMemoryWorkspaces();
		const objects = createMemoryLayerObjects();
		const layers = createArchiveDependencyLayers({ workspaces, objects });
		const owner = { kind: "organisation", organisationId: "org-1" } as const;
		const source = await workspaces.create(ctx, { owner });
		await workspaces.commit(ctx, source.id, {
			baseVersion: 0,
			changes: [
				{ op: "put", path: "node_modules/a/index.js", content: "a" },
				{ op: "put", path: "src/index.ts", content: "src" },
			],
		});
		const report = { name: "pnpm", key: "a".repeat(64), tier: "container" as const };
		const step = { run: "pnpm i", key: ["pnpm-lock.yaml"] };
		const target = await workspaces.create(ctx, { owner });
		expect(await layers.restore(ctx, { workspaceId: target.id, step, report })).toBe(false);
		await layers.save(ctx, { workspaceId: source.id, step, report });
		expect(objects.keys()).toEqual([`deps/${"a".repeat(64)}.tar`]);
		expect(await layers.restore(ctx, { workspaceId: target.id, step, report })).toBe(true);
		const restored = await workspaces.get(ctx, target.id);
		expect(restored.head).toBe(1);
		expect(decoder.decode((await workspaces.read(ctx, target.id, "node_modules/a/index.js")).content)).toBe("a");
		await expect(workspaces.read(ctx, target.id, "src/index.ts")).rejects.toMatchObject({ code: "not_found" });
		await expect(
			layers.save(ctx, { workspaceId: source.id, step, report: { ...report, key: "../x" } }),
		).rejects.toMatchObject({ code: "invalid" });
	});
});
