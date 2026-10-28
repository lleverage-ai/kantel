// The audit view's logic, apart from React: what the filters mean as an `AuditQuery` (the credential included, as the
// store's `itemId`), how each event reads as one line, where it links, and JSONL export.

import type { Actor, AuditEvent, AuditQuery, JsonValue, Page, PageRequest } from "@harbour/contracts";
import { DAY, HOUR } from "../primitives/format.ts";
import type { BadgeTone } from "../primitives/status.tsx";

/**
 * A query as the view asks it: the store's `AuditQuery`, plus the organisation to read. The store takes the
 * organisation from the call context, never the query, so the host reads `organisationId`, binds its context to that
 * organisation (when the viewer belongs to it) and passes the rest on. Absent means the host's current organisation.
 */
export type AuditViewQuery = AuditQuery & { readonly organisationId?: string };

/**
 * Where the view reads events: the audit store's `query`, bound to the viewer's call context by the host. Agents
 * can't read the audit log, so the host only builds one for a person or the system.
 */
export interface AuditSource {
	query(query: AuditViewQuery, page?: PageRequest): Promise<Page<AuditEvent>>;
}

/** The kinds of event the view filters by. Each is one type, or one type prefix, which is all `AuditQuery` takes. */
export type AuditKind =
	| "all"
	| "credential-use"
	| "approval"
	| "vault"
	| "policy"
	| "sandbox"
	| "session"
	| "access"
	| "browser"
	| "identity"
	| "capability";

export const KINDS: readonly { value: AuditKind; label: string; type?: string }[] = [
	{ value: "all", label: "Everything" },
	{ value: "credential-use", label: "Credential uses", type: "vault.use." },
	{ value: "approval", label: "Approvals and denials", type: "vault.decision." },
	{ value: "vault", label: "All vault events", type: "vault." },
	{ value: "policy", label: "Policy changes", type: "vault.policy." },
	{ value: "sandbox", label: "Sandbox", type: "sandbox." },
	{ value: "session", label: "Session lifecycle", type: "session." },
	{ value: "access", label: "Refused access", type: "access.denied" },
	{ value: "browser", label: "Browser", type: "browser." },
	{ value: "identity", label: "Keys and roles", type: "identity." },
	{ value: "capability", label: "Capabilities", type: "capability." },
];

export type AuditRange = "hour" | "day" | "today" | "yesterday" | "week" | "month" | "all";

export const RANGES: readonly { value: AuditRange; label: string }[] = [
	{ value: "hour", label: "Last hour" },
	{ value: "day", label: "Last 24 hours" },
	{ value: "today", label: "Today" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "week", label: "Last 7 days" },
	{ value: "month", label: "Last 30 days" },
	{ value: "all", label: "All time" },
];

/** The view's filters. Empty strings and absent fields mean "any". */
export interface AuditFilters {
	readonly range: AuditRange;
	/** The organisation to read; the host's current one when absent. */
	readonly organisationId?: string;
	readonly kind: AuditKind;
	/** An actor key from `actorKey`. */
	readonly actor?: string;
	readonly projectId?: string;
	readonly agentId?: string;
	readonly sessionId?: string;
	/** A vault item ID, matched by the store as `AuditQuery.itemId`: its uses, requests, approvals and policies. */
	readonly credential?: string;
}

export const DEFAULT_FILTERS: AuditFilters = { range: "day", kind: "all" };

const startOfDay = (at: number) => {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
};

/** A range's bounds as of `now`, in the viewer's local days: `from` inclusive, `to` exclusive. */
export function rangeBounds(range: AuditRange, now: number): { from?: number; to?: number } {
	switch (range) {
		case "hour":
			return { from: now - HOUR };
		case "day":
			return { from: now - DAY };
		case "today":
			return { from: startOfDay(now) };
		case "yesterday": {
			const today = startOfDay(now);
			// The day before today, by the calendar: 23 or 25 hours across a clock change.
			return { from: startOfDay(today - HOUR), to: today };
		}
		case "week":
			return { from: now - 7 * DAY };
		case "month":
			return { from: now - 30 * DAY };
		case "all":
			return {};
	}
}

