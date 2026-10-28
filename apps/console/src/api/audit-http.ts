// The audit log's source over the audit query API (M1-BE8, `@harbour/audit/http`), for when the console talks to a
// real Harbour. The organisation the view asks for becomes the `Harbour-Organisation` header, as the API takes it for
// a human; the server checks the caller belongs to it and answers `forbidden` if not.

import { type AuditClientOptions, createAuditClient } from "@harbour/audit/http";
import { ORGANISATION_HEADER } from "@harbour/contracts";
import { type AuditSource, credentialChoices } from "@harbour/ui";
import { sessionTurnPath } from "../app/router.ts";
import type { ConsoleAudit } from "./oversight.ts";

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

/**
 * The audit log on the gateway this console is served by (`source=api`). Same-origin, like the session API: behind
 * Cloudflare Access the browser's cookie signs each call in, so no credential is sent. With no identity API yet, there
 * is no list of organisations or people: the log is the caller's own organisation's and rows name people by ID. The
 * credentials to filter by, and their names, come from the log's own `vault.item.created` events. Rows link to the
 * session they came from, at the turn when the event names one.
 */
export function apiAudit(options: Partial<AuditApiSourceOptions> = {}): ConsoleAudit {
	const source = auditApiSource({ baseUrl: "", ...options });
	return {
		source,
		directory: {},
		links: {
			// Session pages sit under their project; an event that names none stays unlinked.
			session: (sessionId, turn, projectId) =>
				projectId === undefined ? undefined : sessionTurnPath(projectId, sessionId, turn),
		},
		choices: {},
		credentials: () => credentialChoices(source),
		pollMs: 10_000,
	};
}
