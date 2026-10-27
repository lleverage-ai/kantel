/**
 * The workspace read API: the HTTP surface the console's file browser and note viewer read, and a typed client for it.
 *
 * It is read-only and portable (fetch `Request`/`Response`, no Node modules), so the Cloudflare gateway Worker and the
 * self-hosted gateway mount the same handler. It reads through `Workspaces` only: it holds no `Sandboxes`, so browsing
 * files can never acquire a sandbox. Who the caller is stays the host's job (`authenticate`); every read then goes
 * through the workspace's own project-access checks, including the source-project check on reads through a mount.
 *
 * Routes, under `basePath` (default `/v1/workspaces`), all `GET`:
 *
 * | Route | Returns |
 * | --- | --- |
 * | `/:id` | the `WorkspaceRecord` (head, pinned mounts, seed readiness) |
 * | `/:id/files?path=&recursive=&version=&cursor=&limit=` | a `Page<FileEntry>`, never file bodies; `path=/project` lists a mount |
 * | `/:id/stat?path=&version=` | one `FileEntry` |
 * | `/:id/content?path=&version=` | the file's bytes, with `ETag` (its digest) and `Harbour-Version` |
 * | `/:id/history?cursor=&limit=` | a `Page<WorkspaceVersionInfo>`, newest first |
 *
 * Errors are `{ "error": { "code", "message" } }` with the status `errorStatus` gives. Content is served so a browser
 * never runs it: HTML is sent as text, every response has `nosniff` and a sandboxing CSP.
 */
import {
	type CallContext,
	type ErrorCode,
	type FileContent,
	type FileEntry,
	HarbourError,
	isHarbourError,
	type ListOptions,
	type Page,
	type PageRequest,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
	type WorkspaceVersion,
	type WorkspaceVersionInfo,
} from "@harbour/contracts";

export const WORKSPACE_READ_API_BASE = "/v1/workspaces";

/** Bytes the content route serves by default; larger files are refused with 413. */
export const DEFAULT_MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** The response header carrying a file's version: a workspace version number, or a mount's pinned version string. */
export const VERSION_HEADER = "Harbour-Version";

/** The operations the read API uses. Any `Workspaces` satisfies it; nothing here can write. */
export type WorkspaceReader = Pick<Workspaces, "get" | "list" | "stat" | "read" | "history">;

export interface WorkspaceReadApiOptions {
	readonly workspaces: WorkspaceReader;
	/**
	 * Who is calling, from the request (Access JWT, OIDC session or API key). Throw a `HarbourError` to refuse; its code
	 * sets the status. The API never decides identity itself.
	 */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** Route prefix, without a trailing slash. Default `/v1/workspaces`. */
	readonly basePath?: string;
	/** The largest file the content route serves. Default 16 MiB. */
	readonly maxContentBytes?: number;
}

/** Handles a request under `basePath`; resolves `null` for any other path, so a gateway can try its next route. */
export type WorkspaceReadHandler = (request: Request) => Promise<Response | null>;

const STATUS: { readonly [code in ErrorCode]: number } = {
	invalid: 400,
	forbidden: 403,
	refused: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	exhausted: 429,
	aborted: 499,
	not_supported: 501,
	unavailable: 503,
};

/** The HTTP status for a Harbour error code. */
export function errorStatus(code: ErrorCode): number {
	return STATUS[code] ?? 500;
}

