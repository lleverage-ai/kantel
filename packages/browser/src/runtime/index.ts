/**
 * Harbour's own browser runtime (docs/design/browser-runtime.md): the portable parts both hosts run. The coordinator
 * (one per browser), the harbour provider the broker uses instead of brwsr's, view tokens and links, and sealing for
 * what is stored. The hosts are apps/cloudflare (a Durable Object with a Container per browser, R2) and
 * apps/selfhosted (a Docker container per browser, a directory or S3).
 */
export * from "./coordinator.ts";
export * from "./provider.ts";
export * from "./seal.ts";
export * from "./view-token.ts";
export * from "./views.ts";

/** Which provider a deployment's broker uses: brwsr.dev (the default) or Harbour's own runtime. */
export type BrowserProviderName = "brwsr" | "harbour";

/** `HARBOUR_BROWSER_PROVIDER`, read: anything but `harbour` is brwsr, so an unset or mistyped value keeps today's. */
export function browserProviderName(value: string | undefined): BrowserProviderName {
	return (value ?? "").trim().toLowerCase() === "harbour" ? "harbour" : "brwsr";
}

/** A blob store under a key prefix, so the runtime can share a bucket (`browser/` in the workspaces' R2). */
export function prefixedBlobs(
	store: import("./coordinator.ts").BlobStore,
	prefix: string,
): import("./coordinator.ts").BlobStore {
	return {
		get: (key) => store.get(prefix + key),
		put: (key, bytes) => store.put(prefix + key, bytes),
		delete: (key) => store.delete(prefix + key),
	};
}
