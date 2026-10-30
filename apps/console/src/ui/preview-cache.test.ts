import type { PresentedFile } from "@harbour/protocol";
import { presentedKey } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../api/client.ts";
import { ApiError } from "../api/http.ts";
import { createImagePreviews } from "./image-previews.ts";
import { createPreviewCache } from "./preview-cache.ts";
import { fileOfHash, hashWithFile } from "./preview-url.ts";

const file = (text: string): WorkspaceFile => ({
	content: new TextEncoder().encode(text),
	contentType: "text/plain",
	version: 1,
});

/** A read the test answers by hand, counting how often each path was asked for. */
function reads() {
	const asked = new Map<string, number>();
	const pending = new Map<string, { resolve: (value: WorkspaceFile) => void; reject: (reason: unknown) => void }>();
	const read = (path: string) => {
		asked.set(path, (asked.get(path) ?? 0) + 1);
		return new Promise<WorkspaceFile>((resolve, reject) => pending.set(path, { resolve, reject }));
	};
	return { read, asked, pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const cacheOver = (
	read: (path: string) => Promise<WorkspaceFile>,
	options: { maxBytes?: number; maxEntries?: number } = {},
) => createPreviewCache(read, (path: string) => path, { nameOf: (path: string) => path, ...options });

describe("the preview's cache", () => {
	it("reads a file once, however often it is warmed or opened", async () => {
		const { read, asked, pending } = reads();
		const cache = cacheOver(read);
		cache.load("a.md");
		cache.load("a.md");
		expect(cache.content("a.md")).toEqual({ status: "loading" });
		pending.get("a.md")?.resolve(file("# A"));
		await settle();
		cache.load("a.md");
		expect(asked.get("a.md")).toBe(1);
		expect(cache.content("a.md")).toMatchObject({ status: "ready", contentType: "text/plain" });
	});

	it("tells its listeners when a read lands", async () => {
		const { read, pending } = reads();
		const cache = cacheOver(read);
		let calls = 0;
		const stop = cache.subscribe(() => calls++);
		cache.load("a.md");
		pending.get("a.md")?.resolve(file("# A"));
		await settle();
		expect(calls).toBe(1);
		stop();
		cache.put("a.md", file("# B"));
		expect(calls).toBe(1);
	});

	it("says why a read failed, and tries again when the file is opened again", async () => {
		const { read, asked, pending } = reads();
		const cache = cacheOver(read);
		cache.load("gone.md");
		pending.get("gone.md")?.reject(new ApiError("not_found", "missing"));
		await settle();
		expect(cache.content("gone.md")).toEqual({ status: "error", message: "gone.md is no longer in the workspace." });
		cache.load("gone.md");
		expect(asked.get("gone.md")).toBe(2);
		expect(cache.content("gone.md")).toEqual({ status: "loading" });

		cache.load("huge.csv");
		pending.get("huge.csv")?.reject(new ApiError("too_large", "too large"));
		cache.load("flaky.md");
		pending.get("flaky.md")?.reject(new Error("network down"));
		await settle();
		expect(cache.content("huge.csv")).toEqual({ status: "too-large" });
		expect(cache.content("flaky.md")).toEqual({ status: "error", message: "flaky.md couldn't be read: network down" });
	});

	it("keeps what was saved in place of what was read", async () => {
		const { read, pending } = reads();
		const cache = cacheOver(read);
		cache.load("a.md");
		pending.get("a.md")?.resolve(file("old"));
		await settle();
		cache.put("a.md", { ...file("new"), version: 2 });
		expect(cache.cached("a.md")?.version).toBe(2);
		const content = cache.content("a.md");
		expect(content.status === "ready" && new TextDecoder().decode(content.bytes)).toBe("new");
	});

	it("lets the least recently used files go past its budget, never the one just read", async () => {
		const { read, asked, pending } = reads();
		const cache = cacheOver(read, { maxEntries: 2 });
		for (const path of ["a", "b"]) {
			cache.load(path);
			pending.get(path)?.resolve(file(path));
		}
		await settle();
		cache.load("a"); // a is now the most recent
		cache.load("c");
		pending.get("c")?.resolve(file("c"));
		await settle();
		expect(cache.cached("a")).toBeDefined();
		expect(cache.cached("b")).toBeUndefined();
		expect(cache.cached("c")).toBeDefined();

		const small = reads();
		const bytes = cacheOver(small.read, { maxBytes: 10 });
		bytes.load("big");
		small.pending.get("big")?.resolve(file("x".repeat(64)));
		await settle();
		expect(bytes.cached("big")).toBeDefined();
		expect(asked.get("a")).toBe(1);
	});
});

describe("an image its card has read", () => {
	const image: PresentedFile = {
		workspaceId: "ws-1",
		path: "images/cat.png",
		name: "cat.png",
		mimeType: "image/png",
		size: 3,
	};
	const png: WorkspaceFile = {
		content: new Uint8Array([1, 2, 3]),
		contentType: "image/png",
		version: 1,
		digest: "abc",
	};

	it("opens on the card's picture in its first render, with nothing loading and no second read", async () => {
		const previews = createImagePreviews(
			() => Promise.resolve(png),
			() => "blob:card",
			() => {},
		);
		await previews.url(image);
		let reads = 0;
		const cache = createPreviewCache(
			() => {
				reads++;
				return Promise.resolve(png);
			},
			presentedKey,
			{ nameOf: (file: PresentedFile) => file.name, peek: (file: PresentedFile) => previews.shown(file) },
		);
		expect(cache.content(image)).toMatchObject({ status: "ready", url: "blob:card", contentType: "image/png" });
		expect(reads).toBe(0);
		// Loading it then checks the card's read is still the file (a 304 while it is), and keeps the picture.
		cache.load(image);
		await settle();
		expect(reads).toBe(1);
		expect(cache.content(image)).toMatchObject({ status: "ready", url: "blob:card" });
	});

	it("shows the new bytes when the file changed after the card read it", async () => {
		const changed: WorkspaceFile = { ...png, content: new Uint8Array([4, 5]), digest: "def" };
		const cache = createPreviewCache(() => Promise.resolve(changed), presentedKey, {
			nameOf: (file: PresentedFile) => file.name,
			peek: () => ({ ...png, url: "blob:card" }),
		});
		cache.load(image);
		await settle();
		const content = cache.content(image);
		expect(content.status === "ready" && [...content.bytes]).toEqual([4, 5]);
		expect(content).not.toHaveProperty("url");
	});

	it("loads an image no card has read yet", () => {
		const cache = createPreviewCache(() => new Promise<WorkspaceFile>(() => {}), presentedKey, {
			nameOf: (file: PresentedFile) => file.name,
			peek: () => undefined,
		});
		cache.load(image);
		expect(cache.content(image)).toEqual({ status: "loading" });
	});
});

describe("the open file in the URL", () => {
	it("reads and writes #file= beside other parameters", () => {
		expect(fileOfHash("#file=outputs%2Freport.md")).toBe("outputs/report.md");
		expect(fileOfHash("#turn=4&file=a.md")).toBe("a.md");
		expect(fileOfHash("#turn=4")).toBeUndefined();
		expect(fileOfHash("")).toBeUndefined();
		expect(hashWithFile("#turn=4", "out/a b.md")).toBe("#turn=4&file=out%2Fa+b.md");
		expect(fileOfHash(hashWithFile("#turn=4", "out/a b.md"))).toBe("out/a b.md");
		expect(hashWithFile("#turn=4&file=a.md", undefined)).toBe("#turn=4");
		expect(hashWithFile("#file=a.md", undefined)).toBe("");
	});
});
