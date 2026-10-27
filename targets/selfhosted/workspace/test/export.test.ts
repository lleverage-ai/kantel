import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { type CallContext, isHarbourError } from "@harbour/contracts";
import { syncExport } from "@harbour/workspace/export";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDirectoryExportSink,
	createMemoryObjects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
} from "../src/index.ts";
import { laneSchema, pgliteDatabase } from "./support.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isHarbourError(error) ? error.code : `not a HarbourError: ${String(error)}`;
	}
	return undefined;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "m1-be23-export-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("self-hosted git seeding", () => {
	it("passes the host's git fetcher through and keeps modes in Postgres-backed trees", async () => {
		const db = pgliteDatabase(new PGlite());
		const schema = laneSchema();
		await migrateWorkspaceStore(db, schema);
		const commit = "a".repeat(40);
		const workspaces = createSelfHostedWorkspaces({
			db,
			objects: createMemoryObjects(),
			schema,
			seeders: {
				git: {
					fetch: async () => ({
						commit,
						files: [
							{ path: "README.md", content: new TextEncoder().encode("# r") },
							{ path: "bin/run", content: new TextEncoder().encode("#!/bin/sh"), mode: 0o755 },
						],
					}),
				},
			},
		});
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "git", repo: "tvdavies/site", ref: "main", into: "repo" }] },
		});
		expect(record.seedReport?.sources).toEqual([
			{ kind: "git", repo: "tvdavies/site", commit, into: "repo", indexState: "refreshed" },
		]);
		const listed = await workspaces.list(ctx, record.id, { path: "repo/bin" });
		expect(listed.items).toEqual([expect.objectContaining({ path: "repo/bin/run", mode: 0o755 })]);
		expect(await workspaces.get(ctx, record.id)).toEqual(record);
	});
});

describe("createDirectoryExportSink", () => {
	it("keeps a task's notes directory in step with the workspace's notes/", async () => {
		const db = pgliteDatabase(new PGlite());
		const schema = laneSchema();
		await migrateWorkspaceStore(db, schema);
		const workspaces = createSelfHostedWorkspaces({ db, objects: createMemoryObjects(), schema });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "notes/TASK-1.md": "# v1", "src/a.ts": "a" } }] },
		});
		const root = join(dir, "task");
		const sink = createDirectoryExportSink(root);
		const first = await syncExport(ctx, workspaces, record.id, { prefixes: ["notes/"], sink });
		expect(await readFile(join(root, "notes/TASK-1.md"), "utf8")).toBe("# v1");

		await workspaces.commit(ctx, record.id, {
			baseVersion: 1,
			changes: [
				{ op: "put", path: "notes/TASK-1.md", content: "# v2" },
				{ op: "put", path: "notes/evidence/run.json", content: "{}" },
			],
		});
		await writeFile(join(root, "notes/mine.md"), "host");
		const second = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: first.manifest,
		});
		expect(second.written).toEqual(["notes/TASK-1.md", "notes/evidence/run.json"]);
		expect(await readFile(join(root, "notes/TASK-1.md"), "utf8")).toBe("# v2");

		await workspaces.commit(ctx, record.id, {
			baseVersion: 2,
			changes: [{ op: "delete", path: "notes/evidence/run.json" }],
		});
		const third = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: second.manifest,
		});
		expect(third.removed).toEqual(["notes/evidence/run.json"]);
		expect((await readdir(join(root, "notes"))).sort()).toEqual(["TASK-1.md", "evidence", "mine.md"]);
		expect(await readdir(join(root, "notes/evidence"))).toEqual([]);
	});

	it("refuses to write or remove through a symlink, or over a host directory or file", async () => {
		const outside = join(dir, "outside");
		await mkdir(outside);
		const root = join(dir, "task");
		await mkdir(join(root, "notes"), { recursive: true });
		await symlink(outside, join(root, "notes/linked"));
		await writeFile(join(outside, "victim.md"), "keep");
		await symlink(join(outside, "victim.md"), join(root, "notes/file-link.md"));
		const sink = createDirectoryExportSink(root);
		const bytes = new TextEncoder().encode("x");
		expect(await codeOf(sink.write("notes/linked/a.md", bytes, ""))).toBe("refused");
		expect(await codeOf(sink.write("notes/file-link.md", bytes, ""))).toBe("refused");
		expect(await codeOf(sink.remove("notes/linked/victim.md"))).toBe("refused");
		expect(await codeOf(sink.remove("notes/file-link.md"))).toBe("refused");
		expect(await codeOf(sink.write("../escape.md", bytes, ""))).toBe("invalid");
		expect(await codeOf(sink.write("notes", bytes, ""))).toBe("invalid");
		await writeFile(join(root, "plain"), "file");
		expect(await codeOf(sink.write("plain/below.md", bytes, ""))).toBe("invalid");
		expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("keep");
		expect(await readdir(outside)).toEqual(["victim.md"]);
		// Removing a file that is already gone is not an error.
		await sink.remove("notes/never.md");
	});
});
