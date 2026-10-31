/**
 * Placeholder-gated injection (#331): how a connection's credential gets into a request a sandbox sends itself, such as
 * `curl -H "Authorization: Bearer $GITHUB" https://api.github.com/user`, without the sandbox ever holding it.
 *
 * - **Placeholders.** Every connection with a credential (OAuth or key) has one placeholder, `kantel-conn-ph-` and 32
 *   random hex digits, made once and kept for the connection's life. It is never derived from the value. A session gets
 *   it from `connections_list`, never the value.
 * - **The gate.** The sandbox's egress (`SandboxEgress`) asks the connections service about every outbound request. The
 *   credential goes in only when all of these hold: the request carries the placeholder of a connection the session
 *   may use, the host is one of that connection's hosts, it is https, and the connection's rules let it out (`ask`
 *   waits for a person, as for `connection_request`). A request with no placeholder goes out with no credential.
 * - **Where.** A placeholder is replaced in any header, the path and the query. In a JSON or form body (up to
 *   `EGRESS_BODY_LIMIT`) only where the connection's template allows it (`ProviderTemplate.placeholdersInBody`), since a
 *   body is often content the service publishes. A header that is the placeholder alone, where the connection's
 *   credential goes (`Authorization` for OAuth), gets the standard form (`Bearer <token>`).
 * - **Refusals** are an HTTP 403 whose JSON body is an `EgressRefusal` (schema `EGRESS_REFUSAL_SCHEMA`, also the API's
 *   `EgressRefusal` component). A placeholder sent to a host outside its connection's is `host_not_bound`, not sent on
 *   as text; a request carrying a stored secret itself is `raw_secret`. Both are audited as a denied use of the
 *   connection.
 * - **Responses**: anything of the credential the upstream echoes back is redacted before the sandbox sees it.
 */
import type { CallContext, SessionId } from "./common.ts";

/** One connection placeholder, anywhere in a request. Keep in step with `newConnectionPlaceholder`. */
export const CONNECTION_PLACEHOLDER_PATTERN = /kantel-conn-ph-[0-9a-f]{32}/;
export const CONNECTION_PLACEHOLDER_PREFIX = "kantel-conn-ph-";

/** The most of a body the gate reads, for placeholders and for raw secrets. A longer body is sent as it is. */
export const EGRESS_BODY_LIMIT = 64 * 1024;

/** One request a sandbox sends, as its egress saw it. */
export interface SandboxEgressRequest {
	readonly method: string;
	/** Absolute. */
	readonly url: string;
	/** Lower-case names. */
	readonly headers: { readonly [name: string]: string };
	readonly body?: Uint8Array;
}

/** An upstream's answer to a request the gate sent with a credential, the credential cut out of it. */
export interface SandboxEgressResponse {
	readonly status: number;
	readonly statusText?: string;
	/** Lower-case names, `set-cookie` dropped. */
	readonly headers: { readonly [name: string]: string };
	readonly body: Uint8Array;
	/** The body was cut at `EGRESS_RESPONSE_LIMIT`. */
	readonly truncated?: boolean;
}

/** The most of an answer to a request with a credential the gate reads and gives back. */
export const EGRESS_RESPONSE_LIMIT = 10 * 1024 * 1024;

/**
 * What the gate decided:
 * - `pass`: nothing of a connection's in it; it goes out as it is, with no credential.
 * - `respond`: a connection's placeholder was replaced with its credential and the gate sent it (never following a
 *   redirect); this is the answer, with the credential cut out.
 * - `refuse`: nothing went out; the sandbox gets an HTTP 403 with `refusal` as its JSON body.
 */
export type SandboxEgressVerdict =
	| { readonly outcome: "pass" }
	| { readonly outcome: "respond"; readonly connectionId: string; readonly response: SandboxEgressResponse }
	| { readonly outcome: "refuse"; readonly status: 403; readonly refusal: EgressRefusal };

/** A session's sandbox egress: every outbound request is put to it before it leaves. */
export interface SandboxEgress {
	decide(ctx: CallContext, sessionId: SessionId, request: SandboxEgressRequest): Promise<SandboxEgressVerdict>;
}

