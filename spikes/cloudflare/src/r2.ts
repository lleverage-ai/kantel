import type { ObjectStore } from "./workspace.ts";

/** The workspace's `ObjectStore` over an R2 bucket: the same conditional puts, with R2's etags. */
export function r2Store(bucket: R2Bucket): ObjectStore {
	return {
		async get(key) {
			const object = await bucket.get(key);
			return object === null
				? null
				: { etag: object.etag, text: () => object.text(), arrayBuffer: () => object.arrayBuffer() };
		},
		async put(key, value, options) {
			const put = await bucket.put(key, value, options?.onlyIf === undefined ? undefined : { onlyIf: options.onlyIf });
			return put === null ? null : { etag: put.etag };
		},
	};
}