/** A stable string for an actor, for a select's value and for grouping. */
export function actorKey(actor: Actor): string {
	switch (actor.kind) {
		case "human":
			return `human:${actor.userId}`;
		case "agent":
			return `agent:${actor.agentId}:${actor.sessionId}`;
		case "service":
			return `service:${actor.serviceId}`;
		case "system":
			return `system:${actor.component}`;
	}
}

/** The actor an `actorKey` names, as `AuditQuery.actor` takes it. */
export function actorFromKey(key: string): Actor | undefined {
	const [kind, first, second] = key.split(":");
	if (first === undefined || first === "") return undefined;
	switch (kind) {
		case "human":
			return { kind, userId: first };
		case "agent":
			return second === undefined ? undefined : { kind, agentId: first, sessionId: second };
		case "service":
			return { kind, serviceId: first };
		case "system":
			return { kind, component: first };
		default:
			return undefined;
	}
}

const set = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The filters as the store's query, newest first. */
export function toQuery(filters: AuditFilters, now: number): AuditViewQuery {
	const type = KINDS.find((kind) => kind.value === filters.kind)?.type;
	const actor = set(filters.actor) ? actorFromKey(filters.actor) : undefined;
	const { from, to } = rangeBounds(filters.range, now);
	return {
		newestFirst: true,
		...(set(filters.organisationId) ? { organisationId: filters.organisationId } : {}),
		...(type === undefined ? {} : { type }),
		...(actor === undefined ? {} : { actor }),
		...(set(filters.projectId) ? { projectId: filters.projectId } : {}),
		...(set(filters.agentId) ? { agentId: filters.agentId } : {}),
		...(set(filters.sessionId) ? { sessionId: filters.sessionId } : {}),
		...(set(filters.credential) ? { itemId: filters.credential } : {}),
		...(from === undefined ? {} : { from }),
		...(to === undefined ? {} : { to }),
	};
}

/**
 * The vault item an event is about, as the store's `itemId` filter matches it: its subject when that is a `vault.item`
 * (a new item), or else `data.itemId` (uses, proposals, approvals and policies).
 */
export function eventItemId(event: AuditEvent): string | undefined {
	if (event.subject?.kind === "vault.item") return event.subject.id;
	const itemId = event.data?.itemId;
	return typeof itemId === "string" ? itemId : undefined;
}

/** Whether any filter narrows the log, for the "Clear filters" action and the empty state's copy. */
export function isFiltered(filters: AuditFilters): boolean {
	return (
		filters.kind !== "all" ||
		set(filters.actor) ||
		set(filters.projectId) ||
		set(filters.agentId) ||
		set(filters.sessionId) ||
		set(filters.credential)
	);
}

/**
 * Names for the IDs in events, from identity, the session directory and the vault. Each may return undefined for an
 * ID it doesn't know (a deleted session, a removed item); the view shows the ID then.
 */
export interface AuditDirectory {
	person?(userId: string): string | undefined;
	agent?(agentId: string): string | undefined;
	session?(sessionId: string): string | undefined;
	project?(projectId: string): string | undefined;
	item?(itemId: string): string | undefined;
}

/** Where rows link. Absent builders, and undefined from one (a record the host can't open), leave rows unlinked. */
export interface AuditLinks {
	/**
	 * A session, at the turn an event came from when the event names one (a `session.submission` or `session.tool`
	 * subject), with the project the event names, for a host whose session pages sit under their project.
	 */
	session?(sessionId: string, turn?: string, projectId?: string): string | undefined;
	/** The vault page for a proposal (its decision lives there too). */
	proposal?(proposalId: string): string | undefined;
}

export function actorName(actor: Actor, directory: AuditDirectory = {}): string {
	switch (actor.kind) {
		case "human":
			return directory.person?.(actor.userId) ?? actor.userId;
		case "agent":
			return directory.agent?.(actor.agentId) ?? actor.agentId;
		case "service":
			return actor.serviceId;
		case "system":
			return `Harbour ${actor.component}`;
	}
}

