// The audit view's logic, apart from React: what the filters mean as an `AuditQuery` (the credential included, as the
// store's `itemId`), how each event reads as one line, where it links, and JSONL export.

import {
	type Actor,
	type AuditEvent,
	type AuditQuery,
	currentAuditType,
	type JsonValue,
	type Page,
	type PageRequest,
} from "@kantel/contracts";
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

/**
 * The kinds of event the view filters by. Each is a list of types and type prefixes: one goes to the store as
 * `AuditQuery.type`, several as `types`, any of which matches.
 */
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

export const KINDS: readonly { value: AuditKind; label: string; types?: readonly string[] }[] = [
	{ value: "all", label: "Everything" },
	// Each Connections kind names both the types stored before #324 (`vault.*`) and the ones written since
	// (`connections.*`), so the view shows old and new rows together.
	{ value: "credential-use", label: "Credential uses", types: ["vault.use.", "connections.egress."] },
	// With the uses a rule held for a person's approval (#333).
	{
		value: "approval",
		label: "Approvals and denials",
		types: ["vault.decision.", "connections.decision.", "connections.use.held"],
	},
	{ value: "vault", label: "All connection events", types: ["vault.", "connections."] },
	// Standing connection policies, and the capability grants that say what an agent may call.
	{
		value: "policy",
		label: "Policy changes",
		types: ["vault.policy.", "connections.policy.", "capability.grant."],
	},
	{ value: "sandbox", label: "Sandbox", types: ["sandbox."] },
	{ value: "session", label: "Session lifecycle", types: ["session."] },
	{ value: "access", label: "Refused access", types: ["access.denied"] },
	{ value: "browser", label: "Browser", types: ["browser."] },
	{ value: "identity", label: "Keys and roles", types: ["identity."] },
	{ value: "capability", label: "Capabilities", types: ["capability."] },
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
	/**
	 * A browser session ID, matched by the store as the events' subject: one browser's whole history (open, steps,
	 * refusals, shares and embeds, close, recording).
	 */
	readonly browserSession?: string;
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
	const types = KINDS.find((kind) => kind.value === filters.kind)?.types ?? [];
	const [type] = types;
	const actor = set(filters.actor) ? actorFromKey(filters.actor) : undefined;
	const { from, to } = rangeBounds(filters.range, now);
	return {
		newestFirst: true,
		...(set(filters.organisationId) ? { organisationId: filters.organisationId } : {}),
		...(types.length > 1 ? { types } : type === undefined ? {} : { type }),
		...(actor === undefined ? {} : { actor }),
		...(set(filters.projectId) ? { projectId: filters.projectId } : {}),
		...(set(filters.agentId) ? { agentId: filters.agentId } : {}),
		...(set(filters.sessionId) ? { sessionId: filters.sessionId } : {}),
		...(set(filters.credential) ? { itemId: filters.credential } : {}),
		...(set(filters.browserSession) ? { subject: { kind: BROWSER_SUBJECT, id: filters.browserSession } } : {}),
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

/** The subject kind of every event about one browser session. */
export const BROWSER_SUBJECT = "browser.session";

/** The browser session an event is about, when its subject is one. */
export function eventBrowserSession(event: AuditEvent): string | undefined {
	return event.subject?.kind === BROWSER_SUBJECT ? event.subject.id : undefined;
}

/** Whether any filter narrows the log, for the "Clear filters" action and the empty state's copy. */
export function isFiltered(filters: AuditFilters): boolean {
	return (
		filters.kind !== "all" ||
		set(filters.actor) ||
		set(filters.projectId) ||
		set(filters.agentId) ||
		set(filters.sessionId) ||
		set(filters.credential) ||
		set(filters.browserSession)
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
	/** A session at one of its browsers, where its live view or replay is, for an event about that browser. */
	browser?(sessionId: string, browserSessionId: string, projectId?: string): string | undefined;
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
			return `Kantel ${actor.component}`;
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

/** Whose a new connection is, after its name: a person's own, a project's or the organisation's. */
const ownerText = (owner: string | undefined): string =>
	owner === "user"
		? " for themselves"
		: owner === "project"
			? " for a project"
			: owner === "organisation"
				? " for the organisation"
				: "";

/**
 * What a connection's secret was opened for (#483). A row stored before the vault recorded the request reads
 * `POST <host>/` whatever it was, so its purpose (`connection conn_1: GET api.example.com/headers`, `…: revoke`) says it
 * instead.
 */
const secretOpenTarget = (data: { readonly [key: string]: JsonValue }): string => {
	const recorded = `${text(data.method) ?? ""} ${text(data.host) ?? ""}${text(data.path) ?? ""}`.trim();
	const purpose = text(data.connectionPurpose)?.replace(/^connection [^:]+: /, "");
	if (purpose === undefined || purpose === "") return recorded;
	if (data.path !== "/" || data.method !== "POST") return recorded;
	// "GET host/path" and "egress GET host/path" are the request; anything else ("refresh", "tools/call echo") is why.
	const request = /^(?:egress )?([A-Z]+ \S+)$/.exec(purpose)?.[1];
	return request ?? `${text(data.host) ?? "a host"}, to ${purpose}`;
};

/** What a connection use was for: "call echo on example.com", or "POST api.github.com/repos/a/b/issues". */
const connectionTarget = (data: { readonly [key: string]: JsonValue }): string => {
	const host = text(data.host) ?? "a connection";
	const tool = text(data.tool);
	if (tool !== undefined) return `call ${tool} on ${host}`;
	return `${text(data.method) ?? ""} ${host}${text(data.path) ?? ""}`.trim();
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
	const proposalLink = proposalHref === undefined ? undefined : { href: proposalHref, label: "Connection request" };
	const browserSession = eventBrowserSession(event);
	const browserHref =
		browserSession === undefined || event.sessionId === undefined
			? undefined
			: links.browser?.(event.sessionId, browserSession, event.projectId);
	const browserLink = browserHref === undefined ? undefined : { href: browserHref, label: "Browser" };
	const withLink = (line: Omit<EventLine, "link">, link = proposalLink ?? browserLink ?? sessionLink): EventLine =>
		link === undefined ? line : { ...line, link };
	const count = (value: JsonValue | undefined) => (typeof value === "number" ? value : undefined);

	// A row stored before #324 reads as the same row written since.
	switch (currentAuditType(event.type)) {
		case "connections.egress.injected": {
			const target = secretOpenTarget(data);
			return withLink({ action: `used ${item}: ${target}`, tone: "working", label: "Credential use" }, sessionLink);
		}
		case "connections.egress.denied":
			return withLink(
				{
					action: `was refused ${item} for ${text(data.method) ?? ""} ${text(data.host) ?? ""}${text(data.path) ?? ""}${text(data.reason) === undefined ? "" : `: ${text(data.reason)}`}`,
					tone: "error",
					label: "Use refused",
				},
				sessionLink,
			);
		// The connections package's own record of a use (#335), and a use a rule held for approval (#333). A held use
		// stored before `held` existed reads `connections.use.denied` with its approval pending: it reads as held.
		case "connections.use.allowed":
			return withLink({
				action: `used a connection: ${connectionTarget(data)}`,
				tone: "working",
				label: "Connection use",
			});
		case "connections.use.held":
		case "connections.use.denied": {
			const approvalId = text(data.approvalId);
			const held = event.type === "connections.use.held" || text(data.approval) === "pending";
			if (!held) {
				const reason = text(data.reason);
				return withLink({
					action: `was refused a connection: ${connectionTarget(data)}${reason === undefined ? "" : `: ${reason}`}`,
					tone: "error",
					label: "Use refused",
				});
			}
			const requestHref = approvalId === undefined ? undefined : links.proposal?.(approvalId);
			return withLink(
				{
					action: `was held for approval, nothing sent: ${connectionTarget(data)}`,
					tone: "approval",
					label: "Held for approval",
				},
				requestHref === undefined ? undefined : { href: requestHref, label: "Connection request" },
			);
		}
		case "connections.request.created":
			return withLink({
				action: `asked for ${item}${routeText(data.route) === undefined ? "" : ` (${routeText(data.route)})`}`,
				tone: "approval",
				label: "Connection request",
			});
		case "connections.request.withdrawn":
			return withLink({ action: "withdrew a connection request", tone: "idle", label: "Withdrawn" });
		case "connections.decision.approved":
			return withLink({
				action: `approved ${item}${routeText(data.route) === undefined ? "" : ` for ${routeText(data.route)}`}`,
				tone: "done",
				label: "Approved",
			});
		case "connections.decision.denied":
			return withLink({ action: "denied a connection request", tone: "error", label: "Denied" });
		case "connections.binding_code.mismatch":
			return withLink({
				action: `picked the wrong binding code${text(data.pickedCode) === undefined ? "" : ` (${text(data.pickedCode)})`}; nothing was approved`,
				tone: "error",
				label: "Wrong code",
			});
		case "connections.grant.revoked":
			return withLink({
				action: `stopped a grant${text(data.reason) === undefined ? "" : `: ${text(data.reason)}`}`,
				tone: "idle",
				label: "Grant stopped",
			});
		// A connection made, changed and shared (#483), in words like a disconnect's.
		case "connections.connection.created":
			return withLink({
				action: `connected ${text(data.name) ?? "a connection"}${ownerText(text(data.owner))}`,
				tone: "done",
				label: "Connected",
			});
		case "connections.connection.reconnected":
			return withLink({
				action: `reconnected ${text(data.name) ?? "a connection"}`,
				tone: "done",
				label: "Reconnected",
			});
		case "connections.connection.updated":
			return withLink({
				action: `changed ${text(data.name) ?? "a connection"}'s settings`,
				tone: "neutral",
				label: "Connection changed",
			});
		case "connections.connection.rotated":
			return withLink({
				action: `replaced ${text(data.name) ?? "a connection"}'s key`,
				tone: "neutral",
				label: "Key replaced",
			});
		case "connections.connection.shared":
		case "connections.connection.unshared": {
			const projectId = text(data.project);
			const project =
				projectId === undefined ? "a project" : (directory.project?.(projectId) ?? `project ${projectId}`);
			const name = text(data.name) ?? "a connection";
			return withLink(
				event.type === "connections.connection.shared"
					? { action: `shared ${name} with ${project}`, tone: "accent", label: "Shared" }
					: { action: `stopped sharing ${name} with ${project}`, tone: "idle", label: "Sharing stopped" },
			);
		}
		// A disconnect (#329) and what the provider did with the access: a row stored before it says nothing upstream.
		case "connections.connection.removed": {
			const name = text(data.name) ?? "a connection";
			const reason = text(data.revocationReason);
			const because = reason === undefined ? "" : ` (${reason.replace(/\.$/, "")})`;
			switch (text(data.revocation)) {
				case "revoked":
					return withLink({
						action: `disconnected ${name}; the provider revoked its access`,
						tone: "done",
						label: "Disconnected",
					});
				case "unsupported":
					return withLink({
						action: `disconnected ${name}; revoking at the provider is not supported${because}`,
						tone: "idle",
						label: "Disconnected",
					});
				case "failed":
					return withLink({
						action: `disconnected ${name}, but the provider didn't revoke its access${because}`,
						tone: "error",
						label: "Revoke failed",
					});
				case "none":
					return withLink({
						action: `disconnected ${name}; it held no credential to revoke`,
						tone: "idle",
						label: "Disconnected",
					});
				default:
					return withLink({ action: `disconnected ${name}`, tone: "idle", label: "Disconnected" });
			}
		}
		// Token refresh (#328): a refresh, a failed one, and a connection a person must connect again.
		case "connections.connection.refreshed": {
			const name = text(data.name) ?? "a connection";
			return withLink(
				text(data.recovered) === undefined
					? { action: `refreshed ${name}'s token`, tone: "idle", label: "Token refreshed" }
					: { action: `refreshed ${name}'s token; it works again`, tone: "done", label: "Refresh recovered" },
			);
		}
		case "connections.connection.refresh_failed": {
			const name = text(data.name) ?? "a connection";
			const reason = text(data.reason);
			const because = reason === undefined ? "" : ` (${reason.replace(/\.$/, "")})`;
			return withLink(
				data.retryable === false
					? { action: `couldn't refresh ${name}'s token${because}`, tone: "error", label: "Refresh refused" }
					: {
							action: `couldn't refresh ${name}'s token${because}; Kantel will try again`,
							tone: "error",
							label: "Refresh failing",
						},
			);
		}
		case "connections.connection.needs_reconnect":
			return withLink({
				action: `marked ${text(data.name) ?? "a connection"} as needing someone to reconnect it`,
				tone: "error",
				label: "Reconnect needed",
			});
		case "connections.item.created":
			return withLink({ action: `added ${item} to Connections`, tone: "accent", label: "Credential" });
		case "connections.policy.created":
			return withLink({ action: "added a standing connection policy", tone: "accent", label: "Policy" });
		case "connections.policy.revoked":
			return withLink({ action: "removed a standing connection policy", tone: "idle", label: "Policy" });
		case "capability.grant.created": {
			const names = Array.isArray(data.capabilities) ? data.capabilities.flatMap((name) => text(name) ?? []) : [];
			return withLink({
				action: names.length === 0 ? "granted capabilities" : `granted ${names.join(", ")}`,
				tone: "accent",
				label: "Capability grant",
			});
		}
		case "capability.grant.revoked":
			return withLink({
				action: `revoked a capability grant${text(data.reason) === undefined ? "" : `: ${text(data.reason)}`}`,
				tone: "idle",
				label: "Capability grant",
			});
		case "access.denied":
			return withLink({
				action: `was refused ${text(data.operation) ?? event.subject?.kind ?? "access"}`,
				tone: "error",
				label: "Refused",
			});
		case "sandbox.escalated":
			return withLink({ action: "escalated the sandbox", tone: "approval", label: "Sandbox" });
		case "sandbox.container.stopped":
			return withLink({ action: "stopped the sandbox container", tone: "idle", label: "Sandbox" });
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
		// Kantel's browsers (packages/browser/CONTRACT.md). No event holds a value typed, a whole URL or a link.
		case "browser.session.opened":
			return withLink({ action: "opened a browser", tone: "working", label: "Browser" });
		case "browser.session.closed": {
			const reason = text(data.endReason);
			return withLink({
				action: `closed the browser${reason === undefined || reason === "closed" ? "" : ` (${reason.replace(/_/g, " ")})`}`,
				tone: "idle",
				label: "Browser",
			});
		}
		case "browser.session.step": {
			const host = text(data.host);
			return withLink({
				action: `${data.succeeded === false ? "tried" : "took"} a browser step: ${text(data.step) ?? "a step"}${host === undefined || host === "" ? "" : ` on ${host}`}`,
				tone: data.succeeded === false ? "error" : "neutral",
				label: "Browser step",
			});
		}
		case "browser.session.run": {
			const host = text(data.host);
			const steps = typeof data.steps === "number" ? data.steps : 0;
			const status = text(data.status) ?? "";
			const ended =
				status === "done"
					? "met its goal"
					: status === "needs_supervisor"
						? "handed back"
						: status === "stopped_before"
							? "stopped where asked"
							: status === "max_steps"
								? "ran out of steps"
								: "gave up";
			return withLink({
				action: `ran a browser goal in ${steps} step${steps === 1 ? "" : "s"} and ${ended}${host === undefined || host === "" ? "" : ` on ${host}`}`,
				tone: status === "aborted" ? "error" : "neutral",
				label: "Browser goal",
			});
		}
		case "browser.site.refused":
			return withLink({
				action: `was refused ${text(data.host) || "a site"} in the browser, off the grant's sites`,
				tone: "error",
				label: "Site refused",
			});
		case "browser.session.shared": {
			const minutes = count(data.minutes);
			const what =
				data.replay === true
					? "the browser's replay"
					: data.watch === true
						? "a watch-only view of the browser"
						: "the browser with control";
			return withLink({
				action: `opened ${what}${minutes === undefined ? "" : ` for ${minutes} minutes`}`,
				tone: data.replay === true || data.watch === true ? "neutral" : "approval",
				label: "Browser view",
			});
		}
		case "browser.session.embedded": {
			const minutes = count(data.minutes);
			return withLink({
				action: `made an embed link to the browser's ${data.mode === "replay" ? "replay" : "live view"}${minutes === undefined ? "" : ` for ${minutes} minutes`}`,
				tone: "neutral",
				label: "Browser embed",
			});
		}
		case "browser.recording.stored": {
			const frames = count(data.frames);
			const pages = count(data.pages);
			const seconds = count(data.durationMs);
			const parts = [
				...(frames === undefined ? [] : [`${frames} ${frames === 1 ? "frame" : "frames"}`]),
				...(pages === undefined ? [] : [`${pages} ${pages === 1 ? "page" : "pages"}`]),
				...(seconds === undefined ? [] : [`${Math.round(seconds / 1000)}s`]),
			];
			return withLink({
				action: `stored the browser's recording${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`,
				tone: "done",
				label: "Recording",
			});
		}
		default: {
			// Readable from the type alone: "browser.session.opened" reads "browser session opened", and an old
			// "vault.passkey.refused" reads as its new name does.
			const words = currentAuditType(event.type).split(".").join(" ").replace(/_/g, " ");
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
 * The vault items an organisation's log names, from their `connections.item.created` events (and the
 * `vault.item.created` ones stored before #324), as the credential filter's choices: each item once, labelled with its
 * name (its ID when the event has none), sorted by label. For a host with no vault API to list items from, such as the
 * console on the gateway; the same list names items in rows.
 */
export async function credentialChoices(
	source: AuditSource,
	options: { organisationId?: string; signal?: AbortSignal } = {},
): Promise<{ readonly value: string; readonly label: string }[]> {
	const names = new Map<string, string>();
	for await (const page of readAll(
		source,
		{
			types: ["vault.item.created", "connections.item.created"],
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
