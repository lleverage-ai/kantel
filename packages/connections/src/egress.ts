/**
 * The sandbox egress gate over the connections service (#331), as both targets wire it into their isolates: the
 * session's record is read at each request (so a change to its visibility counts at once), turned into the scope the
 * connection tools use, and the request put to `ConnectionsService.sandboxEgress`.
 */
import {
	type SandboxEgress,
	type SessionAudience,
	type SessionDirectory,
	type SessionRecord,
	sessionAudienceOf,
	systemContext,
} from "@kantel/contracts";
import type { ConnectionsService } from "./service.ts";
import { sessionScope } from "./tools.ts";

const SELF = systemContext("connections");

export interface ConnectionsEgressOptions {
	readonly connections: ConnectionsService | (() => ConnectionsService | undefined);
	readonly sessions: Pick<SessionDirectory, "get"> | (() => Pick<SessionDirectory, "get"> | undefined);
	/** A personal deployment: every session with a person is theirs alone (#335). */
	readonly personal?: boolean;
	readonly audienceOf?: (record: SessionRecord) => SessionAudience;
}

export function connectionsEgress(options: ConnectionsEgressOptions): SandboxEgress {
	const audienceOf = options.audienceOf ?? ((record: SessionRecord) => sessionAudienceOf(record, options.personal));
	return {
		async decide(ctx, sessionId, request) {
			const connections = typeof options.connections === "function" ? options.connections() : options.connections;
			const sessions = typeof options.sessions === "function" ? options.sessions() : options.sessions;
			// Built after the sandboxes and not there yet: no connection can be in the request, but a raw secret still
			// can't be checked, so nothing goes out rather than unchecked.
			if (connections === undefined || sessions === undefined) throw new Error("connections are not ready");
			const record = await sessions.get({ actor: SELF.actor, organisationId: ctx.organisationId }, sessionId);
			return connections.sandboxEgress(SELF, sessionScope(record, audienceOf(record)), request);
		},
	};
}