export function createWorkspaceReadApi(options: WorkspaceReadApiOptions): WorkspaceReadHandler {
	const base = (options.basePath ?? WORKSPACE_READ_API_BASE).replace(/\/+$/, "");
	const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
	const { workspaces } = options;

	return async (request) => {
		const url = new URL(request.url);
		if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
		const response = await handle(request, url);
		// A HEAD answer never has a body, errors included.
		return request.method === "HEAD" && response.body !== null
			? new Response(null, { status: response.status, headers: response.headers })
			: response;
	};

	async function handle(request: Request, url: URL): Promise<Response> {
		const segments = url.pathname
			.slice(base.length + 1)
			.split("/")
			.map((segment) => safeDecode(segment));
		try {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return errorResponse(405, "not_supported", "the workspace read API is read-only", { Allow: "GET, HEAD" });
			}
			const [id, route, ...rest] = segments;
			if (id === undefined || id === "" || id === null || rest.length > 0 || route === null) {
				return errorResponse(404, "not_found", "no such route");
			}
			const ctx = await options.authenticate(request);
			const query = url.searchParams;
			switch (route) {
				case undefined:
					return json(await workspaces.get(ctx, id));
				case "files":
					return json(await workspaces.list(ctx, id, listOptions(query)));
				case "stat":
					return json(await workspaces.stat(ctx, id, requiredPath(query), atVersion(query)));
				case "history":
					return json(await workspaces.history(ctx, id, pageRequest(query)));
				case "content":
					return await content(ctx, id, query, request);
				default:
					return errorResponse(404, "not_found", "no such route");
			}
		} catch (error) {
			if (isHarbourError(error)) return errorResponse(errorStatus(error.code), error.code, error.message);
			return errorResponse(500, "unavailable", "the workspace read API failed");
		}
	}

	async function content(
		ctx: CallContext,
		id: WorkspaceId,
		query: URLSearchParams,
		request: Request,
	): Promise<Response> {
		const path = requiredPath(query);
		const version = atVersion(query);
		const mounted = path.startsWith("/");
		const tooLarge = () =>
			errorResponse(413, "refused", `${path} is larger than the read API serves (${maxContentBytes} bytes)`);
		const entry = await workspaces.stat(ctx, id, path, version);
		if (entry.kind !== "file") throw new HarbourError("invalid", `${path} is a directory`, { path });
		if (entry.size > maxContentBytes) return tooLarge();
		// Only a workspace file at an explicit version is immutable: a mount path reads the mount's current pin, which
		// `remount` moves without a new workspace version.
		const immutable = version?.version !== undefined && !mounted;
		const headers: Record<string, string> = {
			...SAFE_HEADERS,
			"Content-Type": contentTypeFor(path),
			"Cache-Control": immutable ? "private, max-age=31536000, immutable" : "private, no-cache",
		};
		const ifNoneMatch = request.headers.get("If-None-Match");
		// For a workspace file, stat's version is the one read returns, so a match needs no read. A mount file's stat
		// carries the version that last changed it, not the mount's pin that read reports, so mounts always read.
		if (!mounted && entry.digest !== undefined && matchesEtag(ifNoneMatch, `"${entry.digest}"`)) {
			headers.ETag = `"${entry.digest}"`;
			headers[VERSION_HEADER] = JSON.stringify(entry.version);
			return new Response(null, { status: 304, headers });
		}
		const file = await workspaces.read(ctx, id, path, version);
		// The file may have grown in a commit between stat and read.
		if (file.content.byteLength > maxContentBytes) return tooLarge();
		headers.ETag = `"${file.digest}"`;
		headers[VERSION_HEADER] = JSON.stringify(file.version);
		if (matchesEtag(ifNoneMatch, headers.ETag)) return new Response(null, { status: 304, headers });
		headers["Content-Length"] = String(file.content.byteLength);
		return new Response(file.content as Uint8Array<ArrayBuffer>, { status: 200, headers });
	}
}

/** Sent with every response: nothing the API returns is ever run or sniffed by a browser. */
const SAFE_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"Referrer-Policy": "no-referrer",
} as const;

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			...SAFE_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "private, no-cache",
		},
	});
}

function errorResponse(status: number, code: ErrorCode, message: string, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { ...SAFE_HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8" },
	});
}

