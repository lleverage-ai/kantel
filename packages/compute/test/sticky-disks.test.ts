// Sticky disks through the HTTP API with the SDK, on the stub backend: a disk made empty, attached to sandboxes,
// committed from one and started from by the next, and the checks a create's paths get.
import { createKantelClient } from "@kantel/api/sdk";
import type { SqlDriver } from "@kantel/sql";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabaseKind } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendStickyHoldings, SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import {
	type ComputeStore,
	createMemoryStore,
	type StoredStickyDisk,
	type StoredStickyDiskVersion,
	stickyDiskNameId,
} from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const opened: ComputeApi[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setUp(stickyDisks = true, wrap: (backend: SandboxBackend) => SandboxBackend = (backend) => backend) {
	const clock = { now: Date.UTC(2026, 10, 11) };
	const api = createComputeApi({
		backend: wrap(createStubBackend()),
		stickyDisks,
		now: () => clock.now,
		authenticatePerson: async (request) =>
			request.headers.get("authorization") === "Bearer tom-token"
				? { userId: "usr_tom", name: "Tom", email: "tom@example.com" }
				: undefined,
	});
	opened.push(api);
	const client = createKantelClient({
		baseUrl: "http://compute.test/v1",
		token: "tom-token",
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
	return Object.assign(client, { api, clock });
}

describe("sticky disks", () => {
	it("gives each sandbox a copy of the newest version, and makes a commit the next one", async () => {
		const tom = setUp();
		const disk = await tom.createStickyDisk({ name: "ci-cache", sizeGb: 100 });
		expect(disk).toMatchObject({ name: "ci-cache", sizeGb: 100, versions: [] });
		expect(disk.head).toBeUndefined();
		const first = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "ci-cache", path: "/var/lib/ci/" }],
			wait: true,
		});
		expect(first.stickyDisks).toEqual([{ diskId: disk.id, name: "ci-cache", path: "/var/lib/ci", state: "mounted" }]);
		const version = await tom.commitStickyDisk(first.id, "ci-cache");
		expect(version).toMatchObject({ sandboxId: first.id, hostId: expect.any(String) });
		expect(version.parent).toBeUndefined();
		expect((await tom.getStickyDisk(disk.id)).head).toBe(version.id);
		const second = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: disk.id, path: "/var/lib/ci" }],
			wait: true,
		});
		expect(second.stickyDisks?.[0]).toMatchObject({ version: version.id, state: "mounted" });
		const next = await tom.commitStickyDisk(second.id, disk.id);
		expect(next.parent).toBe(version.id);
		expect((await tom.getStickyDisk("ci-cache")).versions?.map((item) => item.id)).toEqual([next.id, version.id]);
		await tom.deleteStickyDisk("ci-cache");
		expect((await tom.listStickyDisks()).items).toEqual([]);
	});

	it("gives a name to one disk at a time, and frees it when the disk is deleted", async () => {
		const tom = setUp();
		const made = await Promise.allSettled([
			tom.createStickyDisk({ name: "cache", sizeGb: 10 }, { idempotencyKey: "one" }),
			tom.createStickyDisk({ name: "cache", sizeGb: 10 }, { idempotencyKey: "two" }),
		]);
		expect(made.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const first = (await tom.listStickyDisks()).items[0];
		if (first === undefined) throw new Error("no disk");
		await tom.deleteStickyDisk("cache");
		await expect(tom.getStickyDisk(first.id)).rejects.toMatchObject({ code: "not_found" });
		const again = await tom.createStickyDisk({ name: "cache", sizeGb: 10 });
		expect(again.id).not.toBe(first.id);
		expect((await tom.listStickyDisks()).items.map((disk) => disk.id)).toEqual([again.id]);
	});

	it("leaves no version of a disk deleted while a commit was made, and deletes its versions again later", async () => {
		const deleted: string[] = [];
		let during: (() => Promise<void>) | undefined;
		const tom = setUp(true, (backend) => ({
			...backend,
			async commitStickyDisk(sandboxId, diskId, version) {
				const committed = await (backend.commitStickyDisk?.(sandboxId, diskId, version) ?? Promise.reject(new Error()));
				await during?.();
				return committed;
			},
			async deleteStickyDisk(diskId) {
				deleted.push(diskId);
				await backend.deleteStickyDisk?.(diskId);
			},
		}));
		const disk = await tom.createStickyDisk({ name: "cache", sizeGb: 10 });
		const sandbox = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "cache", path: "/cache" }],
			wait: true,
		});
		during = () => tom.deleteStickyDisk(disk.id);
		await expect(tom.commitStickyDisk(sandbox.id, disk.id)).rejects.toMatchObject({ code: "not_found" });
		expect(await tom.api.store.stickyDiskVersions.list({ diskId: disk.id })).toEqual([]);
		// Once by the delete, once by the commit that lost to it; the sweep tries again for a host that was away.
		expect(deleted).toEqual([disk.id, disk.id]);
		tom.clock.now += 11 * 60_000;
		await tom.api.service.sweep();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deleted).toEqual([disk.id, disk.id, disk.id]);
	});

	it("forgets a version its host no longer reports holding, but never the head or a version newer than the report", async () => {
		let reports: BackendStickyHoldings[] = [];
		const tom = setUp(true, (backend) => ({ ...backend, stickyHoldings: async () => reports }));
		const disk = await tom.createStickyDisk({ name: "cache", sizeGb: 10 });
		const sandbox = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "cache", path: "/cache" }],
			wait: true,
		});
		const old = await tom.commitStickyDisk(sandbox.id, disk.id);
		const kept = await tom.commitStickyDisk(sandbox.id, disk.id);
		const listed = async () => (await tom.getStickyDisk(disk.id)).versions?.map((each) => each.id);
		const sweep = async () => {
			tom.clock.now += 11 * 60_000;
			await tom.api.service.sweep();
			await tom.api.service.idle();
		};
		// A host from before sticky disks says nothing of what it holds: that isn't holding none.
		reports = [{ hostId: old.hostId, reportedAt: tom.clock.now + 11 * 60_000 }];
		await sweep();
		expect(await listed()).toEqual([kept.id, old.id]);
		// A report taken a moment before two more commits: the old version is gone from it, the newer ones not yet in it.
		reports = [{ hostId: old.hostId, reportedAt: tom.clock.now, disks: [{ diskId: disk.id, versions: [kept.id] }] }];
		const recent = await tom.commitStickyDisk(sandbox.id, disk.id);
		const head = await tom.commitStickyDisk(sandbox.id, disk.id);
		await sweep();
		expect(await listed()).toEqual([head.id, recent.id, kept.id]);
		// The host holds none of the disk now: everything but the head, which stays until a commit replaces it.
		reports = [{ hostId: old.hostId, reportedAt: tom.clock.now + 11 * 60_000, disks: [] }];
		await sweep();
		expect(await listed()).toEqual([head.id]);
		expect((await tom.getStickyDisk(disk.id)).head).toBe(head.id);
	});

	it("keeps a version's block map digest from its commit, or from its own host's report once the map is made", async () => {
		let reports: BackendStickyHoldings[] = [];
		let digest: string | undefined = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const tom = setUp(true, (backend) => ({
			...backend,
			stickyHoldings: async () => reports,
			async commitStickyDisk(sandboxId, diskId, version) {
				const committed = await (backend.commitStickyDisk?.(sandboxId, diskId, version) ?? Promise.reject(new Error()));
				return digest === undefined ? committed : { ...committed, mapDigest: digest };
			},
		}));
		const disk = await tom.createStickyDisk({ name: "cache", sizeGb: 10 });
		const sandbox = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "cache", path: "/cache" }],
			wait: true,
		});
		const mapped = await tom.commitStickyDisk(sandbox.id, disk.id);
		digest = undefined;
		const late = await tom.commitStickyDisk(sandbox.id, disk.id);
		const stored = async (id: string) => (await tom.api.store.stickyDiskVersions.get(id))?.mapDigest;
		expect(await stored(mapped.id)).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(await stored(late.id)).toBeUndefined();
		// Another host's word on a version isn't taken, nor a digest for one that has its own already.
		const versions = [mapped.id, late.id];
		reports = [
			{
				hostId: "host_other",
				reportedAt: tom.clock.now,
				disks: [
					{
						diskId: disk.id,
						versions,
						mapDigests: { [late.id]: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
					},
				],
			},
		];
		tom.clock.now += 11 * 60_000;
		await tom.api.service.sweep();
		await tom.api.service.idle();
		expect(await stored(late.id)).toBeUndefined();
		reports = [
			{
				hostId: late.hostId,
				reportedAt: tom.clock.now,
				disks: [
					{
						diskId: disk.id,
						versions,
						mapDigests: {
							[mapped.id]: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
							[late.id]: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						},
					},
				],
			},
		];
		tom.clock.now += 11 * 60_000;
		await tom.api.service.sweep();
		await tom.api.service.idle();
		expect(await stored(late.id)).toBe("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
		expect(await stored(mapped.id)).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	});

	it("refuses a disk at a system path, twice, inside another, or on an isolate", async () => {
		const tom = setUp();
		await tom.createStickyDisk({ name: "one", sizeGb: 10 });
		await tom.createStickyDisk({ name: "two", sizeGb: 10 });
		await expect(tom.createStickyDisk({ name: "one", sizeGb: 10 })).rejects.toMatchObject({ code: "conflict" });
		for (const stickyDisks of [
			[{ disk: "one", path: "/" }],
			[{ disk: "one", path: "/usr/local" }],
			[{ disk: "one", path: "/var/lib/docker" }],
			[{ disk: "one", path: "/data/../etc" }],
			[
				{ disk: "one", path: "/data" },
				{ disk: "one", path: "/other" },
			],
			[
				{ disk: "one", path: "/data" },
				{ disk: "two", path: "/data/inner" },
			],
		]) {
			await expect(tom.createSandbox({ type: "microvm", stickyDisks })).rejects.toMatchObject({ code: "invalid" });
		}
		await expect(
			tom.createSandbox({ type: "isolate", stickyDisks: [{ disk: "one", path: "/data" }] }),
		).rejects.toMatchObject({ code: "invalid" });
		await expect(
			tom.createSandbox({ type: "microvm", stickyDisks: [{ disk: "missing", path: "/data" }] }),
		).rejects.toMatchObject({ code: "not_found" });
	});

	it("keeps an account's disks' tombstones past its deletion, so a host away then still has their versions deleted", async () => {
		const host = { online: true, deleted: [] as string[] };
		const tom = setUp(true, (backend) => ({
			...backend,
			async deleteStickyDisk(diskId) {
				if (!host.online) throw new Error("the host holding it is offline");
				host.deleted.push(diskId);
				await backend.deleteStickyDisk?.(diskId);
			},
		}));
		const disk = await tom.createStickyDisk({ name: "cache", sizeGb: 10 });
		const sandbox = await tom.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "cache", path: "/cache" }],
			wait: true,
		});
		await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.deleteSandbox(sandbox.id);
		const { accounts } = await tom.getCaller();
		host.online = false;
		await tom.deleteCaller();
		const store = tom.api.store;
		expect(await store.accounts.get(accounts[0]?.id ?? "")).toBeUndefined();
		expect((await store.stickyDisks.get(disk.id))?.deletedAt).toBeDefined();
		expect(await store.stickyDiskVersions.list({ diskId: disk.id })).toEqual([]);
		expect(await store.stickyDiskNames.list()).toEqual([]);
		expect(host.deleted).toEqual([]);
		// The host is back: the next sweep deletes the disk's versions there, until the tombstone expires.
		host.online = true;
		tom.clock.now += 11 * 60_000;
		await tom.api.service.sweep();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.deleted).toContain(disk.id);
		tom.clock.now += 31 * 24 * 3_600_000;
		await tom.api.service.sweep();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await store.stickyDisks.get(disk.id)).toBeUndefined();
	});

	it("answers not_supported while the deployment has them off", async () => {
		const tom = setUp(false);
		await expect(tom.createStickyDisk({ name: "one", sizeGb: 10 })).rejects.toMatchObject({ code: "not_supported" });
		await expect(
			tom.createSandbox({ type: "microvm", stickyDisks: [{ disk: "one", path: "/data" }] }),
		).rejects.toMatchObject({ code: "not_supported" });
	});
});

