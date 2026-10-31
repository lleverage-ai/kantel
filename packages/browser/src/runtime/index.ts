/**
 * Kantel's own browser runtime (docs/design/browser-runtime.md): the portable parts both hosts run. The coordinator
 * (one per browser), the harbour provider the broker uses instead of brwsr's, view tokens and links, and sealing for
 * what is stored. The hosts are apps/cloudflare (a Durable Object with a Container per browser, R2) and
 * apps/selfhosted (a Docker container per browser, a directory or S3).
 */
export * from "./coordinator.ts";
export * from "./provider.ts";
export * from "./seal.ts";
export * from "./view-token.ts";
export * from "./views.ts";

/** Which provider a deployment's broker uses: brwsr.dev (the default) or Kantel's own runtime. */
export type BrowserProviderName = "brwsr" | "harbour";

/** `KANTEL_BROWSER_PROVIDER`, read: anything but `harbour` is brwsr, so an unset or mistyped value keeps today's. */
export function browserProviderName(value: string | undefined): BrowserProviderName {
	return (value ?? "").trim().toLowerCase() === "harbour" ? "harbour" : "brwsr";
}

/**
 * Where Kantel's own browsers' view links point: the console's `/browser/<browser>#<token>` page, on whatever host
 * served it. The token is in the fragment, which no server receives.
 */
export const BROWSER_VIEW_BASE = "/browser";

/** The viewer page's path: `/browser/<browser>`, its token after `#`. */
export const VIEWER_PAGE = /^\/browser\/[A-Za-z0-9-]{1,64}\/?$/;

/**
 * The origins in `KANTEL_EMBED_ORIGINS` that may frame the viewer: each an `https://` origin (or `http://localhost`
 * and `127.0.0.1` with any port, for development). Anything else, a path or a wildcard included, is dropped.
 */
export function embedOrigins(value: string | undefined): readonly string[] {
	const origins: string[] = [];
	for (const each of (value ?? "").split(/[\s,]+/)) {
		if (each === "") continue;
		let url: URL;
		try {
			url = new URL(each);
		} catch {
			continue;
		}
		const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
		if ((url.protocol !== "https:" && !local) || url.origin !== each.replace(/\/$/, "")) continue;
		// A plain host name only: no wildcard, which `URL` lets through.
		if (!/^[a-z0-9.-]+$/.test(url.hostname)) continue;
		if (!origins.includes(url.origin)) origins.push(url.origin);
	}
	return origins;
}

/**
 * The viewer page's headers on top of the page as served: never cached, no referrer, and framed only by the console
 * itself and the `KANTEL_EMBED_ORIGINS` (`frame-ancestors`), since an outside app frames it through the embed API.
 */
export function viewerPageHeaders(served: Headers, origins: string | undefined): Headers {
	const headers = new Headers(served);
	headers.set("cache-control", "no-store");
	headers.set("referrer-policy", "no-referrer");
	headers.set("content-security-policy", `frame-ancestors ${["'self'", ...embedOrigins(origins)].join(" ")}`);
	headers.delete("x-frame-options");
	headers.delete("etag");
	return headers;
}

/** The only request headers a gateway passes on to a browser host's view routes: the token and a socket's upgrade. */
export const VIEW_FORWARD_HEADERS: readonly string[] = [
	"authorization",
	"upgrade",
	"connection",
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-protocol",
];

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