export interface EventLine {
	/** What happened, as a sentence without its actor: "approved Linear API key for api.linear.app". */
	readonly action: string;
	readonly tone: BadgeTone;
	/** The kind label for the row's badge. */
	readonly label: string;
	readonly link?: { readonly href: string; readonly label: string };
}

const text = (value: JsonValue | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const isRecord = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const routeText = (route: JsonValue | undefined): string | undefined => {
	if (!isRecord(route)) return undefined;
	const host = text(route.host);
	const path = text(route.pathPrefix);
	const listed = route.methods;
	const methods = Array.isArray(listed) ? listed.filter((method) => typeof method === "string").join(", ") : "";
	if (host === undefined) return undefined;
	return `${methods === "" ? "" : `${methods} `}${host}${path === undefined || path === "/" ? "" : path}`;
};

/** One line for an event: what happened, how it should read, and where it links. */
export function describeEvent(event: AuditEvent, directory: AuditDirectory = {}, links: AuditLinks = {}): EventLine {
	const data = event.data ?? {};
	const itemId = eventItemId(event);
	const item = itemId === undefined ? "a credential" : (directory.item?.(itemId) ?? itemId);
	const turn =
		event.subject?.kind === "session.submission" || event.subject?.kind === "session.tool"
			? event.subject.id
			: undefined;
	const sessionHref =
		event.sessionId === undefined ? undefined : links.session?.(event.sessionId, turn, event.projectId);
	const sessionLink =
		sessionHref === undefined || event.sessionId === undefined
			? undefined
			: { href: sessionHref, label: directory.session?.(event.sessionId) ?? event.sessionId };
	const proposalHref = event.subject?.kind === "vault.proposal" ? links.proposal?.(event.subject.id) : undefined;
	const proposalLink = proposalHref === undefined ? undefined : { href: proposalHref, label: "Vault request" };
	const withLink = (line: Omit<EventLine, "link">, link = proposalLink ?? sessionLink): EventLine =>
		link === undefined ? line : { ...line, link };

	switch (event.type) {
		case "vault.use.injected": {
			const target = `${text(data.method) ?? ""} ${text(data.host) ?? ""}${text(data.path) ?? ""}`.trim();
			return withLink({ action: `used ${item}: ${target}`, tone: "working", label: "Credential use" }, sessionLink);
		}
		case "vault.use.denied":
			return withLink(
				{
					action: `was refused ${item} for ${text(data.method) ?? ""} ${text(data.host) ?? ""}${text(data.path) ?? ""}${text(data.reason) === undefined ? "" : `: ${text(data.reason)}`}`,
					tone: "error",
					label: "Use refused",
				},
				sessionLink,
			);
		case "vault.proposal.created":
			return withLink({
				action: `asked for ${item}${routeText(data.route) === undefined ? "" : ` (${routeText(data.route)})`}`,
				tone: "approval",
				label: "Vault request",
			});
		case "vault.proposal.withdrawn":
			return withLink({ action: "withdrew a vault request", tone: "idle", label: "Withdrawn" });
		case "vault.decision.approved":
			return withLink({
				action: `approved ${item}${routeText(data.route) === undefined ? "" : ` for ${routeText(data.route)}`}`,
				tone: "done",
				label: "Approved",
			});
		case "vault.decision.denied":
			return withLink({ action: "denied a vault request", tone: "error", label: "Denied" });
		case "vault.binding_code.mismatch":
			return withLink({
				action: `picked the wrong binding code${text(data.pickedCode) === undefined ? "" : ` (${text(data.pickedCode)})`}; nothing was approved`,
				tone: "error",
				label: "Wrong code",
			});
		case "vault.grant.revoked":
			return withLink({
				action: `stopped a grant${text(data.reason) === undefined ? "" : `: ${text(data.reason)}`}`,
				tone: "idle",
				label: "Grant stopped",
			});
		case "vault.item.created":
			return withLink({ action: `added ${item} to the vault`, tone: "accent", label: "Credential" });
		case "vault.policy.created":
			return withLink({ action: "added a standing vault policy", tone: "accent", label: "Policy" });
		case "vault.policy.revoked":
			return withLink({ action: "removed a standing vault policy", tone: "idle", label: "Policy" });
		case "access.denied":
			return withLink({
				action: `was refused ${text(data.operation) ?? event.subject?.kind ?? "access"}`,
				tone: "error",
				label: "Refused",
			});
		case "sandbox.escalated":
			return withLink({ action: "escalated the sandbox", tone: "approval", label: "Sandbox" });
		case "session.created":
			return withLink({ action: "started the session", tone: "neutral", label: "Session" });
		case "session.prompted":
			return withLink({ action: "prompted the agent", tone: "neutral", label: "Prompt" });
		case "session.steered":
			return withLink({ action: "steered the agent", tone: "neutral", label: "Steer" });
		case "session.aborted":
			return withLink({ action: "stopped the session", tone: "idle", label: "Stopped" });
		case "session.settled":
			return withLink({ action: "finished the turn", tone: "done", label: "Settled" });
		case "session.tool.started":
			return withLink({ action: `ran ${text(data.tool) ?? "a tool"}`, tone: "working", label: "Tool" });
		case "session.tool.finished":
			return withLink({
				action: `finished ${text(data.tool) ?? "a tool"}${text(data.outcome) === undefined ? "" : ` (${text(data.outcome)})`}`,
				tone: text(data.outcome) === "error" ? "error" : "neutral",
				label: "Tool",
			});
		default: {
			// Readable from the type alone: "browser.session.opened" reads "browser session opened".
			const words = event.type.split(".").join(" ").replace(/_/g, " ");
			return withLink({ action: words, tone: "neutral", label: event.source });
		}
	}
}

/** The events as JSON Lines, one stored event per line, exactly as the store returned it. */
export function toJsonl(events: readonly AuditEvent[]): string {
	return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A file name for an export: `harbour-audit-<from>-<to>.jsonl`, in UTC dates. */
export function exportName(filters: AuditFilters, now: number): string {
	const { from, to } = rangeBounds(filters.range, now);
	const day = (at: number) => new Date(at).toISOString().slice(0, 10);
	return `harbour-audit-${from === undefined ? "start" : day(from)}-to-${day(to ?? now)}.jsonl`;
}

/**
 * The vault items an organisation's log names, from their `vault.item.created` events, as the credential filter's
 * choices: each item once, labelled with its name (its ID when the event has none), sorted by label. For a host with no
 * vault API to list items from, such as the console on the gateway; the same list names items in rows.
 */
export async function credentialChoices(
	source: AuditSource,
	options: { organisationId?: string; signal?: AbortSignal } = {},
): Promise<{ readonly value: string; readonly label: string }[]> {
	const names = new Map<string, string>();
	for await (const page of readAll(
		source,
		{
			type: "vault.item.created",
			newestFirst: true,
			...(options.organisationId === undefined ? {} : { organisationId: options.organisationId }),
		},
		options.signal === undefined ? {} : { signal: options.signal },
	)) {
		for (const event of page) {
			const itemId = eventItemId(event);
			// Newest first: an item created again (a pasted secret for a requested one) keeps its latest name.
			if (itemId !== undefined && !names.has(itemId)) names.set(itemId, text(event.data?.name) ?? itemId);
		}
	}
	return [...names]
		.map(([value, label]) => ({ value, label }))
		.sort((a, b) => a.label.localeCompare(b.label, "en-GB") || a.value.localeCompare(b.value));
}

/**
 * Reads every page the query matches, oldest first is not assumed: pages come in the query's order. Stops early when
 * `signal` aborts.
 */
export async function* readAll(
	source: AuditSource,
	query: AuditViewQuery,
	options: { pageSize?: number; signal?: AbortSignal } = {},
): AsyncGenerator<AuditEvent[], void, void> {
	let cursor: string | undefined;
	const cancelled = () => options.signal?.aborted === true;
	do {
		if (cancelled()) return;
		const page = await source.query(query, {
			limit: options.pageSize ?? 500,
			...(cursor === undefined ? {} : { cursor }),
		});
		if (cancelled()) return;
		yield [...page.items];
		cursor = page.nextCursor;
	} while (cursor !== undefined);
}
