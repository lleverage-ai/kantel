/**
 * Lazy hydration and cheap forks over stored workspaces (packages/workspace/CONTRACT.md): a lazy seed is usable
 * once its tree and staging packs are written, a body not yet in its blob is read from its pack (only that body), a
 * background pass copies the rest and ends with `workspace.hydrated`, and a fork shares the source's bodies.
 */
import { type CallContext, isKantelError, type WorkspaceHydratedEvent, type WorkspaceRecord } from "@kantel/contracts";
import { RecordingAuditSink } from "@kantel/testing/harness";
import { sha256Hex, toBytes } from "@kantel/workspace";
import {
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	listAll,
	type MemoryWorkspaceStore,
	type WorkspaceStore,
} from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const otherOrg: CallContext = { actor: { kind: "human", userId: "user-2" }, organisationId: "org-2" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Forty files, each with its own content: more than one batch of writes, so the seed is lazy. */
const FILES: Record<string, string> = Object.fromEntries(
	Array.from({ length: 40 }, (_, index) => [
		`src/file-${String(index).padStart(2, "0")}.ts`,
		`export const n = ${index};\n`,
	]),
);
const seed = (extra: Record<string, unknown> = {}) => ({
	name: "repo",
	sources: [{ kind: "files" as const, files: FILES }],
	...extra,
});

/** A store whose writes of the keys `held` picks wait until `open()`: hydration can be held at any point. */
function gated(inner: WorkspaceStore, held: (key: string) => boolean = (key) => key.includes("/blobs/")) {
	let open: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const store: WorkspaceStore = {
		...inner,
		async putObject(key, bytes) {
			if (held(key)) await gate;
			return inner.putObject(key, bytes);
		},
	};
	return { store, open };
}

const collect =
	(events: WorkspaceHydratedEvent[]) =>
	(event: WorkspaceHydratedEvent): void => {
		events.push(event);
	};
const blobKeys = (store: MemoryWorkspaceStore) => store.keys().filter((key) => key.includes("/blobs/"));
const filesOf = async (workspaces: Parameters<typeof listAll>[0], id: string) =>
	(await listAll(workspaces, ctx, id)).filter((entry) => entry.kind === "file");

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isKantelError(error) ? error.code : "thrown";
	}
	return undefined;
}