const disk = (id: string, name = "cache"): StoredStickyDisk => ({
	id,
	accountId: "acc_1",
	name,
	sizeGb: 10,
	createdAt: 1,
	updatedAt: 1,
});
const version = (id: string, diskId: string): StoredStickyDiskVersion => ({
	id,
	diskId,
	accountId: "acc_1",
	hostId: "host_1",
	sandboxId: "sbx_1",
	sizeBytes: 100,
	allocatedBytes: 10,
	seq: 0,
	createdAt: 2,
});

/** A fresh SQL store over `kind`; with `interrupt.next` set, its next batch fails after its own statements have run. */
async function sqlStore(kind: TestDatabaseKind, interrupt: { next: boolean }): Promise<ComputeStore> {
	const database = await kind.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	const driver: SqlDriver = {
		dialect: database.driver.dialect,
		query: (text, params) => database.driver.query(text, params),
		async batch(statements) {
			if (!interrupt.next) return database.driver.batch(statements);
			interrupt.next = false;
			await database.driver.batch([...statements, { sql: "SELECT no_such_column FROM no_such_table" }]);
		},
	};
	return createSqlComputeStore(driver);
}

const STORES: readonly { readonly name: string; readonly kind?: TestDatabaseKind }[] = [
	{ name: "the memory store" },
	{ name: `a SQL store on ${pgliteDatabase.name}`, kind: pgliteDatabase },
	{ name: `a SQL store on ${nodeSqliteDatabase.name}`, kind: nodeSqliteDatabase },
];

