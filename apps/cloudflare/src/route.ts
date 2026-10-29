/**
 * Which part of the Worker answers a request. Portable (no `cloudflare:workers`), so the tests route through it in
 * Node with stand-in namespaces.
 *
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - The vault's egress decision API (`/v1/egress/decisions`, `/v1/connector-credentials`): the `HarbourVault`
 *   Durable Object, which authenticates the calling component itself (`src/vault.ts`).
 * - The vault approval API (`/v1/vault/…`, the console's vault page): the `HarbourStack` Durable Object, which signs the
 *   person in and checks their project role with the runtime's `ProjectAccess`, then calls the VaultDO over RPC
 *   (`src/gateway.ts`, `src/vault.ts`). Never the VaultDO directly: it has no project roles of its own.
 * - Every other `/v1/…`: the session, workspace (read, and `POST /v1/workspaces` to create a seeded one) and audit
 *   APIs, served by the `HarbourStack` Durable Object.
 * - A browser view (`/v1/browser/view/{browser}/…`: a live view, replay or embed of one of Harbour's own browsers): its
 *   token (a bearer header, or the live socket's subprotocol, never in the URL) is its auth, checked here with
 *   `HARBOUR_BROWSER_VIEW_KEY` for the browser the path names, then the browser's `HarbourBrowser` object answers
 *   (and checks it again). Never the stack: a viewer is nobody the stack knows.
 * - The browser viewer page (`/browser/{browser}`, the console's own viewer): the console's assets, sent `no-store` and
 *   `no-referrer` and framed only by the console itself and the origins in `HARBOUR_EMBED_ORIGINS`
 *   (`frame-ancestors`), since an outside app frames it through the embed API.
 * - Everything else: the console's static assets, with single-page-app fallback.
 */
import { BROWSER_VIEW_API, createBrowserViewSigner, viewClaims } from "@harbour/browser/runtime";
import { API_KEYS_PATH, HarbourError } from "@harbour/contracts";
import { API_KEY_BODY_LIMIT } from "@harbour/identity/http";
import { isPasskeyPath, PASSKEY_BODY_LIMIT } from "@harbour/identity/passkey/http";
import { MEMORY_BODY_LIMIT } from "@harbour/memory/http";
import { SKILL_IMPORT_BODY_LIMIT } from "@harbour/skills/http";
import { APPROVAL_API_BASE } from "@harbour/vault/approval-api";
import { DEFAULT_MAX_SEED_BODY_BYTES } from "@harbour/workspace/write-api";
import { isVaultPath } from "./vault.ts";

/** The one stack object's name. */
export const STACK_NAME = "m1";
/** Where a host creates a seeded workspace. */
const WORKSPACES_PATH = "/v1/workspaces";
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
	readonly HARBOUR_LOCATION_HINT?: string;
}

export function isLocationHint(value: string): value is LocationHint {
	return (LOCATION_HINTS as readonly string[]).includes(value);
}

/** The hint the objects are created with. Refuses (`invalid`) one Cloudflare doesn't take. */
export function locationHint(vars: PlacementVars): LocationHint {
	const value = (vars.HARBOUR_LOCATION_HINT ?? "").trim();
	if (value === "") return DEFAULT_LOCATION_HINT;
	if (!isLocationHint(value)) {
		throw new HarbourError("invalid", `HARBOUR_LOCATION_HINT must be one of: ${LOCATION_HINTS.join(", ")}`);
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
export interface RouteEnv<StackId = unknown, VaultId = unknown> extends PlacementVars {
	readonly STACK: NamedObjects<StackId>;
	readonly VAULTS: NamedObjects<VaultId>;
	readonly ASSETS: Answers;
	/** Harbour's own browsers (`HarbourBrowser`), one object per browser by its ID, and the key their links are signed with. */
	readonly BROWSERS?: NamedObjects<unknown>;
	readonly HARBOUR_BROWSER_VIEW_KEY?: string;
	/** A self-hosted browser host serving the browsers instead (its own `/v1/browser/view/…`). */
	readonly HARBOUR_BROWSER_HOST_URL?: string;
	/** The origins that may frame the browser viewer page, besides the console: space- or comma-separated. */
	readonly HARBOUR_EMBED_ORIGINS?: string;
}

/** The viewer page's path: `/browser/<browser>`, its token after `#`. */
export const VIEWER_PAGE = /^\/browser\/[A-Za-z0-9-]{1,64}\/?$/;

/**
 * The origins in `HARBOUR_EMBED_ORIGINS` that may frame the viewer: each an `https://` origin (or `http://localhost`
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

/** The viewer page as the assets answer it, never cached or leaking a referrer, framed only where allowed. */
async function viewerPage(request: Request, env: RouteEnv): Promise<Response> {
	const answer = await env.ASSETS.fetch(request);
	const headers = new Headers(answer.headers);
	headers.set("cache-control", "no-store");
	headers.set("referrer-policy", "no-referrer");
	headers.set(
		"content-security-policy",
		`frame-ancestors ${["'self'", ...embedOrigins(env.HARBOUR_EMBED_ORIGINS)].join(" ")}`,
	);
	headers.delete("x-frame-options");
	headers.delete("etag");
	return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers });
}

