// Sticky disks through the HTTP API with the SDK, on the stub backend: a disk made empty, attached to sandboxes,
// committed from one and started from by the next, and the checks a create's paths get.
import { createKantelClient } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setUp(stickyDisks = true) {
	const api = createComputeApi({
		backend: createStubBackend(),
		stickyDisks,
		authenticatePerson: async (request) =>
			request.headers.get("authorization") === "Bearer tom-token"
				? { userId: "usr_tom", name: "Tom", email: "tom@example.com" }
				: undefined,
	});
	opened.push(api);
	return createKantelClient({
		baseUrl: "http://compute.test/v1",
		token: "tom-token",
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
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
