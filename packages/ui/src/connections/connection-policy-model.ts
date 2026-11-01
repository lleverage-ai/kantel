import {
	type ConnectionRule,
	type ConnectionRuleAction,
	type ConnectionRuleInput,
	type ConnectionRules,
	decideConnectionRules,
	type HttpMethod,
	type RuleScope,
	type UpdateConnectionRuleInput,
} from "@kantel/contracts";

// "What agents may do" (#462): a connection's rules as a grid of permission groups by read, write and delete, each
// Allow, Ask or Block, with an optional list of the only repositories agents may reach.
//
// The grid is a view of the connection's ordinary rules, not a store of its own. Each cell is read by asking the
// contract's own decision (`decideConnectionRules`) what a request of that kind would get, so the grid, the rule list
// and the dry run always agree. Setting a cell compiles to ordinary endpoint rules for any agent, marked with
// `GRID_NOTE`; only rules with that mark are ever changed or removed by the grid, so the template's defaults, a
// person's own rules and rules from approvals stay as they are, and show as exceptions.
//
// Rules match method and path today, so a group is a set of path patterns and an access is a set of methods (reads
// GET and HEAD, writes POST, PUT and PATCH, deletes DELETE): a GraphQL query is a POST, so a write. Operation rules
// (#466, on #465's classification) will replace both; until then the groups below are this console's.

/** What a request does, as the grid's columns say it. */
export type PolicyAccess = "read" | "write" | "delete";

export const POLICY_ACCESSES: readonly PolicyAccess[] = ["read", "write", "delete"];

/** The methods each column covers. */
export const ACCESS_METHODS: Readonly<Record<PolicyAccess, readonly HttpMethod[]>> = {
	read: ["GET", "HEAD"],
	write: ["POST", "PUT", "PATCH"],
	delete: ["DELETE"],
};

/** The note on every rule the grid made: what it changes and removes, and nothing else. */
export const GRID_NOTE = "Set in What agents may do";

/** Where a repository's name goes in a group's path (`owner/name`); `*\/*` for every repository. */
const REPO = "{repo}";
const ANY_REPO = "*/*";
/** A repository's name, as the list takes it. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** What's wrong with a repository's name as the list would take it, or undefined when it's fine. */
export function repositoryProblem(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed === "") return "Name a repository";
	if (!REPO_NAME.test(trimmed)) return "Write it as owner/name, such as tvdavies/harbour";
	return undefined;
}

/** A row of the grid: an area of the service's API, by path. */
export interface PermissionGroup {
	readonly id: string;
	readonly label: string;
	/**
	 * Its path patterns. `{repo}` stands for a repository (`owner/name`): `*\/*` for every one, or each listed one when
	 * agents may reach only some.
	 */
	readonly paths: readonly string[];
	/** The columns it has; the others show a dash. */
	readonly accesses: readonly PolicyAccess[];
}

/** The groups a template's grid has: GitHub's three, or one row for every request. */
export function permissionGroups(templateId: string | undefined): readonly PermissionGroup[] {
	if (templateId === "github") return GITHUB_GROUPS;
	return [{ id: "all", label: "Every request", paths: ["/**"], accesses: POLICY_ACCESSES }];
}

const GITHUB_GROUPS: readonly PermissionGroup[] = [
	{ id: "profile", label: "Your profile", paths: ["/user/**", "/users/**"], accesses: ["read"] },
	{
		id: "repo",
		label: "Repositories, issues and pull requests",
		paths: [`/repos/${REPO}/**`, "/search/**", "/issues/**", "/orgs/**", "/graphql"],
		accesses: POLICY_ACCESSES,
	},
	{
		id: "workflow",
		label: "GitHub Actions workflows",
		paths: [`/repos/${REPO}/actions/**`],
		accesses: POLICY_ACCESSES,
	},
];

/** Whether a template's grid can be narrowed to some repositories. */
export function hasRepositories(groups: readonly PermissionGroup[]): boolean {
	return groups.some((group) => group.paths.some((path) => path.includes(REPO)));
}

/** A cell's key: `repo:write`. */
export const cellKey = (group: string, access: PolicyAccess): string => `${group}:${access}`;

