/**
 * The workspace write API: the one route a host app creates a seeded workspace with, and a typed client for it.
 *
 * `POST /v1/workspaces` takes a project, an optional session and a seed spec v0 (`files` and `git` sources), creates
 * the workspace through `Workspaces.create` and answers `201` with its `WorkspaceRecord`. A git source is fetched by the
 * `GitFetcher` the host gave its workspaces (`seeders: { git }`, such as `createGitHubTarballFetcher`, #81); without
 * one the record waits at `metadata`, as `create` does. The host then creates a session with the record's ID as its
 * `workspaceId`, and the console's Files tab reads it through the read API (`./read-api.ts`).
 *
 * Only operators create: the route checks operator on the project (and the session, when one is named) through
 * `ProjectAccess` before it reads anything else of the body, and `create` checks again. A viewer, a key without the
 * project or an agent outside it is `forbidden` (403), audited once as `access.denied`; nothing is fetched or stored.
 *
 * Portable (fetch `Request`/`Response`, no Node modules), like the read API, so the Cloudflare gateway Worker and the
 * self-hosted gateway mount the same handler. It holds no `Sandboxes`: seeding writes files, never runs a command.
 *
 * Body (JSON, at most `maxBodyBytes`, default 16 MiB):
 *
 * ```json
 * {
 *   "projectId": "proj_…",
 *   "sessionId": "ses_…",
 *   "seed": {
 *     "name": "billing-sync",
 *     "sources": [
 *       { "kind": "git", "repo": "owner/name", "ref": "main", "sparse": ["src"], "into": "repo" },
 *       { "kind": "files", "files": { "notes/plan.md": "# Plan" } }
 *     ],
 *     "mounts": [{ "path": "/project", "source": "project-files", "ref": "proj_…" }]
 *   },
 *   "mounts": []
 * }
 * ```
 *
 * `sessionId`, `seed` and `mounts` are optional. The seed is seed spec v1, parsed by `parseSeedSpec` (`archive` sources
 * are fetched by the host's `seeders: { archive }`). Sources apply in order, later ones winning on a path. `objects`
 * sources and dependency steps (`deps`) are refused here as `not_supported` rather than recorded and ignored, until the
 * route can seed them (M2-BE1).
 * Errors are the read API's: `{ "error": { "code", "message" } }` with `errorStatus`'s status, and 413 for a body over
 * the limit.
 *
 * `POST /v1/workspaces/:id/fork` with `{ "projectId", "sessionId"?, "version"? }` forks a workspace the caller may read
 * into a project it operates (`Workspaces.fork`): the new workspace shares the source's bodies, so it costs one tree
 * whatever its size (packages/workspace/CONTRACT.md).
 */
import {
	type CallContext,
	type ErrorCode,
	isKantelError,
	KantelError,
	type MountRequest,
	type ProjectAccess,
	type SeedSpec,
	type SessionId,
	type WorkspaceRecord,
	type Workspaces,
} from "@kantel/contracts";
import { errorStatus, WORKSPACE_READ_API_BASE } from "./read-api.ts";
import { parseMountRequests, parseSeedSpec } from "./seed-spec.ts";

export { MAX_SEED_SOURCES } from "./seed-spec.ts";

/** The largest body the route reads: a seed's static files travel in it. */
export const DEFAULT_MAX_SEED_BODY_BYTES = 16 * 1024 * 1024;

/** What a host sends to create a workspace. */
export interface CreateWorkspaceBody {
	/** The project the workspace belongs to; the caller needs operator on it. */
	readonly projectId: string;
	/** Ties the workspace to an existing session in that project. Usually left out: the session is created after. */
	readonly sessionId?: SessionId;
	readonly seed?: SeedSpec;
	/** Mounts beside the seed's own, winning on the same mount point. */
	readonly mounts?: readonly MountRequest[];
}

/** The largest file `PUT <basePath>/:id/content` writes: a document the person edited, not an upload. */
export const DEFAULT_MAX_FILE_BODY_BYTES = 2 * 1024 * 1024;

/** Times the content route re-reads the head when another commit moved it between its read and its commit. */
const CONTENT_COMMIT_ATTEMPTS = 3;

