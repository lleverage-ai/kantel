/**
 * kantel: the gateway Worker. One hostname, behind Cloudflare Access (`src/route.ts` decides who answers):
 *
 * - every `/v1/*`: the identity and audit APIs, served by the `KantelStack` Durable Object (`gateway.ts`);
 * - `/healthz`: public liveness, the service name only. Access still guards it on the deployed hostname.
 * - everything else: the console (`apps/console`), as static assets with single-page-app fallback. Assets are served
 *   before the Worker runs, so only Access guards them; the APIs check the Access token (or an API key) themselves.
 *
 * Kantel's agent plane (sessions, the vault, browsers, sandboxes, tool server tunnels) was removed; its code is kept on
 * the `agent-plane-archive` branch and the `agent-plane-archive-2026-11-03` tag (`e496aeb2`). Its Durable Object
 * classes are still exported, inert (`src/retired.ts`), so that no migration deletes them or their storage.
 */
import { withKantelEnv } from "@kantel/contracts/env";
import { RetiredObject } from "./retired.ts";
import { routeRequest } from "./route.ts";
import { type Env, KantelStackBase } from "./stack-object.ts";

export { routeRequest } from "./route.ts";

// The Durable Object classes are exported under their deployed names (wrangler.jsonc's class_name and migrations).
// The stack and the vault were renamed KantelStack and KantelVault by the v6 renamed_classes migration; the browsers
// and sandboxes kept their names (migrations v3-v4).
export {
	KantelBrowser as HarbourBrowser,
	KantelSandbox as HarbourSandbox,
	KantelStack,
	// Their names before the v6 renamed_classes migration (wrangler.jsonc), as aliases: a request that reaches the
	// old name while the rename applies still finds the class.
	KantelStack as HarbourStack,
	KantelVault,
	KantelVault as HarbourVault,
};

class KantelStack extends KantelStackBase {}

/** The vault's object, retired with connections and approvals: its storage stays. */
class KantelVault extends RetiredObject {}

/** One of Kantel's own browsers for sessions, retired: its storage and container app stay. */
class KantelBrowser extends RetiredObject {}

/** One session's container tier, retired: its storage and container app stay. */
class KantelSandbox extends RetiredObject {}

/** One tool server's tunnel, retired. */
export class KantelTunnel extends RetiredObject {}

/** One session's own object, retired: its sessions' storage stays. */
export class KantelSession extends RetiredObject {}

export default {
	// Vars and secrets set before the rename are named HARBOUR_*: every KANTEL_* left unset takes their value.
	fetch: (request: Request, env: Env) => routeRequest(request, withKantelEnv(env)),
} satisfies ExportedHandler<Env>;