const viewRefused = () =>
	Response.json(
		{ error: { code: "expired", message: "This view link has expired or is not valid" } },
		{ status: 401, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
	);

/** A view request, sent to its browser's object once its token checks out. */
async function routeView(request: Request, env: RouteEnv<unknown, unknown>): Promise<Response> {
	const viewKey = (env.HARBOUR_BROWSER_VIEW_KEY ?? "").trim();
	const hostUrl = (env.HARBOUR_BROWSER_HOST_URL ?? "").trim().replace(/\/+$/, "");
	if ((env.BROWSERS === undefined && hostUrl === "") || viewKey.length < 32) return viewRefused();
	const checked = await viewClaims(request, createBrowserViewSigner(viewKey), Date.now());
	if (checked === undefined) return viewRefused();
	const { claims } = checked;
	const forwarded = new Request(request.url, { method: request.method, headers: request.headers });
	if (hostUrl !== "") {
		// The self-hosted host checks the token too (it holds the same key). The path, query and token go; no cookie does.
		const url = new URL(request.url);
		const headers = new Headers();
		for (const name of [
			"authorization",
			"upgrade",
			"connection",
			"sec-websocket-key",
			"sec-websocket-version",
			"sec-websocket-protocol",
		]) {
			const value = request.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		return fetch(`${hostUrl}${url.pathname}${url.search}`, { method: request.method, headers });
	}
	if (env.BROWSERS === undefined) return viewRefused();
	return namedObject(env.BROWSERS, claims.browser, env).fetch(forwarded);
}

export async function routeRequest<StackId, VaultId>(
	request: Request,
	env: RouteEnv<StackId, VaultId>,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === "/healthz") return Response.json({ ok: true, service: "harbour" });
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
	if (request.method === "POST" && path === WORKSPACES_PATH) {
		// The same for creating a workspace: the stack refuses a caller without operator rights before it reads the seed.
		const forwarded = await buffered(request, WORKSPACE_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (request.method === "POST" && (path === API_KEYS_PATH || path.startsWith(`${API_KEYS_PATH}/`))) {
		// And for issuing or revoking a key: the stack refuses a viewer or a stranger before it reads the small JSON body.
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
	if (request.method === "POST" && isPasskeyPath(path)) {
		// And for registering or removing a passkey: a stranger is refused before the small JSON body is read.
		const forwarded = await buffered(request, PASSKEY_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack().fetch(forwarded);
	}
	if (path.startsWith(BROWSER_VIEW_API)) return routeView(request, env as RouteEnv<unknown, unknown>);
	if (VIEWER_PAGE.test(path)) return viewerPage(request, env as RouteEnv<unknown, unknown>);
	if (path === APPROVAL_API_BASE || path.startsWith(`${APPROVAL_API_BASE}/`)) return stack().fetch(request);
	if (path === "/v1" || path.startsWith("/v1/")) return stack().fetch(request);
	return env.ASSETS.fetch(request);
}