export interface WorkspaceWriteApiOptions {
	/**
	 * Creates the workspace (give it the `seeders`, a git fetcher, the host can fetch with) and, with `get`, `stat` and
	 * `commit`, writes one file for the content route. Without those the content route answers `not_supported`.
	 */
	readonly workspaces: Pick<Workspaces, "create"> & Partial<Pick<Workspaces, "get" | "stat" | "commit" | "fork">>;
	/** Project access, for the operator check the route makes before anything else. */
	readonly access: ProjectAccess;
	/** Who is calling, from the request. Throw a `KantelError` to refuse; its code sets the status. */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** Route prefix, without a trailing slash. Default `/v1/workspaces`, beside the read API. */
	readonly basePath?: string;
	/** The largest body read. Default 16 MiB. */
	readonly maxBodyBytes?: number;
}

/**
 * Handles `POST <basePath>` and `PUT <basePath>/:id/content`; resolves `null` for anything else, so a gateway can pass
 * it to the read API.
 */
export type WorkspaceWriteHandler = (request: Request) => Promise<Response | null>;

export function createWorkspaceWriteApi(options: WorkspaceWriteApiOptions): WorkspaceWriteHandler {
	const base = (options.basePath ?? WORKSPACE_READ_API_BASE).replace(/\/+$/, "");
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_SEED_BODY_BYTES;
	const writeFile = createContentWrite(options, base);

	return async (request) => {
		const url = new URL(request.url);
		if (request.method === "PUT") return writeFile(request, url);
		const forkOf =
			request.method === "POST" && url.pathname.startsWith(`${base}/`)
				? url.pathname.slice(base.length).match(/^\/([^/]+)\/fork\/?$/)
				: null;
		if (forkOf !== null) return fork(request, decodeURIComponent(forkOf[1] ?? ""));
		if (request.method !== "POST" || url.pathname.replace(/\/+$/, "") !== base) return null;
		try {
			const ctx = await options.authenticate(request);
			const text = await readBounded(request, maxBodyBytes);
			if (text === undefined) {
				return errorResponse(413, "refused", `the body is larger than this route reads (${maxBodyBytes} bytes)`);
			}
			const raw = parseJson(text);
			const target = parseTarget(raw);
			// Operators only, checked before the seed is looked at: a refused caller learns nothing about its spec.
			await options.access.require(ctx, {
				projectId: target.projectId,
				...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
				needed: "operator",
				operation: "workspace.create",
			});
			const input = createInput(ctx, { ...target, ...parseSeedAndMounts(raw) });
			const record = await options.workspaces.create(ctx, input);
			return json(record, 201, { Location: `${base}/${encodeURIComponent(record.id)}` });
		} catch (error) {
			if (isKantelError(error)) return errorResponse(errorStatus(error.code), error.code, error.message);
			return errorResponse(500, "unavailable", "the workspace write API failed");
		}
	};

	/**
	 * `POST <base>/:id/fork` with `{ projectId, sessionId?, version? }`: a new workspace in the project that shares the
	 * source's bodies (`Workspaces.fork`), 201 with its record. Operator on the target project, checked first; the fork
	 * then needs viewer on the source, as reading it does.
	 */
	async function fork(request: Request, sourceId: string): Promise<Response> {
		try {
			const forkWorkspace = options.workspaces.fork;
			if (forkWorkspace === undefined) {
				throw new KantelError("not_supported", "this host's workspaces cannot be forked");
			}
			const ctx = await options.authenticate(request);
			const text = await readBounded(request, maxBodyBytes);
			if (text === undefined) {
				return errorResponse(413, "refused", `the body is larger than this route reads (${maxBodyBytes} bytes)`);
			}
			const raw = parseJson(text);
			const target = parseTarget(raw);
			const version = raw.version;
			if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 0)) {
				throw invalid("version must be a version number");
			}
			await options.access.require(ctx, {
				projectId: target.projectId,
				...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
				needed: "operator",
				operation: "workspace.create",
			});
			const record = await forkWorkspace.call(options.workspaces, ctx, sourceId, {
				owner: { kind: "project", organisationId: ctx.organisationId, projectId: target.projectId },
				...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
				...(version === undefined ? {} : { version: version as number }),
			});
			return json(record, 201, { Location: `${base}/${encodeURIComponent(record.id)}` });
		} catch (error) {
			if (isKantelError(error)) return errorResponse(errorStatus(error.code), error.code, error.message);
			return errorResponse(500, "unavailable", "the workspace write API failed");
		}
	}
}

/**
 * `PUT <base>/:id/content?path=`: writes one file of the workspace with the body's bytes, as a new version, and answers
 * `{ version, digest }`. The person editing a document saves it this way. With `If-Match: "<digest>"` (the `ETag` the
 * read API sent) the file must still be what the writer read, or the route answers `conflict` (409): a whole-workspace
 * base version would refuse an edit whenever the agent changed any other file. `If-None-Match: *` creates a file that
 * must not exist yet. The workspace's own checks apply: operator on its project, and never a path under a mount.
 */
