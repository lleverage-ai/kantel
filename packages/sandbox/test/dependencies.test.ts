import type { CallContext, Sandboxes, SeedSpec, SeedStatusEvent } from "@harbour/contracts";
import { prepareDependencies } from "@harbour/sandbox/dependencies";
import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { createArchiveDependencyLayers, createMemoryLayerObjects } from "@harbour/workspace/dependency-layers";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const decoder = new TextDecoder();

function seed(lock: string, steps: SeedSpec["deps"] = undefined): SeedSpec {
	return {
		version: 1,
		name: "site",
		sources: [{ kind: "files", files: { "pnpm-lock.yaml": lock, "src/index.ts": "export {};\n" } }],
		deps: steps ?? [
			{
				name: "pnpm",
				run: `mkdir -p node_modules/left && echo ${lock} > node_modules/left/index.js`,
				key: ["pnpm-lock.yaml"],
			},
			{ name: "tool", run: "echo node22 > .tool/node", key: ["toolchain:node@22"], outputs: [".tool"] },
		],
	};
}

function setup() {
	const events: SeedStatusEvent[] = [];
	const workspaces = createMemoryWorkspaces({ onSeedStatus: (event) => void events.push(event) });
	const inner = createMemorySandboxes({ workspaces });
	const runs: string[] = [];
	const sandboxes: Pick<Sandboxes, "acquire" | "exec" | "release"> = {
		acquire: (c, input) => inner.acquire(c, input),
		release: (c, id) => inner.release(c, id),
		exec: (c, id, request) => {
			runs.push(String(request.command));
			return inner.exec(c, id, request);
		},
	};
	const objects = createMemoryLayerObjects();
	const layers = createArchiveDependencyLayers({ workspaces, objects });
	const prepare = async (spec: SeedSpec) => {
		const record = await workspaces.create(ctx, { owner, sessionId: "sess-1", seed: spec });
		return prepareDependencies(ctx, { workspaces, sandboxes, layers, workspaceId: record.id });
	};
	const read = async (id: string, path: string) => decoder.decode((await workspaces.read(ctx, id, path)).content);
	return { workspaces, events, runs, objects, prepare, read };
}

describe("the dependency stage", () => {
	it("builds each step in its tier, saves its layer, and records dependencies", async () => {
		const { events, runs, objects, prepare, read } = setup();
		const record = await prepare(seed("v1"));
		expect(record.seedReadiness).toBe("dependencies");
		expect(record.seedReport?.deps).toMatchObject([
			{ name: "pnpm", tier: "container", layer: "built" },
			{ name: "tool", layer: "built" },
		]);
		expect(await read(record.id, "node_modules/left/index.js")).toBe("v1\n");
		expect(await read(record.id, ".tool/node")).toBe("node22\n");
		expect(runs).toHaveLength(2);
		expect(objects.keys()).toEqual((record.seedReport?.deps ?? []).map((step) => `deps/${step.key}.tar`).sort());
		expect(events.filter((event) => event.workspaceId === record.id).map((event) => event.readiness)).toEqual([
			"metadata",
			"files",
			"dependencies",
		]);
	});

	it("restores equal keys without running anything, and a changed lockfile rebuilds only its own layer", async () => {
		const { runs, prepare, read } = setup();
		await prepare(seed("v1"));
		runs.length = 0;
		const again = await prepare(seed("v1"));
		expect(runs).toEqual([]);
		expect(again.seedReport?.deps?.map((step) => step.layer)).toEqual(["restored", "restored"]);
		expect(await read(again.id, "node_modules/left/index.js")).toBe("v1\n");
		expect(await read(again.id, ".tool/node")).toBe("node22\n");

		const bumped = await prepare(seed("v2"));
		expect(bumped.seedReport?.deps?.map((step) => step.layer)).toEqual(["built", "restored"]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toContain("echo v2");
		expect(await read(bumped.id, "node_modules/left/index.js")).toBe("v2\n");
	});

	it("fails the stage on a step that exits non-zero, keeping the steps already done", async () => {
		const { events, prepare } = setup();
		const record = await prepare(
			seed("v1", [
				{ name: "ok", run: "echo ok > node_modules/ok", key: ["pnpm-lock.yaml"] },
				{ name: "broken", run: "echo nope && false", key: ["pnpm-lock.yaml"] },
			]),
		);
		expect(record.seedReadiness).toBe("failed");
		expect(record.seedReport?.deps).toMatchObject([{ name: "ok", layer: "built" }, { name: "broken" }]);
		expect(record.seedReport?.deps?.[1]?.layer).toBeUndefined();
		expect(events.at(-1)).toMatchObject({
			readiness: "failed",
			error: { code: "unavailable", message: expect.stringContaining("step broken exited with 1") },
		});
	});

	it("leaves a workspace that is not at files, or has no steps, as it is", async () => {
		const { runs, prepare } = setup();
		const plain = await prepare({ version: 1, name: "plain", sources: [{ kind: "files", files: { a: "a" } }] });
		expect(plain.seedReadiness).toBe("files");
		const done = await prepare(seed("v1"));
		expect(done.seedReadiness).toBe("dependencies");
		expect(runs).toHaveLength(2);
	});
});
