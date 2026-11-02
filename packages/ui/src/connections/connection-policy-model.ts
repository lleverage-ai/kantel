import {
	type ConnectionOperation,
	type ConnectionRule,
	type ConnectionRuleAction,
	type ConnectionRuleInput,
	type ConnectionRules,
	type ConnectionRuleWhat,
	type ConnectionRuleWho,
	decideConnectionRules,
	type HttpMethod,
	methodAccess,
	type RuleScope,
	type UpdateConnectionRuleInput,
} from "@kantel/contracts";

// "What agents may do" (#462): a connection's rules as a grid of permission groups by read, write and delete, each
// Allow, Ask or Block, with what scheduled runs get beside them (#466), and an optional list of the only repositories
// agents may reach.
//
// The grid is a view of the connection's ordinary rules, not a store of its own. Each cell is read by asking the
// contract's own decision (`decideConnectionRules`) what a request of that kind would get, so the grid, the rule list
// and the dry run always agree. Setting a cell compiles to ordinary rules, marked with `GRID_NOTE`; only rules with that
// mark are ever changed or removed by the grid, so the template's defaults, a person's own rules and rules from
// approvals stay as they are, and show as exceptions.
//
// For a template that classifies its requests (#465, GitHub), the grid's rules are operation rules (#466): a cell is
// `{ group, access }`, so a GraphQL query reads and a mutation writes, and a listed repository is `{ group, access,
// resource }`. For any other template a group is a set of path patterns and an access a set of methods (reads GET and
// HEAD, writes POST, PUT and PATCH, deletes DELETE), and the grid's rules are endpoint rules.
//
// The scheduled-runs column ("In scheduled runs", mockup D) is a rule for `who: unattended` beside each cell it
// changes, never looser than the cell: Same adds none, Reads only blocks writes and deletes, Block blocks everything.
// Where a cell asks, a scheduled run waits for an approver as any session does (#466).

/** What a request does, as the grid's columns say it. */
export type PolicyAccess = "read" | "write" | "delete";

export const POLICY_ACCESSES: readonly PolicyAccess[] = ["read", "write", "delete"];

/** The methods each column covers. */
export const ACCESS_METHODS: Readonly<Record<PolicyAccess, readonly HttpMethod[]>> = {
	read: ["GET", "HEAD"],
	write: ["POST", "PUT", "PATCH"],
	delete: ["DELETE"],
};

/** What scheduled runs get in a group, beside what attended sessions get (#466). */
export type ScheduledMode = "same" | "reads" | "block";

export const SCHEDULED_MODES: readonly ScheduledMode[] = ["same", "reads", "block"];

/** The modes a group offers: one with only reads has nothing to keep to reads. */
export function scheduledModes(group: Pick<PermissionGroup, "accesses">): readonly ScheduledMode[] {
	return group.accesses.some((access) => access !== "read") ? SCHEDULED_MODES : ["same", "block"];
}

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

/**
 * Whether a template's requests are classified (#465), so its grid writes operation rules: GitHub's. Its groups' IDs
 * are the classification's own (`profile`, `repo`, `workflow`).
 */
export function classifiesOperations(templateId: string | undefined): boolean {
	return templateId === "github";
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

const inRepositories = (group: PermissionGroup): boolean => group.paths.some((path) => path.includes(REPO));

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
	/** What scheduled runs get in each group, by its ID: `mixed` when no mode says it. */
	readonly scheduled: Readonly<Record<string, ScheduledMode | "mixed">>;
	/** The only repositories agents may reach, or undefined for every one the connection reaches. */
	readonly repositories: readonly string[] | undefined;
}

/** What a person sets: every cell's answer, what scheduled runs get, and the repository list. */
export interface PolicyChoice {
	readonly cells: Readonly<Record<string, ConnectionRuleAction>>;
	/** By group ID; a group left out is `same`. */
	readonly scheduled?: Readonly<Record<string, ScheduledMode>>;
	readonly repositories: readonly string[] | undefined;
}

