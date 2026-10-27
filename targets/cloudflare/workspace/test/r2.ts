import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { R2BucketLike } from "../src/index.ts";

/**
 * The R2 binding from ../wrangler.jsonc through wrangler's platform proxy: the same local R2 (workerd's) that
 * `wrangler dev` serves. Nothing persists past `dispose`.
 */
export async function localR2(): Promise<{ bucket: R2BucketLike; dispose: () => Promise<void> }> {
	const proxy = await getPlatformProxy<{ WORKSPACES: R2BucketLike }>({
		configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
		persist: false,
	});
	return { bucket: proxy.env.WORKSPACES, dispose: () => proxy.dispose() };
}

/** Counts reads of blobs and trees through a bucket. */
export function counting(bucket: R2BucketLike): { bucket: R2BucketLike; counts: { blobs: number; trees: number } } {
	const counts = { blobs: 0, trees: 0 };
	return {
		counts,
		bucket: {
			async get(key) {
				const object = await bucket.get(key);
				if (object !== null) {
					if (key.includes("/blobs/")) counts.blobs++;
					else if (key.includes("/trees/")) counts.trees++;
				}
				return object;
			},
			put: (key, value, options) => bucket.put(key, value, options),
		},
	};
}
