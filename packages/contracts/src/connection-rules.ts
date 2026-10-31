/**
 * Access rules on a connection (#332), the fine layer on top of its owner and usage (#335). The usage decides whether a
 * session may use the connection at all (`connectionUsableIn`), and a failure there is a hard refusal that is never
 * turned into `ask`. Rules then decide what the session may do with it: each names who (any agent, organisation-level
 * agents, a project, an agent profile or a session) and what (any request, a method and path pattern, or an MCP tool),
 * and answers `allow`, `ask` or `deny`, with an optional expiry and use count.
 *
 * Matching (`decideConnectionRules`), the same on every target, in the console's dry run and in the proxy:
 * 1. Only live rules count: not expired, not used up.
 * 2. Of the rules that match the request, a rule loses to another that is at least as specific on both who and what
 *    and more specific on one. A tool name beats a path pattern beats any request; among patterns, more literal
 *    segments win, then a named method over `*`. A session beats an agent beats a project beats organisation-level
 *    agents beats anyone.
 * 3. Of the rules left, `deny` beats `ask` beats `allow`.
 * 4. When no rule matches, the connection's `unmatched` answers: `ask` for a connection made with rules, `allow` for
 *    one made before them, so turning rules on changes nothing silently.
 *
 * Paths match whole segments: `*` is one segment, a trailing `/**` is any rest (none included), and `/repos` never
 * matches `/repositories` or `/repos/x`. The query string is not part of the path.
 *
 * The organisation's ceiling (`VaultCeiling`) bounds every rule: an `allow` or `ask` rule that reaches outside it is
 * refused when saved, and a request outside it is denied whatever a rule says. `deny` rules are never bounded.
 *
 * Only people change rules: a person with admin on the connection's owner, or the person for their own connection.
 * An agent may propose one in a connection request (#334); approving a single request never creates one (#333).
 * "Always allow requests like this" on an approval saves a rule with `source: "approval"` and the approval's ID, as a
 * separate act the person can see and stop.
 *
 * `ask` is answered by approvals (#333): the proxy freezes the request, and the rules' `version` is part of its digest,
 * so an approval made under one set of rules is not used under another.
 */
import type { Actor, AgentId, ProjectId, SessionId, Timestamp, UserId } from "./common.ts";
import type { AccessKind, ConnectionSessionScope, ConnectionUseKind, EndpointHint } from "./connections.ts";
import type { HttpMethod, RouteScope } from "./vault.ts";

/** What a rule answers. */
export type ConnectionRuleAction = "allow" | "ask" | "deny";

export const CONNECTION_RULE_ACTIONS: readonly ConnectionRuleAction[] = ["allow", "ask", "deny"];

/**
 * Who a rule is for, checked against the session's scope (never the model's arguments).
 * - `any`: every session the usage admits.
 * - `organisation`: organisation-level agents: sessions in no project.
 * - `project`: sessions in that project.
 * - `agent`: sessions of that agent profile.
 * - `session`: one session.
 */
export type ConnectionRuleWho =
	| { readonly kind: "any" }
	| { readonly kind: "organisation" }
	| { readonly kind: "project"; readonly projectId: ProjectId }
	| { readonly kind: "agent"; readonly agentId: AgentId }
	| { readonly kind: "session"; readonly sessionId: SessionId };

/**
 * What a rule covers.
 * - `any`: every request through the connection, and listing an MCP server's tools.
 * - `endpoint`: an API connection's requests by method and path pattern (`*` one segment, trailing `/**` the rest), on
 *   one of its hosts or, without `host`, on any of them.
 * - `tool`: one MCP tool, by its exact name.
 */
export type ConnectionRuleWhat =
	| { readonly kind: "any" }
	| { readonly kind: "endpoint"; readonly method: HttpMethod | "*"; readonly path: string; readonly host?: string }
	| { readonly kind: "tool"; readonly tool: string };

/**
 * Where a rule came from: the template's defaults when the connection was made, a person, an approval's "always allow
 * requests like this" (#333), or a vault policy or grant moved over (#332's migration).
 */
export type ConnectionRuleSource = "default" | "person" | "approval" | "migrated";

