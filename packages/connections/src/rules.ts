/**
 * Access rules on connections (#332): where they are kept, how a rule is checked before it is saved, and the one
 * decision every request through a connection gets, which the dry run (`dryRun`) shares with the real send.
 *
 * A connection's rules are one record (`rules`, keyed by the connection) in the connections table, read on every
 * decision and never cached, so a change made through one instance holds for the next request through any other, on
 * Cloudflare and self-hosted alike. A connection with no record was made before rules: no rules, and `unmatched`
 * `allow`, which is what it got before.
 */
import {
	type Actor,
	ambiguousPath,
	type CallContext,
	CONNECTION_RULE_ACTIONS,
	type Connection,
	type ConnectionCeiling,
	type ConnectionDecision,
	type ConnectionRule,
	type ConnectionRuleInput,
	type ConnectionRules,
	type ConnectionRuleWho,
	type ConnectionSessionScope,
	connectionUsableIn,
	decideConnectionRules,
	KantelError,
	type HttpMethod,
	isKantelError,
	pathPatternProblem,
	type RouteScope,
	type RuleRequest,
	requestWithinCeiling,
	ruleOutsideCeiling,
	type Timestamp,
} from "@kantel/contracts";
import type { ConnectionsRepository } from "./repository.ts";

/** Where the organisation's ceiling is kept: the vault's (`Vault.getCeiling`). Absent: no ceiling. */
export interface CeilingStore {
	/** The ceiling's routes, or undefined when the organisation has none. */
	get(organisationId: string): Promise<readonly RouteScope[] | undefined>;
	/** Replaces it, as `actor`. The caller has checked they are the organisation's admin. */
	set(
		ctx: { readonly actor: Actor; readonly organisationId: string },
		routes: readonly RouteScope[],
	): Promise<readonly RouteScope[]>;
}

/** The vault's calls a ceiling store makes: `Vault.getCeiling` and `Vault.setCeiling`, or the same over RPC. */
export interface CeilingVault {
	getCeiling(ctx: CallContext): Promise<{ readonly routes: readonly RouteScope[] }>;
	setCeiling(ctx: CallContext, routes: readonly RouteScope[]): Promise<{ readonly routes: readonly RouteScope[] }>;
}

/**
 * The ceiling kept in the vault, where the vault's own grants are bounded by it too: one ceiling per organisation for
 * both. Read as the connections component; set as the person, so the vault records who set it.
 */
export function vaultCeiling(vault: () => CeilingVault): CeilingStore {
	return {
		async get(organisationId) {
			try {
				return (await vault().getCeiling({ actor: CEILING_ACTOR, organisationId })).routes;
			} catch (error) {
				if (isKantelError(error) && error.code === "not_found") return undefined;
				throw error;
			}
		},
		async set(ctx, routes) {
			return (await vault().setCeiling({ actor: ctx.actor, organisationId: ctx.organisationId }, routes)).routes;
		},
	};
}

const CEILING_ACTOR: Actor = { kind: "system", component: "connections" };

/** The rules a connection made before rules has: none, and everything that passes the usage check allowed. */
export const LEGACY_RULES = { rules: [], unmatched: "allow", version: 0 } as const;

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const MAX_RULES = 200;

export function rulesOf(connectionId: string, stored: ConnectionRules | undefined): ConnectionRules {
	return stored ?? { connectionId, ...LEGACY_RULES, rules: [] };
}

/** Reads a connection's rules: the record, or the legacy set. */
export async function readRules(repo: ConnectionsRepository, connectionId: string) {
	const found = await repo.get<ConnectionRules>("rules", connectionId);
	return { rules: rulesOf(connectionId, found?.value), revision: found?.revision };
}

/**
 * Writes a connection's next rules from the stored ones, read again after a lost race. `next` answers undefined to
 * leave them as they are. Resolves the rules written (or left).
 */
export async function changeRules(
	repo: ConnectionsRepository,
	connection: Pick<Connection, "id" | "organisationId">,
	next: (current: ConnectionRules) => ConnectionRules | undefined,
): Promise<ConnectionRules> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const { rules, revision } = await readRules(repo, connection.id);
		const changed = next(rules);
		if (changed === undefined) return rules;
		const written =
			revision === undefined
				? await repo.insert("rules", {
						id: connection.id,
						organisationId: connection.organisationId,
						key: connection.id,
						value: changed,
						createdAt: changed.updatedAt ?? 0,
					})
				: await repo.update("rules", connection.id, revision, changed);
		if (written) return changed;
	}
	throw new KantelError("conflict", `The rules on ${connection.id} changed while they were being saved; try again`);
}