function createContentWrite(
	options: WorkspaceWriteApiOptions,
	base: string,
): (request: Request, url: URL) => Promise<Response | null> {
	return async (request, url) => {
		if (!url.pathname.startsWith(`${base}/`)) return null;
		const segments = url.pathname.slice(base.length + 1).split("/");
		if (segments.length !== 2 || segments[1] !== "content" || segments[0] === "") return null;
		try {
			const { get, stat, commit } = options.workspaces;
			if (get === undefined || stat === undefined || commit === undefined) {
				throw new KantelError("not_supported", "this host doesn't write workspace files");
			}
			const ctx = await options.authenticate(request);
			const id = decodeURIComponent(segments[0] ?? "") as WorkspaceRecord["id"];
			const path = url.searchParams.get("path") ?? "";
			if (path === "" || path.startsWith("/")) {
				throw invalid("path must be a file's path in the workspace, not under a mount");
			}
			const ifMatch = unquote(request.headers.get("If-Match"));
			const mustBeNew = request.headers.get("If-None-Match")?.trim() === "*";
			const limit = options.maxBodyBytes ?? DEFAULT_MAX_FILE_BODY_BYTES;
			const content = await readBoundedBytes(request, Math.min(limit, DEFAULT_MAX_FILE_BODY_BYTES));
			if (content === undefined) {
				return errorResponse(
					413,
					"refused",
					`the file is larger than this route writes (${DEFAULT_MAX_FILE_BODY_BYTES} bytes)`,
				);
			}
			for (let attempt = 1; ; attempt++) {
				const record = await get(ctx, id);
				const current = await stat(ctx, id, path, { version: record.head }).then(
					(entry) => entry,
					(error: unknown) => {
						if (isKantelError(error, "not_found")) return undefined;
						throw error;
					},
				);
				if (current !== undefined && current.kind !== "file") throw invalid(`${path} is a directory`);
				if (mustBeNew && current !== undefined) {
					throw new KantelError("conflict", `${path} already exists`, { path });
				}
				if (ifMatch !== undefined && ifMatch !== "*" && current?.digest !== ifMatch) {
					throw new KantelError("conflict", `${path} changed since it was read`, { path });
				}
				try {
					const result = await commit(ctx, id, {
						baseVersion: record.head,
						changes: [{ op: "put", path, content }],
						message: `edit ${path}`,
					});
					const written = await stat(ctx, id, path, { version: result.version });
					return json({ version: result.version, digest: written.digest ?? null }, 200, {
						...(written.digest === undefined ? {} : { ETag: `"${written.digest}"` }),
					});
				} catch (error) {
					// Another commit moved the head after this read it: read again, and check the file again.
					if (!isKantelError(error, "conflict") || attempt >= CONTENT_COMMIT_ATTEMPTS) throw error;
				}
			}
		} catch (error) {
			if (isKantelError(error)) return errorResponse(errorStatus(error.code), error.code, error.message);
			return errorResponse(500, "unavailable", "the workspace write API failed");
		}
	};
}