describe("lazy hydration", () => {
	it("is usable once the tree and a pack are written, reads from the pack, then hydrates and says so", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store, open } = gated(inner);
		const audit = new RecordingAuditSink();
		const events: WorkspaceHydratedEvent[] = [];
		const workspaces = createStoredWorkspaces({ store, audit, hydration: { onHydrated: collect(events) } });

		const writes = inner.counts.objectWrites;
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		// The tree, one pack and its index: not one write per file.
		expect(inner.counts.objectWrites - writes).toBe(3);
		expect(blobKeys(inner)).toEqual([]);
		expect(record.hydration).toMatchObject({ hydrated: false, entriesTotal: 40 });
		expect(record.hydration?.bytesTotal).toBe(Object.values(FILES).reduce((sum, body) => sum + body.length, 0));
		// The store's staging list never reaches a caller.
		expect(Object.hasOwn(record, "staged")).toBe(false);
		expect(Object.hasOwn(await workspaces.get(ctx, record.id), "staged")).toBe(false);

		// Usable at once: the whole tree lists, and any file reads, while no body is in its blob yet.
		expect((await filesOf(workspaces, record.id)).map((entry) => entry.path)).toEqual(Object.keys(FILES).sort());
		expect(text((await workspaces.read(ctx, record.id, "src/file-07.ts")).content)).toBe(FILES["src/file-07.ts"]);
		expect(workspaces.packReads.memory).toBe(1);

		// Another process (here a second instance, without the pack in memory) reads one body by range: only that body.
		const other = createStoredWorkspaces({ store: inner });
		const packReads = inner.counts.packReads;
		expect(text((await other.read(ctx, record.id, "src/file-31.ts")).content)).toBe(FILES["src/file-31.ts"]);
		expect(other.packReads).toEqual({ memory: 0, ranged: 1, whole: 0 });
		// The pack's index and the one range.
		expect(inner.counts.packReads - packReads).toBe(2);
		expect((await other.get(ctx, record.id)).hydration?.hydrated).toBe(false);

		open();
		await workspaces.hydrationSettled();
		const hydrated = await workspaces.get(ctx, record.id);
		expect(hydrated.hydration).toMatchObject({ hydrated: true, entriesTotal: 40 });
		expect(hydrated.hydration?.hydratedAt).toBeTypeOf("number");
		expect(blobKeys(inner)).toHaveLength(40);
		expect(inner.keys().some((key) => key.endsWith(".pack.done"))).toBe(true);
		expect(events).toEqual([
			expect.objectContaining({ type: "workspace.hydrated", workspaceId: record.id, organisationId: "org-1" }),
		]);
		expect(audit.ofType("workspace.hydrated")).toEqual([
			expect.objectContaining({ subject: { kind: "workspace", id: record.id }, data: expect.anything() }),
		]);

		// Hydrated: reads go to blobs, never to the pack.
		const blobReads = inner.counts.blobReads;
		expect(text((await other.read(ctx, record.id, "src/file-02.ts")).content)).toBe(FILES["src/file-02.ts"]);
		expect(inner.counts.blobReads - blobReads).toBe(1);
		expect(other.packReads.ranged).toBe(1);
	});

	it("serves every read path from the pack: readBlob for the tiers and export", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store } = gated(inner);
		const workspaces = createStoredWorkspaces({ store, hydration: {} });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		const other = createStoredWorkspaces({ store: inner });
		const digest = await sha256Hex(toBytes(FILES["src/file-11.ts"] ?? ""));
		expect(text(await other.readBlob(ctx, record.id, digest, { version: 1 }))).toBe(FILES["src/file-11.ts"]);
		const exported = await other.export(ctx, record.id, ["src/"]);
		expect(exported.map((file) => text(file.content))).toEqual(
			Object.keys(FILES)
				.sort()
				.map((path) => FILES[path]),
		);
	});

	it("keeps the workspace's boundaries: another organisation, or a digest from elsewhere, reads nothing", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store } = gated(inner);
		const workspaces = createStoredWorkspaces({ store, hydration: {} });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		const other = createStoredWorkspaces({ store: inner });
		const before = inner.counts.packReads;
		expect(await codeOf(other.read(otherOrg, record.id, "src/file-01.ts"))).toBe("not_found");
		expect(await codeOf(other.readBlob(ctx, record.id, "0".repeat(64), { version: 1 }))).toBe("not_found");
		expect(inner.counts.packReads).toBe(before);
	});

	it("is resumed by the next instance that loads the workspace when the one that started it stopped", async () => {
		const inner = createMemoryWorkspaceStore();
		// This instance never gets its blob writes through: it stands for a process that died mid-hydration.
		const { store } = gated(inner);
		const stopped = createStoredWorkspaces({ store, hydration: {} });
		const record = await stopped.create(ctx, { owner, seed: seed() });

		const events: WorkspaceHydratedEvent[] = [];
		const next = createStoredWorkspaces({ store: inner, hydration: { onHydrated: collect(events) } });
		expect((await next.get(ctx, record.id)).hydration?.hydrated).toBe(false);
		await next.hydrationSettled();
		expect((await next.get(ctx, record.id)).hydration?.hydrated).toBe(true);
		expect(blobKeys(inner)).toHaveLength(40);
		expect(events.map((event) => event.workspaceId)).toEqual([record.id]);
	});

	it("keeps a commit made while it hydrates", async () => {
		const inner = createMemoryWorkspaceStore();
		const seeded = new Set(
			await Promise.all(Object.values(FILES).map(async (body) => `/blobs/${await sha256Hex(toBytes(body))}`)),
		);
		// Only the seeded bodies wait, so the commit's own blob goes through.
		const { store, open } = gated(inner, (key) => [...seeded].some((suffix) => key.endsWith(suffix)));
		const workspaces = createStoredWorkspaces({ store, hydration: {} });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		const committed = await workspaces.commit(ctx, record.id, {
			baseVersion: record.head,
			changes: [{ op: "put", path: "notes/new.md", content: "new\n" }],
		});
		open();
		await workspaces.hydrationSettled();
		const after = await workspaces.get(ctx, record.id);
		expect(after.head).toBe(committed.version);
		expect(after.hydration?.hydrated).toBe(true);
		expect(text((await workspaces.read(ctx, record.id, "notes/new.md")).content)).toBe("new\n");
		expect(text((await workspaces.read(ctx, record.id, "src/file-39.ts")).content)).toBe(FILES["src/file-39.ts"]);
	});

	it("splits a large seed into several packs, each read on its own", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store } = gated(inner);
		const workspaces = createStoredWorkspaces({ store, hydration: { packBytes: 200 } });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		expect(inner.keys().filter((key) => key.endsWith(".pack")).length).toBeGreaterThan(3);
		const other = createStoredWorkspaces({ store: inner });
		for (const path of ["src/file-00.ts", "src/file-20.ts", "src/file-39.ts"]) {
			expect(text((await other.read(ctx, record.id, path)).content)).toBe(FILES[path]);
		}
	});

	it("never returns bytes that do not match their digest", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store } = gated(inner);
		const workspaces = createStoredWorkspaces({ store, hydration: {} });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		const pack = inner.keys().find((key) => key.endsWith(".pack"));
		if (pack === undefined) throw new Error("no pack");
		const damaged = (await inner.getObject(pack)) ?? new Uint8Array();
		damaged.fill(0x20);
		await inner.putObject(pack, damaged);
		const other = createStoredWorkspaces({ store: inner });
		expect(await codeOf(other.read(ctx, record.id, "src/file-05.ts"))).toBe("unavailable");
	});

	it("seeds eagerly when the spec asks, when the host says so, for a small seed, and without hydration", async () => {
		const cases: [Parameters<typeof createStoredWorkspaces>[0]["hydration"], ReturnType<typeof seed>][] = [
			[{}, seed({ hydration: "eager" })],
			[{ default: "eager" }, seed()],
			[{ minBodies: 100 }, seed()],
			[undefined, seed({ hydration: "lazy" })],
		];
		for (const [hydration, spec] of cases) {
			const inner = createMemoryWorkspaceStore();
			const workspaces = createStoredWorkspaces({ store: inner, ...(hydration === undefined ? {} : { hydration }) });
			const record = await workspaces.create(ctx, { owner, seed: spec });
			expect(record.hydration).toBeUndefined();
			expect(blobKeys(inner)).toHaveLength(40);
			expect(inner.keys().some((key) => key.includes("/packs/"))).toBe(false);
		}
		// A spec that says `lazy` on a host that defaults to eager is lazy.
		const inner = createMemoryWorkspaceStore();
		const { store } = gated(inner);
		const workspaces = createStoredWorkspaces({ store, hydration: { default: "eager" } });
		const record = await workspaces.create(ctx, { owner, seed: seed({ hydration: "lazy" }) });
		expect(record.hydration?.hydrated).toBe(false);
	});
});

