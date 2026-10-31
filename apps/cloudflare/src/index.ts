/**
 * harbour: the M1 gateway Worker (#17). One hostname, behind Cloudflare Access (`src/route.ts` decides who answers):
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
import { KantelBrowserBase, KantelBrowserDecisionsBase } from "./browser-object.ts";
import { routeRequest } from "./route.ts";
import { KantelSandboxBase } from "./sandbox-object.ts";
import { type Env, KantelStackBase } from "./stack-object.ts";
import { KantelTunnelBase } from "./tunnel-object.ts";

export { routeRequest } from "./route.ts";
export { KantelVault } from "./vault-object.ts";

export class KantelStack extends KantelStackBase {}

/** One of Kantel's own browsers, with its Container (`src/browser-object.ts`). */
export class KantelBrowser extends KantelBrowserBase {}

/** Goal mode's decisions for one browser's container, reached only through its object's intercept. */
export class KantelBrowserDecisions extends KantelBrowserDecisionsBase {}

/** One session's container tier, with its Container (`src/sandbox-object.ts`). */
export class KantelSandbox extends KantelSandboxBase {}

/** One tool server's tunnel (`src/tunnel-object.ts`), experimental. */
export class KantelTunnel extends KantelTunnelBase {}

export default {
	fetch: routeRequest,
} satisfies ExportedHandler<Env>;