/** What the grid shows, read from the rules. */
export interface PolicyGrid {
	readonly groups: readonly PermissionGroup[];
	/**
	 * Each cell's answer, by `cellKey`, for the cells its group has. `mixed`: the group's paths don't all get the same
	 * answer (a person's rule covers part of it).
	 */
	readonly cells: Readonly<Record<string, ConnectionRuleAction | "mixed">>;
	/** The only repositories agents may reach, or undefined for every one the connection reaches. */
	readonly repositories: readonly string[] | undefined;
}

/** What a person sets: every cell's answer, and the repository list. */
export interface PolicyChoice {
	readonly cells: Readonly<Record<string, ConnectionRuleAction>>;
	readonly repositories: readonly string[] | undefined;
}

/** The scope the grid reads for: any agent, in the connection's project when it has one. */
export function gridScope(projectId?: string): RuleScope {
	return {
		...(projectId === undefined ? {} : { projectId }),
		agentId: "\u0000grid",
		sessionId: "\u0000grid",
	} as RuleScope;
}

/** A path a pattern matches, to ask the rules about: `/user/**` is `/user`, `*` a placeholder segment. */
function samplePath(pattern: string, repo: string): string {
	const path = pattern
		.replaceAll(REPO, repo)
		.split("/")
		.filter((part) => part !== "**")
		.map((part) => (part === "*" ? "x" : part))
		.join("/");
	return path === "" ? "/" : path;
}

const isGridRule = (rule: Pick<ConnectionRule, "note" | "who" | "what">): boolean =>
	rule.note === GRID_NOTE && rule.who.kind === "any" && rule.what.kind === "endpoint" && rule.what.host === undefined;

/** The paths a group's rules go on: each listed repository's, or every repository's. */
function groupPaths(group: PermissionGroup, repositories: readonly string[] | undefined): string[] {
	return group.paths.flatMap((path) =>
		!path.includes(REPO)
			? [path]
			: repositories === undefined
				? [path.replaceAll(REPO, ANY_REPO)]
				: repositories.map((repo) => path.replaceAll(REPO, repo)),
	);
}

