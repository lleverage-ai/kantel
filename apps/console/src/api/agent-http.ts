// The skills and memory pages' sources over Harbour's public API (`@harbour/api`'s generated SDK), for when the console
// talks to a real Harbour. Same-origin under /v1, like the session API: behind Cloudflare Access the browser's cookie
// signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The API serves reads only for now: skills' list, package, revisions and files, and memory's spaces, concepts, search
// and recall. So the skills page has no author and the memory page no proposals: both are read-only here, and say so
// by leaving those views out rather than offering a button that fails.
//
// The SDK's types are generated from the same TypeBox schemas as the contracts' and differ only where the SDK says
// `unknown` for a JSON value (`extensions`), so its answers are cast to the contracts' types; packages, listings and
// spaces already match.

import { createHarbourClient, type HarbourClient } from "@harbour/api/sdk";
import type { Concept, MemorySpace, Recall, SkillRevision } from "@harbour/contracts";
import type { MemoryPageSource, SkillsSource } from "@harbour/ui";
import type { ConsoleAgent } from "./oversight.ts";

export interface AgentApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: () => Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
}

const MAX_SPACE_PAGES = 20;

/** The skills page's source over the API. The viewer is the caller, so `visibility.userId` is the server's to decide. */
export function skillsApiSource(api: HarbourClient): SkillsSource {
	return {
		list: async (visibility, page) => {
			const result = await api.listSkills({
				...(visibility.projectId === undefined ? {} : { projectId: visibility.projectId }),
				...(page?.limit === undefined ? {} : { limit: page.limit }),
				...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
			});
			return {
				items: result.items,
				...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
			};
		},
		get: (skillId) => api.getSkill(skillId),
		listRevisions: async (skillId, page) => {
			const result = await api.listSkillRevisions(skillId, {
				...(page?.limit === undefined ? {} : { limit: page.limit }),
				...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
			});
			return {
				items: result.items as readonly SkillRevision[],
				...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
			};
		},
		getRevision: async (skillId, revision) => (await api.getSkillRevision(skillId, String(revision))) as SkillRevision,
		readFile: async (skillId, revision, path) => (await api.readSkillFile(skillId, String(revision), { path })).content,
	};
}

/** The memory page's source over the API: reads only, so no proposals. */
export function memoryApiSource(api: HarbourClient): MemoryPageSource {
	return {
		listConcepts: async (spaceId, filter, page) => {
			const result = await api.listConcepts(spaceId, {
				...(filter?.status === undefined ? {} : { status: filter.status }),
				...(page?.limit === undefined ? {} : { limit: page.limit }),
				...(page?.cursor === undefined ? {} : { cursor: page.cursor }),
			});
			return {
				items: result.items as readonly Concept[],
				...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
			};
		},
		getConcept: async (spaceId, conceptId) => (await api.getConcept(spaceId, conceptId)) as Concept,
		search: async (request) =>
			(await api.searchMemory(request)).hits as Awaited<ReturnType<MemoryPageSource["search"]>>,
		recall: async (request) => (await api.recallMemory(request)) as Recall,
	};
}

/** Every memory space the caller may read, oldest first. */
export async function listSpaces(api: HarbourClient): Promise<readonly MemorySpace[]> {
	const spaces: MemorySpace[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < MAX_SPACE_PAGES; index += 1) {
		const page = await api.listMemorySpaces(cursor === undefined ? { limit: 100 } : { limit: 100, cursor });
		spaces.push(...page.items);
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	return spaces;
}

/** The skills and memory pages on the gateway this console is served by (`source=api`). */
export function apiAgent(options: AgentApiOptions = {}): ConsoleAgent {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const api = createHarbourClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: async (input, init) => {
			const response = await doFetch(input, init);
			if (response.status === 401) options.onUnauthenticated?.();
			return response;
		},
	});
	return {
		skills: skillsApiSource(api),
		memory: memoryApiSource(api),
		spaces: () => listSpaces(api),
	};
}
