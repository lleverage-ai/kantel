/**
 * The gateway's API routes, one fetch handler over a `Stack`:
 *
 * | Prefix | Served by |
 * | --- | --- |
 * | `/v1/me`, `/v1/projects`, `/v1/keys`, members and invites | who is signed in, their projects and keys (`@kantel/identity/http`) |
 * | `/v1/audit/…` | the audit query API (`@kantel/audit/http`) |
 * | every other `/v1/…` | 404 |
 *
 * The agent plane's routes (sessions, workspaces, skills, memory, schedules, sharing, connections, tool servers,
 * approvals, the vault, passkeys, attachments and browsers) were removed with it; they are kept in git history on the
 * `agent-plane-archive` branch and the `agent-plane-archive-2026-11-03` tag (`e496aeb2`). This Worker doesn't serve the
 * compute API either: the console it serves finds no `/v1/whoami` here and shows its sample data, as the hosted demo
 * does.
 *
 * Every route authenticates with the stack's authenticator: an `ktk_` API key as a bearer (host apps), or the Access
 * token Cloudflare Access puts in `Cf-Access-Jwt-Assertion` (people). The console's static assets never reach here.
 */
import { createAuditQueryHandler } from "@kantel/audit/http";
import { createIdentityHandler, isIdentityPath } from "@kantel/identity/http";
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
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path.startsWith(AUDIT_PREFIX)) return audit(request);
			if (isIdentityPath(path)) return identity(request);
			return notFound();
		},
	};
}
