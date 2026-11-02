// The Environments page's source over Kantel's public API (`@kantel/api`'s generated SDK, `/v1/environments`), for
// when the console talks to a real Kantel. Same-origin under /v1, like the Tool servers page: behind Cloudflare Access
// the browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The routes are experimental: a gateway without `KANTEL_ENVIRONMENTS=experimental` answers 404, and the console then
// lists no page.

import { createKantelClient, type KantelClient } from "@kantel/api/sdk";
import type { Environment, EnvironmentDetail } from "@kantel/contracts";
import type { EnvironmentsSource } from "@kantel/ui";
import { sessionPath } from "../app/router.ts";
import { readProjects } from "./connections-http.ts";
import type { ConsoleEnvironments } from "./oversight.ts";

export interface EnvironmentsApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

/** The Environments page's source over the API: one call per route. */
export function environmentsApiSource(api: KantelClient): EnvironmentsSource {
	return {
		list: async (filter) =>
			(
				(await api.listEnvironments(filter?.projectId === undefined ? {} : { projectId: filter.projectId })) as {
					items: Environment[];
				}
			).items,
		get: async (id) => (await api.getEnvironment(id)) as EnvironmentDetail,
		start: async (id) => (await api.startEnvironment(id)) as Environment,
		stop: async (id) => (await api.stopEnvironment(id)) as Environment,
	};
}

/**
 * The Environments page on the gateway this console is served by (`source=api`). Asks for the list first: a gateway
 * that doesn't serve `/v1/environments` (the switch is off) answers 404, this throws, and the console lists no page.
 */
export async function apiEnvironments(options: EnvironmentsApiOptions = {}): Promise<ConsoleEnvironments> {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createKantelClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	// The probe: the routes are served.
	await api.listEnvironments({});
	const projects = await readProjects(options, watched).catch(() => []);
	const names = new Map(projects.map((project) => [project.id, project.name]));
	return {
		source: environmentsApiSource(api),
		// People and sessions show by ID until the page has a directory for them; projects by name.
		directory: { project: (id) => names.get(id), person: () => undefined, session: () => undefined },
		links: { session: (sessionId, projectId) => sessionPath(projectId, sessionId) },
	};
}
