/**
 * Which part of the Worker answers a request. Portable (no `cloudflare:workers`), so the tests route through it in
 * Node with stand-in namespaces.
 *
 * - Any name under the ports domain (KANTEL_COMPUTE_PORTS_DOMAIN, default `kantel.run`): an exposed port's page, which
 *   the stack object relays to the sandbox (`src/compute.ts` `servePort`), whatever the path. Nothing else answers
 *   there, the console's files included: `run_worker_first` is `true` in wrangler.jsonc, since assets match by path on
 *   every name the Worker is routed, and a sandbox's `/` or `/assets/…` must never be the console's.
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - Every `/v1/…`: the identity and audit APIs, served by the `KantelStack` Durable Object (`src/gateway.ts`); any other
 *   API path is a 404 there.
 * - `/auth/…`: email-code sign-in, also the stack object's, which answers it only on the public origin
 *   (KANTEL_PUBLIC_URL) and 404s it elsewhere.
 * - Everything else: the console's static assets (`consoleAsset`), through the `ASSETS` binding. A file the build holds
 *   is served as it is; a miss comes back as a 404 (`not_found_handling: "none"` in wrangler.jsonc). A miss under `/assets/` is a real 404: a chunk
 *   an older build named, which a tab opened before a deploy still asks for, must fail as a missing script, not load
 *   the console's page as one (`'text/html' is not a valid JavaScript MIME type`). Any other miss is the
 *   console's page, the single-page app's fallback.
 *
 * The agent plane's routes (the vault's egress API, tool server tunnels, session objects, browser views and the viewer
 * page) were removed with it; they are kept in git history on the `agent-plane-archive` branch and the
 * `agent-plane-archive-2026-11-03` tag (`e496aeb2`). Their Durable Object classes stay exported, inert
 * (`src/retired.ts`), so the deploy deletes neither them nor their storage.
 */
import { API_KEYS_PATH, INVITES_PATH, KantelError } from "@kantel/contracts";
import { API_KEY_BODY_LIMIT } from "@kantel/identity/http";
import { type GatewayVars, isPortName, portsDomainOf } from "./config.ts";

/** The one stack object's name. */
export const STACK_NAME = "m1";

/** Email-code sign-in's routes (`/auth/otp/start`, `/auth/otp/verify`, `/auth/session/end`), served by the stack. */
export const SIGN_IN_PREFIX = "/auth/";
/** Their bodies are an email and a code: refused past this before the stack reads them. */
const SIGN_IN_BODY_LIMIT = 4096;

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
	 * Where the stack object is created (`LOCATION_HINTS`). Default `weur`. A hint applies only when an object is first
	 * created: an object that exists stays where it is, whatever this says.
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

const tooLarge = (limit: number) =>
	Response.json(
		{ error: { code: "invalid", message: `The body is larger than ${limit} bytes` } },
		{ status: 413, headers: { "cache-control": "no-store" } },
	);

/** The request with its body read here, up to `limit`, or a 413. */
export async function buffered(request: Request, limit: number): Promise<Request | Response> {
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
export interface RouteEnv<StackId = unknown> extends PlacementVars, Pick<GatewayVars, "KANTEL_COMPUTE_PORTS_DOMAIN"> {
	readonly STACK: NamedObjects<StackId>;
	readonly ASSETS: Answers;
}

const routeRefused = (status: number, code: string, message: string, headers: { [name: string]: string } = {}) =>
	Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store", ...headers } });

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
 * from a bug. Nothing is retried here: the request's body may already be spent. Any other error is still thrown.
 */
export async function routeRequest<StackId>(request: Request, env: RouteEnv<StackId>): Promise<Response> {
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

async function routeOnce<StackId>(request: Request, env: RouteEnv<StackId>): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	// An exposed port's page: its body streams through to the sandbox, bounded there (`proxyHttp`).
	if (isPortName(url.hostname, portsDomainOf(env))) return namedObject(env.STACK, STACK_NAME, env).fetch(request);
	if (path === "/healthz") return Response.json({ ok: true, service: "kantel" });
	const stack = namedObject(env.STACK, STACK_NAME, env);
	// Email-code sign-in: the stack answers it on the public origin only, and 404s it anywhere else.
	if (path.startsWith(SIGN_IN_PREFIX)) {
		const forwarded = await buffered(request, SIGN_IN_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack.fetch(forwarded);
	}
	if (path !== "/v1" && !path.startsWith("/v1/")) return consoleAsset(request, env);
	const keysOrInvites = [API_KEYS_PATH, INVITES_PATH].some((base) => path === base || path.startsWith(`${base}/`));
	if (request.method === "POST" && keysOrInvites) {
		// Issuing or revoking a key or an invite: the stack refuses a stranger before it reads the small JSON body.
		const forwarded = await buffered(request, API_KEY_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return stack.fetch(forwarded);
	}
	return stack.fetch(request);
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
