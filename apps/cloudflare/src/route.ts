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
 * - Everything else: the console's static assets, with single-page-app fallback.
 */
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

/** What routing needs of a Durable Object namespace, typed without workers-types so Node tests can stand one in. */
export interface NamedObjects<Id> {
	idFromName(name: string): Id;
	get(id: Id): Answers;
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
export interface RouteEnv<StackId = unknown, VaultId = unknown> {
	readonly STACK: NamedObjects<StackId>;
	readonly VAULTS: NamedObjects<VaultId>;
	readonly ASSETS: Answers;
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
		return env.VAULTS.get(env.VAULTS.idFromName(VAULT_NAME)).fetch(forwarded);
	}
	if (request.method === "POST" && path === WORKSPACES_PATH) {
		// The same for creating a workspace: the stack refuses a caller without operator rights before it reads the seed.
		const forwarded = await buffered(request, WORKSPACE_BODY_LIMIT);
		if (forwarded instanceof Response) return forwarded;
		return env.STACK.get(env.STACK.idFromName(STACK_NAME)).fetch(forwarded);
	}
	const stack = () => env.STACK.get(env.STACK.idFromName(STACK_NAME));
	if (path === APPROVAL_API_BASE || path.startsWith(`${APPROVAL_API_BASE}/`)) return stack().fetch(request);
	if (path === "/v1" || path.startsWith("/v1/")) return stack().fetch(request);
	return env.ASSETS.fetch(request);
}
