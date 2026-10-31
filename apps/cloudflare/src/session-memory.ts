/**
 * A session's memory on the stack (#12): the runtime's `memory` setting (`@kantel/runtime`'s `SessionMemoryOptions`)
 * over the stack's memory store.
 *
 * On the session's first prompt the runtime recalls over the profile's memory scopes, each a memory space ID, with the
 * prompt's text as the query; the text is the store's `RecallRenderer`, Kantel's default one. What the request asks
 * for beyond that comes from the spaces themselves, so a space loaded from a host's bundle is recalled as the host
 * recalls it, with no host code here:
 *
 * - **The profile** (`RecallRequest.profile`): every active concept tagged `profile` in the spaces, recalled whatever
 *   the query, within the profile's own budget. This is the bounded profile #12 describes, and the tag a bundle such as
 *   Sal's marks it with.
 * - **Project scopes**: every project a concept in the spaces is scoped to. A space holds what its sessions may see
 *   (a host loads the scopes a task may see), so all of them apply.
 * - **Job scopes**: a job's exceptions travel only with sessions labelled with that job, `job` or the `docketTask` label
 *   the session contract gives as its example. A Docket task is named both ways, `TASK-12` and `docket:TASK-12`.
 *
 * Budgets and limits are the store's defaults. Every read is the session's agent's, so the store's access rules apply.
 */
import type { CallContext, Memory, RecallRequest, SessionRecord } from "@kantel/contracts";
import type { SessionMemoryOptions } from "@kantel/runtime/core";

/** The tag that puts a concept in every session's profile. */
export const PROFILE_TAG = "profile";

const PAGE = 500;

/** The labels whose value names the session's job. */
export const JOB_LABELS = ["job", "docketTask"] as const;

/** The job scopes a session's labels name, in every spelling its exceptions may use. */
export function sessionJobs(session: Pick<SessionRecord, "labels">): readonly string[] {
	const jobs = new Set<string>();
	for (const label of JOB_LABELS) {
		const value = session.labels[label];
		if (value === undefined || value === "") continue;
		jobs.add(value);
		if (label === "docketTask")
			jobs.add(value.startsWith("docket:") ? value.slice("docket:".length) : `docket:${value}`);
	}
	return [...jobs];
}

/** The profile concepts and project scopes of the spaces, as the caller reads them. */
async function spaceScopes(
	memory: Pick<Memory, "listConcepts">,
	ctx: CallContext,
	spaceIds: readonly string[],
): Promise<{ readonly profile: readonly string[]; readonly projects: readonly string[] }> {
	const profile = new Set<string>();
	const projects = new Set<string>();
	for (const spaceId of spaceIds) {
		let cursor: string | undefined;
		do {
			const page = await memory.listConcepts(
				ctx,
				spaceId,
				{ status: "active" },
				cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor },
			);
			for (const concept of page.items) {
				if (concept.tags.includes(PROFILE_TAG)) profile.add(concept.id);
				if (concept.scope.kind === "project") projects.add(concept.scope.project);
			}
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	}
	return { profile: [...profile], projects: [...projects].sort() };
}

/** The runtime's `memory` setting over the stack's memory store. */
export function sessionMemory(
	memory: Pick<Memory, "recall" | "search" | "getConcept" | "listConcepts">,
): SessionMemoryOptions {
	return {
		store: {
			recall: async (ctx, request: RecallRequest) => {
				const { profile, projects } = await spaceScopes(memory, ctx, request.spaceIds);
				return memory.recall(ctx, {
					...request,
					profile: request.profile ?? profile,
					scopes: { projects: request.scopes?.projects ?? projects, jobs: request.scopes?.jobs ?? [] },
				});
			},
			search: (ctx, request) => memory.search(ctx, request),
			getConcept: (ctx, spaceId, conceptId) => memory.getConcept(ctx, spaceId, conceptId),
		},
		recall: (session) => ({ scopes: { jobs: sessionJobs(session) } }),
	};
}