export interface ConnectionRule {
	readonly id: string;
	readonly connectionId: string;
	readonly who: ConnectionRuleWho;
	readonly what: ConnectionRuleWhat;
	readonly action: ConnectionRuleAction;
	/** After this it no longer matches. */
	readonly expiresAt?: Timestamp;
	/** Once `uses` reaches it, it no longer matches. Counts the requests it allowed. */
	readonly maxUses?: number;
	/** Requests it has allowed (or, for `ask`, that were approved under it). */
	readonly uses: number;
	readonly source: ConnectionRuleSource;
	/** For `source: "approval"`: the approval whose "always allow" saved it. */
	readonly approvalId?: string;
	/** A person's note on why the rule is there. */
	readonly note?: string;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/** A connection's rules, as one versioned set. */
export interface ConnectionRules {
	readonly connectionId: string;
	readonly rules: readonly ConnectionRule[];
	/** What a request no live rule matches gets. */
	readonly unmatched: ConnectionRuleAction;
	/**
	 * Goes up by one on every change to the rules or `unmatched`, not on a use. Part of an approval's digest (#333): an
	 * approval made under one version is not used under another.
	 */
	readonly version: number;
	readonly updatedAt?: Timestamp;
}

/** A new rule. */
export interface ConnectionRuleInput {
	readonly who: ConnectionRuleWho;
	readonly what: ConnectionRuleWhat;
	readonly action: ConnectionRuleAction;
	readonly expiresAt?: Timestamp;
	readonly maxUses?: number;
	readonly note?: string;
}

/** A change to a rule. `null` clears an expiry, a use limit or a note. */
export interface UpdateConnectionRuleInput {
	readonly who?: ConnectionRuleWho;
	readonly what?: ConnectionRuleWhat;
	readonly action?: ConnectionRuleAction;
	readonly expiresAt?: Timestamp | null;
	readonly maxUses?: number | null;
	readonly note?: string | null;
}

/** A change to the set itself. */
export interface UpdateConnectionRulesInput {
	readonly unmatched?: ConnectionRuleAction;
	/**
	 * `template`: replaces every `default` rule with the template's defaults now (reads `allow`, writes `ask`) and sets
	 * `unmatched` to `ask`. A person's own rules stay.
	 */
	readonly reset?: "template";
}

/** What decided a request. */
export type ConnectionDecisionSource =
	/** A rule: `ruleId` names it. */
	| { readonly kind: "rule"; readonly ruleId: string }
	/** No live rule matched: the connection's `unmatched`. */
	| { readonly kind: "unmatched" }
	/** The owner or usage layer (`connectionUsableIn`): a hard refusal, never `ask`. */
	| { readonly kind: "usage" }
	/** The connection itself: disabled, needing reconnecting, not bound to the host, or not over https. */
	| { readonly kind: "connection" }
	/** The organisation's ceiling. */
	| { readonly kind: "ceiling" }
	/** Listing an MCP server's tools, which only an `any` rule decides; otherwise allowed. */
	| { readonly kind: "listing" };

/** The answer for one request, from the proxy or the dry run alike. */
export interface ConnectionDecision {
	readonly action: ConnectionRuleAction;
	readonly by: ConnectionDecisionSource;
	/** The deciding rule, when one did. */
	readonly rule?: ConnectionRule;
	/** In plain words, such as "Rule: agent triage may POST /repos/*\/issues". */
	readonly reason: string;
	/** The rules' version the decision was made under. */
	readonly rulesVersion: number;
}

/**
 * The dry run: what the proxy would do with this request from a session like this. The session is described, not
 * named: absent fields are a session in no project, of no agent any rule names, acting for the caller, with the
 * audience a real session of theirs would have. It writes no use and opens no secret.
 */
export interface DryRunConnectionRequest {
	readonly method: HttpMethod;
	/** The full URL. For an MCP connection, its server URL (the default). */
	readonly url?: string;
	/** For an MCP connection: the tool to call. Without it, listing the tools. */
	readonly tool?: string;
	readonly agentId?: AgentId;
	readonly projectId?: ProjectId;
	readonly sessionId?: SessionId;
	/** The person the session acts for. Default the caller; `null` for an unattended session. */
	readonly actingUserId?: UserId | null;
	/** Who can see the session. Default: `private` in a one-person deployment, else `shared`. */
	readonly audience?: "private" | "shared";
}

/** The organisation's ceiling as rules see it. `set: false`: there is none, and nothing is bounded. */
export interface ConnectionCeiling {
	readonly set: boolean;
	readonly routes: readonly RouteScope[];
}

/** One request, as rules see it. */
export interface RuleRequest {
	readonly kind: ConnectionUseKind;
	readonly method: HttpMethod;
	readonly host: string;
	readonly path: string;
	readonly tool?: string;
}

export const ALL_HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// Paths.

const segments = (path: string): string[] => {
	const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
	return trimmed.split("/").slice(1);
};

/** Why a path pattern is not valid, or undefined. */
export function pathPatternProblem(pattern: string): string | undefined {
	if (!pattern.startsWith("/")) return "A path starts with /";
	if (pattern.includes("?") || pattern.includes("#")) return "A path has no query or fragment";
	if (pattern.length > 512) return "A path is at most 512 characters";
	const parts = segments(pattern);
	for (const [index, part] of parts.entries()) {
		if (part === "**" && index !== parts.length - 1) return "/** may only end a path";
		if (part !== "*" && part !== "**" && part.includes("*")) return "* stands for a whole segment";
		if (part === "" && parts.length > 1) return "A path has no empty segments";
	}
	return undefined;
}

/**
 * A request's path as rules see it, so a server that reads paths loosely can't be reached past a deny: escaped
 * unreserved characters decoded (`%61` is `a`), other escapes upper-cased, and runs of `/` made one.
 */
export function canonicalPath(path: string): string {
	const decoded = path.replace(/%([0-9a-fA-F]{2})/g, (escaped, hex: string) => {
		const char = String.fromCharCode(Number.parseInt(hex, 16));
		return /^[A-Za-z0-9\-._~]$/.test(char) ? char : escaped.toUpperCase();
	});
	return decoded.replace(/\/{2,}/g, "/");
}

/**
 * Why a request's path can't be judged by path rules, or undefined: an escaped `/` or `\`, a backslash, a NUL or a
 * `.` or `..` segment, which servers read differently. Such a request is refused wherever rules or a ceiling apply.
 */
export function ambiguousPath(path: string): string | undefined {
	if (/%2f|%5c|%00|\\/i.test(path)) return "Its path has an escaped / or \\, a backslash or a NUL";
	if (
		canonicalPath(path)
			.split("/")
			.some((part) => part === "." || part === "..")
	)
		return "Its path has a . or .. segment";
	return undefined;
}

/**
 * Whether `path` matches `pattern`, segment by segment. `foldCase` compares letters regardless of case: deny and ask
 * rules match that way, so `/Repos/Acme` can't slip past a deny on `/repos/acme` to a server that ignores case.
 */
export function pathMatches(pattern: string, path: string, options: { readonly foldCase?: boolean } = {}): boolean {
	const fold = (text: string) => (options.foldCase === true ? text.toLowerCase() : text);
	const want = segments(fold(pattern));
	const have = segments(fold(canonicalPath(path)));
	for (let index = 0; index < want.length; index += 1) {
		const part = want[index]!;
		if (part === "**") return true;
		const actual = have[index];
		if (actual === undefined) return false;
		if (part !== "*" && part !== actual) return false;
	}
	return want.length === have.length;
}

/** The literal part of a pattern, up to its first wildcard: what a ceiling's path prefix must cover. */
export function patternPrefix(pattern: string): string {
	const literal: string[] = [];
	for (const part of segments(pattern)) {
		if (part === "*" || part === "**") break;
		literal.push(part);
	}
	return literal.length === 0 || (literal.length === 1 && literal[0] === "") ? "/" : `/${literal.join("/")}`;
}

/** Whole segments: `/repos` covers `/repos` and `/repos/x`, never `/repositories`. As the vault's `pathUnder`. */
export function pathWithin(path: string, prefix: string): boolean {
	if (prefix === "" || prefix === "/" || path === prefix) return true;
	const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
	return path.startsWith(base);
}

// Matching.

/** A session's scope, as a rule's who sees it. */
export type RuleScope = Pick<ConnectionSessionScope, "projectId" | "agentId" | "sessionId">;

export function whoMatches(who: ConnectionRuleWho, scope: RuleScope): boolean {
	switch (who.kind) {
		case "any":
			return true;
		case "organisation":
			return scope.projectId === undefined;
		case "project":
			return scope.projectId === who.projectId;
		case "agent":
			return scope.agentId === who.agentId;
		case "session":
			return scope.sessionId === who.sessionId;
	}
}

export function whatMatches(
	what: ConnectionRuleWhat,
	request: RuleRequest,
	options: { readonly foldCase?: boolean } = {},
): boolean {
	switch (what.kind) {
		case "any":
			return true;
		case "endpoint":
			return (
				request.kind === "http" &&
				(what.method === "*" || what.method === request.method) &&
				(what.host === undefined || what.host.toLowerCase() === request.host.toLowerCase()) &&
				pathMatches(what.path, request.path, options)
			);
		case "tool":
			return request.kind === "mcp_call" && request.tool === what.tool;
	}
}

const WHO_RANK: Record<ConnectionRuleWho["kind"], number> = {
	any: 0,
	organisation: 1,
	project: 2,
	agent: 3,
	session: 4,
};

/** How narrowly a rule's who picks sessions. Higher is narrower. */
export function whoSpecificity(who: ConnectionRuleWho): number {
	return WHO_RANK[who.kind];
}

/** How narrowly a rule's what picks requests. Higher is narrower; only compared between rules that both match. */
export function whatSpecificity(what: ConnectionRuleWhat): number {
	switch (what.kind) {
		case "any":
			return 0;
		case "tool":
			return 100_000;
		case "endpoint": {
			let score = 1;
			for (const part of segments(what.path)) score += part === "**" ? 0 : part === "*" ? 10 : 100;
			if (what.method !== "*") score += 2;
			if (what.host !== undefined) score += 1;
			return score;
		}
	}
}

const ACTION_RANK: Record<ConnectionRuleAction, number> = { allow: 0, ask: 1, deny: 2 };

/** Whether a rule can still match at `now`. */
export function ruleLive(rule: Pick<ConnectionRule, "expiresAt" | "maxUses" | "uses">, now: Timestamp): boolean {
	if (rule.expiresAt !== undefined && now >= rule.expiresAt) return false;
	if (rule.maxUses !== undefined && rule.uses >= rule.maxUses) return false;
	return true;
}

/**
 * The rule that decides a request, or undefined when none matches (the set's `unmatched` answers). Expired and used-up
 * rules are skipped. See the module's comment for the order.
 */
export function decidingRule(
	rules: readonly ConnectionRule[],
	scope: RuleScope,
	request: RuleRequest,
	now: Timestamp,
): ConnectionRule | undefined {
	const matching = rules.filter(
		(rule) =>
			ruleLive(rule, now) &&
			whoMatches(rule.who, scope) &&
			whatMatches(rule.what, request, { foldCase: rule.action !== "allow" }),
	);
	const ranked = matching.map((rule) => ({
		rule,
		who: whoSpecificity(rule.who),
		what: whatSpecificity(rule.what),
	}));
	const dominated = (a: (typeof ranked)[number], b: (typeof ranked)[number]) =>
		b.who >= a.who && b.what >= a.what && (b.who > a.who || b.what > a.what);
	const best = ranked.filter((a) => !ranked.some((b) => dominated(a, b)));
	best.sort(
		(a, b) =>
			ACTION_RANK[b.rule.action] - ACTION_RANK[a.rule.action] ||
			b.who + b.what - (a.who + a.what) ||
			a.rule.createdAt - b.rule.createdAt ||
			(a.rule.id < b.rule.id ? -1 : 1),
	);
	return best[0]?.rule;
}

/** A rule in a line: "Agent triage: POST /repos/*\/issues". */
export function describeRule(rule: Pick<ConnectionRule, "who" | "what">): string {
	const who =
		rule.who.kind === "any"
			? "Any agent"
			: rule.who.kind === "organisation"
				? "Organisation-level agents"
				: rule.who.kind === "project"
					? `Project ${rule.who.projectId}`
					: rule.who.kind === "agent"
						? `Agent ${rule.who.agentId}`
						: `Session ${rule.who.sessionId}`;
	const what =
		rule.what.kind === "any"
			? "any request"
			: rule.what.kind === "tool"
				? `tool ${rule.what.tool}`
				: `${rule.what.method === "*" ? "any method" : rule.what.method} ${rule.what.host ?? ""}${rule.what.path}`;
	return `${who}: ${what}`;
}

const ACTION_WORDS: Record<ConnectionRuleAction, string> = {
	allow: "allowed",
	ask: "needs approval",
	deny: "blocked",
};

/**
 * The rules' answer for one request from a session the usage already admits: the deciding rule, or `unmatched`.
 * Listing an MCP server's tools is allowed unless an `any` rule says otherwise. The ceiling is the caller's to check
 * first (`requestWithinCeiling`).
 */
export function decideConnectionRules(
	set: Pick<ConnectionRules, "rules" | "unmatched" | "version">,
	scope: RuleScope,
	request: RuleRequest,
	now: Timestamp,
): ConnectionDecision {
	const rules = request.kind === "mcp_tools" ? set.rules.filter((rule) => rule.what.kind === "any") : set.rules;
	const rule = decidingRule(rules, scope, request, now);
	if (rule !== undefined) {
		return {
			action: rule.action,
			by: { kind: "rule", ruleId: rule.id },
			rule,
			reason: `${describeRule(rule)} is ${ACTION_WORDS[rule.action]}`,
			rulesVersion: set.version,
		};
	}
	if (request.kind === "mcp_tools") {
		return {
			action: "allow",
			by: { kind: "listing" },
			reason: "Listing the server's tools is allowed",
			rulesVersion: set.version,
		};
	}
	return {
		action: set.unmatched,
		by: { kind: "unmatched" },
		reason: `No rule covers it, so it is ${ACTION_WORDS[set.unmatched]}`,
		rulesVersion: set.version,
	};
}

// The ceiling.

/** Whether the ceiling lets this request out. No ceiling (`set: false`) lets everything out. */
export function requestWithinCeiling(ceiling: ConnectionCeiling, request: RuleRequest): boolean {
	if (!ceiling.set) return true;
	const host = request.host.toLowerCase();
	return ceiling.routes.some(
		(route) =>
			route.host === host &&
			route.methods.includes(request.method) &&
			pathWithin(canonicalPath(request.path), route.pathPrefix),
	);
}

/**
 * Why an `allow` or `ask` rule reaches outside the ceiling, or undefined when it doesn't (or is `deny`, or there is no
 * ceiling). Every host the rule can reach (its own, or each of the connection's) and every method it names must be
 * inside one of the ceiling's routes, from the pattern's literal prefix down. A tool is a POST to the MCP server's URL.
 */
export function ruleOutsideCeiling(
	ceiling: ConnectionCeiling,
	rule: Pick<ConnectionRuleInput, "what" | "action">,
	connection: { readonly hosts: readonly string[]; readonly mcpUrl?: string },
): string | undefined {
	if (!ceiling.set || rule.action === "deny") return undefined;
	const checks: { host: string; method: HttpMethod; prefix: string }[] = [];
	const what = rule.what;
	if (what.kind === "tool" || (what.kind === "any" && connection.mcpUrl !== undefined)) {
		const url = new URL(connection.mcpUrl ?? "https://invalid.invalid/");
		checks.push({ host: url.hostname.toLowerCase(), method: "POST", prefix: url.pathname });
	}
	if (what.kind === "any" && connection.mcpUrl === undefined) {
		for (const host of connection.hosts)
			for (const method of ALL_HTTP_METHODS) checks.push({ host, method, prefix: "/" });
	}
	if (what.kind === "endpoint") {
		const hosts = what.host === undefined ? connection.hosts : [what.host.toLowerCase()];
		const methods = what.method === "*" ? ALL_HTTP_METHODS : [what.method];
		for (const host of hosts)
			for (const method of methods) checks.push({ host, method, prefix: patternPrefix(what.path) });
	}
	for (const check of checks) {
		const inside = ceiling.routes.some(
			(route) =>
				route.host === check.host && route.methods.includes(check.method) && pathWithin(check.prefix, route.pathPrefix),
		);
		if (!inside) {
			return `The organisation's ceiling doesn't allow ${check.method} ${check.host}${check.prefix === "/" ? "" : check.prefix}`;
		}
	}
	return undefined;
}

// Defaults.

/**
 * The rules a new connection starts with, from its template's endpoint hints: reads `allow`, writes `ask`, for any
 * agent. Anything no hint covers falls to `unmatched`, `ask`.
 */
export function defaultRuleInputs(hints: readonly EndpointHint[] | undefined): ConnectionRuleInput[] {
	return (hints ?? []).map((hint) => ({
		who: { kind: "any" },
		what: { kind: "endpoint", method: hint.method, path: hint.path },
		action: defaultActionFor(hint.access),
	}));
}

export function defaultActionFor(access: AccessKind): ConnectionRuleAction {
	return access === "read" ? "allow" : "ask";
}

/**
 * The defaults for one MCP tool from its annotations: `readOnlyHint` `allow`, `destructiveHint` `ask`, anything else
 * left to `unmatched`.
 */
export function defaultToolAction(annotations: {
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
}): ConnectionRuleAction | undefined {
	if (annotations.destructiveHint === true) return "ask";
	if (annotations.readOnlyHint === true) return "allow";
	return undefined;
}
