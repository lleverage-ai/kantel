import { describe, expect, it } from "vitest";
import { durableHeadCache, type SyncKvLike, WORKSPACE_HEAD_PREFIX } from "../src/workspace-heads.ts";

function memoryKv(): SyncKvLike & { readonly values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	return {
		values,
		get: <T>(key: string) => values.get(key) as T | undefined,
		put: (key, value) => {
			values.set(key, value);
		},
		delete: (key) => values.delete(key),
	};
}

describe("workspace heads in the stack object's storage", () => {
	it("keeps each head under its own prefixed key, and drops it", () => {
		const kv = memoryKv();
		const cache = durableHeadCache(kv);
		expect(cache.get("ws-1")).toBeUndefined();
		cache.set("ws-1", { etag: "e1", text: "{}" });
		expect(kv.values.get(`${WORKSPACE_HEAD_PREFIX}ws-1`)).toEqual({ etag: "e1", text: "{}" });
		expect(cache.get("ws-1")).toEqual({ etag: "e1", text: "{}" });
		expect(cache.get("ws-2")).toBeUndefined();
		cache.delete("ws-1");
		expect(cache.get("ws-1")).toBeUndefined();
	});

	it("treats a malformed entry as a miss", () => {
		const kv = memoryKv();
		kv.put(`${WORKSPACE_HEAD_PREFIX}ws-1`, { etag: 1 });
		expect(durableHeadCache(kv).get("ws-1")).toBeUndefined();
	});
});
