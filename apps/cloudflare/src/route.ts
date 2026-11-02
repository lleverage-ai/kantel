/**
 * Which part of the Worker answers a request. Portable (no `cloudflare:workers`), so the tests route through it in
 * Node with stand-in namespaces.
 *
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - The vault's egress decision API (`/v1/egress/decisions`, `/v1/connector-credentials`): the `KantelVault`
 *   Durable Object, which authenticates the calling component itself (`src/vault.ts`).
 * - The connection approval API (`/v1/connection-approvals/…` and its deprecated alias `/v1/vault/…`, the console's
 *   connection request page): the `KantelStack` Durable Object, which signs the
 *   person in and checks their project role with the runtime's `ProjectAccess`, then calls the VaultDO over RPC
 *   (`src/gateway.ts`, `src/vault.ts`). Never the VaultDO directly: it has no project roles of its own.
 * - Every other `/v1/…`: the session, workspace (read, and `POST /v1/workspaces` to create a seeded one) and audit
 *   APIs, served by the `KantelStack` Durable Object.
 * - A browser view (`/v1/browser/view/{browser}/…`: a live view, replay or embed of one of Kantel's own browsers): its
 *   token (a bearer header, or the live socket's subprotocol, never in the URL) is its auth, checked here with
 *   `KANTEL_BROWSER_VIEW_KEY` for the browser the path names, then the browser's `KantelBrowser` object answers
 *   (and checks it again). Never the stack: a viewer is nobody the stack knows.
 * - A tool server's tunnel (`GET /v1/tool-servers/{id}/connect` with `Upgrade: websocket`, experimental): the stack
 *   checks its `ktt_` token first (`authenticateTunnel` over RPC), and a refusal is a plain 401, 403 or 404 before any
 *   upgrade. Then the upgrade goes to the server's `KantelTunnel` object, named by the server the stack's grant names,
 *   with that grant in a header the Worker sets (`src/tunnel.ts`). Off (`KANTEL_TOOL_SERVERS` isn't `experimental`),
 *   every `/v1/tool-servers` path is a 404 here, and the stack is never asked.
 * - The browser viewer page (`/browser/{browser}`, the console's own viewer): the console's assets, sent `no-store` and
 *   `no-referrer` and framed only by the console itself and the origins in `KANTEL_EMBED_ORIGINS`
 *   (`frame-ancestors`), since an outside app frames it through the embed API.
 * - Everything else: the console's static assets (`consoleAsset`). A file the build holds is served without the Worker;
 *   a miss reaches it (`not_found_handling: "none"` in wrangler.jsonc). A miss under `/assets/` is a real 404: a chunk
 *   an older build named, which a tab opened before a deploy still asks for, must fail as a missing script, not load
 *   the console's page as one (`'text/html' is not a valid JavaScript MIME type`). Any other miss is the
 *   console's page, the single-page app's fallback.
 */
import {
	BROWSER_VIEW_API,
	createBrowserViewSigner,
	VIEW_FORWARD_HEADERS,
	VIEWER_PAGE,
	viewClaims,
	viewerPageHeaders,
} from "@kantel/browser/runtime";
import { API_KEYS_PATH, INVITES_PATH, KantelError, legacyHeaderName } from "@kantel/contracts";
import { API_KEY_BODY_LIMIT } from "@kantel/identity/http";
import { isPasskeyPath, PASSKEY_BODY_LIMIT } from "@kantel/identity/passkey/http";
import { MEMORY_BODY_LIMIT } from "@kantel/memory/http";
import { SKILL_IMPORT_BODY_LIMIT } from "@kantel/skills/http";
import { isToolServersPath, TOOL_SERVERS_BODY_LIMIT, tunnelServerId } from "@kantel/tools/http";
import { isApprovalApiPath } from "@kantel/vault/approval-api";
import { DEFAULT_MAX_FILE_BODY_BYTES, DEFAULT_MAX_SEED_BODY_BYTES } from "@kantel/workspace/write-api";
import {
	type ToolServersVars,
	type TunnelAuthentication,
	type TunnelAuthority,
	toolServersOn,
} from "./tool-servers.ts";
import { TUNNEL_GRANT_HEADER, tunnelGrantHeader } from "./tunnel.ts";
import { isVaultPath } from "./vault.ts";

