/**
 * Kantel's public API, version 1: every route a host app (or the console) may call, under `/v1`. Add a route here and
 * the server must implement it (`createRouter` takes a handler for each), and the OpenAPI document and the SDK pick it
 * up when they are generated (`pnpm --filter @kantel/api generate`; CI fails while they are stale).
 */

import { computeRoutes } from "./compute-routes.ts";
import { defineRoute } from "./route.ts";
import { BrowserEmbed, BrowserSessionPath, CreateProjectBody, EmbedBrowserBody, Project } from "./schema.ts";

/** The version's base path, before every route's own path. */
export const API_VERSION_BASE = "/v1";

// Browsers (packages/browser/CONTRACT.md): an outside app frames a session's browser.

export const embedBrowserSession = defineRoute({
	operationId: "embedBrowserSession",
	method: "POST",
	path: "/sessions/{sessionId}/browsers/{browserSessionId}/embed",
	tag: "browsers",
	summary: "Embed a session's browser",
	description:
		"A link for an iframe: a watch-only live view of one of the session's open browsers, or a replay of one, open or " +
		"closed. Needs viewer on the session; never an agent. The link carries a short-lived token scoped to that one view " +
		"(never control), lasting `minutes`. A closed browser has no live view (`expired`); a deployment whose browsers " +
		"keep no recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Audited as " +
		"`browser.session.embedded`, without the link.",
	params: BrowserSessionPath,
	body: EmbedBrowserBody,
	answer: { status: 200, description: "The link to frame.", schema: BrowserEmbed },
	errors: ["invalid", "forbidden", "not_found", "expired", "unavailable"],
});

/** The browsers' routes, served by `@kantel/browser/http`. */
export const browserRoutes = { embedBrowserSession } as const;

// Projects: served by identity (`@kantel/identity/http`), beside `GET /v1/projects`, `GET /v1/me` and the key routes.

export const createProject = defineRoute({
	operationId: "createProject",
	method: "POST",
	path: "/projects",
	tag: "projects",
	summary: "Create a project",
	description:
		"Creates a project in the caller's organisation, which the `kantel-organisation` header names for a person in " +
		"more than one. Needs an organisation-wide admin, or an organisation API key with the `create_projects` " +
		"permission; a project key is refused, whatever its role. An organisation key holds its role on the new project " +
		"at once. Audited as `identity.project.created`, with the caller as its actor.",
	body: CreateProjectBody,
	answer: { status: 201, description: "The new project.", schema: Project },
	errors: ["invalid", "forbidden"],
});

export const projectRoutes = { createProject } as const;

/**
 * Every v1 route, by operation ID, in the order the document and the SDK list them. Each server serves its own group.
 * The dormant agent plane's environment routes (`environmentRoutes`, served by nothing) aren't among them: the compute
 * plane's environments took their names, and the document and the SDK keep only the first shape of each name.
 */
export const routes = {
	...browserRoutes,
	...projectRoutes,
	...computeRoutes,
} as const;

export type Routes = typeof routes;
export type OperationId = keyof Routes;