/** The scope the grid reads for: any agent, in the connection's project when it has one; attended unless asked. */
export function gridScope(projectId?: string, unattended = false): RuleScope {
	return {
		...(projectId === undefined ? {} : { projectId }),
		agentId: "\u0000grid",
		sessionId: "\u0000grid",
		...(unattended ? { unattended: true } : {}),
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

const GRID_WHO: ReadonlySet<ConnectionRuleWho["kind"]> = new Set(["any", "unattended"]);

const isGridRule = (rule: Pick<ConnectionRule, "note" | "who" | "what">): boolean =>
	rule.note === GRID_NOTE &&
	GRID_WHO.has(rule.who.kind) &&
	((rule.what.kind === "endpoint" && rule.what.host === undefined) || rule.what.kind === "operation");

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

/**
 * The repositories the grid's own rules list, when it blocks the rest: operation rules naming one (`{ resource }` beside
 * a block on `*\/*`), or endpoint rules under `/repos/owner/name` beside a block on `/repos/*\/*\/**`.
 */
function listedRepositories(rules: readonly ConnectionRule[]): string[] | undefined {
	const grid = rules.filter((rule) => isGridRule(rule) && rule.who.kind === "any");
	const repos = new Set<string>();
	const operationBlock = grid.some(
		(rule) => rule.action === "deny" && rule.what.kind === "operation" && rule.what.resource === ANY_REPO,
	);
	if (operationBlock) {
		for (const rule of grid) {
			if (rule.what.kind !== "operation" || rule.what.resource === undefined) continue;
			if (REPO_NAME.test(rule.what.resource)) repos.add(rule.what.resource);
		}
		return [...repos].sort();
	}
	const blocksRest = grid.some(
		(rule) =>
			rule.action === "deny" &&
			rule.what.kind === "endpoint" &&
			rule.what.method === "*" &&
			rule.what.path === `/repos/${ANY_REPO}/**`,
	);
	if (!blocksRest) return undefined;
	for (const rule of grid) {
		if (rule.what.kind !== "endpoint") continue;
		const match = /^\/repos\/([^/*]+\/[^/*]+)\/(?:actions\/)?\*\*$/.exec(rule.what.path);
		if (match?.[1] !== undefined) repos.add(match[1]);
	}
	return [...repos].sort();
}

type RuleSet = Pick<ConnectionRules, "rules" | "unmatched" | "version">;

/** One request the grid asks the rules about. */
interface Unit {
	readonly group: PermissionGroup;
	readonly access: PolicyAccess;
	readonly path: string;
	/** For a classifying template: the repository the request names, if any. */
	readonly resource?: string;
}

/** What a sample request does, as the template would classify it: by method, in the group, in the repository. */
function sampleOperation(
	group: PermissionGroup,
	method: HttpMethod,
	resource: string | undefined,
): ConnectionOperation {
	return {
		label: `${method} in ${group.label}`,
		group: group.id,
		access: methodAccess(method),
		...(resource === undefined ? {} : { resource }),
	};
}

/**
 * The requests each cell is read from. For a classifying template, a group in repositories is read in one (each listed
 * one, or a sample); requests that name none (GraphQL, search) get the cell's rule too, and in a list the stricter of it
 * and Ask. For any other template, one per path pattern.
 */
function unitsOf(
	groups: readonly PermissionGroup[],
	repositories: readonly string[] | undefined,
	operations: boolean,
): Unit[] {
	const sampleRepo = repositories?.[0] ?? "owner/repo";
	const out: Unit[] = [];
	for (const group of groups) {
		for (const access of group.accesses) {
			if (operations) {
				if (!inRepositories(group)) {
					out.push({ group, access, path: samplePath(group.paths[0] ?? "/", sampleRepo) });
					continue;
				}
				const repoPath = group.paths.find((path) => path.includes(REPO)) ?? `/repos/${REPO}/**`;
				for (const repo of repositories ?? [sampleRepo])
					out.push({ group, access, path: samplePath(repoPath, repo), resource: repo });
				continue;
			}
			for (const path of groupPaths(group, repositories))
				out.push({ group, access, path: samplePath(path, sampleRepo) });
		}
	}
	return out;
}

/** The answer one unit gets, over every method of its column: one, or mixed. */
function unitAnswer(
	set: RuleSet,
	unit: Unit,
	options: { readonly host: string; readonly scope: RuleScope; readonly now: number; readonly operations: boolean },
): ConnectionRuleAction | "mixed" {
	const answers = new Set(
		ACCESS_METHODS[unit.access].map(
			(method) =>
				decideConnectionRules(
					set,
					options.scope,
					{
						kind: "http",
						method,
						host: options.host,
						path: unit.path,
						...(options.operations ? { operation: sampleOperation(unit.group, method, unit.resource) } : {}),
					},
					options.now,
				).action,
		),
	);
	return answers.size === 1 ? ([...answers][0] as ConnectionRuleAction) : "mixed";
}

const merge = (seen: ConnectionRuleAction | "mixed" | undefined, next: ConnectionRuleAction | "mixed") =>
	seen === undefined || seen === next ? next : "mixed";

const STRICT: Record<ConnectionRuleAction, number> = { allow: 0, ask: 1, deny: 2 };
const stricter = (a: ConnectionRuleAction, b: ConnectionRuleAction | undefined): ConnectionRuleAction =>
	b === undefined || STRICT[a] >= STRICT[b] ? a : b;

/** What a mode asks of an access, before the cell's own answer: undefined leaves the cell's. */
function modeAction(mode: ScheduledMode, access: PolicyAccess | "admin"): ConnectionRuleAction | undefined {
	switch (mode) {
		case "same":
			return undefined;
		case "reads":
			return access === "read" ? undefined : "deny";
		case "block":
			return "deny";
	}
}

interface ReadOptions {
	readonly templateId: string | undefined;
	readonly host: string;
	readonly projectId?: string;
	readonly now: number;
}

/** The grid as the rules say it now. */
export function readPolicyGrid(set: ConnectionRules, options: ReadOptions): PolicyGrid {
	const groups = permissionGroups(options.templateId);
	const operations = classifiesOperations(options.templateId);
	const repositories = hasRepositories(groups) ? listedRepositories(set.rules) : undefined;
	const units = unitsOf(groups, repositories, operations);
	const attended = { host: options.host, scope: gridScope(options.projectId), now: options.now, operations };
	const unattended = { ...attended, scope: gridScope(options.projectId, true) };
	const cells: Record<string, ConnectionRuleAction | "mixed"> = {};
	const pairs = new Map<string, { at: ConnectionRuleAction | "mixed"; un: ConnectionRuleAction | "mixed" }[]>();
	for (const unit of units) {
		const at = unitAnswer(set, unit, attended);
		const un = unitAnswer(set, unit, unattended);
		const key = cellKey(unit.group.id, unit.access);
		cells[key] = merge(cells[key], at);
		pairs.set(key, [...(pairs.get(key) ?? []), { at, un }]);
	}
	const scheduled: Record<string, ScheduledMode | "mixed"> = {};
	for (const group of groups) {
		// A group with scheduled-run rules of the grid's reads as their mode even where it gives the cell's answer, so
		// Reads only stays chosen while writes are blocked anyway.
		const own = set.rules.some(
			(rule) => isGridRule(rule) && rule.who.kind === "unattended" && ruleInGroup(rule.what, group, operations),
		);
		const order: readonly ScheduledMode[] = own ? ["reads", "block", "same"] : ["same", "reads", "block"];
		const fits = (mode: ScheduledMode) =>
			group.accesses.every((access) =>
				(pairs.get(cellKey(group.id, access)) ?? []).every(
					({ at, un }) => at !== "mixed" && un === stricter(at, modeAction(mode, access)),
				),
			);
		scheduled[group.id] = order.filter((mode) => scheduledModes(group).includes(mode)).find(fits) ?? "mixed";
	}
	return { groups, cells, scheduled, repositories };
}

/** Whether a grid rule's what is one of a group's. */
function ruleInGroup(what: ConnectionRuleWhat, group: PermissionGroup, operations: boolean): boolean {
	if (operations) return what.kind === "operation" && what.group === group.id;
	if (what.kind !== "endpoint") return false;
	return group.paths.some((path) =>
		path.includes(REPO) ? /^\/repos\/[^/]+\/[^/]+\//.test(what.path) : what.path === path,
	);
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

type GridWho = Extract<ConnectionRuleWho, { kind: "any" | "unattended" }>;
type GridWhat = Extract<ConnectionRuleWhat, { kind: "endpoint" | "operation" }>;
type Desired = { who: GridWho; what: GridWhat; action: ConnectionRuleAction };

/** A grid rule's identity: who and what, in a fixed order. */
const ruleKey = (who: ConnectionRuleWho, what: ConnectionRuleWhat): string =>
	what.kind === "endpoint"
		? `${who.kind} endpoint ${what.method} ${what.path}`
		: what.kind === "operation"
			? `${who.kind} operation ${what.group ?? ""} ${what.access ?? ""} ${what.resource ?? ""}`
			: `${who.kind} ${what.kind}`;

const operationWhat = (group: string, access?: PolicyAccess | "admin", resource?: string): GridWhat => ({
	kind: "operation",
	group,
	...(access === undefined ? {} : { access }),
	...(resource === undefined ? {} : { resource }),
});

/**
 * The fewest grid rules that make the rules answer `choice`, and the changes from the grid's rules today. Rules the grid
 * didn't make are never touched: where one decides part of a cell, the cell reads as mixed afterwards.
 *
 * With a repository list, each listed repository gets its own rules for the repository-wide groups, and a rule blocks
 * every other repository. Without one, a cell gets rules only where the rules around it wouldn't already give its
 * answer. Scheduled runs get a rule beside each cell their mode makes stricter.
 */
export function planPolicy(set: ConnectionRules, choice: PolicyChoice, options: ReadOptions): PolicyPlan {
	const groups = permissionGroups(options.templateId);
	const operations = classifiesOperations(options.templateId);
	const repositories =
		choice.repositories === undefined || !hasRepositories(groups)
			? undefined
			: [...new Set(choice.repositories.map((repo) => repo.trim()).filter((repo) => REPO_NAME.test(repo)))].sort();
	const others = set.rules.filter((rule) => !isGridRule(rule));
	const desired = new Map<string, Desired>();
	const put = (who: GridWho, what: GridWhat, action: ConnectionRuleAction) =>
		desired.set(ruleKey(who, what), { who, what, action });
	const ANY: GridWho = { kind: "any" };
	const UNATTENDED: GridWho = { kind: "unattended" };
	const cell = (group: PermissionGroup, access: PolicyAccess) => choice.cells[cellKey(group.id, access)];

	const asRules = (): ConnectionRule[] => [
		...others,
		...[...desired.values()].map(
			(rule, index): ConnectionRule => ({
				id: `planned-${index}`,
				connectionId: set.connectionId,
				who: rule.who,
				what: rule.what,
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
	const attended = {
		host: options.host,
		scope: gridScope(options.projectId),
		now: options.now,
		operations,
	};

	if (operations) planOperations();
	else planEndpoints();

	// Scheduled runs: beside each cell a mode makes stricter, a rule for unattended runs on the same what.
	for (const group of groups) {
		const mode = choice.scheduled?.[group.id] ?? "same";
		if (mode === "same" || !scheduledModes(group).includes(mode)) continue;
		for (const access of group.accesses) {
			const asked = modeAction(mode, access);
			const chosen = cell(group, access);
			if (asked === undefined || chosen === undefined) continue;
			const action = stricter(chosen, asked);
			if (operations) put(UNATTENDED, operationWhat(group.id, access), action);
			else
				for (const path of groupPaths(group, repositories))
					for (const method of ACCESS_METHODS[access]) put(UNATTENDED, { kind: "endpoint", method, path }, action);
		}
		if (operations && group.accesses.includes("write")) {
			const asked = modeAction(mode, "admin");
			if (asked !== undefined) put(UNATTENDED, operationWhat(group.id, "admin"), stricter("ask", asked));
		}
	}

	function planOperations() {
		// Every cell's answer for requests of its kind, where the rules around it don't already give it; with a list, for
		// requests that name no repository, never looser than Ask (a GraphQL mutation can reach any repository).
		for (const group of groups) {
			const write = cell(group, "write");
			if (repositories !== undefined && inRepositories(group)) {
				put(ANY, operationWhat(group.id, undefined, ANY_REPO), "deny");
				for (const repo of repositories) {
					// Admin changes in a listed repository ask, as they do anywhere, unless writes there are blocked.
					put(ANY, operationWhat(group.id, undefined, repo), stricter("ask", write === "deny" ? "deny" : undefined));
					for (const access of group.accesses) {
						const action = cell(group, access);
						if (action !== undefined) put(ANY, operationWhat(group.id, access, repo), action);
					}
				}
				for (const access of group.accesses) {
					const action = cell(group, access);
					if (action !== undefined)
						put(ANY, operationWhat(group.id, access), access === "read" ? action : stricter(action, "ask"));
				}
				continue;
			}
			for (const access of group.accesses) {
				const action = cell(group, access);
				if (action === undefined) continue;
				const units = unitsOf([group], undefined, true).filter((unit) => unit.access === access);
				const rules = { ...set, rules: asRules() };
				if (units.every((unit) => unitAnswer(rules, unit, attended) === action)) continue;
				put(ANY, operationWhat(group.id, access), action);
			}
			// Writes blocked: admin changes, which ask by default, are blocked too.
			if (write === "deny") put(ANY, operationWhat(group.id, "admin"), "deny");
		}
	}

	function planEndpoints() {
		if (repositories !== undefined) {
			put(ANY, { kind: "endpoint", method: "*", path: `/repos/${ANY_REPO}/**` }, "deny");
			// Each listed repository's paths always carry the chosen answer: the block on the rest is broader than them all.
			// A group whose answers are the same for every column is one rule per repository, and a path inside another
			// group's repository path (Actions inside a repository) needs none when its answers are the same as that group's.
			const answers = (group: PermissionGroup) => group.accesses.map((access) => cell(group, access));
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
							put(ANY, { kind: "endpoint", method: "*", path: at }, chosen[0]);
							continue;
						}
						group.accesses.forEach((access, index) => {
							const action = chosen[index];
							if (action === undefined) return;
							for (const method of ACCESS_METHODS[access]) put(ANY, { kind: "endpoint", method, path: at }, action);
						});
					}
				}
			}
		}
		// Path by path, add the rules a unit still lacks, until every unit answers as chosen (or nothing more helps: a rule
		// a person made, more specific than any the grid makes, decides it).
		for (let round = 0; round < 8; round++) {
			const rules = { ...set, rules: asRules() };
			let changed = false;
			for (const group of groups) {
				for (const access of group.accesses) {
					const action = cell(group, access);
					if (action === undefined) continue;
					for (const path of groupPaths(group, repositories)) {
						if (repositories !== undefined && inRepositories(group) && path.startsWith("/repos/")) continue;
						const unit = { group, access, path: samplePath(path, repositories?.[0] ?? "owner/repo") };
						if (unitAnswer(rules, unit, attended) === action) continue;
						for (const method of ACCESS_METHODS[access]) {
							const what: GridWhat = { kind: "endpoint", method, path };
							if (desired.get(ruleKey(ANY, what))?.action === action) continue;
							put(ANY, what, action);
							changed = true;
						}
					}
				}
			}
			if (!changed) break;
		}
	}

	const existing = set.rules.filter(isGridRule);
	const create: ConnectionRuleInput[] = [];
	const update: { ruleId: string; action: ConnectionRuleAction }[] = [];
	const kept = new Set<string>();
	for (const rule of desired.values()) {
		const key = ruleKey(rule.who, rule.what);
		const found = existing.find((each) => !kept.has(each.id) && ruleKey(each.who, each.what) === key);
		if (found === undefined) {
			create.push({ who: rule.who, what: rule.what, action: rule.action, note: GRID_NOTE });
			continue;
		}
		kept.add(found.id);
		if (found.action !== rule.action || found.expiresAt !== undefined || found.maxUses !== undefined)
			update.push({ ruleId: found.id, action: rule.action });
	}
	const remove = existing.filter((rule) => !kept.has(rule.id)).map((rule) => rule.id);
	return { create, update, remove };
}

/**
 * The grid's choice as it reads now, with one cell, one group's scheduled runs or the repository list changed. Mixed
 * cells and modes keep no answer.
 */
export function choiceOf(
	grid: PolicyGrid,
	change: {
		readonly cell?: { readonly key: string; readonly action: ConnectionRuleAction };
		readonly scheduled?: { readonly group: string; readonly mode: ScheduledMode };
		readonly repositories?: readonly string[] | null;
	},
): PolicyChoice {
	const cells: Record<string, ConnectionRuleAction> = {};
	for (const [key, answer] of Object.entries(grid.cells)) if (answer !== "mixed") cells[key] = answer;
	if (change.cell !== undefined) cells[change.cell.key] = change.cell.action;
	const scheduled: Record<string, ScheduledMode> = {};
	for (const [group, mode] of Object.entries(grid.scheduled ?? {})) if (mode !== "mixed") scheduled[group] = mode;
	if (change.scheduled !== undefined) scheduled[change.scheduled.group] = change.scheduled.mode;
	const repositories =
		change.repositories === undefined
			? grid.repositories
			: change.repositories === null
				? undefined
				: change.repositories;
	return { cells, scheduled, repositories };
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

/** Scheduled runs across the groups, in words, or undefined when they get the same answers everywhere. */
export function scheduledLine(grid: PolicyGrid): string | undefined {
	const modes = new Set(grid.groups.map((group) => grid.scheduled?.[group.id] ?? "same"));
	if (modes.size === 1 && modes.has("same")) return undefined;
	if (modes.size === 1) {
		const [mode] = modes;
		if (mode === "reads") return "Scheduled runs only read";
		if (mode === "block") return "Scheduled runs are blocked";
	}
	return "Scheduled runs get stricter answers in some areas";
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
