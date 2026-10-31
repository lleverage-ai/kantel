// The sharing page's source over Kantel's public API (`@kantel/api`'s generated SDK, `/v1/sharing`), for when the
// console talks to a real Kantel. Same-origin under /v1, like the schedules API: behind Cloudflare Access the
// browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The page shows one project at a time: the projects the person can see, by name. The server decides every call: a
// request reaches the inbox only of those who may decide it, and a grant is never wider than asked.

import { createKantelClient, type KantelClient } from "@kantel/api/sdk";
import type {
	AccessRequest,
	AccessRequestQuery,
	Page,
	PageRequest,
	Project,
	ResourceShare,
	ShareGrantee,
	ShareQuery,
} from "@kantel/contracts";
import type { SharingSource } from "@kantel/ui";
import { readPeople } from "./audit-http.ts";
import type { ConsoleSharing } from "./oversight.ts";

export interface SharingApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

const pageQuery = (page: PageRequest | undefined) => ({
	...(page?.limit === undefined ? {} : { limit: page.limit }),
	...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
});

const pageOf = <T>(result: { readonly items: readonly unknown[]; readonly nextCursor?: string }): Page<T> => ({
	items: result.items as readonly T[],
	...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
});

/** A grantee as the list routes' `granteeKind` and `granteeId`. */
export function granteeQuery(grantee: ShareGrantee | undefined): {
	granteeKind?: ShareGrantee["kind"];
	granteeId?: string;
} {
	if (grantee === undefined) return {};
	switch (grantee.kind) {
		case "project":
			return { granteeKind: "project", granteeId: grantee.projectId };
		case "agent":
			return { granteeKind: "agent", granteeId: grantee.agentId };
		case "user":
			return { granteeKind: "user", granteeId: grantee.userId };
		case "session":
			return { granteeKind: "session", granteeId: grantee.sessionId };
	}
}

const resourceQuery = (query: { readonly resource?: { readonly kind: string; readonly id: string } }) =>
	query.resource === undefined ? {} : { resourceKind: query.resource.kind, resourceId: query.resource.id };

/** The sharing page's source over the API: one call per route. */
export function sharingApiSource(api: KantelClient): SharingSource {
	return {
		listShares: async (query: ShareQuery, page) =>
			pageOf<ResourceShare>(
				await api.listResourceShares({
					...resourceQuery(query),
					...granteeQuery(query.grantee),
					...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
					...(query.includeInactive === undefined ? {} : { includeInactive: query.includeInactive }),
					...pageQuery(page),
				}),
			),
		listRequests: async (query: AccessRequestQuery, page) =>
			pageOf<AccessRequest>(
				await api.listAccessRequests({
					...resourceQuery(query),
					...granteeQuery(query.grantee),
					...(query.status === undefined ? {} : { status: query.status }),
					...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
					...(query.decidable === undefined ? {} : { decidable: query.decidable }),
					...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
					...pageQuery(page),
				}),
			),
		revokeShare: async (shareId, reason) =>
			(await api.revokeResourceShare(shareId, reason === undefined ? {} : { reason })) as ResourceShare,
		decideRequest: async (requestId, input) => {
			const decided = await api.decideAccessRequest(requestId, input);
			return decided as { request: AccessRequest; share?: ResourceShare };
		},
		withdrawRequest: async (requestId) => (await api.withdrawAccessRequest(requestId)) as AccessRequest,
	};
}

/** Every project the person can see (`GET /v1/projects`), following the pages. */
async function projects(options: SharingApiOptions, doFetch: typeof fetch): Promise<Project[]> {
	const items: Project[] = [];
	let cursor: string | undefined;
	do {
		const query = new URLSearchParams({ limit: "200" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const response = await doFetch(`${options.baseUrl ?? "/v1"}/projects?${query}`, {
			headers: { accept: "application/json", ...(options.headers?.() ?? {}) },
		});
		if (!response.ok) throw new Error(`GET /v1/projects answered ${response.status}`);
		const page = (await response.json()) as Page<Project>;
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return items.sort((a, b) => a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id));
}

/**
 * The sharing page on the gateway this console is served by (`source=api`). Reads the projects and people first, for
 * the picker and for names; people who can't be read are shown by ID.
 */
export async function apiSharing(options: SharingApiOptions = {}): Promise<ConsoleSharing> {
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
	const [visible, people] = await Promise.all([
		projects(options, watched),
		readPeople({
			baseUrl: (options.baseUrl ?? "/v1").replace(/\/v1$/, ""),
			fetch: watched,
			...(options.headers === undefined ? {} : { headers: options.headers }),
		}).catch(() => undefined),
	]);
	const names = people?.names ?? new Map<string, string>();
	return {
		source: sharingApiSource(api),
		projects: visible.map((project) => ({ id: project.id, name: project.name })),
		directory: { person: (userId) => names.get(userId) },
	};
}
