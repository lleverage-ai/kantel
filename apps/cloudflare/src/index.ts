/**
 * kantel: the gateway Worker (#17). One hostname, behind Cloudflare Access (`src/route.ts` decides who answers):
 *
 * - `/v1/egress/decisions`, `/v1/connector-credentials`: the vault's egress decision API, served by the `KantelVault`
 *   Durable Object (`vault-object.ts`) to the egress and model gateways by shared key.
 * - every other `/v1/*`: the session, workspace read and audit APIs, served by the `KantelStack` Durable Object
 *   (`gateway.ts`).
 * - `GET /v1/tool-servers/{id}/connect` upgraded to a WebSocket: a tool server's tunnel, its token checked by the stack,
 *   then held by that server's `KantelTunnel` Durable Object (`tunnel-object.ts`). Only with
 *   `KANTEL_TOOL_SERVERS=experimental`.
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - everything else: the console (`apps/console`), as static assets with single-page-app fallback. Assets are served
 *   before the Worker runs, so only Access guards them; the APIs check the Access token (or an API key) themselves.
 */
import { withKantelEnv } from "@kantel/contracts/env";
import { KantelBrowserBase, KantelBrowserDecisionsBase } from "./browser-object.ts";
import { routeRequest } from "./route.ts";
import { KantelSandboxBase } from "./sandbox-object.ts";
import { type Env, KantelStackBase } from "./stack-object.ts";
import { KantelTunnelBase } from "./tunnel-object.ts";
import { KantelVault } from "./vault-object.ts";

export { routeRequest } from "./route.ts";

// The Durable Object classes are exported under their deployed names (wrangler.jsonc's class_name and migrations
// v1-v4): those names are the namespaces that hold every existing object, and the browser and sandbox container apps
// are named after them. Renaming them needs a renamed_classes migration and new container apps (a follow-up).
export {
	KantelBrowser as HarbourBrowser,
	KantelSandbox as HarbourSandbox,
	KantelStack as KantelStack,
	KantelVault as KantelVault,
};

class KantelStack extends KantelStackBase {}

/** One of Kantel's own browsers, with its Container (`src/browser-object.ts`). */
class KantelBrowser extends KantelBrowserBase {}

/** Goal mode's decisions for one browser's container, reached only through its object's intercept. */
export class KantelBrowserDecisions extends KantelBrowserDecisionsBase {}

/** One session's container tier, with its Container (`src/sandbox-object.ts`). */
class KantelSandbox extends KantelSandboxBase {}

/** One tool server's tunnel (`src/tunnel-object.ts`), experimental. */
export class KantelTunnel extends KantelTunnelBase {}

export default {
	// Vars and secrets set before the rename are named HARBOUR_*: every KANTEL_* left unset takes their value.
	fetch: (request: Request, env: Env) => routeRequest(request, withKantelEnv(env)),
} satisfies ExportedHandler<Env>;
