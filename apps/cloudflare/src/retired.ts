/**
 * The agent plane's Durable Object classes, kept exported and inert. Kantel is a compute plane now, and nothing routes
 * to these objects; the code they ran is kept in git history on the `agent-plane-archive` branch and the
 * `agent-plane-archive-2026-11-03` tag (`e496aeb2`).
 *
 * They stay because a class the Worker stops exporting needs a `deleted_classes` migration, and that migration deletes
 * every object of the class and its storage. Kept like this, their storage stays where it is, and deleting it is a
 * separate decision. Each answers any request it still gets with 410, and an alarm an older version armed is answered
 * and not armed again. The browser and sandbox classes' container apps (scripts/deploy-config.ts) stay attached to
 * them; these classes never start a container.
 */
import { DurableObject } from "cloudflare:workers";

const gone = () =>
	Response.json(
		{
			error: {
				code: "not_found",
				message: "Kantel's agent plane was removed; this deployment serves the console, identity and audit only",
			},
		},
		{ status: 410, headers: { "cache-control": "no-store" } },
	);

/** A Durable Object class that is still deployed but no longer does anything. */
export class RetiredObject extends DurableObject {
	override async fetch(_request: Request): Promise<Response> {
		return gone();
	}

	override async alarm(): Promise<void> {}
}
