// The Tool servers page's source over Kantel's public API (`@kantel/api`'s generated SDK, `/v1/tool-servers`), for
// when the console talks to a real Kantel. Same-origin under /v1, like the Connections page: behind Cloudflare Access
// the browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The routes are experimental: a gateway without `KANTEL_TOOL_SERVERS=experimental` answers 404, and the console then
// lists no page. A tunnel token's secret comes back once, in the call that makes it, and the page forgets it.

import { createKantelClient, type KantelClient } from "@kantel/api/sdk";
import type {
	CreatedToolServer,
	IssuedToolServerToken,
	MeResponse,
	Page,
	ToolServer,
	ToolServerTools,
} from "@kantel/contracts";
import { createIdentityClient } from "@kantel/identity/http";
import type { ToolServersSource } from "@kantel/ui";
import { AUDIT_PATH } from "../app/router.ts";
import { readProjects } from "./connections-http.ts";
import type { ConsoleToolServers } from "./oversight.ts";

export interface ToolServersApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
	/** Kantel's address, as the tunnel command names it. Default `location.origin`. */
	readonly origin?: string;
}

/** A server's disabled tools with `tool` turned on or off, the rest as they were. */
export function disabledToolsWith(disabled: readonly string[], tool: string, enabled: boolean): readonly string[] {
	const others = disabled.filter((name) => name !== tool);
	return enabled ? others : [...others, tool];
}

/** The Tool servers page's source over the API: one call per route, two to turn a tool on or off. */
export function toolServersApiSource(api: KantelClient): ToolServersSource {
	return {
		list: async (filter) => {
			const items: ToolServer[] = [];
			let cursor: string | undefined;
			do {
				const page = (await api.listToolServers({
					limit: 200,
					...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
					...(cursor === undefined ? {} : { cursor }),
				})) as Page<ToolServer>;
				items.push(...page.items);
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return items;
		},
		create: async (input) =>
			(await api.createToolServer({
				name: input.name,
				transport: input.transport,
				...(input.projectId === undefined ? {} : { projectId: input.projectId }),
				...(input.description === undefined ? {} : { description: input.description }),
			})) as CreatedToolServer,
		get: async (id) => (await api.getToolServer(id)) as ToolServer,
		tools: async (id) => (await api.getToolServerTools(id)) as ToolServerTools,
		// The update replaces the whole disabled list, so it is worked out from the server's list as it is now.
		setToolEnabled: async (id, tool, enabled) => {
			const server = (await api.getToolServer(id)) as ToolServer;
			await api.updateToolServer(id, { disabledTools: disabledToolsWith(server.disabledTools, tool, enabled) });
		},
		createToken: async (id) => (await api.createToolServerToken(id)) as IssuedToolServerToken,
		listTokens: async (id) => (await api.listToolServerTokens(id)).items,
		revokeToken: async (id, tokenId) => {
			await api.revokeToolServerToken(id, tokenId);
		},
		remove: async (id) => {
			await api.removeToolServer(id);
		},
		// No stats: Kantel has no route for a server's calls over the day yet, and the list leaves them out without it.
		//
		// The audit query API can't filter `session.tool.finished` by `data.toolServerId` (only by subject, type and the
		// vault's `itemId` and `grantId`), and the server's own `tool_server.*` rows are changes to it (made, tokens,
		// connected, tools changed), none of them a call. So no calls are listed: the page shows none and links to the
		// audit log.
		recentCalls: async () => [],
		// The audit log reads no filter from its address yet, so Open in audit opens it whole.
		auditHref: () => AUDIT_PATH,
	};
}

/**
 * The Tool servers page on the gateway this console is served by (`source=api`). Asks for one server first: a gateway
 * that doesn't serve `/v1/tool-servers` (the switch is off) answers 404, this throws, and the console lists no page.
 */
export async function apiToolServers(
	me: Pick<MeResponse, "organisationId">,
	options: ToolServersApiOptions = {},
): Promise<ConsoleToolServers> {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const baseUrl = options.baseUrl ?? "/v1";
	const api = createKantelClient({
		baseUrl,
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	// The probe: one server is enough to know the routes are served.
	await api.listToolServers({ limit: 1 });
	const [visible, organisations] = await Promise.all([
		readProjects(options, watched).catch(() => undefined),
		createIdentityClient({
			baseUrl: baseUrl.replace(/\/v1$/, ""),
			fetch: watched,
			...(options.headers === undefined ? {} : { headers: options.headers }),
		})
			.organisations()
			.catch(() => undefined),
	]);
	const organisation =
		organisations?.items.find((candidate) => candidate.id === me.organisationId)?.name ?? "Your organisation";
	return {
		source: toolServersApiSource(api),
		organisation,
		// Without the projects, the page names the console's own.
		...(visible === undefined ? {} : { projects: visible.map((project) => ({ id: project.id, name: project.name })) }),
		origin: options.origin ?? (typeof location === "undefined" ? "" : location.origin),
	};
}
