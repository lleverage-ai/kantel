/**
 * Which part of the Worker answers a request. Portable (no `cloudflare:workers`), so the tests route through it in
 * Node with stand-in namespaces.
 *
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - The vault's egress decision API (`/v1/egress/decisions`, `/v1/connector-credentials`): the `HarbourVault`
 *   Durable Object, which authenticates the calling component itself (`src/vault.ts`).
 * - Every other `/v1/…`: the session, workspace read and audit APIs, served by the `HarbourStack` Durable Object.
 * - Everything else: the console's static assets, with single-page-app fallback.
 */
import { isVaultPath } from "./vault.ts";

/** The one stack object's name. */
export const STACK_NAME = "m1";
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
		// still sending the object as an uncaught error. Its bodies are small JSON, so they are read here first.
		const body = request.method === "POST" ? await request.arrayBuffer() : null;
		const buffered = new Request(request.url, { method: request.method, headers: request.headers, body });
		return env.VAULTS.get(env.VAULTS.idFromName(VAULT_NAME)).fetch(buffered);
	}
	if (path === "/v1" || path.startsWith("/v1/")) return env.STACK.get(env.STACK.idFromName(STACK_NAME)).fetch(request);
	return env.ASSETS.fetch(request);
}