/** The ceiling as rules see it. */
export async function ceilingFor(store: CeilingStore | undefined, organisationId: string): Promise<ConnectionCeiling> {
	const routes = store === undefined ? undefined : await store.get(organisationId);
	return routes === undefined ? { set: false, routes: [] } : { set: true, routes };
}

export function validateRoutes(routes: readonly RouteScope[]): void {
	if (!Array.isArray(routes) || routes.length > 500) throw new KantelError("invalid", "Give at most 500 routes");
	for (const route of routes) {
		if (typeof route.host !== "string" || !/^[a-z0-9.-]+$/.test(route.host)) {
			throw new KantelError("invalid", "A route's host is a lower-case host name");
		}
		if (
			!Array.isArray(route.methods) ||
			route.methods.length === 0 ||
			route.methods.some((m: HttpMethod) => !METHODS.includes(m))
		) {
			throw new KantelError("invalid", "A route names one or more HTTP methods");
		}
		if (typeof route.pathPrefix !== "string" || !route.pathPrefix.startsWith("/")) {
			throw new KantelError("invalid", "A route's path prefix starts with /");
		}
	}
}

/** Why a rule's who names a session the connection's owner or usage never admits, or undefined. */
function whoOutsideUsage(connection: Connection, who: ConnectionRuleWho): string | undefined {
	const { owner, usage } = connection;
	if (who.kind === "project") {
		if (owner.kind === "project" && owner.projectId !== who.projectId) {
			return "This connection belongs to another project, so a rule can't name this one";
		}
		if (usage.projects !== undefined && !usage.projects.includes(who.projectId)) {
			return "This connection isn't available in that project, so a rule for it would never apply";
		}
	}
	if (who.kind === "organisation" && (owner.kind === "project" || usage.projects !== undefined)) {
		return "This connection is only for sessions in a project, so organisation-level agents can't use it";
	}
	if (who.kind === "agent" && usage.agents !== undefined && !usage.agents.includes(who.agentId)) {
		return "This connection isn't available to that agent, so a rule for it would never apply";
	}
	return undefined;
}

const nonEmpty = (value: unknown, max = 200): value is string =>
	typeof value === "string" && value.trim() !== "" && value.length <= max;

/**
 * Checks a rule before it is saved: well formed (`invalid`), within the connection's usage and the organisation's
 * ceiling (`refused`).
 */
export function checkRule(
	connection: Connection,
	input: ConnectionRuleInput,
	ceiling: ConnectionCeiling,
	now: Timestamp,
): void {
	const { who, what } = input;
	if (!CONNECTION_RULE_ACTIONS.includes(input.action))
		throw new KantelError("invalid", "A rule is allow, ask or deny");
	switch (who?.kind) {
		case "any":
		case "organisation":
			break;
		case "project":
			if (!nonEmpty(who.projectId)) throw new KantelError("invalid", "Name the project");
			break;
		case "agent":
			if (!nonEmpty(who.agentId)) throw new KantelError("invalid", "Name the agent");
			break;
		case "session":
			if (!nonEmpty(who.sessionId)) throw new KantelError("invalid", "Name the session");
			break;
		default:
			throw new KantelError("invalid", "A rule names who it is for");
	}
	const mcp = connection.kind === "mcp";
	switch (what?.kind) {
		case "any":
			break;
		case "endpoint": {
			if (mcp) throw new KantelError("invalid", "An MCP server's rules name its tools, not endpoints");
			if (what.method !== "*" && !METHODS.includes(what.method)) throw new KantelError("invalid", "Pick a method");
			const problem = typeof what.path === "string" ? pathPatternProblem(what.path) : "Give a path";
			if (problem !== undefined) throw new KantelError("invalid", problem);
			if (what.host !== undefined && !connection.hosts.includes(what.host.toLowerCase())) {
				throw new KantelError("invalid", `This connection is for ${connection.hosts.join(", ")}, not ${what.host}`);
			}
			break;
		}
		case "tool":
			if (!mcp) throw new KantelError("invalid", "Only an MCP server's rules name tools");
			if (!nonEmpty(what.tool)) throw new KantelError("invalid", "Name the tool");
			break;
		default:
			throw new KantelError("invalid", "A rule names what it covers");
	}
	if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= now)) {
		throw new KantelError("invalid", "An expiry must be in the future");
	}
	if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
		throw new KantelError("invalid", "A use limit is a whole number above zero");
	}
	if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500)) {
		throw new KantelError("invalid", "A note is at most 500 characters");
	}
	const outsideUsage = whoOutsideUsage(connection, who);
	if (outsideUsage !== undefined) throw new KantelError("refused", outsideUsage);
	const outside = ruleOutsideCeiling(ceiling, input, {
		hosts: connection.hosts,
		...(connection.mcp === undefined ? {} : { mcpUrl: connection.mcp.url }),
	});
	if (outside !== undefined) throw new KantelError("refused", `${outside}, so this rule can't be saved`);
}

