// The audit log's source over the audit query API (M1-BE8, `@harbour/audit/http`), for when the console talks to a
// real Harbour. The organisation the view asks for becomes the `Harbour-Organisation` header, as the API takes it for
// a human; the server checks the caller belongs to it and answers `forbidden` if not.

import { type AuditClientOptions, createAuditClient } from "@harbour/audit/http";
import { ORGANISATION_HEADER } from "@harbour/contracts";
import type { AuditSource } from "@harbour/ui";
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
					return organisationId === undefined ? base : { ...base, [ORGANISATION_HEADER]: organisationId };
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
 * is no list of organisations or names: the log is the caller's own organisation's, rows name people and items by id,
 * and only the filters' free choices apply.
 */
export function apiAudit(options: Partial<AuditApiSourceOptions> = {}): ConsoleAudit {
	return {
		source: auditApiSource({ baseUrl: "", ...options }),
		directory: {},
		links: {},
		choices: {},
		pollMs: 10_000,
	};
}
