// The audit log's source over the audit query API (M1-BE8, `@harbour/audit/http`), for when the console talks to a
// real Harbour. The organisation the view asks for becomes the `Harbour-Organisation` header, as the API takes it for
// a human; the server checks the caller belongs to it and answers `forbidden` if not.

import { type AuditClientOptions, createAuditClient } from "@harbour/audit/http";
import { ORGANISATION_HEADER } from "@harbour/contracts";
import { type AuditDirectory, type AuditSource, type Choice, credentialChoices } from "@harbour/ui";
import { sessionTurnPath, vaultRequestPath } from "../app/router.ts";
import type { AuditChoices, AuditLookups, ConsoleAudit } from "./oversight.ts";

export interface AuditApiSourceOptions {
	readonly baseUrl: string;
	/** Credentials for every call, such as `Authorization`. The organisation header is added per query. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: AuditClientOptions["fetch"];
}

/** An `AuditSource` over the audit query API: one client per organisation the view reads. */
export function auditApiSource(options: AuditApiSourceOptions): AuditSource {
	const clients = new Map<string, ReturnType<typeof createAuditClient>>();
	const clientFor = (organisationId: string | undefined) => {
		const key = organisationId ?? "";
		let client = clients.get(key);
		if (client === undefined) {
			client = createAuditClient({
				baseUrl: options.baseUrl,
				...(options.fetch === undefined ? {} : { fetch: options.fetch }),
				headers: async () => {
					const base = (await options.headers?.()) ?? {};
					if (organisationId === undefined) return base;
					// Header names are case-insensitive: the organisation asked for replaces any the credentials carry.
					const headers = new Headers(base);
					headers.set(ORGANISATION_HEADER, organisationId);
					return Object.fromEntries(headers);
				},
			});
			clients.set(key, client);
		}
		return client;
	};
	return {
		query({ organisationId, ...query }, page) {
			return clientFor(organisationId).query(query, page);
		},
	};
}

/** The most sessions the *Session* filter offers, the most recently active first; every session is still named. */
export const SESSION_CHOICE_CAP = 200;

/** The lists the filters are made from, as the gateway's APIs give them. Each is optional and read on its own. */
export interface AuditListSources {
	/** The caller's projects: identity's `GET /v1/projects`, every page. */
	readonly projects?: () => Promise<readonly { readonly id: string; readonly name: string }[]>;
	/** Every session the caller can see: the session API's `GET /v1/sessions`, every page. */
	readonly sessions?: () => Promise<
		readonly {
			readonly id: string;
			readonly projectId: string;
			readonly agentId: string;
			readonly title?: string;
			readonly updatedAt: number;
		}[]
	>;
	/** The agent profiles, to name the agents sessions ran: `GET /v1/profiles`, every page. */
	readonly agents?: () => Promise<readonly { readonly id: string; readonly name: string }[]>;
}

const byLabel = (a: Choice, b: Choice) => a.label.localeCompare(b.label, "en-GB") || a.value.localeCompare(b.value);

/**
 * The *Project*, *Agent* and *Session* choices, and names for rows, from the gateway's lists. Projects come by name;
 * agents are the ones the sessions ran, named by their profile; sessions are the most recently active
 * `SESSION_CHOICE_CAP`, by title. A list that can't be read leaves its filter hidden and the others as they are; the
 * call rejects only when every list it was given fails.
 */
export async function auditLookups(lists: AuditListSources): Promise<AuditLookups> {
	const read = <T>(list: (() => Promise<T>) | undefined) => (list === undefined ? Promise.resolve(undefined) : list());
	const [projects, sessions, agents] = await Promise.allSettled([
		read(lists.projects),
		read(lists.sessions),
		read(lists.agents),
	]);
	const asked = [lists.projects, lists.sessions, lists.agents].filter((list) => list !== undefined).length;
	const failed = [projects, sessions, agents].filter((result) => result.status === "rejected");
	if (asked > 0 && failed.length === asked) throw (failed[0] as PromiseRejectedResult).reason;

	const choices: { -readonly [K in keyof AuditChoices]: AuditChoices[K] } = {};
	const directory: { -readonly [K in keyof AuditDirectory]: AuditDirectory[K] } = {};

	if (projects.status === "fulfilled" && projects.value !== undefined && projects.value.length > 0) {
		const names = new Map(projects.value.map((project) => [project.id, project.name]));
		choices.projects = [...names].map(([value, label]) => ({ value, label })).sort(byLabel);
		directory.project = (projectId) => names.get(projectId);
	}

	const profiles = new Map(
		agents.status === "fulfilled" && agents.value !== undefined
			? agents.value.map((profile) => [profile.id, profile.name])
			: [],
	);
	if (profiles.size > 0) directory.agent = (agentId) => profiles.get(agentId);

	if (sessions.status === "fulfilled" && sessions.value !== undefined && sessions.value.length > 0) {
		const recent = [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		const titles = new Map(
			recent.flatMap((session) => (session.title === undefined ? [] : [[session.id, session.title]])),
		);
		if (titles.size > 0) directory.session = (sessionId) => titles.get(sessionId);
		choices.sessions = recent.slice(0, SESSION_CHOICE_CAP).map((session) => ({
			value: session.id,
			// An untitled session by its ID too, so two of them can be told apart.
			label: session.title ?? `Untitled session (${session.id})`,
		}));
		const ran = new Set(recent.map((session) => session.agentId));
		choices.agents = [...ran]
			.map((agentId) => ({ value: agentId, label: profiles.get(agentId) ?? agentId }))
			.sort(byLabel);
	}
	return { choices, directory };
}

export interface ApiAuditOptions extends Partial<AuditApiSourceOptions>, AuditListSources {
	/** Whether the console has its vault page, which vault rows link to. Default true; without it they stay unlinked. */
	readonly vaultPage?: boolean;
}

/**
 * The audit log on the gateway this console is served by (`source=api`). Same-origin, like the session API: behind
 * Cloudflare Access the browser's cookie signs each call in, so no credential is sent. With no identity read of
 * organisations or members yet, the log is the caller's own organisation's and rows name people by ID. The credentials
 * to filter by, and their names, come from the log's own `vault.item.created` events; the projects, agents and
 * sessions from the lists the options give (`auditLookups`), read each time the log opens. Rows link to the session
 * they came from, at the turn when the event names one, and vault requests, approvals and denials to the vault page.
 */
export function apiAudit(options: ApiAuditOptions = {}): ConsoleAudit {
	const { projects, sessions, agents, vaultPage = true, ...sourceOptions } = options;
	const source = auditApiSource({ baseUrl: "", ...sourceOptions });
	const lists: AuditListSources = {
		...(projects === undefined ? {} : { projects }),
		...(sessions === undefined ? {} : { sessions }),
		...(agents === undefined ? {} : { agents }),
	};
	return {
		source,
		directory: {},
		links: {
			// Session pages sit under their project; an event that names none stays unlinked.
			session: (sessionId, turn, projectId) =>
				projectId === undefined ? undefined : sessionTurnPath(projectId, sessionId, turn),
			// The console's own vault page opens any request the viewer may see, and says so when they may not.
			...(vaultPage ? { proposal: (proposalId: string) => vaultRequestPath(proposalId) } : {}),
		},
		choices: {},
		credentials: () => credentialChoices(source),
		...(projects === undefined && sessions === undefined && agents === undefined
			? {}
			: { lookups: () => auditLookups(lists) }),
		pollMs: 10_000,
	};
}
