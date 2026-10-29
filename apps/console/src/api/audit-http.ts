// The audit log's source over the audit query API (M1-BE8, `@harbour/audit/http`), for when the console talks to a
// real Harbour. The organisation the view asks for becomes the `Harbour-Organisation` header, as the API takes it for
// a human; the server checks the caller belongs to it and answers `forbidden` if not.

import { type AuditClientOptions, createAuditClient } from "@harbour/audit/http";
import {
	type AgentProfile,
	ORGANISATION_HEADER,
	type Page,
	type Project,
	type SessionRecord,
} from "@harbour/contracts";
import { type AuditSource, type Choice, credentialChoices } from "@harbour/ui";
import { sessionTurnPath, vaultRequestPath } from "../app/router.ts";
import type { AuditScope, ConsoleAudit } from "./oversight.ts";

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

const byLabel = (a: Choice, b: Choice) => a.label.localeCompare(b.label, "en-GB") || a.value.localeCompare(b.value);

/**
 * The projects, agents and sessions to filter the log by, from the session API on the same origin: `GET /v1/projects`,
 * `GET /v1/sessions` and `GET /v1/profiles`, every page. Agents are the ones the caller's sessions ran, named by their
 * profile when the caller may read it; sessions come most recently active first, by title. Rejects when the projects
 * or sessions can't be read.
 */
export async function readAuditScope(options: Partial<AuditApiSourceOptions> = {}): Promise<AuditScope> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const every = async <T>(route: string): Promise<T[]> => {
		const items: T[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ limit: "200" });
			if (cursor !== undefined) query.set("cursor", cursor);
			const response = await doFetch(`${options.baseUrl ?? ""}/v1/${route}?${query}`, {
				headers: { accept: "application/json", ...((await options.headers?.()) ?? {}) },
			});
			if (!response.ok) throw new Error(`GET /v1/${route} answered ${response.status}`);
			const page = (await response.json()) as Page<T>;
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return items;
	};
	const [projects, sessions, profiles] = await Promise.all([
		every<Project>("projects"),
		every<SessionRecord>("sessions"),
		// Names only: a caller who may not list profiles still filters by agent, by ID.
		every<AgentProfile>("profiles").catch((): AgentProfile[] => []),
	]);
	const profileName = new Map(profiles.map((profile) => [profile.id, profile.name]));
	const agents = new Map<string, string>();
	for (const session of sessions) agents.set(session.agentId, profileName.get(session.agentId) ?? session.agentId);
	return {
		projects: projects.map((project) => ({ value: project.id, label: project.name })).sort(byLabel),
		agents: [...agents].map(([value, label]) => ({ value, label })).sort(byLabel),
		sessions: [...sessions]
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
			.map((session) => ({ value: session.id, label: session.title ?? `Untitled session ${session.id}` })),
	};
}

/**
 * The audit log on the gateway this console is served by (`source=api`). Same-origin, like the session API: behind
 * Cloudflare Access the browser's cookie signs each call in, so no credential is sent. With no identity API yet, there
 * is no list of organisations or people: the log is the caller's own organisation's and rows name people by ID. The
 * credentials to filter by, and their names, come from the log's own `vault.item.created` events; the projects, agents
 * and sessions from the session API (`readAuditScope`). Rows link to the session they came from, at the turn when the
 * event names one, and rows about a vault request (asked, approved, denied, withdrawn) to its page on the vault, when
 * the console has one (`vaultRequests`).
 */
export function apiAudit(
	options: Partial<AuditApiSourceOptions> & { readonly vaultRequests?: boolean } = {},
): ConsoleAudit {
	const { vaultRequests, ...sourceOptions } = options;
	const source = auditApiSource({ baseUrl: "", ...sourceOptions });
	return {
		source,
		directory: {},
		links: {
			// Session pages sit under their project; an event that names none stays unlinked.
			session: (sessionId, turn, projectId) =>
				projectId === undefined ? undefined : sessionTurnPath(projectId, sessionId, turn),
			...(vaultRequests === true ? { proposal: vaultRequestPath } : {}),
		},
		choices: {},
		credentials: () => credentialChoices(source),
		scope: () => readAuditScope(sourceOptions),
		pollMs: 10_000,
	};
}
