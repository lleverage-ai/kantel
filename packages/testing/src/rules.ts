/**
 * Conformance suite for `PromptRules` (packages/contracts/src/rules.ts, docs/design/org-scope.md decision 5). Every
 * target registers it with a provider that builds a fresh store on the suite's clock, audit sink and access.
 */
import {
	type CallContext,
	type OwnerRef,
	type PromptRules,
	resolvePromptLayers,
	systemContext,
} from "@kantel/contracts";
import {
	actors,
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface RulesSubject {
	readonly rules: PromptRules;
}

export type RulesConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: RulesSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-rules";
const OTHER_ORG = "org-rules-elsewhere";
const PROJECT = "proj-rules";
const OTHER_PROJECT = "proj-rules-other";

/** An admin across the organisation. */
const admin = contextFor(actors.human("admin-1"), ORG);
/** An admin on the project only. */
const projectAdmin = contextFor(actors.human("padmin-1"), ORG, PROJECT);
/** An operator across the organisation: not enough to change the organisation's rules. */
const orgOperator = contextFor(actors.human("operator-1"), ORG);
/** A viewer on the project. */
const viewer = contextFor(actors.human("viewer-1"), ORG, PROJECT);
/** An operator on another project only. */
const stranger = contextFor(actors.human("stranger-1"), ORG, OTHER_PROJECT);
/** A user with no role anywhere, who owns rules of their own. */
const solo = contextFor(actors.human("solo-1"), ORG);
const projectAgent = contextFor(actors.agent("agent-p", "sess-project"), ORG, PROJECT);
const orgAgent = contextFor(actors.agent("agent-o", "sess-org"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const harbour: CallContext = { ...systemContext("rules-seed"), organisationId: ORG };
const outsiderKantel: CallContext = { ...systemContext("rules-seed"), organisationId: OTHER_ORG };

const organisation: OwnerRef = { kind: "organisation", organisationId: ORG };
const project: OwnerRef = { kind: "project", organisationId: ORG, projectId: PROJECT };
const otherProject: OwnerRef = { kind: "project", organisationId: ORG, projectId: OTHER_PROJECT };
const soloOwner: OwnerRef = { kind: "user", organisationId: ORG, userId: "solo-1" };
const platform: OwnerRef = { kind: "platform" };

function seedTenancy(deps: ConformanceDeps): void {
	const { tenancy } = deps;
	tenancy.bind(admin.actor, ORG, "admin");
	tenancy.bind(projectAdmin.actor, ORG, "admin", PROJECT);
	tenancy.bind(orgOperator.actor, ORG, "operator");
	tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
	tenancy.bind(stranger.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.session({ id: "sess-project", organisationId: ORG, projectId: PROJECT, agentId: "agent-p" });
	tenancy.session({ id: "sess-org", organisationId: ORG, agentId: "agent-o" });
}

export function createRulesConformance(options: {
	assertions: ConformanceAssertions;
	provider: RulesConformanceProvider;
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const withRules = (run: (rules: PromptRules, deps: ConformanceDeps) => Promise<void>) => async () => {
		const deps = createDeps();
		seedTenancy(deps);
		await options.provider(deps, ({ rules }) => run(rules, deps));
	};
	const put = (rules: PromptRules, ctx: CallContext, owner: OwnerRef, name: string, text = `${name} text`, order = 0) =>
		rules.put(ctx, { owner, name, text, order });

	const cases: ConformanceCase[] = [
		{
			name: "puts and lists an owner's rules by order then name, and a put of an existing name replaces that rule",
			run: withRules(async (rules, deps) => {
				const first = await put(rules, admin, organisation, "tone", "Be brief.", 2);
				await put(rules, admin, organisation, "safety", "Ask before deleting.", 1);
				await put(rules, admin, organisation, "audience", "Write for engineers.", 2);
				a.deepEqual(
					(await rules.list(admin, organisation)).map((rule) => rule.name),
					["safety", "audience", "tone"],
				);
				a.partialDeepEqual(first, { owner: organisation, name: "tone", text: "Be brief.", order: 2 });
				deps.clock.advance(1000);
				const replaced = await put(rules, admin, organisation, "tone", "Be very brief.", 0);
				a.strictEqual(replaced.id, first.id, "the rule keeps its ID");
				a.strictEqual(replaced.createdAt, first.createdAt);
				a.ok(replaced.updatedAt > first.updatedAt, "and is updated");
				a.partialDeepEqual(await rules.get(admin, first.id), { text: "Be very brief.", order: 0 });
				a.deepEqual(
					(await rules.list(admin, organisation)).map((rule) => rule.name),
					["tone", "safety", "audience"],
				);
				await rules.remove(admin, first.id);
				await a.rejectsWithCode(rules.get(admin, first.id), "not_found");
				a.strictEqual((await rules.list(admin, organisation)).length, 2);
			}),
		},
		{
			name: "audits each change as rules.rule.put or rules.rule.removed with the rule's ID and owner, never its text",
			run: withRules(async (rules, deps) => {
				const rule = await put(rules, projectAdmin, project, "review", "SECRET-RULE-TEXT");
				await rules.remove(projectAdmin, rule.id);
				const events = [...deps.audit.ofType("rules.rule.put"), ...deps.audit.ofType("rules.rule.removed")];
				a.strictEqual(events.length, 2);
				for (const event of events) {
					a.partialDeepEqual(event, {
						source: "rules",
						organisationId: ORG,
						projectId: PROJECT,
						actor: projectAdmin.actor,
						subject: { kind: "rules.rule", id: rule.id },
						data: { owner: { kind: "project", projectId: PROJECT } },
					});
					a.ok(!JSON.stringify(event).includes("SECRET-RULE-TEXT"), "the audit holds no rule text");
				}
			}),
		},
		{
			name: "rejects a malformed name, empty or oversized text, a fractional order or a malformed owner as invalid",
			run: withRules(async (rules) => {
				for (const name of ["", "-leading", "has space", "x".repeat(101)]) {
					await a.rejectsWithCode(put(rules, admin, organisation, name), "invalid", JSON.stringify(name));
				}
				await a.rejectsWithCode(put(rules, admin, organisation, "empty", "   "), "invalid");
				await a.rejectsWithCode(put(rules, admin, organisation, "big", "x".repeat(32_769)), "invalid");
				await a.rejectsWithCode(put(rules, admin, organisation, "half", "text", 0.5), "invalid");
				await a.rejectsWithCode(
					rules.put(admin, { owner: { kind: "project", organisationId: ORG } as OwnerRef, name: "n", text: "t" }),
					"invalid",
				);
				a.strictEqual((await rules.list(admin, organisation)).length, 0);
			}),
		},
		{
			name: "platform rules: only Kantel writes them, and every organisation reads them",
			run: withRules(async (rules, deps) => {
				// Started after the suite counts the audit rows: the refusal may be audited before the call's first await.
				const later = (call: () => Promise<unknown>) => Promise.resolve().then(call);
				await assertAccessDenied(
					a,
					deps,
					later(() => put(rules, admin, platform, "house")),
					{ operation: "rules.rule.put" },
				);
				const rule = await put(rules, harbour, platform, "house", "Platform rule.");
				a.deepEqual(rule.owner, platform);
				a.deepEqual(
					(await rules.list(outsider, platform)).map((each) => each.id),
					[rule.id],
				);
				a.partialDeepEqual(await rules.get(solo, rule.id), { text: "Platform rule." });
				await assertAccessDenied(
					a,
					deps,
					later(() => rules.remove(admin, rule.id)),
					{ operation: "rules.rule.remove" },
				);
				await rules.remove(outsiderKantel, rule.id);
				a.deepEqual(await rules.list(admin, platform), []);
			}),
		},
		{
			name: "another organisation's rules and owners are not_found",
			run: withRules(async (rules) => {
				const rule = await put(rules, admin, organisation, "tone");
				await a.rejectsWithCode(rules.get(outsider, rule.id), "not_found");
				await a.rejectsWithCode(rules.remove(outsider, rule.id), "not_found");
				await a.rejectsWithCode(rules.list(outsider, organisation), "not_found");
				await a.rejectsWithCode(put(rules, outsider, organisation, "taken"), "not_found");
				await a.rejectsWithCode(rules.get(admin, "rule_missing"), "not_found");
				a.strictEqual((await rules.list(admin, organisation)).length, 1);
			}),
		},
		{
			name: "forSession: platform, organisation, project then user rules, and resolvePromptLayers puts the profile before the user's",
			run: withRules(async (rules) => {
				await put(rules, harbour, platform, "house", "P");
				await put(rules, admin, organisation, "org", "O");
				await put(rules, admin, project, "proj", "J");
				await put(rules, admin, otherProject, "elsewhere", "X");
				await put(rules, solo, soloOwner, "mine", "U");
				await put(rules, admin, { kind: "user", organisationId: ORG, userId: "someone-else" }, "theirs", "Y");
				const forProject = await rules.forSession(harbour, { projectId: PROJECT, userId: "solo-1" });
				a.deepEqual(
					forProject.map((rule) => rule.text),
					["P", "O", "J", "U"],
				);
				a.deepEqual(resolvePromptLayers(forProject, [{ name: "role", text: "R" }]), [
					{ name: "rules:platform:house", text: "P" },
					{ name: "rules:organisation:org", text: "O" },
					{ name: "rules:project:proj", text: "J" },
					{ name: "role", text: "R" },
					{ name: "rules:user:mine", text: "U" },
				]);
				// An organisation session has no project layer.
				a.deepEqual(
					(await rules.forSession(harbour, { userId: "solo-1" })).map((rule) => rule.text),
					["P", "O", "U"],
				);
				a.deepEqual(
					(await rules.forSession(harbour, {})).map((rule) => rule.text),
					["P", "O"],
				);
			}),
		},
	];
	if (options.projectAccess !== true) return cases;

	cases.push(
		{
			name: "user rules: that user writes their own; an organisation-wide admin may too, and nobody else",
			run: withRules(async (rules, deps) => {
				const own = await put(rules, solo, soloOwner, "style", "Use British English.");
				await put(rules, admin, soloOwner, "by-admin");
				for (const other of [orgOperator, viewer, projectAdmin]) {
					await assertAccessDenied(a, deps, put(rules, other, soloOwner, "nope"), { operation: "rules.rule.put" });
				}
				await assertAccessDenied(a, deps, rules.remove(orgOperator, own.id), { operation: "rules.rule.remove" });
				// Open to the organisation to read, as a user's skills are.
				a.deepEqual(
					(await rules.list(stranger, soloOwner)).map((rule) => rule.name),
					["by-admin", "style"],
				);
			}),
		},
		{
			name: "writes by owner: organisation rules need an organisation-wide admin, a project's an admin on the project",
			run: withRules(async (rules, deps) => {
				const denied = (call: Promise<unknown>) => assertAccessDenied(a, deps, call, { operation: "rules.rule.put" });
				await denied(put(rules, orgOperator, organisation, "tone"));
				await denied(put(rules, projectAdmin, organisation, "tone"));
				await denied(put(rules, viewer, project, "tone"));
				await denied(put(rules, stranger, project, "tone"));
				await denied(put(rules, projectAdmin, otherProject, "tone"));
				await put(rules, projectAdmin, project, "tone");
				await put(rules, admin, project, "admin-too");
				await put(rules, admin, organisation, "tone");
				a.strictEqual((await rules.list(admin, project)).length, 2);
				a.strictEqual((await rules.list(admin, organisation)).length, 1);
				a.strictEqual((await rules.list(admin, otherProject)).length, 0);
			}),
		},
		{
			name: "agents never write rules, an organisation session's agent included, and each refusal is audited",
			run: withRules(async (rules, deps) => {
				const existing = await put(rules, admin, organisation, "tone");
				for (const agent of [projectAgent, orgAgent]) {
					for (const owner of [organisation, project, soloOwner]) {
						await assertAccessDenied(a, deps, put(rules, agent, owner, "agent-rule"), {
							operation: "rules.rule.put",
						});
					}
					await assertAccessDenied(a, deps, rules.remove(agent, existing.id), { operation: "rules.rule.remove" });
				}
				a.deepEqual(
					(await rules.list(admin, organisation)).map((rule) => rule.name),
					["tone"],
				);
				a.strictEqual((await rules.list(admin, project)).length, 0);
			}),
		},
		{
			name: "reads: a project's rules need viewer on it; the organisation's are open to its members and agents",
			run: withRules(async (rules, deps) => {
				const projectRule = await put(rules, admin, project, "proj");
				await put(rules, admin, organisation, "org");
				a.strictEqual((await rules.list(viewer, project)).length, 1);
				a.strictEqual((await rules.list(projectAgent, project)).length, 1);
				await assertAccessDenied(a, deps, rules.list(stranger, project), { operation: "rules.rule.list" });
				await assertAccessDenied(a, deps, rules.get(stranger, projectRule.id), { operation: "rules.rule.get" });
				// An organisation session's agent reads the organisation's rules, never a project's.
				await assertAccessDenied(a, deps, rules.list(orgAgent, project), { operation: "rules.rule.list" });
				await assertAccessDenied(a, deps, rules.forSession(orgAgent, { projectId: PROJECT }), {
					operation: "rules.rule.list",
				});
				for (const reader of [stranger, solo, orgAgent, projectAgent]) {
					a.strictEqual((await rules.list(reader, organisation)).length, 1);
				}
			}),
		},
	);
	return cases;
}

export function registerRulesConformance(
	runner: ConformanceRunner,
	name: string,
	provider: RulesConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createRulesConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
		}),
	);
}
