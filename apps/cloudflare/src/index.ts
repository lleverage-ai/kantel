/**
 * harbour: the M1 gateway Worker (#17). One hostname, behind Cloudflare Access:
 *
 * - `/v1/*`: the session, workspace read and audit APIs, served by the `HarbourStack` Durable Object (`gateway.ts`).
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - everything else: the console (`apps/console`), as static assets with single-page-app fallback. Assets are served
 *   before the Worker runs, so only Access guards them; the APIs check the Access token (or an API key) themselves.
 */
import { type Env, HarbourStackBase, STACK_NAME } from "./stack-object.ts";

export class HarbourStack extends HarbourStackBase {}

export async function routeRequest(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === "/healthz") return Response.json({ ok: true, service: "harbour" });
	if (path === "/v1" || path.startsWith("/v1/")) return env.STACK.get(env.STACK.idFromName(STACK_NAME)).fetch(request);
	return env.ASSETS.fetch(request);
}

export default {
	fetch: routeRequest,
} satisfies ExportedHandler<Env>;
