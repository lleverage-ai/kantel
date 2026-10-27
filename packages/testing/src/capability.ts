/**
 * Conformance suite for `CapabilityRegistry` (packages/contracts/src/capability.ts). Every target registers it with a
 * provider that builds a fresh registry on the suite's clock, audit sink and project access, and a way to crash a call
 * mid-flight.
 */
import type {
	CallContext,
	CapabilityDefinition,
	CapabilityGrant,
	CapabilityHandler,
	CapabilityInvocation,
	CapabilityRegistry,
	CapabilityResult,
	InvokeInput,
	ReplayPolicy,
	SessionEndReason,
} from "@harbour/contracts";
import {
	actors,
	assertAccessDenied,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	eventually,
	registerCases,
} from "./harness.ts";

export interface CapabilitySubject {
	readonly registry: CapabilityRegistry;
	/**
	 * Invokes as `ctx` and makes the process "die" before the call commits, leaving a `started` journal entry without
	 * a result. Resolves once that state is in place; the handler may or may not have run.
	 */
	crashMidCall(input: { readonly ctx: CallContext; readonly invoke: InvokeInput }): Promise<void>;
}

export type CapabilityConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: CapabilitySubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const operator = contextFor(actors.human("operator-1"), ORG, PROJECT);
const host = contextFor(actors.service("host-1", "key-1"), ORG, PROJECT);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT);
const otherAgent = contextFor(actors.agent("agent-2", "session-2"), ORG, PROJECT);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG, PROJECT);
const outsiderAgent = contextFor(actors.agent("agent-1", "session-b1"), OTHER_ORG, PROJECT);
const SESSION_END_REASONS: readonly SessionEndReason[] = ["session_ended", "aborted"];
/** The session-end hook's context: a system actor in the session's organisation. */
const sessionEnder = contextFor(actors.system("session-end"), ORG);

// For the project-access cases: an operator on the project only, an operator on another project only, and an agent
// whose session is in another project but which names this one.
const projectOperator = contextFor(actors.human("project-operator-1"), ORG, PROJECT);
const stranger = contextFor(actors.human("stranger-1"), ORG, PROJECT);
const strangerAgent = contextFor(actors.agent("agent-9", "session-9"), ORG, PROJECT);
const strangerAgentAtHome = contextFor(actors.agent("agent-9", "session-9"), ORG, OTHER_PROJECT);