/** Where the console uploads a file for a prompt (`src/attachments.ts`). */
export const ATTACHMENTS_PATH = "/v1/attachments";
/** The largest file that API takes, in bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The one stack object's name. */
export const STACK_NAME = "m1";
/** Where a host creates a seeded workspace. */
const WORKSPACES_PATH = "/v1/workspaces";
/** The shares API (`@kantel/workspace/shares-api`), besides a workspace's own `/shares`. */
const SHARES_PATH = "/v1/shares";
/** A share or an invite is a small JSON body. */
const SHARE_BODY_LIMIT = 8 * 1024;
/** The one vault object's name. Platform items live outside every organisation, so the deployment has one vault. */
export const VAULT_NAME = "vault";

/** Something that answers a request: a Durable Object stub, or the assets fetcher. */
export interface Answers {
	fetch(request: Request): Promise<Response>;
}

/** Durable Objects' location hints (Cloudflare's `DurableObjectLocationHint`): regions, never a city or colo. */
export const LOCATION_HINTS = [
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
] as const;
export type LocationHint = (typeof LOCATION_HINTS)[number];
/** Western Europe: the region Amsterdam (and London) are in. */
export const DEFAULT_LOCATION_HINT: LocationHint = "weur";

export interface PlacementVars {
	/**
	 * Where the stack and vault objects are created (`LOCATION_HINTS`). Default `weur`. A hint applies only when an
	 * object is first created: an object that exists stays where it is, whatever this says.
	 */
	readonly KANTEL_LOCATION_HINT?: string;
}

export function isLocationHint(value: string): value is LocationHint {
	return (LOCATION_HINTS as readonly string[]).includes(value);
}

/** The hint the objects are created with. Refuses (`invalid`) one Cloudflare doesn't take. */
export function locationHint(vars: PlacementVars): LocationHint {
	const value = (vars.KANTEL_LOCATION_HINT ?? "").trim();
	if (value === "") return DEFAULT_LOCATION_HINT;
	if (!isLocationHint(value)) {
		throw new KantelError("invalid", `KANTEL_LOCATION_HINT must be one of: ${LOCATION_HINTS.join(", ")}`);
	}
	return value;
}

/** What routing needs of a Durable Object namespace, typed without workers-types so Node tests can stand one in. */
export interface NamedObjects<Id, Stub = Answers> {
	idFromName(name: string): Id;
	get(id: Id, options?: { locationHint?: LocationHint }): Stub;
}

/** The one object of `name` in `namespace`, created (the first time only) where `vars` hints. */
export function namedObject<Id, Stub>(namespace: NamedObjects<Id, Stub>, name: string, vars: PlacementVars): Stub {
	return namespace.get(namespace.idFromName(name), { locationHint: locationHint(vars) });
}

/** The largest body the vault's API takes: an egress request or a key read is a few hundred bytes of JSON. */
export const VAULT_BODY_LIMIT = 64 * 1024;

/** The largest body `POST /v1/workspaces` takes: a seed's static files travel in it. */
export const WORKSPACE_BODY_LIMIT = DEFAULT_MAX_SEED_BODY_BYTES;

const tooLarge = (limit: number) =>
	Response.json(
		{ error: { code: "invalid", message: `The body is larger than ${limit} bytes` } },
		{ status: 413, headers: { "cache-control": "no-store" } },
	);

/** The request with its body read here, up to `limit`, or a 413. */
async function buffered(request: Request, limit: number): Promise<Request | Response> {
	const body = await readLimited(request, limit);
	if (body === undefined) return tooLarge(limit);
	return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** The whole body, or `undefined` once it passes `limit` bytes. Counts what arrives, not what Content-Length claims. */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > limit) return undefined;
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
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** What routing needs from the Worker's bindings. */
export interface RouteEnv<StackId = unknown, VaultId = unknown> extends PlacementVars, ToolServersVars {
	readonly STACK: NamedObjects<StackId>;
	readonly VAULTS: NamedObjects<VaultId>;
	readonly ASSETS: Answers;
	/** Kantel's own browsers (`KantelBrowser`), one object per browser by its ID, and the key their links are signed with. */
	readonly BROWSERS?: NamedObjects<unknown>;
	readonly KANTEL_BROWSER_VIEW_KEY?: string;
	/** A self-hosted browser host serving the browsers instead (its own `/v1/browser/view/…`). */
	readonly KANTEL_BROWSER_HOST_URL?: string;
	/** The origins that may frame the browser viewer page, besides the console: space- or comma-separated. */
	readonly KANTEL_EMBED_ORIGINS?: string;
	/** Tool servers' tunnels (`KantelTunnel`), one object per server by its ID, when tool servers are on. */
	readonly TUNNELS?: NamedObjects<unknown>;
}

