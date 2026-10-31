// The self-hosted browser host, without Docker: its auth, its view routes' refusals, and where it keeps blobs.
import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserViewSigner } from "@kantel/browser/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { directoryBlobStore, sweepRecordings } from "../../src/browser/blobs.ts";
import { createBrowserHost, dockerMachines } from "../../src/browser/host.ts";

const VIEW_KEY = "test-browser-view-key-0123456789abcdef";
const HOST_TOKEN = "test-browser-host-token-0123456789abcdef";
const dirs: string[] = [];
const scratch = async () => {
	const dir = await mkdtemp(join(tmpdir(), "harbour-browser-"));
	dirs.push(dir);
	return dir;
};
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function host() {
	const created = createBrowserHost({
		token: HOST_TOKEN,
		viewKey: VIEW_KEY,
		sealKey: "test-browser-seal-key-0123456789abcdef",
		dataDir: await scratch(),
		recordingRetentionMs: 60_000,
		machines: dockerMachines({
			socket: "/nonexistent.sock",
			image: "harbour-browser:test",
			stack: "test",
			memoryBytes: 1,
			nanoCpus: 1,
		}),
	});
	const server = { upgrade: () => false } as never;
	return {
		ask: async (path: string, init: RequestInit = {}) =>
			(await created.fetch(new Request(`http://h${path}`, init), server))!,
		stop: () => created.stop(),
	};
}

describe("the self-hosted browser host", () => {
	it("refuses the coordinator's routes without its token", async () => {
		const h = await host();
		try {
			expect((await h.ask("/browsers/b1/status")).status).toBe(401);
			const wrong = await h.ask("/browsers/b1/status", { headers: { authorization: "Bearer not-the-token" } });
			expect(wrong.status).toBe(401);
			// With the token, a browser it never started is unknown, and nothing is created for it.
			const unknown = await h.ask("/browsers/b1/status", { headers: { authorization: `Bearer ${HOST_TOKEN}` } });
			expect(unknown.status).toBe(404);
			expect(await (await h.ask("/health")).json()).toMatchObject({ ok: true, browsers: 0 });
		} finally {
			await h.stop();
		}
	});

	it("refuses a view without a valid token for its browser", async () => {
		const h = await host();
		try {
			const token = await createBrowserViewSigner(VIEW_KEY).sign({
				browser: "b1",
				mode: "live",
				control: false,
				expiresAt: Date.now() + 60_000,
			});
			expect((await h.ask("/v1/browser/view/b1")).status).toBe(401);
			expect((await h.ask("/v1/browser/view/b2", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
			// A good token for a browser this host doesn't run: the socket can't open.
			const live = await h.ask("/v1/browser/view/b1/live", {
				headers: { upgrade: "websocket", "sec-websocket-protocol": `harbour-view.v1, harbour-view-token.${token}` },
			});
			expect(live.status).toBe(410);
		} finally {
			await h.stop();
		}
	});
});

describe("the browser host's blob directory", () => {
	it("keeps blobs under their keys and never outside the directory", async () => {
		const dir = await scratch();
		const blobs = directoryBlobStore(dir);
		await blobs.put("recordings/b1/manifest.json", new Uint8Array([1, 2]));
		expect(await blobs.get("recordings/b1/manifest.json")).toEqual(new Uint8Array([1, 2]));
		expect(await blobs.get("recordings/b1/none.mkv")).toBeUndefined();
		expect(((await stat(join(dir, "recordings/b1/manifest.json"))).mode & 0o777).toString(8)).toBe("600");
		await expect(blobs.put("../escape", new Uint8Array([1]))).rejects.toThrow("may not leave");
		await expect(blobs.get("recordings/../../escape")).rejects.toThrow("may not leave");
		await blobs.delete("recordings/b1/manifest.json");
		expect(await blobs.get("recordings/b1/manifest.json")).toBeUndefined();
	});

	it("deletes recordings past their retention, and keeps newer ones and profiles", async () => {
		const dir = await scratch();
		const blobs = directoryBlobStore(dir);
		await blobs.put("recordings/old/manifest.json", new Uint8Array([1]));
		await blobs.put("recordings/old/1/00000.mkv", new Uint8Array([1]));
		await blobs.put("recordings/new/manifest.json", new Uint8Array([1]));
		await blobs.put("contexts/ctx.tgz", new Uint8Array([1]));
		const now = Date.now();
		const old = new Date(now - 120_000);
		await utimes(join(dir, "recordings/old/manifest.json"), old, old);
		expect(await sweepRecordings(dir, 60_000, now)).toBe(1);
		expect(await readdir(join(dir, "recordings"))).toEqual(["new"]);
		expect(await blobs.get("contexts/ctx.tgz")).toEqual(new Uint8Array([1]));
	});
});