/**
 * Why a request was refused, as `error` says it:
 * - `host_not_bound`: a placeholder sent to a host outside its connection's hosts.
 * - `raw_secret`: the request carries a stored secret itself rather than its placeholder.
 * - `not_https`: a placeholder over plain http.
 * - `unknown_placeholder`: a placeholder no connection in the organisation has (removed, or made up).
 * - `placeholder_conflict`: placeholders of more than one connection in one request.
 * - `placeholder_in_body`: a placeholder in a body, where the connection's template doesn't allow one.
 * - `connection_not_usable`: the session may not use the connection (its usage, visibility or owner).
 * - `needs_reauth`: the connection must be connected again.
 * - `denied`: the connection's rules or the organisation's ceiling refuse it.
 * - `approval_pending`: a rule asks for a person to approve this exact request; send it again once approved.
 * - `unavailable`: the gate could not decide, so nothing went out.
 */
export const EGRESS_REFUSAL_CODES = [
	"host_not_bound",
	"raw_secret",
	"not_https",
	"unknown_placeholder",
	"placeholder_conflict",
	"placeholder_in_body",
	"connection_not_usable",
	"needs_reauth",
	"denied",
	"approval_pending",
	"unavailable",
] as const;
export type EgressRefusalCode = (typeof EGRESS_REFUSAL_CODES)[number];

/** What would make the request go through, where something would. */
export const EGRESS_FIX_ACTIONS = [
	"use_placeholder",
	"use_bound_host",
	"use_https",
	"move_placeholder",
	"request_connection",
	"reconnect",
	"wait_for_approval",
] as const;
export type EgressFixAction = (typeof EGRESS_FIX_ACTIONS)[number];

export interface EgressRefusal {
	readonly error: EgressRefusalCode;
	/** One sentence, for the agent and the person reading its transcript. Never a secret. */
	readonly message: string;
	readonly fix?: {
		readonly action: EgressFixAction;
		readonly message: string;
		/** A page for a person, such as the connection request page. */
		readonly link?: string;
	};
	/** The connection it was about, where the session may know it. */
	readonly connectionId?: string;
	/** For `approval_pending`: the approval to wait on. */
	readonly approval?: {
		readonly id: string;
		readonly digest: string;
		readonly link: string;
		readonly bindingCode: string;
		readonly expiresAt: number;
	};
}

/** The published schema of a refusal's body (JSON Schema 2020-12), the same as the API's `EgressRefusal` component. */
export const EGRESS_REFUSAL_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://kantel.dev/schemas/egress-refusal.json",
	title: "EgressRefusal",
	description: "The JSON body of a 403 the sandbox egress answers when it refuses a request (#331).",
	type: "object",
	required: ["error", "message"],
	additionalProperties: false,
	properties: {
		error: { type: "string", enum: [...EGRESS_REFUSAL_CODES] },
		message: { type: "string", minLength: 1 },
		fix: {
			type: "object",
			required: ["action", "message"],
			additionalProperties: false,
			properties: {
				action: { type: "string", enum: [...EGRESS_FIX_ACTIONS] },
				message: { type: "string", minLength: 1 },
				link: { type: "string" },
			},
		},
		connectionId: { type: "string" },
		approval: {
			type: "object",
			required: ["id", "digest", "link", "bindingCode", "expiresAt"],
			additionalProperties: false,
			properties: {
				id: { type: "string" },
				digest: { type: "string" },
				link: { type: "string" },
				bindingCode: { type: "string" },
				expiresAt: { type: "integer" },
			},
		},
	},
} as const;

/** A refusal as the sandbox gets it: an HTTP 403 with the refusal as JSON. */
export function egressRefusalResponse(refusal: EgressRefusal): {
	readonly status: 403;
	readonly headers: { readonly [name: string]: string };
	readonly body: string;
} {
	return {
		status: 403,
		headers: { "content-type": "application/json; charset=utf-8", "x-kantel-egress": refusal.error },
		body: JSON.stringify(refusal),
	};
}