for (const each of STORES) {
	const timeout = each.kind?.testTimeoutMs === undefined ? {} : { timeout: each.kind.testTimeoutMs };
	const interrupt = { next: false };
	const open = (): Promise<ComputeStore> =>
		each.kind === undefined ? Promise.resolve(createMemoryStore()) : sqlStore(each.kind, interrupt);
	const claimOf = async (store: ComputeStore, name = "cache") =>
		(await store.stickyDiskNames.get(stickyDiskNameId("acc_1", name)))?.diskId;

	describe(`sticky disk writes in ${each.name}`, timeout, () => {
		it("give a name to one live disk at a time, and a delayed delete never frees a newer disk's name", async () => {
			const store = await open();
			const made = await Promise.all([
				store.stickyDiskWrites.create(disk("sdk_a")),
				store.stickyDiskWrites.create(disk("sdk_b")),
			]);
			expect(made.filter(Boolean)).toHaveLength(1);
			const [winner, loser] = made[0] === true ? ["sdk_a", "sdk_b"] : ["sdk_b", "sdk_a"];
			expect(await store.stickyDisks.get(loser)).toBeUndefined();
			expect(await claimOf(store)).toBe(winner);
			expect((await store.stickyDiskWrites.tombstone(winner, 5))?.deletedAt).toBe(5);
			expect(await claimOf(store)).toBeUndefined();
			expect(await store.stickyDiskWrites.create(disk("sdk_c"))).toBe(true);
			// The old disk's delete again, late: its tombstone stays as it was, and the new disk keeps its name.
			expect((await store.stickyDiskWrites.tombstone(winner, 9))?.deletedAt).toBe(5);
			expect(await claimOf(store)).toBe("sdk_c");
			expect(await store.stickyDiskWrites.tombstone("sdk_missing", 9)).toBeUndefined();
		});

		it("record a version with its live disk's head, in order, and none once the disk is tombstoned", async () => {
			const store = await open();
			await store.stickyDiskWrites.create(disk("sdk_a"));
			const committed = await Promise.all([
				store.stickyDiskWrites.commit(version("sdv_1", "sdk_a"), 3),
				store.stickyDiskWrites.commit(version("sdv_2", "sdk_a"), 3),
			]);
			expect(committed.map((each) => each?.seq).sort()).toEqual([1, 2]);
			const last = committed.find((each) => each?.seq === 2);
			expect((await store.stickyDisks.get("sdk_a"))?.head).toBe(last?.id);
			await store.stickyDiskWrites.tombstone("sdk_a", 4);
			expect(await store.stickyDiskWrites.commit(version("sdv_3", "sdk_a"), 5)).toBeUndefined();
			expect((await store.stickyDiskVersions.list({ diskId: "sdk_a" })).map((each) => each.id).sort()).toEqual([
				"sdv_1",
				"sdv_2",
			]);
			expect((await store.stickyDisks.get("sdk_a"))?.head).toBe(last?.id);
			// Forgetting the head is refused; any other version is forgotten.
			const first = committed.find((each) => each?.seq === 1);
			expect(await store.stickyDiskWrites.forget(last?.id ?? "")).toBe(false);
			expect(await store.stickyDiskWrites.forget(first?.id ?? "")).toBe(true);
			expect((await store.stickyDiskVersions.list({ diskId: "sdk_a" })).map((each) => each.id)).toEqual([last?.id]);
		});

		it("keep a version's block map digest, given with its commit or after", async () => {
			const store = await open();
			await store.stickyDiskWrites.create(disk("sdk_a"));
			await store.stickyDiskWrites.commit(
				{
					...version("sdv_1", "sdk_a"),
					mapDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
				3,
			);
			await store.stickyDiskWrites.commit(version("sdv_2", "sdk_a"), 4);
			expect((await store.stickyDiskVersions.get("sdv_1"))?.mapDigest).toBe(
				"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			);
			expect((await store.stickyDiskVersions.get("sdv_2"))?.mapDigest).toBeUndefined();
			await store.stickyDiskVersions.update("sdv_2", (current) => ({
				...current,
				mapDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			}));
			expect(await store.stickyDiskVersions.get("sdv_2")).toMatchObject({
				seq: 2,
				mapDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			});
		});

		if (each.kind !== undefined) {
			it("delete a disk whatever its description holds, and a repeated delete leaves a new disk's name", async () => {
				const store = await open();
				// A NUL and a lone surrogate: what a description may hold, and what Postgres's jsonb refuses.
				for (const [n, description] of ["a\u0000b", "\udc00"].entries()) {
					const name = `odd-${n}`;
					const odd = { ...disk(`sdk_odd${n}`, name), description };
					expect(await store.stickyDiskWrites.create(odd)).toBe(true);
					expect((await store.stickyDiskWrites.tombstone(odd.id, 5))?.deletedAt).toBe(5);
					expect(await claimOf(store, name)).toBeUndefined();
					expect(await store.stickyDiskWrites.create({ ...disk(`sdk_new${n}`, name), description })).toBe(true);
					expect((await store.stickyDiskWrites.tombstone(odd.id, 9))?.deletedAt).toBe(5);
					expect(await claimOf(store, name)).toBe(`sdk_new${n}`);
					expect((await store.stickyDiskWrites.commit(version(`sdv_${n}`, `sdk_new${n}`), 6))?.seq).toBe(1);
				}
			});

			it("leave all of a create, a tombstone or a commit, or none of it, when the write is interrupted", async () => {
				const store = await open();
				interrupt.next = true;
				await expect(store.stickyDiskWrites.create(disk("sdk_a"))).rejects.toThrow();
				expect(await store.stickyDisks.get("sdk_a")).toBeUndefined();
				expect(await claimOf(store)).toBeUndefined();
				expect(await store.stickyDiskWrites.create(disk("sdk_b"))).toBe(true);

				interrupt.next = true;
				await expect(store.stickyDiskWrites.commit(version("sdv_1", "sdk_b"), 3)).rejects.toThrow();
				expect((await store.stickyDisks.get("sdk_b"))?.head).toBeUndefined();
				expect(await store.stickyDiskVersions.get("sdv_1")).toBeUndefined();

				interrupt.next = true;
				await expect(store.stickyDiskWrites.tombstone("sdk_b", 4)).rejects.toThrow();
				expect((await store.stickyDisks.get("sdk_b"))?.deletedAt).toBeUndefined();
				expect(await claimOf(store)).toBe("sdk_b");
			});
		}
	});
}