/** The roles and agent sessions every case acts with, seeded whether or not the project-access cases run. */
function seedTenancy(deps: ConformanceDeps): void {
	const { tenancy } = deps;
	tenancy.bind(operator.actor, ORG, "operator");
	tenancy.bind(host.actor, ORG, "operator");
	tenancy.bind(outsider.actor, OTHER_ORG, "operator");
	tenancy.bind(projectOperator.actor, ORG, "operator", PROJECT);
	tenancy.bind(stranger.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	tenancy.session({ id: "session-2", organisationId: ORG, projectId: PROJECT, agentId: "agent-2" });
	tenancy.session({ id: "session-3", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	tenancy.session({ id: "session-9", organisationId: ORG, projectId: OTHER_PROJECT, agentId: "agent-9" });
	tenancy.session({ id: "session-b1", organisationId: OTHER_ORG, projectId: PROJECT, agentId: "agent-1" });
}

function definition(name: string, replay: ReplayPolicy = "safe", version = "1"): CapabilityDefinition {
	return {
		name,
		version,
		description: `The ${name} capability`,
		inputSchema: { type: "object" },
		replay,
		runsIn: "host",
	};
}

interface Recorder {
	readonly calls: CapabilityInvocation[];
	readonly handler: CapabilityHandler;
}

/** A handler that records every invocation and answers with `respond` (by default, an echo of the arguments). */
function recorder(
	respond: (invocation: CapabilityInvocation, signal: AbortSignal) => Promise<CapabilityResult> = async (
		invocation,
	) => ({ output: { echo: invocation.args } }),
): Recorder {
	const calls: CapabilityInvocation[] = [];
	return {
		calls,
		handler: async (invocation, signal) => {
			calls.push(invocation);
			return respond(invocation, signal);
		},
	};
}

function names(definitions: readonly CapabilityDefinition[]): string[] {
	return definitions.map((entry) => entry.name).sort();
}

function statusById(grants: readonly CapabilityGrant[]): Record<string, CapabilityGrant["status"]> {
	return Object.fromEntries(grants.map((grant) => [grant.id, grant.status]));
}

export function createCapabilityConformance(options: {
	assertions: ConformanceAssertions;
	provider: CapabilityConformanceProvider;
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (subject: CapabilitySubject, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject, deps));
		},
	});

	/** Registers `definitions` as the host service and grants them to agent-1's session. */
	async function registerAndGrant(
		registry: CapabilityRegistry,
		definitions: readonly CapabilityDefinition[],
		handler: CapabilityHandler,
	) {
		const subscription = await registry.register(host, definitions, handler);
		const grant = await registry.grant(operator, {
			selector: { sessionId: "session-1" },
			capabilities: definitions.map((entry) => entry.name),
		});
		return { subscription, grant };
	}

	/** Asserts, through `assertAccessDenied`, that a call is refused by project access. */
	const deniedIn =
		(deps: ConformanceDeps) =>
		(call: Promise<unknown>, operation: string, message: string): Promise<void> =>
			assertAccessDenied(assert, deps, call, { operation, message });

	function sessionEndCase(reason: SessionEndReason): ConformanceCase {
		return test(`ends the session's grants at session end (${reason}), leaving other sessions' grants and those selected only by project or agent, and does nothing the second time`, async ({
			registry,
		}, deps) => {
			const handler = recorder();
			await registry.register(
				host,
				["tool.session", "tool.exact", "tool.expiring", "tool.revoked", "tool.project", "tool.agent"].map((name) =>
					definition(name),
				),
				handler.handler,
			);
			const own = await registry.grant(operator, {
				selector: { sessionId: "session-1" },
				capabilities: ["tool.session"],
			});
			const exact = await registry.grant(operator, {
				selector: { projectId: PROJECT, agentId: "agent-1", sessionId: "session-1" },
				capabilities: ["tool.exact"],
			});
			const expiring = await registry.grant(operator, {
				selector: { sessionId: "session-1" },
				capabilities: ["tool.expiring"],
				ttlMs: 1_000,
			});
			const revoked = await registry.grant(operator, {
				selector: { sessionId: "session-1" },
				capabilities: ["tool.revoked"],
			});
			await registry.revokeGrant(operator, revoked.id);
			const otherSession = await registry.grant(operator, {
				selector: { sessionId: "session-2" },
				capabilities: ["tool.session"],
			});
			const byProject = await registry.grant(operator, {
				selector: { projectId: PROJECT },
				capabilities: ["tool.project"],
			});
			const byAgent = await registry.grant(operator, {
				selector: { agentId: "agent-1" },
				capabilities: ["tool.agent"],
			});
			await registry.invoke(agent, { callId: "call-1", capability: "tool.session", args: {} });
			deps.clock.advance(1_000);
			const revokedBefore = deps.audit.ofType("capability.grant.revoked").length;

			await registry.endSession(sessionEnder, "session-1", reason);

			const statuses = statusById((await registry.listGrants(operator)).items);
			assert.deepEqual(
				statuses,
				{
					[own.id]: "revoked",
					[exact.id]: "revoked",
					[expiring.id]: "expired",
					[revoked.id]: "revoked",
					[otherSession.id]: "active",
					[byProject.id]: "active",
					[byAgent.id]: "active",
				},
				"the session's active grants are revoked; an expired one stays expired; every other grant stays active",
			);
			assert.deepEqual(
				names(await registry.discover(agent)),
				["tool.agent", "tool.project"],
				"the session no longer discovers its ended grants",
			);
			assert.deepEqual(
				names(await registry.discover(otherAgent)),
				["tool.project", "tool.session"],
				"another session keeps its grants",
			);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.session", args: {} }),
				"forbidden",
				"a retry under an ended grant is refused",
			);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-2", capability: "tool.exact", args: {} }),
				"forbidden",
				"a new call under an ended grant is refused",
			);
			await registry.invoke(agent, { callId: "call-3", capability: "tool.project", args: {} });
			await registry.invoke(otherAgent, { callId: "call-4", capability: "tool.session", args: {} });
			assert.strictEqual(handler.calls.length, 3, "grants the session did not hold still work");

			const ended = deps.audit.ofType("capability.grant.revoked").slice(revokedBefore);
			assert.deepEqual(
				ended.map((event) => event.subject?.id).sort(),
				[own.id, exact.id].sort(),
				"each grant the session ended is audited once",
			);
			for (const event of ended) {
				assert.partialDeepEqual(event, {
					source: "capability",
					organisationId: ORG,
					sessionId: "session-1",
					actor: sessionEnder.actor,
					data: { reason },
				});
			}

			const eventsBefore = deps.audit.events.length;
			await registry.endSession(sessionEnder, "session-1", reason);
			await registry.endSession(sessionEnder, "session-1", reason === "aborted" ? "session_ended" : "aborted");
			await registry.endSession(sessionEnder, "session-3", reason);
			assert.strictEqual(deps.audit.events.length, eventsBefore, "a teardown with nothing left audits nothing");
			assert.deepEqual(statusById((await registry.listGrants(operator)).items), statuses, "and changes nothing");

			if (reason === "aborted") {
				await registry.grant(operator, { selector: { sessionId: "session-1" }, capabilities: ["tool.session"] });
				await registry.invoke(agent, { callId: "call-5", capability: "tool.session", args: {} });
				assert.strictEqual(handler.calls.length, 4, "an aborted session's later grants work as usual");
			}
		});
	}

	function projectAccessCases(): ConformanceCase[] {
		return [
			test("project access: refuses an operator outside the project each grant, revocation, journal read, resolution and session end in it, and organisation-wide calls, changing nothing", async (subject, deps) => {
				const { registry } = subject;
				const denied = deniedIn(deps);
				await registry.register(host, [definition("tool.run", "unsafe")], recorder().handler);
				const bySession = await registry.grant(operator, {
					selector: { sessionId: "session-1" },
					capabilities: ["tool.run"],
				});
				const byProject = await registry.grant(operator, {
					selector: { projectId: PROJECT },
					capabilities: ["tool.run"],
				});
				await subject.crashMidCall({ ctx: agent, invoke: { callId: "call-1", capability: "tool.run", args: {} } });
				const grantsBefore = (await registry.listGrants(operator)).items;
				const entryBefore = await registry.journal(operator, "call-1");
				const otherEvents = () => deps.audit.events.filter((event) => event.type !== "access.denied").length;
				const eventsBefore = otherEvents();

				const grantOf = (selector: Parameters<CapabilityRegistry["grant"]>[1]["selector"]) =>
					registry.grant(stranger, { selector, capabilities: ["tool.run"] });
				await denied(grantOf({ projectId: PROJECT }), "capability.grant", "a grant on the project");
				await denied(grantOf({ sessionId: "session-1" }), "capability.grant", "a grant for the project's session");
				await denied(
					grantOf({ projectId: OTHER_PROJECT, sessionId: "session-1" }),
					"capability.grant",
					"a grant naming its own project and this project's session",
				);
				await denied(grantOf({ agentId: "agent-1" }), "capability.grant", "an organisation-wide grant");
				await denied(
					registry.revokeGrant(stranger, bySession.id),
					"capability.revokeGrant",
					"revoking a session grant",
				);
				await denied(
					registry.revokeGrant(stranger, byProject.id),
					"capability.revokeGrant",
					"revoking a project grant",
				);
				await denied(registry.journal(stranger, "call-1"), "capability.journal", "reading a journal entry");
				await denied(
					registry.listJournal(stranger, { sessionId: "session-1" }),
					"capability.listJournal",
					"listing the session's journal",
				);
				await denied(
					registry.resolve(stranger, "call-1", { output: CANARY_SECRET }),
					"capability.resolve",
					"resolving the session's call",
				);
				await denied(
					registry.endSession(stranger, "session-1", "aborted"),
					"capability.endSession",
					"ending the session",
				);
				await denied(
					registry.register(stranger, [definition("tool.new")], recorder().handler),
					"capability.register",
					"registering is organisation-wide",
				);
				await denied(registry.discover(stranger), "capability.discover", "discovering is organisation-wide");

				assert.strictEqual(otherEvents(), eventsBefore, "nothing but the refusals was audited");
				assert.deepEqual((await registry.listGrants(operator)).items, grantsBefore, "no grant changed");
				assert.deepEqual(await registry.journal(operator, "call-1"), entryBefore, "the journal entry is unchanged");
				assert.deepEqual(names(await registry.discover(operator)), ["tool.run"], "nothing was registered");
			}),

			test("project access: refuses an agent whose session belongs to another project, acting on this project's records or naming its session, and changes nothing", async ({
				registry,
			}, deps) => {
				const denied = deniedIn(deps);
				const handler = recorder();
				await registry.register(host, [definition("tool.run")], handler.handler);
				const open = await registry.grant(operator, { selector: {}, capabilities: ["tool.run"] });
				await registry.grant(operator, { selector: { projectId: PROJECT }, capabilities: ["tool.run"] });
				await registry.grant(operator, { selector: { sessionId: "session-1" }, capabilities: ["tool.run"] });
				await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} });
				const grantsBefore = (await registry.listGrants(operator)).items;

				await denied(
					registry.invoke(strangerAgent, { callId: "call-2", capability: "tool.run", args: { token: CANARY_SECRET } }),
					"capability.invoke",
					"a call naming this project",
				);
				await denied(
					registry.endSession(strangerAgent, "session-1", "aborted"),
					"capability.endSession",
					"ending this project's session",
				);
				await denied(
					registry.endSession(strangerAgentAtHome, "session-1", "aborted"),
					"capability.endSession",
					"ending this project's session from its own project",
				);
				await denied(registry.discover(strangerAgent), "capability.discover", "discovering this project's grants");
				assert.strictEqual(handler.calls.length, 1, "the handler never ran for it");
				await assert.rejectsWithCode(
					registry.journal(operator, "call-2"),
					"not_found",
					"the refused call is not journalled",
				);
				await assert.rejectsWithCode(registry.journal(strangerAgent, "call-1"), "not_found", "it reads no entry");
				assert.strictEqual(
					(await registry.listJournal(strangerAgent, { sessionId: "session-1" })).items.length,
					0,
					"it lists none of the session's entries",
				);
				assert.deepEqual(
					(await registry.listGrants(strangerAgent)).items.map((grant) => grant.id),
					[open.id],
					"it lists no grant on this project, only the unscoped one",
				);
				assert.deepEqual((await registry.listGrants(operator)).items, grantsBefore, "no grant changed");
				await registry.invoke(strangerAgentAtHome, { callId: "call-3", capability: "tool.run", args: {} });
				assert.strictEqual(handler.calls.length, 2, "in its own project the unscoped grant works");
			}),

			test("project access: refuses an agent whose session was closed", async ({ registry }, deps) => {
				const denied = deniedIn(deps);
				const handler = recorder();
				await registry.register(host, [definition("tool.run")], handler.handler);
				const grant = await registry.grant(operator, {
					selector: { sessionId: "session-1" },
					capabilities: ["tool.run"],
				});
				await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} });
				deps.tenancy.close("session-1");
				await denied(
					registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} }),
					"capability.invoke",
					"a replay",
				);
				await denied(
					registry.invoke(agent, { callId: "call-2", capability: "tool.run", args: {} }),
					"capability.invoke",
					"a new call",
				);
				await denied(registry.discover(agent), "capability.discover", "discovery");
				await denied(registry.journal(agent, "call-1"), "capability.journal", "reading its journal entry");
				await denied(
					registry.listJournal(agent, { sessionId: "session-1" }),
					"capability.listJournal",
					"listing its journal",
				);
				assert.strictEqual((await registry.listJournal(agent, {})).items.length, 0, "an unfiltered list shows nothing");
				assert.strictEqual(handler.calls.length, 1, "the handler never ran again");
				await assert.rejectsWithCode(registry.journal(operator, "call-2"), "not_found", "nothing was journalled");
				assert.strictEqual(
					statusById((await registry.listGrants(operator)).items)[grant.id],
					"active",
					"the grant is untouched until the session-end teardown runs",
				);
			}),

			test("project access: lists without a project or session filter leave out another project's grants and journal entries", async ({
				registry,
			}) => {
				await registry.register(host, [definition("tool.run")], recorder().handler);
				const grantOf = async (selector: Parameters<CapabilityRegistry["grant"]>[1]["selector"]) =>
					(await registry.grant(operator, { selector, capabilities: ["tool.run"] })).id;
				const open = await grantOf({});
				const byAgent = await grantOf({ agentId: "agent-1" });
				const onProject = await grantOf({ projectId: PROJECT });
				const onSession = await grantOf({ sessionId: "session-1" });
				const onOtherProject = await grantOf({ projectId: OTHER_PROJECT });
				const onOtherSession = await grantOf({ sessionId: "session-9" });
				await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} });
				await registry.invoke(strangerAgentAtHome, { callId: "call-9", capability: "tool.run", args: {} });
				const grantIds = async (ctx: CallContext) =>
					(await registry.listGrants(ctx)).items.map((grant) => grant.id).sort();
				const callIds = async (ctx: CallContext, filter: Parameters<CapabilityRegistry["listJournal"]>[1]) =>
					(await registry.listJournal(ctx, filter)).items.map((entry) => entry.callId).sort();

				assert.deepEqual(
					await grantIds(stranger),
					[open, byAgent, onOtherProject, onOtherSession].sort(),
					"an operator on another project sees its grants and the unscoped ones",
				);
				assert.deepEqual(await callIds(stranger, {}), ["call-9"], "and only its project's journal entries");
				assert.deepEqual(await callIds(stranger, { status: "committed" }), ["call-9"], "also with a status filter");
				assert.deepEqual(
					await grantIds(projectOperator),
					[open, byAgent, onProject, onSession].sort(),
					"an operator on this project sees this project's grants and the unscoped ones",
				);
				assert.deepEqual(await callIds(projectOperator, {}), ["call-1"]);
				assert.deepEqual(
					await grantIds(operator),
					[open, byAgent, onProject, onSession, onOtherProject, onOtherSession].sort(),
					"an organisation-wide operator sees every grant",
				);
				assert.deepEqual(await callIds(operator, {}), ["call-1", "call-9"]);
			}),

			test("project access: allows an operator on the project and an agent in its own session, and keeps organisation-wide calls for organisation-wide roles", async (subject, deps) => {
				const { registry } = subject;
				const denied = deniedIn(deps);
				await registry.register(host, [definition("tool.run", "unsafe"), definition("tool.safe")], recorder().handler);
				const bySession = await registry.grant(projectOperator, {
					selector: { sessionId: "session-1" },
					capabilities: ["tool.run"],
				});
				const byProject = await registry.grant(projectOperator, {
					selector: { projectId: PROJECT, agentId: "agent-2" },
					capabilities: ["tool.safe"],
				});
				assert.deepEqual(names(await registry.discover(agent)), ["tool.run"], "the agent discovers in its own session");
				assert.deepEqual(names(await registry.discover(otherAgent)), ["tool.safe"]);
				await subject.crashMidCall({ ctx: agent, invoke: { callId: "call-1", capability: "tool.run", args: {} } });
				assert.strictEqual((await registry.journal(projectOperator, "call-1")).status, "started");
				assert.strictEqual((await registry.journal(agent, "call-1")).status, "started");
				assert.strictEqual((await registry.listJournal(projectOperator, { sessionId: "session-1" })).items.length, 1);
				assert.strictEqual((await registry.listJournal(agent, { sessionId: "session-1" })).items.length, 1);
				const resolution = { output: "settled by the project operator" };
				assert.strictEqual((await registry.resolve(projectOperator, "call-1", resolution)).status, "resolved");
				assert.deepEqual(
					await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} }),
					resolution,
				);
				await registry.invoke(otherAgent, { callId: "call-2", capability: "tool.safe", args: {} });
				assert.strictEqual((await registry.revokeGrant(projectOperator, byProject.id)).status, "revoked");
				await registry.endSession(projectOperator, "session-1", "session_ended");
				assert.strictEqual(
					statusById((await registry.listGrants(projectOperator)).items)[bySession.id],
					"revoked",
					"an operator on the project ends its session's grants",
				);
				await denied(
					registry.grant(projectOperator, { selector: { agentId: "agent-1" }, capabilities: ["tool.run"] }),
					"capability.grant",
					"a grant naming no project or session needs an organisation-wide role",
				);
				await denied(
					registry.register(projectOperator, [definition("tool.new")], recorder().handler),
					"capability.register",
					"registering needs an organisation-wide role",
				);
				await denied(
					registry.discover(projectOperator),
					"capability.discover",
					"discovering as a human needs an organisation-wide role",
				);
			}),

			// Settled by Tom on 27 Oct 2026 (question 12): kept on purpose, so don't "fix" it into not_found.
			test("existence (settled question 12): in the organisation, a journal entry the caller may not see is forbidden, a missing one not_found, and a call ID another session used a conflict; across organisations both are not_found and the call ID is free", async ({
				registry,
			}) => {
				const handler = recorder();
				await registry.register(host, [definition("tool.run")], handler.handler);
				await registry.grant(operator, { selector: {}, capabilities: ["tool.run"] });
				const call = { callId: "call-1", capability: "tool.run", args: {} };
				await registry.invoke(agent, call);
				await assert.rejectsWithCode(
					registry.journal(stranger, "call-1"),
					"forbidden",
					"an existing entry it may not see",
				);
				await assert.rejectsWithCode(registry.journal(stranger, "call-missing"), "not_found", "a missing entry");
				await assert.rejectsWithCode(registry.invoke(otherAgent, call), "conflict", "a call ID another session used");
				await assert.rejectsWithCode(registry.journal(outsider, "call-1"), "not_found", "another organisation's entry");
				await assert.rejectsWithCode(
					registry.journal(outsider, "call-missing"),
					"not_found",
					"a missing entry elsewhere",
				);
				const theirs = recorder();
				await registry.register(outsider, [definition("tool.run")], theirs.handler);
				await registry.grant(outsider, { selector: {}, capabilities: ["tool.run"] });
				await registry.invoke(outsiderAgent, call);
				assert.strictEqual(theirs.calls.length, 1, "the same call ID is free in another organisation");
			}),
		];
	}

	const cases: ConformanceCase[] = [
		test("shows an agent only the capabilities its grants cover, and a namespace grant covers its members but not a sibling namespace sharing its letters", async ({
			registry,
		}) => {
			const all = [
				"github",
				"github.issue.read",
				"github.issue.write",
				"github.repo.list",
				"githubx.read",
				"linear.create",
			];
			await registry.register(
				host,
				all.map((name) => definition(name)),
				recorder().handler,
			);
			assert.deepEqual(names(await registry.discover(agent)), [], "no grant, nothing to discover");
			await registry.grant(operator, { selector: { agentId: "agent-1" }, capabilities: ["github.*", "linear.create"] });
			assert.deepEqual(
				names(await registry.discover(agent)),
				["github.issue.read", "github.issue.write", "github.repo.list", "linear.create"],
				"github.* covers github.x and github.x.y, not github itself nor githubx",
			);
			await registry.grant(operator, { selector: { agentId: "agent-2" }, capabilities: ["github.issue.read"] });
			assert.deepEqual(
				names(await registry.discover(otherAgent)),
				["github.issue.read"],
				"an exact name covers itself",
			);
			assert.deepEqual(names(await registry.discover(operator)), all, "an operator sees every registered capability");
			assert.deepEqual(names(await registry.discover(host)), all, "a service sees every registered capability");
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-sibling", capability: "githubx.read", args: {} }),
				"forbidden",
				"a sibling namespace sharing the prefix's letters is not covered",
			);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-namespace", capability: "github", args: {} }),
				"forbidden",
				"a namespace grant does not cover the namespace's own name",
			);
		}),

		test("applies a grant only to the session, agent and project its selector names", async ({ registry }) => {
			const handler = recorder();
			await registry.register(
				host,
				["a.session", "a.agent", "a.project", "a.everyone", "a.exact"].map((name) => definition(name)),
				handler.handler,
			);
			await registry.grant(operator, { selector: { sessionId: "session-2" }, capabilities: ["a.session"] });
			await registry.grant(operator, { selector: { agentId: "agent-2" }, capabilities: ["a.agent"] });
			await registry.grant(operator, { selector: { projectId: OTHER_PROJECT }, capabilities: ["a.project"] });
			await registry.grant(operator, { selector: {}, capabilities: ["a.everyone"] });
			await registry.grant(operator, {
				selector: { projectId: PROJECT, agentId: "agent-2", sessionId: "session-2" },
				capabilities: ["a.exact"],
			});
			assert.deepEqual(
				names(await registry.discover(agent)),
				["a.everyone"],
				"agent-1 in proj-a gets only the open grant",
			);
			assert.deepEqual(
				names(await registry.discover(otherAgent)),
				["a.agent", "a.everyone", "a.exact", "a.session"],
				"agent-2 in session-2 and proj-a",
			);
			assert.deepEqual(
				names(await registry.discover(strangerAgentAtHome)),
				["a.everyone", "a.project"],
				"agent-9 in session-9 and proj-b",
			);
			for (const capability of ["a.session", "a.agent", "a.project", "a.exact"]) {
				await assert.rejectsWithCode(
					registry.invoke(agent, { callId: `call-${capability}`, capability, args: {} }),
					"forbidden",
					`${capability} is granted to someone else`,
				);
			}
			assert.strictEqual(handler.calls.length, 0, "no handler ran");
			await registry.invoke(otherAgent, { callId: "call-exact", capability: "a.exact", args: {} });
			assert.strictEqual(handler.calls.length, 1, "a selector naming every field applies to that exact caller");
		}),

		test("refuses an agent registering capabilities or granting or revoking access", async ({ registry }) => {
			await assert.rejectsWithCode(
				registry.register(agent, [definition("agent.own")], recorder().handler),
				"forbidden",
				"an agent cannot register",
			);
			await registry.register(host, [definition("tool.run")], recorder().handler);
			await assert.rejectsWithCode(
				registry.grant(agent, { selector: { sessionId: "session-1" }, capabilities: ["tool.run"] }),
				"forbidden",
				"an agent cannot grant itself access",
			);
			const grant = await registry.grant(operator, {
				selector: { sessionId: "session-2" },
				capabilities: ["tool.run"],
			});
			await assert.rejectsWithCode(registry.revokeGrant(agent, grant.id), "forbidden", "an agent cannot revoke");
			assert.strictEqual(names(await registry.discover(agent)).length, 0, "the agent gained nothing");
			assert.deepEqual(names(await registry.discover(operator)), ["tool.run"], "the agent registered nothing");
		}),

		test("refuses an invoke without a covering grant as forbidden and audits it", async ({ registry }, deps) => {
			const handler = recorder();
			await registry.register(host, [definition("tool.run")], handler.handler);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { a: 1 } }),
				"forbidden",
			);
			assert.strictEqual(handler.calls.length, 0, "the handler never ran");
			const refused = deps.audit.ofType("capability.call.refused");
			assert.strictEqual(refused.length, 1, "the refusal is audited");
			assert.deepEqual(refused[0]!.actor, agent.actor, "the audit names the agent");
			assert.partialDeepEqual(refused[0], {
				source: "capability",
				organisationId: ORG,
				subject: { kind: "capability.call", id: "call-1" },
				data: { capability: "tool.run" },
			});
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.other", args: { a: 1 } }),
				"forbidden",
			);
			assert.strictEqual(
				deps.audit.ofType("capability.call.refused").length,
				2,
				"refusals for two capabilities under one call ID are two rows",
			);
			await assert.rejectsWithCode(
				registry.journal(operator, "call-1"),
				"not_found",
				"a refused call is not journalled",
			);
			await registry.grant(operator, { selector: {}, capabilities: ["tool.run"] });
			await assert.rejectsWithCode(
				registry.invoke(operator, { callId: "call-2", capability: "tool.run", args: {} }),
				"forbidden",
				"only an agent invokes",
			);
			assert.strictEqual(handler.calls.length, 0);
		}),

		test("refuses a retry with the same call ID once the grant is revoked or expired", async ({ registry }, deps) => {
			const handler = recorder();
			await registry.register(host, [definition("tool.run")], handler.handler);
			const revocable = await registry.grant(operator, {
				selector: { sessionId: "session-1" },
				capabilities: ["tool.run"],
			});
			const call = { callId: "call-1", capability: "tool.run", args: { n: 1 } };
			await registry.invoke(agent, call);
			const revoked = await registry.revokeGrant(operator, revocable.id);
			assert.strictEqual(revoked.status, "revoked");
			assert.strictEqual(deps.audit.ofType("capability.grant.revoked").length, 1, "the revocation is audited");
			await assert.rejectsWithCode(
				registry.invoke(agent, call),
				"forbidden",
				"a committed call ID is refused once revoked",
			);
			assert.deepEqual(names(await registry.discover(agent)), [], "a revoked grant shows nothing");

			const expiring = await registry.grant(operator, {
				selector: { sessionId: "session-1" },
				capabilities: ["tool.*"],
				ttlMs: 1_000,
			});
			assert.strictEqual(expiring.expiresAt, expiring.createdAt + 1_000);
			const second = { callId: "call-2", capability: "tool.run", args: { n: 2 } };
			await registry.invoke(agent, second);
			deps.clock.advance(1_000);
			await assert.rejectsWithCode(
				registry.invoke(agent, second),
				"forbidden",
				"a committed call ID is refused once expired",
			);
			assert.deepEqual(names(await registry.discover(agent)), [], "an expired grant shows nothing");
			const listed = (await registry.listGrants(operator)).items.find((grant) => grant.id === expiring.id);
			assert.strictEqual(listed?.status, "expired", "the grant reads as expired by the clock");
			assert.strictEqual(handler.calls.length, 2, "the handler ran once per call, never for a refused retry");
		}),

		test("replays a committed call's result without calling the handler again", async ({ registry }, deps) => {
			const handler = recorder();
			await registerAndGrant(registry, [definition("tool.run")], handler.handler);
			const first = await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { a: 1, b: [2] } });
			assert.deepEqual(first, { output: { echo: { a: 1, b: [2] } } });
			const again = await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { b: [2], a: 1 } });
			assert.deepEqual(again, first, "the same arguments in another key order replay the result");
			assert.strictEqual(handler.calls.length, 1, "the handler ran once");
			assert.strictEqual((await registry.journal(operator, "call-1")).status, "committed");
			assert.strictEqual(deps.audit.ofType("capability.call.started").length, 1, "one started event per call ID");
			assert.strictEqual(deps.audit.ofType("capability.call.settled").length, 1, "one settled event per call ID");
		}),

		test("replays a safe call's failure without calling the handler again", async ({ registry }) => {
			const handler = recorder(async () => {
				throw new Error("the upstream said no");
			});
			await registerAndGrant(registry, [definition("tool.run", "safe")], handler.handler);
			const call = { callId: "call-1", capability: "tool.run", args: {} };
			const first = await registry.invoke(agent, call);
			assert.deepEqual(first, { output: "the upstream said no", isError: true }, "a thrown handler is an error result");
			const entry = await registry.journal(operator, "call-1");
			assert.strictEqual(entry.status, "failed");
			assert.strictEqual(entry.error, "the upstream said no");
			assert.deepEqual(await registry.invoke(agent, call), first, "the retry replays the failure");
			assert.strictEqual(handler.calls.length, 1, "the handler ran once");
		}),

		test("leaves an unsafe call whose handler throws uncertain, refuses its retry, and lets an operator resolve it", async ({
			registry,
		}, deps) => {
			const thrown = new Error("the connection dropped mid-charge");
			const handler = recorder(async () => {
				throw thrown;
			});
			await registerAndGrant(registry, [definition("payments.charge", "unsafe")], handler.handler);
			const call = { callId: "call-1", capability: "payments.charge", args: { amount: 10 } };
			let caught: unknown;
			try {
				await registry.invoke(agent, call);
			} catch (error) {
				caught = error;
			}
			assert.strictEqual(caught, thrown, "the caller gets the handler's own error");
			const entry = await registry.journal(operator, "call-1");
			assert.strictEqual(entry.status, "started", "the call is left uncertain");
			assert.strictEqual(entry.result, undefined, "with no result");
			const settled = deps.audit.ofType("capability.call.settled");
			assert.strictEqual(settled.length, 1);
			assert.strictEqual(settled[0]!.data?.outcome, "uncertain", "the audit says uncertain");
			await assert.rejectsWithCode(registry.invoke(agent, call), "refused", "a retry is refused");
			assert.strictEqual(handler.calls.length, 1, "the refused retry did not run the handler");
			const resolution = { output: { charged: true } };
			assert.strictEqual((await registry.resolve(operator, "call-1", resolution)).status, "resolved");
			assert.deepEqual(await registry.invoke(agent, call), resolution, "a later retry returns the resolution");
			assert.strictEqual(handler.calls.length, 1);

			const answered = recorder(async () => ({ output: "declined", isError: true }));
			await registerAndGrant(registry, [definition("payments.refund", "unsafe")], answered.handler);
			const refund = await registry.invoke(agent, { callId: "call-2", capability: "payments.refund", args: {} });
			assert.deepEqual(refund, { output: "declined", isError: true });
			assert.strictEqual(
				(await registry.journal(operator, "call-2")).status,
				"committed",
				"an unsafe handler that returns an error result is committed",
			);
		}),

		test("treats the same call ID with other arguments or another capability as a conflict", async ({ registry }) => {
			const handler = recorder();
			await registerAndGrant(registry, [definition("tool.run"), definition("tool.other")], handler.handler);
			await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { n: 1 } });
			const before = await registry.journal(operator, "call-1");
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { n: 2 } }),
				"conflict",
				"other arguments",
			);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.other", args: { n: 1 } }),
				"conflict",
				"another capability",
			);
			assert.strictEqual(handler.calls.length, 1, "no conflicting call ran");
			assert.deepEqual(await registry.journal(operator, "call-1"), before, "the journal entry is unchanged");
		}),

		test("refuses retrying a crashed unsafe call until an operator resolves it, and only an operator may resolve", async (subject, deps) => {
			const { registry } = subject;
			const handler = recorder();
			await registerAndGrant(registry, [definition("payments.charge", "unsafe")], handler.handler);
			const call = { callId: "call-1", capability: "payments.charge", args: { amount: 10 } };
			await subject.crashMidCall({ ctx: agent, invoke: call });
			const crashed = await registry.journal(operator, "call-1");
			assert.strictEqual(crashed.status, "started", "the crash leaves a started entry");
			assert.strictEqual(crashed.result, undefined, "with no result");
			assert.strictEqual(crashed.replay, "unsafe");
			const ranBefore = handler.calls.length;
			await assert.rejectsWithCode(registry.invoke(agent, call), "refused", "an uncertain unsafe call is refused");
			assert.strictEqual(handler.calls.length, ranBefore, "the refused retry did not run the handler");
			await assert.rejectsWithCode(
				registry.resolve(agent, "call-1", { output: "done" }),
				"forbidden",
				"an agent cannot resolve",
			);
			assert.strictEqual((await registry.journal(operator, "call-1")).status, "started", "the agent changed nothing");
			const resolution = { output: { charged: false }, isError: true };
			const resolved = await registry.resolve(operator, "call-1", resolution);
			assert.strictEqual(resolved.status, "resolved");
			assert.deepEqual(resolved.result, resolution);
			assert.deepEqual(resolved.resolvedBy, operator.actor);
			assert.ok(resolved.settledAt !== undefined, "the resolution is timestamped");
			assert.deepEqual(await registry.invoke(agent, call), resolution, "a later retry returns the resolution");
			assert.strictEqual(handler.calls.length, ranBefore, "and still does not run the handler");
			assert.strictEqual(deps.audit.ofType("capability.call.resolved").length, 1, "the resolution is audited");
			await assert.rejectsWithCode(
				registry.resolve(operator, "call-1", { output: "again" }),
				"conflict",
				"only a started call can be resolved",
			);
			await registry.invoke(agent, { callId: "call-2", capability: "payments.charge", args: { amount: 1 } });
			await assert.rejectsWithCode(
				registry.resolve(host, "call-2", { output: "no" }),
				"conflict",
				"a committed call cannot be resolved",
			);
		}),

		test("runs a crashed safe or idempotent call again with the same call ID", async (subject) => {
			const { registry } = subject;
			for (const replay of ["safe", "idempotent"] as const) {
				const handler = recorder();
				const name = `tool.${replay}`;
				await registerAndGrant(registry, [definition(name, replay)], handler.handler);
				const call = { callId: `call-${replay}`, capability: name, args: { replay } };
				await subject.crashMidCall({ ctx: agent, invoke: call });
				assert.strictEqual((await registry.journal(operator, call.callId)).status, "started");
				const ranBefore = handler.calls.length;
				const result = await registry.invoke(agent, call);
				assert.deepEqual(result, { output: { echo: { replay } } }, `the ${replay} call ran again`);
				assert.strictEqual(handler.calls.length, ranBefore + 1, `the ${replay} handler was called again`);
				assert.strictEqual(handler.calls.at(-1)!.callId, call.callId, "with the same call ID");
				assert.strictEqual((await registry.journal(operator, call.callId)).status, "committed");
			}
		}),

		test("refuses an invoke whose expectVersion differs from the registered version as a conflict", async ({
			registry,
		}) => {
			const handler = recorder();
			await registerAndGrant(registry, [definition("tool.run", "safe", "2")], handler.handler);
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {}, expectVersion: "1" }),
				"conflict",
			);
			assert.strictEqual(handler.calls.length, 0, "the handler never ran");
			await assert.rejectsWithCode(registry.journal(operator, "call-1"), "not_found", "nothing was journalled");
			await registry.invoke(agent, { callId: "call-2", capability: "tool.run", args: {}, expectVersion: "2" });
			assert.strictEqual(handler.calls[0]!.version, "2", "the handler is told the version");
		}),

		test("lets only one provider register a name, and closing a registration removes it", async ({
			registry,
		}, deps) => {
			const first = recorder();
			const subscription = await registry.register(host, [definition("tool.run")], first.handler);
			assert.strictEqual(deps.audit.ofType("capability.registered").length, 1, "the registration is audited");
			await assert.rejectsWithCode(
				registry.register(operator, [definition("tool.new"), definition("tool.run")], recorder().handler),
				"conflict",
			);
			assert.deepEqual(names(await registry.discover(operator)), ["tool.run"], "a refused registration adds nothing");
			await registry.grant(operator, { selector: {}, capabilities: ["tool.*"] });
			await subscription.close();
			assert.deepEqual(names(await registry.discover(operator)), [], "closing unregisters");
			assert.deepEqual(names(await registry.discover(agent)), [], "agents no longer see it");
			await assert.rejectsWithCode(
				registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} }),
				"not_found",
				"an unregistered capability is not found",
			);
			const second = recorder();
			await registry.register(operator, [definition("tool.run")], second.handler);
			await subscription.close();
			await registry.invoke(agent, { callId: "call-2", capability: "tool.run", args: {} });
			assert.strictEqual(second.calls.length, 1, "closing a stale registration leaves the new provider in place");
			assert.strictEqual(first.calls.length, 0);
		}),

		test("journals the version, fingerprint, status and timestamps, and lists entries by session and status", async (subject, deps) => {
			const { registry } = subject;
			const handler = recorder(async (invocation) => {
				deps.clock.advance(5);
				if (invocation.capability === "tool.fail") throw new Error("failed");
				return { output: "ok" };
			});
			await registry.register(
				host,
				[definition("tool.run", "idempotent", "3"), definition("tool.fail")],
				handler.handler,
			);
			await registry.grant(operator, { selector: {}, capabilities: ["tool.*"] });
			const startedAt = deps.clock.now();
			await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: { a: 1, b: 2 } });
			const entry = await registry.journal(operator, "call-1");
			assert.partialDeepEqual(entry, {
				callId: "call-1",
				capability: "tool.run",
				version: "3",
				sessionId: "session-1",
				agentId: "agent-1",
				replay: "idempotent",
				status: "committed",
				result: { output: "ok" },
				startedAt,
				settledAt: startedAt + 5,
			});
			assert.ok(HEX_SHA256.test(entry.inputFingerprint), "the fingerprint is hex SHA-256");
			await registry.invoke(agent, { callId: "call-2", capability: "tool.run", args: { b: 2, a: 1 } });
			await registry.invoke(agent, { callId: "call-3", capability: "tool.run", args: { a: 2, b: 1 } });
			assert.strictEqual(
				(await registry.journal(operator, "call-2")).inputFingerprint,
				entry.inputFingerprint,
				"key order does not change the fingerprint",
			);
			assert.ok(
				(await registry.journal(operator, "call-3")).inputFingerprint !== entry.inputFingerprint,
				"other arguments change it",
			);
			await registry.invoke(otherAgent, { callId: "call-4", capability: "tool.fail", args: {} });
			await subject.crashMidCall({ ctx: agent, invoke: { callId: "call-5", capability: "tool.run", args: {} } });
			const ids = async (filter: Parameters<CapabilityRegistry["listJournal"]>[1]) =>
				(await registry.listJournal(operator, filter)).items.map((item) => item.callId).sort();
			assert.deepEqual(await ids({}), ["call-1", "call-2", "call-3", "call-4", "call-5"]);
			assert.deepEqual(await ids({ sessionId: "session-1" }), ["call-1", "call-2", "call-3", "call-5"]);
			assert.deepEqual(await ids({ status: "failed" }), ["call-4"]);
			assert.deepEqual(await ids({ status: "started" }), ["call-5"]);
			assert.deepEqual(await ids({ sessionId: "session-2", status: "committed" }), []);
			assert.deepEqual(await ids({ sessionId: "session-1", status: "committed" }), ["call-1", "call-2", "call-3"]);
			const page = await registry.listJournal(operator, {}, { limit: 2 });
			assert.strictEqual(page.items.length, 2);
			assert.ok(page.nextCursor !== undefined, "a partial page has a cursor");
		}),

		test("hides another organisation's capabilities, grants and journal entries", async ({ registry }) => {
			const handler = recorder();
			const { grant } = await registerAndGrant(registry, [definition("tool.run", "unsafe")], handler.handler);
			await registry.invoke(agent, { callId: "call-1", capability: "tool.run", args: {} });
			assert.deepEqual(await registry.discover(outsider), [], "no capabilities");
			assert.strictEqual((await registry.listGrants(outsider)).items.length, 0, "no grants");
			assert.strictEqual((await registry.listJournal(outsider, {})).items.length, 0, "no journal entries");
			await assert.rejectsWithCode(registry.revokeGrant(outsider, grant.id), "not_found");
			await assert.rejectsWithCode(registry.journal(outsider, "call-1"), "not_found");
			await assert.rejectsWithCode(registry.resolve(outsider, "call-1", { output: "x" }), "not_found");
			await assert.rejectsWithCode(
				registry.invoke(outsiderAgent, { callId: "call-1", capability: "tool.run", args: {} }),
				"forbidden",
				"a grant in another organisation does not apply",
			);
			await registry.grant(outsider, { selector: {}, capabilities: ["tool.run"] });
			await assert.rejectsWithCode(
				registry.invoke(outsiderAgent, { callId: "call-1", capability: "tool.run", args: {} }),
				"not_found",
				"a capability registered in another organisation is not found",
			);
			const theirs = recorder();
			await registry.register(outsider, [definition("tool.run")], theirs.handler);
			await registry.invoke(outsiderAgent, { callId: "call-1", capability: "tool.run", args: { n: 1 } });
			assert.strictEqual(theirs.calls.length, 1, "names and call IDs are per organisation");
			assert.strictEqual(handler.calls.length, 1, "our handler never ran for them");
			assert.strictEqual((await registry.journal(operator, "call-1")).status, "committed", "our entry is untouched");
		}),

		test("hides one session's journal entries and results from another session's agent", async ({ registry }) => {
			const handler = recorder();
			await registry.register(host, [definition("tool.run")], handler.handler);
			await registry.grant(operator, { selector: {}, capabilities: ["tool.run"] });
			const call = { callId: "call-1", capability: "tool.run", args: {} };
			await registry.invoke(agent, call);
			await assert.rejectsWithCode(registry.journal(otherAgent, "call-1"), "not_found");
			assert.strictEqual((await registry.listJournal(otherAgent, {})).items.length, 0);
			assert.strictEqual((await registry.listJournal(otherAgent, { sessionId: "session-1" })).items.length, 0);
			assert.strictEqual((await registry.listJournal(agent, {})).items.length, 1, "an agent sees its own session");
			await assert.rejectsWithCode(registry.invoke(otherAgent, call), "conflict", "another session cannot replay it");
			const sameAgentNewSession = contextFor(actors.agent("agent-1", "session-3"), ORG, PROJECT);
			await assert.rejectsWithCode(
				registry.invoke(sameAgentNewSession, call),
				"conflict",
				"nor can the same agent in another session",
			);
			assert.strictEqual(handler.calls.length, 1);
		}),

		test("aborts the handler's signal when the caller's signal aborts, failing a safe call and leaving an unsafe one uncertain", async ({
			registry,
		}) => {
			let handlerSignal: AbortSignal | undefined;
			const handler = recorder(
				(_invocation, signal) =>
					new Promise<CapabilityResult>((_resolve, reject) => {
						handlerSignal = signal;
						signal.addEventListener("abort", () => reject(new Error("the handler was aborted")), { once: true });
					}),
			);
			await registerAndGrant(
				registry,
				[definition("tool.wait", "safe"), definition("tool.wait_unsafe", "unsafe")],
				handler.handler,
			);
			const controller = new AbortController();
			const caller = contextFor(agent.actor, ORG, PROJECT, { signal: controller.signal });
			const pending = registry.invoke(caller, { callId: "call-1", capability: "tool.wait", args: {} });
			await eventually(() => handlerSignal !== undefined, 1_000, "the handler to start");
			assert.strictEqual(handlerSignal!.aborted, false, "the handler's signal starts live");
			controller.abort();
			assert.strictEqual(handlerSignal!.aborted, true, "aborting the caller aborts the handler");
			const result = await pending;
			assert.strictEqual(result.isError, true, "the aborted safe call settles as an error");
			assert.strictEqual((await registry.journal(operator, "call-1")).status, "failed");

			handlerSignal = undefined;
			const unsafeController = new AbortController();
			const unsafeCaller = contextFor(agent.actor, ORG, PROJECT, { signal: unsafeController.signal });
			const unsafeCall = { callId: "call-2", capability: "tool.wait_unsafe", args: {} };
			const unsafePending = registry.invoke(unsafeCaller, unsafeCall).then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await eventually(() => handlerSignal !== undefined, 1_000, "the unsafe handler to start");
			unsafeController.abort();
			assert.strictEqual(await unsafePending, "the handler was aborted", "the caller gets the handler's error");
			assert.strictEqual((await registry.journal(operator, "call-2")).status, "started", "the call is uncertain");
			await assert.rejectsWithCode(registry.invoke(agent, unsafeCall), "refused", "its retry is refused");
		}),

		...SESSION_END_REASONS.map((reason) => sessionEndCase(reason)),
	];
	if (options.projectAccess) cases.push(...projectAccessCases());
	return cases;
}

export function registerCapabilityConformance(
	runner: ConformanceRunner,
	name: string,
	provider: CapabilityConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createCapabilityConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
		}),
	);
}
