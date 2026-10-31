// The schedules page's source over Kantel's public API (`@kantel/api`'s generated SDK, `/v1/schedules`), for when
// the console talks to a real Kantel. Same-origin under /v1, like the session API: behind Cloudflare Access the
// browser's cookie signs each call in; signed in with an email code, `headers` adds the session's bearer.
//
// The SDK's types are generated from the same TypeBox schemas as the contracts' and differ only where the SDK says
// `unknown` for a JSON value (a run's `result`), so its answers are cast to the contracts' types.
//
// New schedule and Edit need somewhere to own the schedule and an agent to ask: the first project (by name) the person
// may operate in, and the agent profiles they can see. Without either, the page reads, pauses and resumes only, and
// the server still decides each call.

import { createKantelClient, type KantelClient } from "@kantel/api/sdk";
import type {
	AgentProfile,
	MeResponse,
	Occurrence,
	Page,
	PageRequest,
	Project,
	Schedule,
	ScheduleUpdate,
} from "@kantel/contracts";
import { roleSatisfies } from "@kantel/contracts";
import type { AuditDirectory, ScheduleFormSettings, SchedulesSource } from "@kantel/ui";
import { readPeople } from "./audit-http.ts";
import type { ConsoleSchedules } from "./oversight.ts";

export interface SchedulesApiOptions {
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

/**
 * The schedules page's source over the API: one call per route. Ending is `DELETE /schedules/:id`, which keeps the
 * schedule listed as ended with its runs. The API has no read for a check's findings, so the page shows each run's
 * count only.
 */
export function schedulesApiSource(api: KantelClient): SchedulesSource {
	return {
		list: async (filter, page) =>
			pageOf<Schedule>(
				await api.listSchedules({
					...(filter?.status === undefined ? {} : { status: filter.status }),
					...pageQuery(page),
				}),
			),
		get: async (scheduleId) => (await api.getSchedule(scheduleId)) as Schedule,
		preview: async (scheduleId, n) => (await api.previewSchedule(scheduleId, { n })).dueAt,
		listOccurrences: async (scheduleId, page) =>
			pageOf<Occurrence>(await api.listScheduleRuns(scheduleId, pageQuery(page))),
		create: async (input) => (await api.createSchedule(input)) as Schedule,
		update: async (scheduleId, input: ScheduleUpdate) => (await api.updateSchedule(scheduleId, input)) as Schedule,
		pause: async (scheduleId) => (await api.pauseSchedule(scheduleId)) as Schedule,
		resume: async (scheduleId) => (await api.resumeSchedule(scheduleId)) as Schedule,
		end: async (scheduleId) => (await api.deleteSchedule(scheduleId)) as Schedule,
	};
}

/** Every item of a session API list (`GET /v1/<route>`), following the pages. */
async function every<T>(options: SchedulesApiOptions, route: string): Promise<T[]> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const query = new URLSearchParams({ limit: "200" });
		if (cursor !== undefined) query.set("cursor", cursor);
		const response = await doFetch(`${options.baseUrl ?? "/v1"}/${route}?${query}`, {
			headers: { accept: "application/json", ...(options.headers?.() ?? {}) },
		});
		if (!response.ok) throw new Error(`GET /v1/${route} answered ${response.status}`);
		const page = (await response.json()) as Page<T>;
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return items;
}

/** The first project, by name, that `me` may operate in: its organisation-wide role, or its role on that project. */
export function operableProject(me: Pick<MeResponse, "roles">, projects: readonly Project[]): Project | undefined {
	const organisationWide = me.roles.find((held) => held.projectId === undefined)?.role;
	const may = (project: Project) => {
		const role = me.roles.find((held) => held.projectId === project.id)?.role ?? organisationWide;
		return role !== undefined && roleSatisfies(role, "operator");
	};
	return [...projects].sort((a, b) => a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id)).find(may);
}

/** New schedule's settings: the agents by name, owned by the first project the person may operate in. */
export function formSettings(
	me: Pick<MeResponse, "roles" | "organisationId">,
	projects: readonly Project[],
	profiles: readonly AgentProfile[],
): ScheduleFormSettings | undefined {
	const project = operableProject(me, projects);
	if (project === undefined || profiles.length === 0) return undefined;
	return {
		owner: { kind: "project", organisationId: me.organisationId, projectId: project.id },
		agents: [...profiles]
			.map((profile) => ({ id: profile.id, name: profile.name }))
			.sort((a, b) => a.name.localeCompare(b.name, "en-GB")),
	};
}

/** Names for what schedules name: people (`GET /v1/members`), projects and agents. */
export function scheduleDirectory(
	people: ReadonlyMap<string, string>,
	projects: readonly Project[],
	profiles: readonly AgentProfile[],
): AuditDirectory {
	const projectNames = new Map(projects.map((project) => [project.id, project.name]));
	const agentNames = new Map(profiles.map((profile) => [profile.id, profile.name]));
	return {
		person: (userId) => people.get(userId),
		project: (projectId) => projectNames.get(projectId),
		agent: (agentId) => agentNames.get(agentId),
	};
}

/**
 * The schedules page on the gateway this console is served by (`source=api`), for the signed-in `me`. Reads the
 * projects, agent profiles and people first, for the form and for names; any that can't be read leaves its names out
 * (and, for the projects or profiles, the form).
 */
export async function apiSchedules(me: MeResponse, options: SchedulesApiOptions = {}): Promise<ConsoleSchedules> {
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
	const reads = { ...options, fetch: watched };
	const [projects, profiles, people] = await Promise.all([
		every<Project>(reads, "projects").catch((): Project[] => []),
		every<AgentProfile>(reads, "profiles").catch((): AgentProfile[] => []),
		readPeople({
			baseUrl: (options.baseUrl ?? "/v1").replace(/\/v1$/, ""),
			fetch: watched,
			...(options.headers === undefined ? {} : { headers: options.headers }),
		}).catch(() => undefined),
	]);
	const form = formSettings(me, projects, profiles);
	return {
		source: schedulesApiSource(api),
		directory: scheduleDirectory(people?.names ?? new Map(), projects, profiles),
		...(form === undefined ? {} : { form }),
	};
}