function unquote(header: string | null): string | undefined {
	if (header === null || header.trim() === "") return undefined;
	const first = header.split(",")[0]?.trim() ?? "";
	return first.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** The input `Workspaces.create` takes, from a checked body: owned by the project, in the caller's organisation. */
function createInput(ctx: CallContext, body: ParsedBody): Parameters<Workspaces["create"]>[1] {
	return {
		owner: { kind: "project", organisationId: ctx.organisationId, projectId: body.projectId },
		...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
		...(body.seed === undefined ? {} : { seed: body.seed }),
		...(body.mounts === undefined ? {} : { mounts: body.mounts }),
	};
}

// ---- the body ------------------------------------------------------------------------------------------------------

interface ParsedBody {
	readonly projectId: string;
	readonly sessionId?: string;
	readonly seed?: SeedSpec;
	readonly mounts?: readonly MountRequest[];
}

const invalid = (message: string): KantelError => new KantelError("invalid", message);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalid(`${name} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return nonEmpty(value, name);
}

function parseJson(text: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalid("the body is not JSON");
	}
	if (!isRecord(value)) throw invalid("the body must be a JSON object");
	return value;
}

/** Where the workspace goes: what the operator check needs, read before anything else. */
function parseTarget(value: Record<string, unknown>): Pick<ParsedBody, "projectId" | "sessionId"> {
	const projectId = nonEmpty(value.projectId, "projectId");
	const sessionId = optionalString(value.sessionId, "sessionId");
	return { projectId, ...(sessionId === undefined ? {} : { sessionId }) };
}

/** The seed and mounts' shape. Paths and trees are `create`'s to check, so its rules hold whoever calls it. */
function parseSeedAndMounts(value: Record<string, unknown>): Pick<ParsedBody, "seed" | "mounts"> {
	const seed = value.seed === undefined ? undefined : parseSeed(value.seed);
	const mounts = value.mounts === undefined ? undefined : parseMountRequests(value.mounts, "mounts");
	return {
		...(seed === undefined ? {} : { seed }),
		...(mounts === undefined ? {} : { mounts }),
	};
}

/** Seed spec v1 through `parseSeedSpec`, less what this route does not seed yet. */
function parseSeed(value: unknown): SeedSpec {
	if (isRecord(value) && value.deps !== undefined) {
		throw new KantelError("not_supported", "dependency steps (seed.deps) are not seeded yet; leave them out");
	}
	const seed = parseSeedSpec(value);
	const objects = seed.sources.findIndex((source) => source.kind === "objects");
	if (objects >= 0) {
		throw new KantelError(
			"not_supported",
			`seed.sources[${objects}]: objects sources are not seeded yet; use files, git or archive`,
		);
	}
	return seed;
}

/** The body as text, or `undefined` once it passes `limit` bytes. Counts what arrives, not what Content-Length claims. */
async function readBounded(request: Request, limit: number): Promise<string | undefined> {
	const bytes = await readBoundedBytes(request, limit);
	return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

/** The body's bytes, or `undefined` once it passes `limit` bytes. */
async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) {
		await request.body?.cancel();
		return undefined;
	}
	if (request.body === null) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

const SAFE_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
} as const;

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SAFE_HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8" },
	});
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
	return json({ error: { code, message } }, status);
}

// ---- client ---------------------------------------------------------------------------------------------------------

export interface WorkspaceWriteClientOptions {
	/** The API's origin and prefix, such as `https://harbour.example/v1/workspaces`. */
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
	/** Headers sent with every request, such as `Authorization: Bearer hbr_…` for a host app. */
	readonly headers?: Readonly<Record<string, string>>;
}

export interface WorkspaceWriteClient {
	/** Creates a seeded workspace; errors come back as `KantelError` with the server's code and message. */
	create(body: CreateWorkspaceBody, init?: { readonly signal?: AbortSignal }): Promise<WorkspaceRecord>;
	/** Forks a workspace into the project (`POST /:id/fork`), sharing its bodies. */
	fork(
		workspaceId: string,
		body: ForkWorkspaceBody,
		init?: { readonly signal?: AbortSignal },
	): Promise<WorkspaceRecord>;
}

/** What a host sends to fork a workspace. */
export interface ForkWorkspaceBody {
	readonly projectId: string;
	readonly sessionId?: SessionId;
	/** The source's version to fork; its head when absent. */
	readonly version?: number;
}

export function createWorkspaceWriteClient(options: WorkspaceWriteClientOptions): WorkspaceWriteClient {
	const base = options.baseUrl.replace(/\/+$/, "");
	const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
	return {
		async create(body, init) {
			const response = await fetcher(base, {
				method: "POST",
				headers: { ...options.headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				...(init?.signal === undefined ? {} : { signal: init.signal }),
			});
			if (!response.ok) throw await toError(response);
			return (await response.json()) as WorkspaceRecord;
		},
		async fork(workspaceId, body, init) {
			const response = await fetcher(`${base}/${encodeURIComponent(workspaceId)}/fork`, {
				method: "POST",
				headers: { ...options.headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				...(init?.signal === undefined ? {} : { signal: init.signal }),
			});
			if (!response.ok) throw await toError(response);
			return (await response.json()) as WorkspaceRecord;
		},
	};
}

const CODES = new Set<string>([
	"invalid",
	"forbidden",
	"refused",
	"not_found",
	"conflict",
	"expired",
	"exhausted",
	"aborted",
	"not_supported",
	"unavailable",
]);

async function toError(response: Response): Promise<KantelError> {
	try {
		const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
		const code = body.error?.code;
		const message = body.error?.message;
		if (typeof code === "string" && CODES.has(code) && typeof message === "string") {
			return new KantelError(code as ErrorCode, message);
		}
	} catch {
		// Falls through: not this API's error body.
	}
	return new KantelError("unavailable", `the workspace write API answered ${response.status}`);
}
