/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `/v1/hosts/register`, `/v1/hosts/images/…`, with Kantel Connect on | hosts, with no sign-in (`src/compute.ts`, `@kantel/hosts`) |
 * | `/v1/whoami`, `/v1/sandboxes`, `/v1/snapshots` and the rest of the compute API | the compute plane (`src/compute.ts`, `@kantel/compute`) |
 * | `/v1/me`, `/v1/projects`, `/v1/keys`, members and invites | who is signed in, their projects and keys (`@kantel/identity/http`) |
 * | `/v1/audit/…` | the audit query API (`@kantel/audit/http`) |
 * | every other `/v1/…` | 404 |
 *
 * In that order, as the self-hosted gateway has them (`apps/selfhosted/src/gateway/gateway.ts`): the compute API
 * answers only its own routes and passes on the rest.
 *
 * The agent plane's routes (sessions, workspaces, skills, memory, schedules, sharing, connections, tool servers,
 * approvals, the vault, passkeys, attachments and browsers) were removed with it; they are kept in git history on the
 * `agent-plane-archive` branch and the `agent-plane-archive-2026-11-03` tag (`e496aeb2`).
 *
 * Every route authenticates with the stack's authenticator: the Access token Cloudflare Access puts in
 * `Cf-Access-Jwt-Assertion` (people), or an API key as a bearer: identity's `ktk_` keys for the identity and audit
 * routes, the compute API's own `ksk_` keys for its routes. The compute API asks for a bearer, so a request with only
 * Access's token gets it as its bearer too (`withAccessBearer`). The console's static assets never reach here.
 */
import { createAuditQueryHandler } from "@kantel/audit/http";
import { createIdentityHandler, isIdentityPath } from "@kantel/identity/http";
import { withAccessBearer } from "./compute.ts";
import type { Stack } from "./stack.ts";

export const API_BASE = "/v1";
const AUDIT_PREFIX = "/v1/audit/";

export interface Gateway {
	fetch(request: Request): Promise<Response>;
}

const notFound = () =>
	Response.json(
		{ error: { code: "not_found", message: "No such route" } },
		{ status: 404, headers: { "cache-control": "no-store" } },
	);

export function createGateway(stack: Stack): Gateway {
	const audit = createAuditQueryHandler({ store: stack.audit, authenticator: stack.authenticator });
	// A 401 here names Access, so the console reloads for Access to sign the person in rather than showing its own form.
	const identity = createIdentityHandler({
		identity: stack.identity,
		authenticator: stack.authenticator,
		signIn: stack.signIn,
	});
	return {
		async fetch(incoming) {
			// A host has no sign-in: its join token or credential is its own (the stack object takes its WebSocket).
			const forHosts = await stack.compute.hosts?.fetch(incoming);
			if (forHosts !== undefined) return forHosts;
			const request = withAccessBearer(incoming);
			const path = new URL(request.url).pathname;
			const computed = await stack.compute.fetch(request);
			if (computed !== undefined) return computed;
			if (path.startsWith(AUDIT_PREFIX)) return audit(request);
			if (isIdentityPath(path)) return identity(request);
			return notFound();
		},
	};
}
