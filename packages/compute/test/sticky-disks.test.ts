// Sticky disks through the HTTP API with the SDK, on the stub backend: a disk made empty, attached to sandboxes,
// committed from one and started from by the next, and the checks a create's paths get.
import { createKantelClient } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
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

	it("answers not_supported while the deployment has them off", async () => {
		const tom = setUp(false);
		await expect(tom.createStickyDisk({ name: "one", sizeGb: 10 })).rejects.toMatchObject({ code: "not_supported" });
		await expect(
			tom.createSandbox({ type: "microvm", stickyDisks: [{ disk: "one", path: "/data" }] }),
		).rejects.toMatchObject({ code: "not_supported" });
	});
});