/** The repositories the grid's own rules list: the paths of its rules under `/repos/owner/name`, when it blocks the rest. */
function listedRepositories(rules: readonly ConnectionRule[]): string[] | undefined {
	const grid = rules.filter(isGridRule);
	const blocksRest = grid.some(
		(rule) =>
			rule.action === "deny" &&
			rule.what.kind === "endpoint" &&
			rule.what.method === "*" &&
			rule.what.path === `/repos/${ANY_REPO}/**`,
	);
	if (!blocksRest) return undefined;
	const repos = new Set<string>();
	for (const rule of grid) {
		if (rule.what.kind !== "endpoint") continue;
		const match = /^\/repos\/([^/*]+\/[^/*]+)\/(?:actions\/)?\*\*$/.exec(rule.what.path);
		if (match?.[1] !== undefined) repos.add(match[1]);
	}
	return [...repos].sort();
}

function decide(
	set: Pick<ConnectionRules, "rules" | "unmatched" | "version">,
	scope: RuleScope,
	host: string,
	method: HttpMethod,
	path: string,
	now: number,
): ConnectionRuleAction {
	return decideConnectionRules(set, scope, { kind: "http", method, host, path }, now).action;
}

/** The answer for each (group, access, path) unit, from the rules as they are. */
function unitAnswers(
	set: Pick<ConnectionRules, "rules" | "unmatched" | "version">,
	groups: readonly PermissionGroup[],
	repositories: readonly string[] | undefined,
	options: { readonly host: string; readonly scope: RuleScope; readonly now: number },
): Map<string, { group: PermissionGroup; access: PolicyAccess; path: string; answer: ConnectionRuleAction }> {
	const sampleRepo = repositories?.[0] ?? "owner/repo";
	const out = new Map<
		string,
		{ group: PermissionGroup; access: PolicyAccess; path: string; answer: ConnectionRuleAction }
	>();
	for (const group of groups) {
		for (const access of group.accesses) {
			for (const path of groupPaths(group, repositories)) {
				// Every method of the column, so a cell with a rule on POST alone reads as mixed.
				const answers = new Set(
					ACCESS_METHODS[access].map((method) =>
						decide(set, options.scope, options.host, method, samplePath(path, sampleRepo), options.now),
					),
				);
				const answer = answers.size === 1 ? [...answers][0] : undefined;
				out.set(`${group.id}:${access}:${path}`, {
					group,
					access,
					path,
					answer: answer ?? ("mixed" as never),
				});
			}
		}
	}
	return out;
}

/** The grid as the rules say it now. */
export function readPolicyGrid(
	set: ConnectionRules,
	options: {
		readonly templateId: string | undefined;
		readonly host: string;
		readonly projectId?: string;
		readonly now: number;
	},
): PolicyGrid {
	const groups = permissionGroups(options.templateId);
	const repositories = hasRepositories(groups) ? listedRepositories(set.rules) : undefined;
	const units = unitAnswers(set, groups, repositories, {
		host: options.host,
		scope: gridScope(options.projectId),
		now: options.now,
	});
	const cells: Record<string, ConnectionRuleAction | "mixed"> = {};
	for (const unit of units.values()) {
		const key = cellKey(unit.group.id, unit.access);
		const seen = cells[key];
		cells[key] = seen === undefined || seen === unit.answer ? unit.answer : "mixed";
	}
	return { groups, cells, repositories };
}

/** The changes that make the rules say `choice`. Creates first, then updates, then removals. */
export interface PolicyPlan {
	readonly create: readonly ConnectionRuleInput[];
	readonly update: readonly { readonly ruleId: string; readonly action: ConnectionRuleAction }[];
	readonly remove: readonly string[];
}

/** Whether a plan changes nothing. */
export const emptyPlan = (plan: PolicyPlan): boolean =>
	plan.create.length === 0 && plan.update.length === 0 && plan.remove.length === 0;

/** The rules API's calls a plan makes (`ConnectionRulesSource`'s). */
export interface PolicyPlanCalls {
	create(connectionId: string, input: ConnectionRuleInput): Promise<unknown>;
	updateRule(connectionId: string, ruleId: string, input: UpdateConnectionRuleInput): Promise<unknown>;
	remove(connectionId: string, ruleId: string): Promise<unknown>;
}

/**
 * Makes a plan's changes one call at a time: every create, then every update, then every removal. Adding before
 * removing means a request is never decided by fewer of the grid's rules than either the old or the new choice has, so
 * a failure part way leaves the rules no looser than one of them. A failed call stops the rest and throws.
 */
export async function runPolicyPlan(calls: PolicyPlanCalls, connectionId: string, plan: PolicyPlan): Promise<void> {
	for (const input of plan.create) await calls.create(connectionId, input);
	// A grid rule is standing: an update clears any limit someone gave it in the rule list.
	for (const { ruleId, action } of plan.update)
		await calls.updateRule(connectionId, ruleId, { action, expiresAt: null, maxUses: null });
	for (const ruleId of plan.remove) await calls.remove(connectionId, ruleId);
}

type Desired = { method: HttpMethod | "*"; path: string; action: ConnectionRuleAction };

/**
 * The fewest grid rules that make the rules answer `choice`, and the changes from the grid's rules today. Rules the grid
 * didn't make are never touched: where one decides part of a cell, the cell reads as mixed afterwards.
 *
 * With a repository list, each listed repository gets its own rules for the repository-wide groups, and a rule blocks
 * every other repository (`* /repos/*\/*\/**`, Block). Without one, a cell gets rules only where the rules around it
 * wouldn't already give its answer, one path at a time, until every cell reads as chosen.
 */
export function planPolicy(
	set: ConnectionRules,
	choice: PolicyChoice,
	options: {
		readonly templateId: string | undefined;
		readonly host: string;
		readonly projectId?: string;
		readonly now: number;
	},
): PolicyPlan {
	const groups = permissionGroups(options.templateId);
	const repositories =
		choice.repositories === undefined || !hasRepositories(groups)
			? undefined
			: [...new Set(choice.repositories.map((repo) => repo.trim()).filter((repo) => REPO_NAME.test(repo)))].sort();
	const scope = gridScope(options.projectId);
	const others = set.rules.filter((rule) => !isGridRule(rule));
	const desired = new Map<string, Desired>();
	const put = (method: HttpMethod | "*", path: string, action: ConnectionRuleAction) =>
		desired.set(`${method} ${path}`, { method, path, action });

	if (repositories !== undefined) {
		put("*", `/repos/${ANY_REPO}/**`, "deny");
		// Each listed repository's paths always carry the chosen answer: the block on the rest is broader than them all.
		// A group whose answers are the same for every column is one rule per repository, and a path inside another
		// group's repository path (Actions inside a repository) needs none when its answers are the same as that group's.
		const answers = (group: PermissionGroup) => group.accesses.map((access) => choice.cells[cellKey(group.id, access)]);
		const repoPaths: { readonly path: string; readonly answers: string }[] = [];
		for (const group of groups) {
			const chosen = answers(group);
			for (const path of group.paths) {
				if (!path.includes(REPO)) continue;
				const key = group.accesses.map((access, index) => `${access}=${chosen[index]}`).join(",");
				const outer = repoPaths.find((each) => path !== each.path && path.startsWith(each.path.replace(/\*\*$/, "")));
				repoPaths.push({ path, answers: key });
				if (outer !== undefined && outer.answers === key) continue;
				const whole =
					group.accesses.length === POLICY_ACCESSES.length &&
					chosen.every((action) => action !== undefined && action === chosen[0]);
				for (const repo of repositories) {
					const at = path.replaceAll(REPO, repo);
					if (whole && chosen[0] !== undefined) {
						put("*", at, chosen[0]);
						continue;
					}
					group.accesses.forEach((access, index) => {
						const action = chosen[index];
						if (action === undefined) return;
						for (const method of ACCESS_METHODS[access]) put(method, at, action);
					});
				}
			}
		}
	}

	const asRules = (): ConnectionRule[] => [
		...others,
		...[...desired.values()].map(
			(rule, index): ConnectionRule => ({
				id: `planned-${index}`,
				connectionId: set.connectionId,
				who: { kind: "any" },
				what: { kind: "endpoint", method: rule.method, path: rule.path },
				action: rule.action,
				uses: 0,
				source: "person",
				note: GRID_NOTE,
				createdBy: { kind: "system", component: "console" },
				createdAt: options.now,
				updatedAt: options.now,
			}),
		),
	];

	// Path by path, add the rules a unit still lacks, until every unit answers as chosen (or nothing more helps: a rule
	// a person made, more specific than any the grid makes, decides it).
	for (let round = 0; round < 8; round++) {
		const units = unitAnswers({ ...set, rules: asRules() }, groups, repositories, {
			host: options.host,
			scope,
			now: options.now,
		});
		let changed = false;
		for (const unit of units.values()) {
			const action = choice.cells[cellKey(unit.group.id, unit.access)];
			if (action === undefined || unit.answer === action) continue;
			if (
				repositories !== undefined &&
				unit.group.paths.some((path) => path.includes(REPO)) &&
				unit.path.startsWith("/repos/")
			)
				continue;
			for (const method of ACCESS_METHODS[unit.access]) {
				const key = `${method} ${unit.path}`;
				if (desired.get(key)?.action === action) continue;
				put(method, unit.path, action);
				changed = true;
			}
		}
		if (!changed) break;
	}

	const existing = set.rules.filter(isGridRule);
	const create: ConnectionRuleInput[] = [];
	const update: { ruleId: string; action: ConnectionRuleAction }[] = [];
	const kept = new Set<string>();
	for (const rule of desired.values()) {
		const found = existing.find(
			(each) =>
				!kept.has(each.id) &&
				each.what.kind === "endpoint" &&
				each.what.method === rule.method &&
				each.what.path === rule.path,
		);
		if (found === undefined) {
			create.push({
				who: { kind: "any" },
				what: { kind: "endpoint", method: rule.method, path: rule.path },
				action: rule.action,
				note: GRID_NOTE,
			});
			continue;
		}
		kept.add(found.id);
		if (found.action !== rule.action || found.expiresAt !== undefined || found.maxUses !== undefined)
			update.push({ ruleId: found.id, action: rule.action });
	}
	const remove = existing.filter((rule) => !kept.has(rule.id)).map((rule) => rule.id);
	return { create, update, remove };
}

/** The grid's choice as it reads now, with one cell or the repository list changed. Mixed cells keep no answer. */
export function choiceOf(
	grid: PolicyGrid,
	change: {
		readonly cell?: { readonly key: string; readonly action: ConnectionRuleAction };
		readonly repositories?: readonly string[] | null;
	},
): PolicyChoice {
	const cells: Record<string, ConnectionRuleAction> = {};
	for (const [key, answer] of Object.entries(grid.cells)) if (answer !== "mixed") cells[key] = answer;
	if (change.cell !== undefined) cells[change.cell.key] = change.cell.action;
	const repositories =
		change.repositories === undefined
			? grid.repositories
			: change.repositories === null
				? undefined
				: change.repositories;
	return { cells, repositories };
}

const ACCESS_NOUN: Record<PolicyAccess, string> = { read: "Reads", write: "Writes", delete: "Deletes" };

/** One line per column, for a summary: "Reads go through", "Writes ask you first", "Deletes are blocked". */
export interface PolicyLine {
	readonly access: PolicyAccess;
	readonly answer: ConnectionRuleAction | "mixed";
	readonly text: string;
}

/** A column's answer across every group that has it: one answer, or mixed. */
function columnAnswer(grid: PolicyGrid, access: PolicyAccess): ConnectionRuleAction | "mixed" | undefined {
	let seen: ConnectionRuleAction | "mixed" | undefined;
	for (const group of grid.groups) {
		const answer = grid.cells[cellKey(group.id, access)];
		if (answer === undefined) continue;
		seen = seen === undefined || seen === answer ? answer : "mixed";
	}
	return seen;
}

/** The grid in a few lines, one per column. */
export function policyLines(grid: PolicyGrid): PolicyLine[] {
	const lines: PolicyLine[] = [];
	for (const access of POLICY_ACCESSES) {
		const answer = columnAnswer(grid, access);
		if (answer === undefined) continue;
		const noun = ACCESS_NOUN[access];
		const text =
			answer === "allow"
				? `${noun} go through`
				: answer === "ask"
					? `${noun} ask you first`
					: answer === "deny"
						? `${noun} are blocked`
						: `${noun} vary by request`;
		lines.push({ access, answer, text });
	}
	return lines;
}

const SHORT_WORD: Record<ConnectionRuleAction | "mixed", string> = {
	allow: "allowed",
	ask: "ask",
	deny: "blocked",
	mixed: "vary",
};

/**
 * The grid in one line, for a menu: "Reads allowed, writes ask, deletes blocked", with "in 3 repositories" when agents
 * may reach only some.
 */
export function policySentence(grid: PolicyGrid): string {
	const parts = POLICY_ACCESSES.flatMap((access) => {
		const answer = columnAnswer(grid, access);
		return answer === undefined ? [] : [`${ACCESS_NOUN[access].toLowerCase()} ${SHORT_WORD[answer]}`];
	});
	const sentence = parts.join(", ");
	const capital = sentence.charAt(0).toUpperCase() + sentence.slice(1);
	const repos = grid.repositories;
	if (repos === undefined) return capital;
	return `${capital}, only in ${repos.length === 1 ? repos[0] : `${repos.length} repositories`}`;
}

/** Where an exception (a rule the grid didn't make) came from, in words. */
export function ruleOrigin(
	rule: Pick<ConnectionRule, "source" | "who" | "createdAt">,
	formatDate: (at: number) => string,
): string {
	if (rule.who.kind === "session") return "This session only";
	switch (rule.source) {
		case "approval":
			return `From an approval, ${formatDate(rule.createdAt)}`;
		case "default":
			return "A default";
		case "migrated":
			return "Moved from the vault";
		case "person":
			return `Set by a person, ${formatDate(rule.createdAt)}`;
	}
}

/** The rules shown as exceptions under the grid: everything the grid and the template's defaults didn't make. */
export function policyExceptions(set: Pick<ConnectionRules, "rules">): ConnectionRule[] {
	return set.rules.filter((rule) => !isGridRule(rule) && rule.source !== "default");
}