function safeDecode(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

function requiredPath(query: URLSearchParams): string {
	const path = query.get("path");
	if (path === null || path === "") throw new HarbourError("invalid", "the path parameter is required");
	return path;
}

function atVersion(query: URLSearchParams): { readonly version?: WorkspaceVersion } | undefined {
	const raw = query.get("version");
	if (raw === null) return undefined;
	if (!/^\d+$/.test(raw)) throw new HarbourError("invalid", "version must be a non-negative integer");
	return { version: Number(raw) };
}

function pageRequest(query: URLSearchParams): PageRequest {
	const cursor = query.get("cursor");
	const limit = query.get("limit");
	if (limit !== null && !/^\d+$/.test(limit)) throw new HarbourError("invalid", "limit must be a positive integer");
	return {
		...(cursor === null ? {} : { cursor }),
		...(limit === null ? {} : { limit: Number(limit) }),
	};
}

function listOptions(query: URLSearchParams): ListOptions {
	const path = query.get("path");
	const recursive = query.get("recursive");
	if (recursive !== null && recursive !== "true" && recursive !== "false") {
		throw new HarbourError("invalid", "recursive must be true or false");
	}
	return {
		...pageRequest(query),
		...(path === null || path === "" ? {} : { path }),
		...(recursive === "true" ? { recursive: true } : {}),
		...atVersion(query),
	};
}

function matchesEtag(header: string | null, etag: string): boolean {
	if (header === null) return false;
	return header
		.split(",")
		.map((candidate) => candidate.trim().replace(/^W\//, ""))
		.some((candidate) => candidate === etag || candidate === "*");
}

const TEXT_TYPES: { readonly [extension: string]: string } = {
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	json: "application/json; charset=utf-8",
	jsonl: "application/x-ndjson; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
};

/** Text-like extensions served as `text/plain`, HTML and SVG included, so a browser shows them rather than runs them. */
const PLAIN = new Set(
	"txt log ts tsx js jsx mjs cjs css scss html htm svg xml yaml yml toml ini sh bash zsh fish py rb go rs java kt c h cpp hpp sql graphql env gitignore dockerfile lock".split(
		" ",
	),
);

/** The content type the content route sends for `path`. */
export function contentTypeFor(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	const dot = name.lastIndexOf(".");
	const extension = dot < 0 ? name : name.slice(dot + 1);
	const known = TEXT_TYPES[extension];
	if (known !== undefined) return known;
	if (PLAIN.has(extension) || dot < 0) return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

// ---- client ---------------------------------------------------------------------------------------------------------

export interface WorkspaceReadClientOptions {
	/** The API's origin and prefix, such as `https://harbour.example/v1/workspaces` or `/v1/workspaces`. */
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
	/** Headers sent with every request, such as an API key for a host app. The console relies on its cookie instead. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** A file as the content route returned it. */
export interface ReadFile extends FileContent {
	readonly contentType: string;
}

export interface WorkspaceReadClient {
	get(id: WorkspaceId, init?: RequestOptions): Promise<WorkspaceRecord>;
	list(id: WorkspaceId, options?: ListOptions, init?: RequestOptions): Promise<Page<FileEntry>>;
	stat(
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
		init?: RequestOptions,
	): Promise<FileEntry>;
	read(
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
		init?: RequestOptions,
	): Promise<ReadFile>;
	history(id: WorkspaceId, page?: PageRequest, init?: RequestOptions): Promise<Page<WorkspaceVersionInfo>>;
}

export interface RequestOptions {
	readonly signal?: AbortSignal;
}

/** A typed client for the read API. Errors come back as `HarbourError` with the server's code and message. */
export function createWorkspaceReadClient(options: WorkspaceReadClientOptions): WorkspaceReadClient {
	const base = options.baseUrl.replace(/\/+$/, "");
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

	async function call(
		id: WorkspaceId,
		route: string,
		params: { readonly [key: string]: string | number | boolean | undefined },
		init: RequestOptions | undefined,
	): Promise<Response> {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
		const encoded = search.toString();
		const query = encoded === "" ? "" : `?${encoded}`;
		const response = await fetcher(`${base}/${encodeURIComponent(id)}${route === "" ? "" : `/${route}`}${query}`, {
			method: "GET",
			...(options.headers === undefined ? {} : { headers: options.headers }),
			...(init?.signal === undefined ? {} : { signal: init.signal }),
		});
		if (!response.ok) throw await toError(response);
		return response;
	}

	return {
		async get(id, init) {
			return (await call(id, "", {}, init)).json() as Promise<WorkspaceRecord>;
		},
		async list(id, list = {}, init) {
			const { path, recursive, version, cursor, limit } = list;
			const params = { path, recursive: recursive === true ? true : undefined, version, cursor, limit };
			return (await call(id, "files", params, init)).json() as Promise<Page<FileEntry>>;
		},
		async stat(id, path, at, init) {
			return (await call(id, "stat", { path, version: at?.version }, init)).json() as Promise<FileEntry>;
		},
		async read(id, path, at, init) {
			const response = await call(id, "content", { path, version: at?.version }, init);
			const content = new Uint8Array(await response.arrayBuffer());
			const version = JSON.parse(response.headers.get(VERSION_HEADER) ?? "null") as WorkspaceVersion | string;
			const digest = (response.headers.get("ETag") ?? "").replace(/^W\//, "").replace(/"/g, "");
			const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
			return { path, content, version, digest, contentType };
		},
		async history(id, page = {}, init) {
			return (await call(id, "history", { cursor: page.cursor, limit: page.limit }, init)).json() as Promise<
				Page<WorkspaceVersionInfo>
			>;
		},
	};
}

async function toError(response: Response): Promise<HarbourError> {
	try {
		const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
		const code = body.error?.code;
		const message = body.error?.message;
		if (typeof code === "string" && code in STATUS && typeof message === "string") {
			return new HarbourError(code as ErrorCode, message);
		}
	} catch {
		// Falls through: not a read API error body.
	}
	return new HarbourError("unavailable", `the workspace read API answered ${response.status}`);
}