describe("forks", () => {
	async function hydratedSource() {
		const store = createMemoryWorkspaceStore();
		const audit = new RecordingAuditSink();
		const workspaces = createStoredWorkspaces({ store, audit, hydration: {} });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		await workspaces.hydrationSettled();
		await workspaces.commit(ctx, record.id, {
			baseVersion: record.head,
			changes: [{ op: "put", path: "src/file-00.ts", content: "changed\n" }],
		});
		return { store, audit, workspaces, record: await workspaces.get(ctx, record.id) };
	}

	it("costs one tree and a head, copies no body, and is independent of its source", async () => {
		const { store, audit, workspaces, record } = await hydratedSource();
		const blobs = blobKeys(store).length;
		const writes = store.counts.objectWrites;
		const blobReads = store.counts.blobReads;
		const fork = await workspaces.fork(ctx, record.id, { owner });
		expect(store.counts.objectWrites - writes).toBe(1);
		expect(store.counts.blobReads).toBe(blobReads);
		expect(blobKeys(store)).toHaveLength(blobs);
		expect(fork).toMatchObject({ head: 1, forkedFrom: { workspaceId: record.id, version: 2 }, seedReadiness: "files" });
		expect(fork.hydration).toBeUndefined();

		const entries = await filesOf(workspaces, fork.id);
		expect(entries).toHaveLength(40);
		expect(new Set(entries.map((entry) => entry.version))).toEqual(new Set([1]));
		expect(text((await workspaces.read(ctx, fork.id, "src/file-00.ts")).content)).toBe("changed\n");
		const history = await workspaces.history(ctx, fork.id);
		expect(history.items.map((item) => item.version)).toEqual([1, 0]);

		await workspaces.commit(ctx, fork.id, {
			baseVersion: 1,
			changes: [{ op: "put", path: "src/file-01.ts", content: "fork only\n" }],
		});
		expect(text((await workspaces.read(ctx, record.id, "src/file-01.ts")).content)).toBe(FILES["src/file-01.ts"]);
		expect(audit.ofType("workspace.forked")).toEqual([
			expect.objectContaining({
				subject: { kind: "workspace", id: fork.id },
				data: { from: record.id, version: 2, entries: 40 },
			}),
		]);
	});

	it("forks an older version, or an empty one, and refuses what the caller cannot see", async () => {
		const { workspaces, record } = await hydratedSource();
		const older = await workspaces.fork(ctx, record.id, { owner, version: 1 });
		expect(text((await workspaces.read(ctx, older.id, "src/file-00.ts")).content)).toBe(FILES["src/file-00.ts"]);
		const empty = await workspaces.fork(ctx, record.id, { owner, version: 0 });
		expect(empty.head).toBe(0);
		expect(await codeOf(workspaces.fork(ctx, record.id, { owner, version: 9 }))).toBe("not_found");
		expect(
			await codeOf(workspaces.fork(otherOrg, record.id, { owner: { kind: "organisation", organisationId: "org-2" } })),
		).toBe("not_found");
		expect(
			await codeOf(workspaces.fork(ctx, record.id, { owner: { kind: "organisation", organisationId: "org-2" } })),
		).toBe("forbidden");
	});

	it("of a workspace still hydrating reads from the same packs and hydrates too", async () => {
		const inner = createMemoryWorkspaceStore();
		const { store, open } = gated(inner);
		const events: WorkspaceHydratedEvent[] = [];
		const workspaces = createStoredWorkspaces({ store, hydration: { onHydrated: collect(events) } });
		const record = await workspaces.create(ctx, { owner, seed: seed() });
		const fork: WorkspaceRecord = await workspaces.fork(ctx, record.id, { owner });
		expect(fork.hydration?.hydrated).toBe(false);
		const other = createStoredWorkspaces({ store: inner });
		expect(text((await other.read(ctx, fork.id, "src/file-12.ts")).content)).toBe(FILES["src/file-12.ts"]);

		open();
		await workspaces.hydrationSettled();
		expect((await workspaces.get(ctx, fork.id)).hydration?.hydrated).toBe(true);
		expect((await workspaces.get(ctx, record.id)).hydration?.hydrated).toBe(true);
		expect(events.map((event) => event.workspaceId).sort()).toEqual([record.id, fork.id].sort());
		// The pack was copied out once: forty blobs, one done marker.
		expect(blobKeys(inner)).toHaveLength(40);
		expect(inner.keys().filter((key) => key.endsWith(".pack.done"))).toHaveLength(1);
	});
});
