/**
 * The shares' public API routes (`@harbour/api`'s `shareRoutes`) over any `FileShares`, and the link's page.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /workspaces/{id}/shares` | `list` |
 * | `POST /workspaces/{id}/shares` | `share` |
 * | `GET /shares/{id}` | `get` |
 * | `PATCH /shares/{id}` | `update` |
 * | `DELETE /shares/{id}` | `revoke` |
 * | `POST /shares/{id}/invites` | `invite` |
 * | `POST /shares/{id}/invites/remove` | `removeInvite` |
 *
 * The link's page, `GET /shared/<token>`, is outside the API and needs no sign-in: `createSharedLinkHandler` finds the
 * share by its token (`open`, as Harbour), reads the file's newest version as Harbour in the share's organisation, and
 * answers the page the host renders, or the bytes at `/shared/<token>/raw`. It reads that one file and nothing else.
 */
import { createRouter, STATUS_BY_CODE, shareRoutes } from "@harbour/api";
import {
	type CallContext,
	type FileShare,
	type FileShares,
	isHarbourError,
	type ShareAccess,
	systemContext,
	type Workspaces,
} from "@harbour/contracts";
import { contentTypeFor, DEFAULT_MAX_CONTENT_BYTES } from "./read-api.ts";

export interface SharesApiOptions {
	readonly shares: FileShares;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

function errorResponse(error: unknown): Response {
	if (isHarbourError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	return json({ error: { code: "unavailable", message: "The shares API failed" } }, 500);
}

/** Whether `path` is one of the shares' API routes under `basePath`. */
export function isSharesPath(path: string, basePath = "/v1"): boolean {
	const base = basePath.replace(/\/+$/, "");
	return path === `${base}/shares` || path.startsWith(`${base}/shares/`) || SHARES_OF_WORKSPACE(base).test(path);
}

const SHARES_OF_WORKSPACE = (base: string) =>
	new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/workspaces/[^/]+/shares$`);

/** The shares' routes: answers one of them, or resolves `undefined` for any other request. */
export function createSharesApi(options: SharesApiOptions): (request: Request) => Promise<Response | undefined> {
	const { shares } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		shareRoutes,
		{
			listShares: async (ctx: CallContext, { params, query }) => ({
				items: await shares.list(ctx, {
					workspaceId: params.workspaceId,
					...(query.path === undefined ? {} : { path: query.path }),
				}),
			}),
			shareFile: (ctx: CallContext, { params, body }) =>
				shares.share(ctx, {
					workspaceId: params.workspaceId,
					path: body.path,
					...(body.title === undefined ? {} : { title: body.title }),
					...(body.access === undefined ? {} : { access: body.access as ShareAccess }),
				}),
			getShare: (ctx: CallContext, { params }) => shares.get(ctx, params.shareId),
			updateShare: (ctx: CallContext, { params, body }) =>
				shares.update(ctx, params.shareId, {
					...(body.access === undefined ? {} : { access: body.access as ShareAccess }),
					...(body.title === undefined ? {} : { title: body.title }),
				}),
			revokeShare: (ctx: CallContext, { params }) => shares.revoke(ctx, params.shareId),
			inviteToShare: (ctx: CallContext, { params, body }) => shares.invite(ctx, params.shareId, body.email),
			removeShareInvite: (ctx: CallContext, { params, body }) => shares.removeInvite(ctx, params.shareId, body.email),
		},
		{ basePath },
	);
	return async (request) => {
		if (!isSharesPath(new URL(request.url).pathname, basePath)) return undefined;
		try {
			const ctx = await options.authenticate(request);
			return (await router(ctx, request)) ?? json({ error: { code: "not_found", message: "No such route" } }, 404);
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/** Where a link's page is: `/shared/<token>`, and its bytes at `/shared/<token>/raw`. */
export const SHARED_LINK_BASE = "/shared";
const SHARED_LINK = /^\/shared\/([A-Za-z0-9_-]{20,100})(\/raw)?\/?$/;

/** What the host's page shows of a shared file. */
export interface SharedFile {
	readonly share: Pick<FileShare, "title" | "path" | "updatedAt">;
	/** The file's name, the last part of its path. */
	readonly name: string;
	readonly contentType: string;
	readonly size: number;
	readonly content: Uint8Array;
	/** Where the page's bytes are, for an image, a PDF or a download. */
	readonly rawUrl: string;
}

export interface SharedLinkOptions {
	readonly shares: Pick<FileShares, "open">;
	readonly workspaces: Pick<Workspaces, "read" | "stat">;
	/** The page for a shared file: the host renders it (a document as HTML, an image inline, anything else to download). */
	readonly renderPage: (file: SharedFile) => Response | Promise<Response>;
	/** The page for a link that doesn't open: unknown, revoked, restricted or its file gone, alike. */
	readonly renderMissing: () => Response;
}

const LINK_CONTEXT = systemContext("workspace.share");

/**
 * Serves `/shared/<token>` and `/shared/<token>/raw` without sign-in: the token is the only credential, and it opens
 * one file. Resolves `undefined` for any other path.
 */
export function createSharedLinkHandler(
	options: SharedLinkOptions,
): (request: Request) => Promise<Response | undefined> {
	return async (request) => {
		const match = SHARED_LINK.exec(new URL(request.url).pathname);
		if (match === null) return undefined;
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("GET only", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		const [, token, raw] = match;
		const share = await options.shares.open(LINK_CONTEXT, token as string);
		if (share === undefined) return options.renderMissing();
		const ctx = { ...LINK_CONTEXT, organisationId: share.organisationId };
		let file: Awaited<ReturnType<Workspaces["read"]>>;
		try {
			const entry = await options.workspaces.stat(ctx, share.workspaceId, share.path);
			if (entry.kind !== "file" || entry.size > DEFAULT_MAX_CONTENT_BYTES) return options.renderMissing();
			file = await options.workspaces.read(ctx, share.workspaceId, share.path);
		} catch (error) {
			if (isHarbourError(error, "not_found")) return options.renderMissing();
			throw error;
		}
		const name = share.path.split("/").pop() ?? share.path;
		const contentType = contentTypeFor(share.path);
		if (raw !== undefined) {
			return new Response(request.method === "HEAD" ? null : (file.content as Uint8Array<ArrayBuffer>), {
				headers: {
					"content-type": contentType,
					"content-length": String(file.content.byteLength),
					"content-disposition": `inline; filename="${name.replace(/["\\\r\n]/g, "_")}"`,
					// The file is the agent's: it runs nothing on Harbour's origin. A PDF goes to the browser's own viewer, which a
					// sandboxed response would stop; it runs outside the origin anyway.
					...(contentType === "application/pdf"
						? {}
						: {
								"content-security-policy":
									"sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
							}),
					"x-content-type-options": "nosniff",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
				},
			});
		}
		return options.renderPage({
			share: {
				path: share.path,
				updatedAt: share.updatedAt,
				...(share.title === undefined ? {} : { title: share.title }),
			},
			name,
			contentType,
			size: file.content.byteLength,
			content: file.content,
			rawUrl: `${SHARED_LINK_BASE}/${token}/raw`,
		});
	};
}
