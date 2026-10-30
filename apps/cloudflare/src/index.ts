/**
 * harbour: the M1 gateway Worker (#17). One hostname, behind Cloudflare Access (`src/route.ts` decides who answers):
 *
 * - `/v1/egress/decisions`, `/v1/connector-credentials`: the vault's egress decision API, served by the `HarbourVault`
 *   Durable Object (`vault-object.ts`) to the egress and model gateways by shared key.
 * - every other `/v1/*`: the session, workspace read and audit APIs, served by the `HarbourStack` Durable Object
 *   (`gateway.ts`).
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - everything else: the console (`apps/console`), as static assets with single-page-app fallback. Assets are served
 *   before the Worker runs, so only Access guards them; the APIs check the Access token (or an API key) themselves.
 */
import { HarbourBrowserBase } from "./browser-object.ts";
import { routeRequest } from "./route.ts";
import { HarbourSandboxBase } from "./sandbox-object.ts";
import { type Env, HarbourStackBase } from "./stack-object.ts";

export { routeRequest } from "./route.ts";
export { HarbourVault } from "./vault-object.ts";

export class HarbourStack extends HarbourStackBase {}

/** One of Harbour's own browsers, with its Container (`src/browser-object.ts`). */
export class HarbourBrowser extends HarbourBrowserBase {}

/** One session's container tier, with its Container (`src/sandbox-object.ts`). */
export class HarbourSandbox extends HarbourSandboxBase {}

export default {
	fetch: routeRequest,
} satisfies ExportedHandler<Env>;