export { embedOrigins, VIEWER_PAGE } from "@kantel/browser/runtime";

/** The viewer page as the assets answer it, never cached or leaking a referrer, framed only where allowed. */
async function viewerPage(request: Request, env: RouteEnv): Promise<Response> {
	const answer = await consoleAsset(request, env);
	const headers = viewerPageHeaders(answer.headers, env.KANTEL_EMBED_ORIGINS);
	return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

const viewRefused = () =>
	Response.json(
		{ error: { code: "expired", message: "This view link has expired or is not valid" } },
		{ status: 401, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
	);

/** A view request, sent to its browser's object once its token checks out. */
async function routeView(request: Request, env: RouteEnv<unknown, unknown>): Promise<Response> {
	const viewKey = (env.KANTEL_BROWSER_VIEW_KEY ?? "").trim();
	const hostUrl = (env.KANTEL_BROWSER_HOST_URL ?? "").trim().replace(/\/+$/, "");
	if ((env.BROWSERS === undefined && hostUrl === "") || viewKey.length < 32) return viewRefused();
	const checked = await viewClaims(request, createBrowserViewSigner(viewKey), Date.now());
	if (checked === undefined) return viewRefused();
	const { claims } = checked;
	const forwarded = new Request(request.url, { method: request.method, headers: request.headers });
	if (hostUrl !== "") {
		// The self-hosted host checks the token too (it holds the same key). The path, query and token go; no cookie does.
		const url = new URL(request.url);
		const headers = new Headers();
		for (const name of VIEW_FORWARD_HEADERS) {
			const value = request.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		return fetch(`${hostUrl}${url.pathname}${url.search}`, { method: request.method, headers });
	}
	if (env.BROWSERS === undefined) return viewRefused();
	return namedObject(env.BROWSERS, claims.browser, env).fetch(forwarded);
}

const routeRefused = (status: number, code: string, message: string, headers: { [name: string]: string } = {}) =>
	Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * What a tunnel's upgrade loses on its way to the object: the client's credentials, and any grant it made up, under
 * either name (the object reads the grant's name from before the rename too).
 */
const TUNNEL_DROPPED_HEADERS = [
	TUNNEL_GRANT_HEADER,
	legacyHeaderName(TUNNEL_GRANT_HEADER) as string,
	"authorization",
	"cookie",
	"cf-access-jwt-assertion",
];

const TUNNEL_REFUSALS: { readonly [status in 401 | 403 | 404]: readonly [code: string, message: string] } = {
	401: ["unauthenticated", "The tunnel token is missing or not valid"],
	403: ["forbidden", "The tunnel token is for another tool server"],
	404: ["not_found", "No such tool server"],
};

/**
 * A tunnel's upgrade, its token checked by the stack before any object holds a socket; then the server's own tunnel
 * object takes it.
 */
async function routeTunnel(
	request: Request,
	env: RouteEnv<unknown, unknown>,
	serverId: string,
	stack: () => TunnelAuthority,
): Promise<Response> {
	if (request.method !== "GET") return routeRefused(400, "invalid", "A tunnel is opened with GET");
	const secret = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
	const refuse = (status: 401 | 403 | 404) =>
		routeRefused(
			status,
			...TUNNEL_REFUSALS[status],
			status === 401 ? { "www-authenticate": `Bearer realm="kantel"` } : {},
		);
	if (secret === undefined) return refuse(401);
	const tunnels = env.TUNNELS;
	if (tunnels === undefined) return routeRefused(503, "unavailable", "This deployment holds no tunnels");
	let checked: TunnelAuthentication;
	try {
		checked = await stack().authenticateTunnel(serverId, secret);
	} catch (error) {
		console.error("kantel: checking a tunnel token failed", error);
		return routeRefused(503, "unavailable", "The tunnel token couldn't be checked");
	}
	if ("refused" in checked) return refuse(checked.refused);
	const headers = new Headers(request.headers);
	for (const name of TUNNEL_DROPPED_HEADERS) headers.delete(name);
	headers.set(TUNNEL_GRANT_HEADER, tunnelGrantHeader(checked.grant));
	// Named by the server the grant names, which the stack read from its record, never by the path alone.
	return namedObject(tunnels, checked.grant.toolServerId, env).fetch(
		new Request(request.url, { method: "GET", headers }),
	);
}

type ObjectErrorMarks = {
	readonly retryable?: unknown;
	readonly overloaded?: unknown;
	readonly durableObjectReset?: unknown;
};

/**
 * Whether an error thrown at a Durable Object's stub is a transient one: the object was reset under the request, or is
 * overloaded, or the connection to it was lost. workerd marks every reset (`broken.*`: a deploy's "Durable Object
 * reset because its code was updated", and "Durable Object's isolate exceeded its memory limit and was reset")
 * `durableObjectReset`, a lost connection `retryable`, and an overloaded object `overloaded` (jsg/util.c++). A memory
 * reset is not marked `retryable`, so checking that alone misses it.
 */
export function isTransientObjectError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const marked = error as ObjectErrorMarks;
	return marked.retryable === true || marked.overloaded === true || marked.durableObjectReset === true;
}

/** How long to wait before asking again: a reset object is back within a second; an overloaded one needs longer. */
function retryAfter(error: unknown): string {
	return (error as ObjectErrorMarks).overloaded === true ? "10" : "1";
}

/**
 * Every request. A transient object error (`isTransientObjectError`) is answered as a JSON 503 with `Retry-After`,
 * like any other refusal, rather than thrown: thrown, it becomes Cloudflare's HTML 500 page, which a client can't tell
 * from a bug. A deploy resets the stack object under every request in flight (a run's result wait, a write) and the
 * stack's `resume()` then picks its runs up again, so a client that waits a second and asks again gets its answer.
 * Nothing is retried here: the request's body may already be spent. Any other error is still thrown.
 */
export async function routeRequest<StackId, VaultId>(
	request: Request,
	env: RouteEnv<StackId, VaultId>,
): Promise<Response> {
	try {
		return await routeOnce(request, env);
	} catch (error) {
		if (!isTransientObjectError(error)) throw error;
		console.warn("kantel: a Durable Object was reset or overloaded under a request; answered 503", error);
		return routeRefused(503, "unavailable", "Kantel is restarting or busy; try again shortly", {
			"retry-after": retryAfter(error),
		});
	}
}

async function routeOnce<StackId, VaultId>(request: Request, env: RouteEnv<StackId, VaultId>): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === "/healthz") return Response.json({ ok: true, service: "kantel" });
	if (isVaultPath(path)) {
		// The vault refuses an unknown caller before it reads the body, and workerd then reports the unread stream it was
		// still sending the object as an uncaught error. Its bodies are small JSON, so they are read here first, up to a
		// limit, since anyone who reaches the Worker can send one before the vault checks who they are.
		const forwarded =
			request.method === "POST"
				? await buffered(request, VAULT_BODY_LIMIT)
				: new Request(request.url, { method: request.method, headers: request.headers });
		if (forwarded instanceof Response) return forwarded;
		return namedObject(env.VAULTS, VAULT_NAME, env).fetch(forwarded);
	}
	const stack = () => namedObject(env.STACK, STACK_NAME, env);
	if (isToolServersPath(path)) {
		if (!toolServersOn(env)) {
			return routeRefused(404, "not_found", "No such route");
		}
		const serverId = tunnelServerId(path);
		if (serverId !== undefined && (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
			// The stack object's RPC: its stub has the method, which the portable `Answers` type doesn't say.
			return routeTunnel(
				request,
				env as RouteEnv<unknown, unknown>,
				serverId,
				() => stack() as unknown as TunnelAuthority,
			);
		}
		if (request.method === "POST" || request.method === "PATCH") {
			// Registering or changing a server: a stranger is refused before the small JSON body is read.
			const forwarded = await buffered(request, TOOL_SERVERS_BODY_LIMIT);
			if (forwarded instanceof Response) return forwarded;
			return stack().fetch(forwarded);
		}
		return stack().fetch(request);
	}
	if (request.method === "POST" && path === WORKSPACES_PATH) {
		// The same for creating a workspace: the stack refuses a caller without operator rights before it reads the seed.
		const forwarded = await buffered(request, WORKSPACE_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (
		(request.method === "POST" || request.method === "PATCH") &&
		(path.startsWith(`${SHARES_PATH}/`) || (path.startsWith(`${WORKSPACES_PATH}/`) && path.endsWith("/shares")))
	) {
		// And for sharing a file or changing a share: a stranger is refused before the small JSON body is read.
		const forwarded = await buffered(request, SHARE_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	// A share link's page, without sign-in (the stack checks the token).
	if (path.startsWith("/shared/")) {
		return stack().fetch(new Request(request.url, { method: request.method, headers: request.headers }));
	}
	if (request.method === "PUT" && path.startsWith(`${WORKSPACES_PATH}/`)) {
		// And for writing a file (a document the person edited): the stack refuses a viewer before it reads the bytes.
		const forwarded = await buffered(request, DEFAULT_MAX_FILE_BODY_BYTES);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	const keysOrInvites = [API_KEYS_PATH, INVITES_PATH].some((base) => path === base || path.startsWith(`${base}/`));
	if (request.method === "POST" && keysOrInvites) {
		// And for issuing or revoking a key or an invite: the stack refuses a stranger before it reads the small JSON body.
		const forwarded = await buffered(request, API_KEY_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	const skills = path === "/v1/skills" || path.startsWith("/v1/skills/");
	if (request.method === "POST" && (skills || path.startsWith("/v1/memory/"))) {
		// And for importing a skill, loading a snapshot, a search or a recall: the stack refuses a stranger before it reads
		// the JSON body, at most a skill's files or a space's concepts.
		const forwarded = await buffered(request, skills ? SKILL_IMPORT_BODY_LIMIT : MEMORY_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (request.method === "POST" && path === ATTACHMENTS_PATH) {
		// And for a prompt's attachment: the stack refuses someone who can't start a session in the project before it reads
		// the file, at most 20 MB.
		const forwarded = await buffered(request, MAX_ATTACHMENT_BYTES);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (request.method === "POST" && isPasskeyPath(path)) {
		// And for registering or removing a passkey: a stranger is refused before the small JSON body is read.
		const forwarded = await buffered(request, PASSKEY_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (path.startsWith(BROWSER_VIEW_API)) return routeView(request, env as RouteEnv<unknown, unknown>);
	if (VIEWER_PAGE.test(path)) return viewerPage(request, env as RouteEnv<unknown, unknown>);
	if (isApprovalApiPath(path)) return stack().fetch(request);
	if (path === "/v1" || path.startsWith("/v1/")) return stack().fetch(request);
	return consoleAsset(request, env);
}

/** Where the console's build puts its scripts, styles and fonts, each named by a hash of its contents. */
export const CONSOLE_ASSETS_PREFIX = "/assets/";

/**
 * The console: the file the build holds at the path; else, outside `/assets/`, its page (`/`), which routes in the
 * browser. A missing build file is a plain 404 the browser never caches, so a stale tab's dynamic import fails as one.
 */
export async function consoleAsset(request: Request, env: Pick<RouteEnv, "ASSETS">): Promise<Response> {
	const answer = await env.ASSETS.fetch(request);
	if (answer.status !== 404) return answer;
	const path = new URL(request.url).pathname;
	if (path.startsWith(CONSOLE_ASSETS_PREFIX) || (request.method !== "GET" && request.method !== "HEAD")) {
		await answer.body?.cancel().catch(() => undefined);
		return new Response(request.method === "HEAD" ? null : "Not found", {
			status: 404,
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		});
	}
	await answer.body?.cancel().catch(() => undefined);
	return env.ASSETS.fetch(new Request(new URL("/", request.url), { method: request.method, headers: request.headers }));
}