export function newRule(
	id: string,
	connectionId: string,
	input: ConnectionRuleInput,
	extra: { readonly source: ConnectionRule["source"]; readonly approvalId?: string; readonly actor: Actor },
	now: Timestamp,
): ConnectionRule {
	return {
		id,
		connectionId,
		who: input.who,
		what:
			input.what.kind === "endpoint" && input.what.host !== undefined
				? { ...input.what, host: input.what.host.toLowerCase() }
				: input.what,
		action: input.action,
		...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
		...(input.maxUses === undefined ? {} : { maxUses: input.maxUses }),
		uses: 0,
		source: extra.source,
		...(extra.approvalId === undefined ? {} : { approvalId: extra.approvalId }),
		...(input.note === undefined || input.note.trim() === "" ? {} : { note: input.note.trim() }),
		createdBy: extra.actor,
		createdAt: now,
		updatedAt: now,
	};
}

export function assertRoom(rules: ConnectionRules): void {
	if (rules.rules.length >= MAX_RULES) {
		throw new KantelError("refused", `A connection has at most ${MAX_RULES} rules; remove one first`);
	}
}

/** One request through a connection, as the decision sees it. */
export interface UseRequest {
	readonly kind: RuleRequest["kind"];
	readonly method: HttpMethod;
	readonly url: URL;
	readonly tool?: string;
}

/**
 * The decision for one request from a session, in order: the owner and usage (`connectionUsableIn`, a hard refusal),
 * the connection itself (disabled, needing reconnecting, https, its hosts), the ceiling, then the rules. The real send
 * and the dry run both call this, so they cannot disagree.
 */
export function decideUse(
	connection: Connection,
	rules: ConnectionRules,
	ceiling: ConnectionCeiling,
	scope: ConnectionSessionScope,
	request: UseRequest,
	options: { readonly now: Timestamp; readonly allowHttp: boolean },
): ConnectionDecision {
	const deny = (by: ConnectionDecision["by"], reason: string): ConnectionDecision => ({
		action: "deny",
		by,
		reason,
		rulesVersion: rules.version,
	});
	const usable = connectionUsableIn(connection, scope);
	if (!usable.usable)
		return deny({ kind: "usage" }, `Connection ${connection.name} can't be used here: ${usable.reason}`);
	if (connection.status === "needs_reauth") {
		return deny({ kind: "connection" }, `Connection ${connection.name} needs someone to connect it again`);
	}
	const { url } = request;
	if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
		return deny({ kind: "connection" }, "A connection only sends over https");
	}
	const host = url.hostname.toLowerCase();
	if (!connection.hosts.includes(host)) {
		return deny(
			{ kind: "connection" },
			`Connection ${connection.name} is not for ${url.hostname}; it is for ${connection.hosts.join(", ")}`,
		);
	}
	// A path servers read differently can't be judged by a path: refused where a ceiling or rules apply, and let through
	// as before where neither does.
	const ambiguous = ambiguousPath(url.pathname);
	if (ambiguous !== undefined && (ceiling.set || rules.rules.length > 0)) {
		return deny(
			ceiling.set ? { kind: "ceiling" } : { kind: "connection" },
			`${ambiguous}, so the ${ceiling.set ? "organisation's ceiling" : "connection's rules"} can't judge it`,
		);
	}
	const ruleRequest: RuleRequest = {
		kind: request.kind,
		method: request.method,
		host,
		path: url.pathname,
		...(request.tool === undefined ? {} : { tool: request.tool }),
	};
	if (!requestWithinCeiling(ceiling, ruleRequest)) {
		return deny(
			{ kind: "ceiling" },
			`The organisation's ceiling doesn't allow ${request.method} ${host}${url.pathname}, whatever a rule says`,
		);
	}
	return decideConnectionRules(rules, scope, ruleRequest, options.now);
}
