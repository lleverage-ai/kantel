import { BLOB_CACHE_BYTES, BlobCache } from "@kantel/sandbox/isolate";
import { describe, expect, it } from "vitest";

const bytes = (size: number) => new Uint8Array(size);

describe("BlobCache", () => {
	it("defaults to 32 MiB", () => {
		expect(BLOB_CACHE_BYTES).toBe(32 * 1024 * 1024);
		const cache = new BlobCache();
		cache.set("a", bytes(BLOB_CACHE_BYTES));
		expect(cache.bytes).toBe(BLOB_CACHE_BYTES);
	});

	it("keeps at most maxBytes, emptying itself before it would pass them", () => {
		const cache = new BlobCache(100);
		cache.set("a", bytes(60));
		cache.set("b", bytes(30));
		expect(cache.bytes).toBe(90);
		cache.set("c", bytes(20));
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")?.byteLength).toBe(20);
		expect(cache.bytes).toBe(20);
	});

	it("never keeps a body larger than maxBytes, and keeps what it has", () => {
		const cache = new BlobCache(100);
		cache.set("a", bytes(50));
		cache.set("big", bytes(101));
		expect(cache.get("big")).toBeUndefined();
		expect(cache.get("a")?.byteLength).toBe(50);
		expect(cache.bytes).toBe(50);
	});

	it("counts a digest once", () => {
		const cache = new BlobCache(100);
		cache.set("a", bytes(40));
		cache.set("a", bytes(40));
		expect(cache.bytes).toBe(40);
	});
});
