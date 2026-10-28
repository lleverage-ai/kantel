/**
 * Conformance suite for the session runtime: `SessionRuntime`, `SessionDirectory`, `AgentProfiles` and
 * `HostToolBridge`. The model is scripted through `ModelScript`, so the suite knows nothing of Pi; each implementation
 * wires its scripted model, its clock, its audit sink and a sandbox `releaseSession` recorder into the subject.
 */
import {
	type AgentProfile,
	type AgentProfiles,
	type CallContext,
	HarbourError,
	type HostToolBridge,
	type HostToolCall,
	type HostToolDefinition,
	type HostToolHandler,
	type JsonValue,
	type SessionDirectory,
	type SessionEnd,
	type SessionEndHook,
	type SessionHistory,
	type SessionRuntime,
	type Subscription,
} from "@harbour/contracts";
import {
	applyFrames,
	type ServerFrame,
	type SessionSnapshot,
	type ToolItem,
	type TranscriptItem,
	type UserItem,
} from "@harbour/protocol";
import {
	actors,
	assertAccessDenied,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
	eventually,
	registerCases,
} from "./harness.ts";

export interface ModelRequestView {
	readonly system: string;
	/** The conversation as the model receives it, flattened to text. */
	readonly messages: readonly { readonly role: "user" | "assistant" | "tool"; readonly text: string }[];
}

export type ScriptedTurn =
	| { readonly text: string }
	| { readonly toolCalls: readonly { readonly name: string; readonly args: JsonValue }[] }
	| ((request: ModelRequestView) => ScriptedTurn | Promise<ScriptedTurn>);

export interface ModelScript {
	/** Queues replies for the next model requests, in order. */
	reply(...turns: readonly ScriptedTurn[]): void;
	/** Every request the model has received so far. */
	readonly requests: readonly ModelRequestView[];
}

export interface RuntimeSubject {
	readonly runtime: SessionRuntime;
	readonly directory: SessionDirectory;
	readonly profiles: AgentProfiles;
	readonly hostTools: HostToolBridge;
	readonly model: ModelScript;
	/** Session IDs passed to the sandbox's releaseSession, in order. */
	readonly releasedSessions: readonly string[];
	/** The session-end hook the runtime runs on close and abort; the suite registers teardowns with it. */
	readonly sessionEnd: SessionEndHook;
	/** The transcript in pages (proposed). Needed by the `history:` cases, which run with `history: true`. */
	readonly history?: SessionHistory;
}

export interface RuntimeConformanceOptions extends ConformanceOptions {
	/** Adds the `history:` cases, for a subject that serves `history` (proposed, issue #6). */
	readonly history?: boolean;
}

/**
 * Besides the clock and audit sink, wire `deps.tenancy.identity` into the runtime's project-access check (the runtime
 * reads sessions from its own directory), and `releaseSession` into its sandbox.
 */
export interface RuntimeConformanceDeps extends ConformanceDeps {
	/** Wire this into the sandbox's `releaseSession`. */
	readonly releaseSession: (sessionId: string) => void;
	/** What `releaseSession` recorded, in order; hand it to the subject as `releasedSessions`. */
	readonly releasedSessions: readonly string[];
}

export type RuntimeConformanceProvider = (
	deps: RuntimeConformanceDeps,
	use: (subject: RuntimeSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-harbour";
const OTHER_ORG = "org-elsewhere";
const PROJECT = "proj-docs";
const OTHER_PROJECT = "proj-site";
const HOST = "sal";
const AGENT = "sal-worker";

const operator: CallContext = contextFor(actors.service("sal-supervisor"), ORG, PROJECT);
const outsider: CallContext = contextFor(actors.service("intruder"), OTHER_ORG);
/** Same organisation, operator only on the other project. */
const siteOperator: CallContext = contextFor(actors.service("site-operator"), ORG, OTHER_PROJECT);
/** Same organisation, viewer only on the project. */
const reader: CallContext = contextFor(actors.human("reader"), ORG, PROJECT);
const agentIn = (sessionId: string, projectId = PROJECT): CallContext =>
	contextFor(actors.agent(AGENT, sessionId), ORG, projectId);

/** What each fake component holds for a session, and the teardown that ends it. */
const FAKE_COMPONENTS: readonly { readonly name: string; readonly holds: readonly string[] }[] = [
	{ name: "conformance-sandbox", holds: ["sandbox.lease"] },
	{ name: "conformance-browser", holds: ["browser.session", "browser.grant"] },
	{ name: "conformance-capability", holds: ["capability.grant"] },
	{ name: "conformance-vault", holds: ["vault.grant"] },
];
const EVERYTHING = FAKE_COMPONENTS.flatMap((component) => component.holds);

interface FakeHoldings {
	/** What each session still holds. */
	readonly held: Map<string, Set<string>>;
	/** Every teardown call, in order. */
	readonly calls: { readonly name: string; readonly ctx: CallContext; readonly end: SessionEnd }[];
	hold(sessionId: string): void;
}

/** Registers fake browser, capability, vault and sandbox teardowns that drop what a session holds. */
function registerFakeComponents(subject: RuntimeSubject): FakeHoldings {
	const held = new Map<string, Set<string>>();
	const calls: FakeHoldings["calls"][number][] = [];
	for (const component of FAKE_COMPONENTS) {
		subject.sessionEnd.register(component.name, async (ctx, end) => {
			calls.push({ name: component.name, ctx, end });
			for (const kind of component.holds) held.get(end.sessionId)?.delete(kind);
		});
	}
	return { held, calls, hold: (sessionId) => held.set(sessionId, new Set(EVERYTHING)) };
}

const LOOKUP: HostToolDefinition = {
	name: "lookup",
	description: "Reads a note by key",
	inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
	replay: "safe",
};
const REVIEW: HostToolDefinition = {
	name: "wait_for_review",
	description: "Waits until a human reviews the work",
	inputSchema: { type: "object", properties: {} },
	replay: "unsafe",
};

function workerProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		id: AGENT,
		organisationId: ORG,
		name: "Sal worker",
		model: { route: "default" },
		promptLayers: [
			{ name: "role", text: "You are a careful worker." },
			{ name: "brief", text: "Answer briefly." },
		],
		tools: [LOOKUP.name, REVIEW.name, "not_served"],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
		hostId: HOST,
		...overrides,
	};
}

interface Gate {
	readonly opened: Promise<void>;
	open(): void;
}

function gate(): Gate {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** A host serving `lookup` at once and `wait_for_review` only once `review` opens. */
interface Host {
	readonly calls: HostToolCall[];
	readonly signals: AbortSignal[];
	readonly review: Gate;
	readonly subscription: Subscription;
}

async function serveHost(subject: RuntimeSubject): Promise<Host> {
	const calls: HostToolCall[] = [];
	const signals: AbortSignal[] = [];
	const review = gate();
	const handler: HostToolHandler = async (call, signal) => {
		calls.push(call);
		signals.push(signal);
		if (call.tool === REVIEW.name) {
			await review.opened;
			return { output: "Reviewed and approved" };
		}
		const key = (call.args as { key?: string } | null)?.key ?? "?";
		return { output: `Note ${key} is ready`, structured: { key } };
	};
	const subscription = await subject.hostTools.register(operator, HOST, [LOOKUP, REVIEW], handler);
	return { calls, signals, review, subscription };
}

async function setUp(subject: RuntimeSubject, profile: AgentProfile = workerProfile()) {
	await subject.profiles.put(operator, profile);
	return subject.runtime.create(operator, { projectId: PROJECT, agentId: profile.id, labels: { docketTask: "T-1" } });
}

const usersOf = (items: readonly TranscriptItem[]) => items.filter((item): item is UserItem => item.kind === "user");
const toolsOf = (items: readonly TranscriptItem[]) => items.filter((item): item is ToolItem => item.kind === "tool");
const assistantTexts = (items: readonly TranscriptItem[]) =>
	items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));
const lastUserText = (request: ModelRequestView | undefined) =>
	request?.messages.filter((message) => message.role === "user").at(-1)?.text;

function comparable(snapshot: SessionSnapshot | undefined) {
	return snapshot === undefined
		? undefined
		: { items: snapshot.items, status: snapshot.status, attention: snapshot.attention, cursor: snapshot.cursor };
}

export function createRuntimeConformance(options: {
	assertions: ConformanceAssertions;
	provider: RuntimeConformanceProvider;
	/** Adds the `project access:` cases; see `ConformanceOptions.projectAccess`. */
	projectAccess?: boolean;
	/** Adds the `history:` cases; see `RuntimeConformanceOptions.history`. */
	history?: boolean;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const run =
		(body: (subject: RuntimeSubject, deps: RuntimeConformanceDeps) => Promise<void>): (() => Promise<void>) =>
		async () => {
			const released: string[] = [];
			const deps: RuntimeConformanceDeps = {
				...createDeps(),
				releaseSession: (sessionId) => {
					released.push(sessionId);
				},
				releasedSessions: released,
			};
			// The supervisor operates across the organisation; the others hold one project each.
			deps.tenancy.bind(operator.actor, ORG, "operator");
			deps.tenancy.bind(siteOperator.actor, ORG, "operator", OTHER_PROJECT);
			deps.tenancy.bind(reader.actor, ORG, "viewer", PROJECT);
			await options.provider(deps, (subject) => body(subject, deps));
		};

	const sessionEndCases: ConformanceCase[] = [
		{
			name: "session end: closing runs every registered teardown once for the session, which then holds nothing, and closing again runs none",
			run: run(async (subject) => {
				const fakes = registerFakeComponents(subject);
				const session = await setUp(subject);
				const other = await subject.runtime.create(operator, { projectId: PROJECT, agentId: AGENT });
				fakes.hold(session.id);
				fakes.hold(other.id);
				await subject.runtime.close(operator, session.id);
				a.deepEqual(
					fakes.calls.map((call) => call.name),
					FAKE_COMPONENTS.map((component) => component.name),
					"each teardown runs once, in registration order",
				);
				for (const call of fakes.calls) {
					a.partialDeepEqual(call.end, {
						sessionId: session.id,
						organisationId: ORG,
						projectId: PROJECT,
						agentId: AGENT,
						reason: "session_ended",
						endedBy: operator.actor,
					});
					a.strictEqual(call.ctx.actor.kind, "system", "a teardown runs as Harbour, not as the caller");
					a.strictEqual(call.ctx.organisationId, ORG);
				}
				a.strictEqual(fakes.held.get(session.id)?.size, 0, "the closed session holds nothing");
				a.strictEqual(fakes.held.get(other.id)?.size, EVERYTHING.length, "another session keeps what it holds");
				await subject.runtime.close(operator, session.id);
				await subject.runtime.abort(operator, session.id);
				a.strictEqual(fakes.calls.length, FAKE_COMPONENTS.length, "closing or aborting a closed session runs nothing");
			}),
		},
		{
			name: "session end: closing a parent does not end an already closed child again",
			run: run(async (subject) => {
				const fakes = registerFakeComponents(subject);
				const parent = await setUp(subject);
				const child = await subject.runtime.create(operator, {
					projectId: PROJECT,
					agentId: AGENT,
					parentSessionId: parent.id,
				});
				await subject.runtime.close(operator, child.id);
				await subject.runtime.close(operator, parent.id);
				a.deepEqual(
					fakes.calls.map((call) => `${call.end.sessionId === child.id ? "child" : "parent"}:${call.end.reason}`),
					[...FAKE_COMPONENTS.map(() => "child:session_ended"), ...FAKE_COMPONENTS.map(() => "parent:session_ended")],
				);
			}),
		},
		{
			name: "session end: aborting runs the teardowns for each child and the session, which stays usable, and a second abort changes nothing",
			run: run(async (subject, deps) => {
				const fakes = registerFakeComponents(subject);
				const parent = await setUp(subject);
				const child = await subject.runtime.create(operator, {
					projectId: PROJECT,
					agentId: AGENT,
					parentSessionId: parent.id,
				});
				fakes.hold(parent.id);
				fakes.hold(child.id);
				await subject.runtime.abort(operator, parent.id, "operator stopped it");
				const ended = fakes.calls.map((call) => `${call.end.sessionId === child.id ? "child" : "parent"}:${call.name}`);
				a.deepEqual(ended, [
					...FAKE_COMPONENTS.map((component) => `child:${component.name}`),
					...FAKE_COMPONENTS.map((component) => `parent:${component.name}`),
				]);
				a.ok(
					fakes.calls.every((call) => call.end.reason === "aborted"),
					"an abort ends with reason aborted",
				);
				a.partialDeepEqual(fakes.calls[0]?.end, { parentSessionId: parent.id, endedBy: operator.actor });
				a.strictEqual(fakes.held.get(parent.id)?.size, 0, "the aborted session holds nothing");
				a.strictEqual(fakes.held.get(child.id)?.size, 0, "its child holds nothing");
				const before = deps.audit.events.filter((event) => event.type !== "session.aborted").length;
				await subject.runtime.abort(operator, parent.id);
				a.strictEqual(fakes.held.get(parent.id)?.size, 0);
				a.strictEqual(
					deps.audit.events.filter((event) => event.type !== "session.aborted").length,
					before,
					"a second abort with nothing held audits nothing new",
				);
				subject.model.reply({ text: "Still here" });
				const next = await subject.runtime.prompt(operator, parent.id, { text: "Carry on" });
				a.partialDeepEqual(await subject.runtime.wait(operator, parent.id, next.id), { answer: "Still here" });
			}),
		},
		{
			name: "session end: a failing teardown does not stop the others or fail the close, and is audited with its name and code but not its message",
			run: run(async (subject, deps) => {
				const ran: string[] = [];
				subject.sessionEnd.register("conformance-first", async () => {
					ran.push("first");
				});
				subject.sessionEnd.register("conformance-broken", async () => {
					ran.push("broken");
					throw new HarbourError("unavailable", `The provider answered with ${CANARY_SECRET}`);
				});
				subject.sessionEnd.register("conformance-last", async () => {
					ran.push("last");
				});
				const session = await setUp(subject);
				await subject.runtime.close(operator, session.id);
				a.deepEqual(ran, ["first", "broken", "last"], "every teardown runs");
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "done", "the session still closes");
				const failed = deps.audit.ofType("session.teardown.failed");
				a.strictEqual(failed.length, 1);
				a.partialDeepEqual(failed[0], {
					source: "session",
					organisationId: ORG,
					projectId: PROJECT,
					sessionId: session.id,
					data: { teardown: "conformance-broken", reason: "session_ended", code: "unavailable" },
				});
				a.ok(!containsCanary(deps.audit.events), "the failure's message is never audited");
			}),
		},
		{
			name: "session end: a teardown name is registered once, and closing its registration removes it",
			run: run(async (subject) => {
				let calls = 0;
				const registration = subject.sessionEnd.register("conformance-once", async () => {
					calls += 1;
				});
				await a.rejectsWithCode(
					Promise.resolve().then(() => subject.sessionEnd.register("conformance-once", async () => {})),
					"conflict",
				);
				await registration.close();
				const session = await setUp(subject);
				await subject.runtime.close(operator, session.id);
				a.strictEqual(calls, 0, "a removed teardown is not run");
			}),
		},
	];

	const projectAccessCases: ConformanceCase[] = [
		{
			name: "project access: refuses an operator outside the project every call on its sessions and profiles, and changes nothing",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				const site = await subject.runtime.create(operator, { projectId: OTHER_PROJECT, agentId: AGENT });
				const denied = (call: Promise<unknown>, operation: string) =>
					assertAccessDenied(a, deps, call, { operation, message: `${operation} by an operator outside the project` });
				await denied(subject.runtime.create(siteOperator, { projectId: PROJECT, agentId: AGENT }), "session.create");
				await denied(
					subject.runtime.create(siteOperator, {
						projectId: OTHER_PROJECT,
						agentId: AGENT,
						parentSessionId: session.id,
					}),
					"session.create",
				);
				await denied(subject.runtime.prompt(siteOperator, session.id, { text: "Hi" }), "session.prompt");
				await denied(subject.runtime.steer(siteOperator, session.id, { text: "Hi" }), "session.steer");
				await denied(subject.runtime.followUp(siteOperator, session.id, { text: "Hi" }), "session.followUp");
				await denied(subject.runtime.abort(siteOperator, session.id), "session.abort");
				await denied(subject.runtime.close(siteOperator, session.id), "session.close");
				await denied(subject.runtime.wait(siteOperator, session.id, "no-such-submission"), "session.wait");
				await denied(subject.runtime.snapshot(siteOperator, session.id), "session.snapshot");
				await denied(
					subject.runtime.watch(siteOperator, session.id, {}, () => {}),
					"session.watch",
				);
				await denied(subject.directory.get(siteOperator, session.id), "session.get");
				await denied(subject.directory.children(siteOperator, session.id), "session.children");
				await denied(subject.directory.list(siteOperator, { projectId: PROJECT }), "session.list");
				await denied(
					subject.profiles.put(siteOperator, workerProfile({ id: "docs-only", projectId: PROJECT })),
					"session.profiles.put",
				);
				const docs = await subject.profiles.put(operator, workerProfile({ id: "docs-writer", projectId: PROJECT }));
				await denied(subject.profiles.get(siteOperator, docs.id), "session.profiles.get");
				await denied(
					subject.profiles.put(siteOperator, workerProfile({ id: docs.id, projectId: OTHER_PROJECT })),
					"session.profiles.put",
				);
				a.strictEqual((await subject.profiles.get(operator, docs.id)).projectId, PROJECT, "the profile was not moved");
				a.ok(
					!(await subject.profiles.list(siteOperator)).items.some((profile) => profile.id === docs.id),
					"the other project's profile is left out of the list",
				);
				a.ok((await subject.profiles.list(operator)).items.some((profile) => profile.id === docs.id));
				await denied(
					subject.hostTools.register(
						contextFor(siteOperator.actor, ORG, PROJECT),
						"intruder-host",
						[LOOKUP],
						async () => ({
							output: "no",
						}),
					),
					"session.hostTools.register",
				);
				a.deepEqual(await subject.hostTools.list(operator, "intruder-host"), [], "no host tools were registered");
				await serveHost(subject);
				await denied(
					subject.hostTools.register(siteOperator, HOST, [LOOKUP], async () => ({ output: "hijacked" })),
					"session.hostTools.register",
				);
				await denied(subject.hostTools.list(siteOperator, HOST), "session.hostTools.list");
				a.deepEqual(
					(await subject.hostTools.list(operator, HOST)).map((tool) => tool.name),
					[LOOKUP.name, REVIEW.name],
					"the project's host keeps its tools",
				);
				const listed = await subject.directory.list(siteOperator);
				a.deepEqual(
					listed.items.map((record) => record.id),
					[site.id],
					"an unfiltered list leaves out the other project's sessions",
				);
				a.strictEqual(subject.model.requests.length, 0, "the model was never asked");
				const record = await subject.directory.get(operator, session.id);
				a.strictEqual(record.status, "idle");
				a.strictEqual((await subject.runtime.snapshot(operator, session.id)).items.length, 0);
				a.strictEqual(deps.audit.ofType("session.aborted").length, 0, "nothing was aborted");
				a.strictEqual((await subject.directory.list(operator, { projectId: PROJECT })).items.length, 1);
				await a.rejectsWithCode(subject.profiles.get(operator, "docs-only"), "not_found");
			}),
		},
		{
			name: "project access: refuses an agent whose session belongs to another project, and changes nothing",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				const site = await subject.runtime.create(operator, { projectId: OTHER_PROJECT, agentId: AGENT });
				const siteAgent = agentIn(site.id, OTHER_PROJECT);
				const denied = (call: Promise<unknown>, operation: string) =>
					assertAccessDenied(a, deps, call, { operation, message: `${operation} by another project's agent` });
				await denied(subject.runtime.prompt(siteAgent, session.id, { text: "Hi" }), "session.prompt");
				await denied(subject.runtime.abort(siteAgent, session.id), "session.abort");
				await denied(subject.runtime.close(siteAgent, session.id), "session.close");
				await denied(subject.runtime.snapshot(siteAgent, session.id), "session.snapshot");
				await denied(subject.directory.get(siteAgent, session.id), "session.get");
				await denied(subject.runtime.create(siteAgent, { projectId: PROJECT, agentId: AGENT }), "session.create");
				await denied(
					subject.runtime.create(siteAgent, { projectId: PROJECT, agentId: AGENT, parentSessionId: session.id }),
					"session.create",
				);
				a.deepEqual(
					(await subject.directory.list(siteAgent)).items.map((record) => record.id),
					[site.id],
					"the agent lists only its own session",
				);
				a.strictEqual(subject.model.requests.length, 0);
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "idle");
				a.strictEqual((await subject.directory.list(operator)).items.length, 2, "no session was created");
			}),
		},
		{
			name: "project access: an agent acts in its own session and supervises its children, never a sibling, and nowhere once its session is closed",
			run: run(async (subject, deps) => {
				const parent = await setUp(subject);
				const sibling = await subject.runtime.create(operator, { projectId: PROJECT, agentId: AGENT });
				const agent = agentIn(parent.id);
				const child = await subject.runtime.create(agent, {
					projectId: PROJECT,
					agentId: AGENT,
					parentSessionId: parent.id,
				});
				a.strictEqual(child.parentSessionId, parent.id);
				a.partialDeepEqual(child.createdBy, agent.actor);
				a.strictEqual((await subject.runtime.snapshot(agent, parent.id)).status, "idle");
				a.strictEqual((await subject.directory.get(agent, child.id)).id, child.id, "a supervisor reads its child");
				await subject.runtime.abort(agent, child.id, "the supervisor stopped it");
				a.deepEqual(
					(await subject.directory.list(agent)).items.map((record) => record.id),
					[child.id, parent.id],
					"the agent lists its own session and its child, not its sibling",
				);
				await assertAccessDenied(a, deps, subject.directory.get(agent, sibling.id), { operation: "session.get" });
				await assertAccessDenied(a, deps, subject.runtime.prompt(agent, sibling.id, { text: "Hi" }), {
					operation: "session.prompt",
				});
				await subject.runtime.close(operator, parent.id);
				await assertAccessDenied(a, deps, subject.runtime.snapshot(agent, parent.id), {
					operation: "session.snapshot",
					message: "an agent whose session is closed reads nothing",
				});
				await assertAccessDenied(a, deps, subject.directory.get(agent, child.id), {
					operation: "session.get",
					message: "an agent whose session is closed no longer supervises its child",
				});
				a.strictEqual(subject.model.requests.length, 0, "the sibling was never prompted");
			}),
		},
		{
			name: "project access: a viewer on the project reads its sessions but cannot change them",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				a.strictEqual((await subject.directory.get(reader, session.id)).id, session.id);
				a.strictEqual((await subject.runtime.snapshot(reader, session.id)).status, "idle");
				a.deepEqual(
					(await subject.directory.list(reader, { projectId: PROJECT })).items.map((record) => record.id),
					[session.id],
				);
				await assertAccessDenied(a, deps, subject.runtime.prompt(reader, session.id, { text: "Hi" }), {
					operation: "session.prompt",
				});
				await assertAccessDenied(a, deps, subject.runtime.close(reader, session.id), { operation: "session.close" });
				await assertAccessDenied(a, deps, subject.runtime.create(reader, { projectId: PROJECT, agentId: AGENT }), {
					operation: "session.create",
				});
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "idle");
			}),
		},
	];

	const cases: ConformanceCase[] = [
		{
			name: "lists a created session in its organisation with its labels, idle, and filters by project and labels",
			run: run(async (subject, deps) => {
				const first = await setUp(subject);
				deps.clock.advance(1000);
				const second = await subject.runtime.create(operator, {
					projectId: OTHER_PROJECT,
					agentId: AGENT,
					title: "Site rebuild",
					labels: { docketTask: "T-2", lane: "web" },
				});
				const record = await subject.directory.get(operator, first.id);
				a.partialDeepEqual(record, {
					id: first.id,
					organisationId: ORG,
					projectId: PROJECT,
					agentId: AGENT,
					status: "idle",
					labels: { docketTask: "T-1" },
					createdBy: operator.actor,
				});
				const all = await subject.directory.list(operator);
				a.deepEqual(
					all.items.map((item) => item.id),
					[second.id, first.id],
					"newest first",
				);
				const byProject = await subject.directory.list(operator, { projectId: PROJECT });
				a.deepEqual(
					byProject.items.map((item) => item.id),
					[first.id],
				);
				const byLabels = await subject.directory.list(operator, { labels: { docketTask: "T-2", lane: "web" } });
				a.deepEqual(
					byLabels.items.map((item) => item.id),
					[second.id],
				);
				const noMatch = await subject.directory.list(operator, { labels: { docketTask: "T-2", lane: "api" } });
				a.strictEqual(noMatch.items.length, 0, "every label given must match");
				const firstPage = await subject.directory.list(operator, undefined, { limit: 1 });
				a.deepEqual(
					firstPage.items.map((item) => item.id),
					[second.id],
				);
				a.ok(firstPage.nextCursor, "a first page of one has a next cursor");
				const secondPage = await subject.directory.list(operator, undefined, {
					limit: 1,
					...(firstPage.nextCursor === undefined ? {} : { cursor: firstPage.nextCursor }),
				});
				a.deepEqual(
					secondPage.items.map((item) => item.id),
					[first.id],
				);
				a.strictEqual(deps.audit.ofType("session.created").length, 2);
			}),
		},
		{
			name: "hides sessions and profiles from other organisations as not_found",
			run: run(async (subject) => {
				const session = await setUp(subject);
				await a.rejectsWithCode(subject.directory.get(outsider, session.id), "not_found");
				a.strictEqual((await subject.directory.list(outsider)).items.length, 0);
				await a.rejectsWithCode(subject.runtime.prompt(outsider, session.id, { text: "Hi" }), "not_found");
				await a.rejectsWithCode(subject.runtime.snapshot(outsider, session.id), "not_found");
				await a.rejectsWithCode(subject.runtime.abort(outsider, session.id), "not_found");
				await a.rejectsWithCode(subject.directory.children(outsider, session.id), "not_found");
				await a.rejectsWithCode(subject.profiles.get(outsider, AGENT), "not_found");
				a.strictEqual((await subject.profiles.list(outsider)).items.length, 0);
				await a.rejectsWithCode(
					subject.runtime.create(outsider, { projectId: PROJECT, agentId: AGENT }),
					"not_found",
					"another organisation cannot use the profile",
				);
			}),
		},
		{
			name: "refuses to create a session with an unknown agent profile as not_found",
			run: run(async (subject) => {
				await subject.profiles.put(operator, workerProfile());
				await a.rejectsWithCode(
					subject.runtime.create(operator, { projectId: PROJECT, agentId: "no-such-agent" }),
					"not_found",
				);
				await a.rejectsWithCode(
					subject.runtime.create(operator, { projectId: PROJECT, agentId: AGENT, parentSessionId: "no-such-session" }),
					"not_found",
					"an unknown parent session is not_found",
				);
				await subject.profiles.put(operator, workerProfile({ id: "site-writer", projectId: OTHER_PROJECT }));
				await a.rejectsWithCode(
					subject.runtime.create(operator, { projectId: PROJECT, agentId: "site-writer" }),
					"invalid",
					"a project's profile runs only in that project",
				);
			}),
		},
		{
			name: "keeps agent profiles per organisation and refuses one for another organisation",
			run: run(async (subject) => {
				const profile = workerProfile();
				await subject.profiles.put(operator, profile);
				a.deepEqual(await subject.profiles.get(operator, AGENT), profile);
				const listed = await subject.profiles.list(operator);
				a.deepEqual(
					listed.items.map((item) => item.id),
					[AGENT],
				);
				await a.rejectsWithCode(
					subject.profiles.put(operator, workerProfile({ id: "foreign", organisationId: OTHER_ORG })),
					"forbidden",
				);
			}),
		},
		{
			name: "answers a prompt with the scripted text and shows the user and assistant items",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				subject.model.reply({ text: "Hello from Harbour" });
				const submission = await subject.runtime.prompt(operator, session.id, { text: "Say hello" });
				a.partialDeepEqual(submission, { sessionId: session.id, via: "prompt" });
				const result = await subject.runtime.wait(operator, session.id, submission.id);
				a.partialDeepEqual(result, {
					sessionId: session.id,
					submissionId: submission.id,
					status: "answered",
					answer: "Hello from Harbour",
				});
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(usersOf(snapshot.items), [{ text: "Say hello", via: "prompt" }]);
				a.partialDeepEqual(
					snapshot.items.filter((item) => item.kind === "assistant"),
					[{ text: "Hello from Harbour", streaming: false }],
				);
				a.strictEqual(snapshot.status, "idle");
				a.strictEqual(snapshot.attention, "done");
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "idle");
				const request = subject.model.requests[0];
				a.ok(request !== undefined, "the model was asked");
				const system = request?.system ?? "";
				const role = system.indexOf("You are a careful worker.");
				a.ok(role >= 0 && system.indexOf("Answer briefly.") > role, "prompt layers are joined in order");
				a.strictEqual(lastUserText(request), "Say hello");
				a.strictEqual(deps.audit.ofType("session.prompted").length, 1);
			}),
		},
		{
			name: "returns the same submission for a retried requestId and asks the model once",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				subject.model.reply({ text: "Once" }, { text: "Twice" });
				const first = await subject.runtime.prompt(operator, session.id, { text: "Go", requestId: "req-1" });
				const again = await subject.runtime.prompt(operator, session.id, { text: "Go", requestId: "req-1" });
				a.deepEqual(again, first);
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, first.id), { answer: "Once" });
				const retried = await subject.runtime.prompt(operator, session.id, { text: "Go", requestId: "req-1" });
				a.deepEqual(retried, first, "a retry after the answer still finds the submission");
				a.strictEqual(subject.model.requests.length, 1);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(usersOf(snapshot.items), [{ text: "Go", requestId: "req-1" }]);
				a.strictEqual(usersOf(snapshot.items).length, 1);
				a.strictEqual(deps.audit.ofType("session.prompted").length, 1);
			}),
		},
		{
			name: "streams hello and a snapshot, live deltas rebuild the final snapshot, and a reconnect resumes after a cursor",
			run: run(async (subject) => {
				const session = await setUp(subject);
				const frames: ServerFrame[] = [];
				const live = await subject.runtime.watch(operator, session.id, {}, (frame) => frames.push(frame));
				a.partialDeepEqual(frames[0], { type: "hello", sessionId: session.id, resumed: false });
				a.strictEqual(frames[1]?.type, "snapshot");
				subject.model.reply({ text: "First answer" });
				const first = await subject.runtime.prompt(operator, session.id, { text: "First" });
				await subject.runtime.wait(operator, session.id, first.id);
				const middle = await subject.runtime.snapshot(operator, session.id);
				a.deepEqual(comparable(applyFrames(frames)), comparable(middle));
				await live.close();

				subject.model.reply({ text: "Second answer" });
				const second = await subject.runtime.prompt(operator, session.id, { text: "Second" });
				await subject.runtime.wait(operator, session.id, second.id);
				const resumed: ServerFrame[] = [];
				const again = await subject.runtime.watch(operator, session.id, { after: middle.cursor }, (frame) =>
					resumed.push(frame),
				);
				a.partialDeepEqual(resumed[0], { type: "hello", resumed: true });
				a.ok(
					resumed.slice(1).every((frame) => frame.type === "delta"),
					"only deltas follow a resumed hello",
				);
				a.ok(resumed.length > 1, "the deltas after the cursor are sent");
				const final = await subject.runtime.snapshot(operator, session.id);
				a.deepEqual(comparable(applyFrames(resumed, middle)), comparable(final));
				a.deepEqual(assistantTexts(final.items), ["First answer", "Second answer"]);
				await again.close();
			}),
		},
		{
			name: "passes a host tool call to the host with the session, agent, call ID and arguments, and its result to the model",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				const host = await serveHost(subject);
				subject.model.reply({ toolCalls: [{ name: "lookup", args: { key: "plan" } }] }, { text: "Plan found" });
				const submission = await subject.runtime.prompt(operator, session.id, { text: "Find the plan" });
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, submission.id), {
					status: "answered",
					answer: "Plan found",
				});
				a.strictEqual(host.calls.length, 1);
				const call = host.calls[0];
				a.partialDeepEqual(call, {
					hostId: HOST,
					sessionId: session.id,
					organisationId: ORG,
					projectId: PROJECT,
					agentId: AGENT,
					tool: "lookup",
					args: { key: "plan" },
				});
				a.ok(typeof call?.callId === "string" && call.callId !== "", "the call has a stable ID");
				const toolMessages = subject.model.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
				a.ok(
					toolMessages.some((message) => message.text.includes("Note plan is ready")),
					"the tool result reaches the model's next request",
				);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(toolsOf(snapshot.items), [{ name: "lookup", callId: call?.callId, status: "done" }]);
				a.ok((toolsOf(snapshot.items)[0]?.label ?? "") !== "", "the tool item has a label");
				a.strictEqual(deps.audit.ofType("session.tool.started").length, 1);
				a.strictEqual(deps.audit.ofType("session.tool.finished").length, 1);
				a.deepEqual(
					(await subject.hostTools.list(operator, HOST)).map((tool) => tool.name),
					[LOOKUP.name, REVIEW.name],
				);
				await host.subscription.close();
				a.strictEqual((await subject.hostTools.list(operator, HOST)).length, 0, "closing the registration ends it");
			}),
		},
		{
			name: "gives the model an error result for a profile tool the host does not serve, and the run still answers",
			run: run(async (subject) => {
				const session = await setUp(subject);
				const host = await serveHost(subject);
				subject.model.reply({ toolCalls: [{ name: "not_served", args: {} }] }, { text: "Recovered" });
				const submission = await subject.runtime.prompt(operator, session.id, { text: "Try it" });
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, submission.id), {
					status: "answered",
					answer: "Recovered",
				});
				a.strictEqual(host.calls.length, 0, "the host is not called");
				const toolMessages = subject.model.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
				a.strictEqual(toolMessages.length, 1, "the model gets a result for the call");
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(toolsOf(snapshot.items), [{ name: "not_served", status: "error" }]);
			}),
		},
		{
			name: "joins a steer sent while a host tool is blocked to the run after the tool round",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				const host = await serveHost(subject);
				subject.model.reply({ toolCalls: [{ name: REVIEW.name, args: {} }] }, { text: "Short answer" });
				const prompt = await subject.runtime.prompt(operator, session.id, { text: "Write it up" });
				await eventually(() => host.calls.length === 1, 3000, "the blocking tool call");
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "running");
				a.strictEqual((await subject.runtime.snapshot(operator, session.id)).attention, "working");
				const steer = await subject.runtime.steer(operator, session.id, { text: "Use the short format" });
				a.strictEqual(steer.via, "steer");
				host.review.open();
				const result = await subject.runtime.wait(operator, session.id, prompt.id);
				a.partialDeepEqual(result, { status: "answered", answer: "Short answer" });
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, steer.id), {
					status: "answered",
					answer: "Short answer",
				});
				a.strictEqual(subject.model.requests.length, 2, "the steer joins the run rather than starting another");
				a.strictEqual(lastUserText(subject.model.requests[1]), "Use the short format");
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(usersOf(snapshot.items), [
					{ text: "Write it up", via: "prompt" },
					{ text: "Use the short format", via: "steer" },
				]);
				a.strictEqual(deps.audit.ofType("session.steered").length, 1);
			}),
		},
		{
			name: "starts a follow-up sent while busy after the current run answers",
			run: run(async (subject) => {
				const session = await setUp(subject);
				const model = gate();
				subject.model.reply(
					async () => {
						await model.opened;
						return { text: "First answer" };
					},
					{ text: "Second answer" },
				);
				const first = await subject.runtime.prompt(operator, session.id, { text: "First" });
				await eventually(() => subject.model.requests.length === 1, 3000, "the first model request");
				const followUp = await subject.runtime.followUp(operator, session.id, { text: "Second" });
				a.strictEqual(followUp.via, "followUp");
				a.strictEqual(subject.model.requests.length, 1, "the follow-up waits for the run");
				model.open();
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, first.id), { answer: "First answer" });
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, followUp.id), {
					status: "answered",
					answer: "Second answer",
				});
				const second = subject.model.requests[1];
				a.strictEqual(lastUserText(second), "Second");
				a.ok(
					second?.messages.some((message) => message.role === "assistant" && message.text === "First answer"),
					"the follow-up run sees the first answer",
				);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(
					snapshot.items.map((item) => (item.kind === "user" ? `${item.via}:${item.text}` : item.kind)),
					["prompt:First", "assistant", "followUp:Second", "assistant"],
				);
			}),
		},
		{
			name: "aborting while a host tool is blocked ends the run aborted, aborts the handler, releases sandbox leases and leaves the session usable",
			run: run(async (subject, deps) => {
				const session = await setUp(subject);
				const host = await serveHost(subject);
				subject.model.reply({ toolCalls: [{ name: REVIEW.name, args: {} }] }, { text: "Fresh start" });
				const prompt = await subject.runtime.prompt(operator, session.id, { text: "Wait for review" });
				await eventually(() => host.calls.length === 1, 3000, "the blocking tool call");
				await subject.runtime.abort(operator, session.id, "operator stopped it");
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, prompt.id), { status: "aborted" });
				a.strictEqual(host.signals[0]?.aborted, true, "the handler's signal is aborted");
				a.ok(subject.releasedSessions.includes(session.id), "the session's sandbox leases are released");
				a.ok(deps.audit.ofType("session.aborted").length >= 1);
				const aborted = await subject.runtime.snapshot(operator, session.id);
				a.partialDeepEqual(toolsOf(aborted.items), [{ name: REVIEW.name, status: "interrupted" }]);
				a.strictEqual(aborted.status, "idle");
				const next = await subject.runtime.prompt(operator, session.id, { text: "Start again" });
				a.partialDeepEqual(await subject.runtime.wait(operator, session.id, next.id), {
					status: "answered",
					answer: "Fresh start",
				});
				host.review.open();
			}),
		},
		{
			name: "aborting a parent aborts its running child session, which the directory lists under the parent",
			run: run(async (subject) => {
				const parent = await setUp(subject);
				const child = await subject.runtime.create(operator, {
					projectId: PROJECT,
					agentId: AGENT,
					parentSessionId: parent.id,
				});
				a.strictEqual(child.parentSessionId, parent.id);
				a.deepEqual(
					(await subject.directory.children(operator, parent.id)).map((record) => record.id),
					[child.id],
				);
				a.deepEqual(
					(await subject.directory.list(operator, { parentSessionId: parent.id })).items.map((record) => record.id),
					[child.id],
				);
				const host = await serveHost(subject);
				subject.model.reply({ toolCalls: [{ name: REVIEW.name, args: {} }] });
				const childPrompt = await subject.runtime.prompt(operator, child.id, { text: "Wait for review" });
				await eventually(() => host.calls.length === 1, 3000, "the child's blocking tool call");
				a.strictEqual(host.calls[0]?.sessionId, child.id);
				await subject.runtime.abort(operator, parent.id);
				a.partialDeepEqual(await subject.runtime.wait(operator, child.id, childPrompt.id), { status: "aborted" });
				a.strictEqual(host.signals[0]?.aborted, true, "the child's handler is aborted");
				a.ok(subject.releasedSessions.includes(child.id), "the child's leases are released");
				a.ok(subject.releasedSessions.includes(parent.id), "the parent's leases are released");
				a.strictEqual((await subject.directory.get(operator, child.id)).status, "idle");
				host.review.open();
			}),
		},
		{
			name: "closing a session marks it done and refuses later prompts with conflict",
			run: run(async (subject) => {
				const session = await setUp(subject);
				subject.model.reply({ text: "All done" });
				const prompt = await subject.runtime.prompt(operator, session.id, { text: "Finish" });
				await subject.runtime.wait(operator, session.id, prompt.id);
				await subject.runtime.close(operator, session.id);
				a.strictEqual((await subject.directory.get(operator, session.id)).status, "done");
				a.strictEqual((await subject.directory.list(operator, { status: "done" })).items.length, 1);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.strictEqual(snapshot.status, "done");
				a.strictEqual(snapshot.attention, "done");
				a.ok(subject.releasedSessions.includes(session.id), "closing releases the session's leases");
				await a.rejectsWithCode(subject.runtime.prompt(operator, session.id, { text: "More" }), "conflict");
				await a.rejectsWithCode(subject.runtime.steer(operator, session.id, { text: "More" }), "conflict");
				await a.rejectsWithCode(subject.runtime.followUp(operator, session.id, { text: "More" }), "conflict");
			}),
		},
	];

	const historyOf = (subject: RuntimeSubject): SessionHistory => {
		if (subject.history === undefined) throw new Error("The history cases need the subject's history");
		return subject.history;
	};

	/** Runs `turns` prompts, each answered, so the session holds a user and an assistant item for each. */
	const converse = async (subject: RuntimeSubject, sessionId: string, turns: number, from = 0) => {
		for (let turn = from; turn < from + turns; turn++) {
			subject.model.reply({ text: `Answer ${turn}` });
			const prompt = await subject.runtime.prompt(operator, sessionId, { text: `Question ${turn}` });
			await subject.runtime.wait(operator, sessionId, prompt.id);
		}
	};

	/** Every item, oldest first, by following cursors from the latest page. */
	const readBack = async (history: SessionHistory, ctx: CallContext, sessionId: string, limit: number) => {
		const pages: (readonly TranscriptItem[])[] = [];
		let cursor: string | undefined;
		do {
			const page = await history.history(ctx, sessionId, { limit, ...(cursor === undefined ? {} : { cursor }) });
			a.ok(page.items.length > 0 && page.items.length <= limit, "a page holds from one to limit items");
			a.strictEqual(page.sessionId, sessionId);
			pages.push(page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return { pages, items: pages.flat().reverse() };
	};

	const textsOf = (items: readonly TranscriptItem[]) =>
		items.map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind));

	const historyCases: ConformanceCase[] = [
		{
			name: "history: serves the latest page first, newest first, and its cursors page back to the start without a repeat or a gap",
			run: run(async (subject) => {
				const history = historyOf(subject);
				const session = await setUp(subject);
				const empty = await history.history(operator, session.id);
				a.deepEqual(empty.items, [], "a new session has no items");
				a.strictEqual(empty.nextCursor, undefined);
				await converse(subject, session.id, 9);
				const latest = await history.history(operator, session.id, { limit: 4 });
				a.deepEqual(textsOf(latest.items), ["Answer 8", "Question 8", "Answer 7", "Question 7"]);
				a.ok(latest.nextCursor !== undefined, "older items follow");
				const { pages, items } = await readBack(history, operator, session.id, 4);
				a.strictEqual(pages.length, 5, "18 items in pages of 4");
				a.deepEqual(
					textsOf(items),
					Array.from({ length: 9 }, (_, turn) => [`Question ${turn}`, `Answer ${turn}`]).flat(),
				);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				a.deepEqual(
					items.map((item) => item.id),
					snapshot.items.map((item) => item.id),
					"the same items, with the same IDs, as the snapshot",
				);
				const all = await history.history(reader, session.id);
				a.strictEqual(all.items.length, 18, "the default page holds them all, and a viewer may read it");
				a.strictEqual(all.nextCursor, undefined);
			}),
		},
		{
			name: "history: pages behind a cursor stay the same while new turns arrive",
			run: run(async (subject) => {
				const history = historyOf(subject);
				const session = await setUp(subject);
				await converse(subject, session.id, 6);
				const latest = await history.history(operator, session.id, { limit: 3 });
				await converse(subject, session.id, 3, 6);
				const older: TranscriptItem[] = [...latest.items];
				let cursor = latest.nextCursor;
				while (cursor !== undefined) {
					const page = await history.history(operator, session.id, { cursor, limit: 3 });
					older.push(...page.items);
					cursor = page.nextCursor;
				}
				a.deepEqual(
					textsOf(older.reverse()),
					Array.from({ length: 6 }, (_, turn) => [`Question ${turn}`, `Answer ${turn}`]).flat(),
					"paging back from the first page sees each earlier item once, whatever arrived since",
				);
				const now = await history.history(operator, session.id, { limit: 2 });
				a.deepEqual(textsOf(now.items), ["Answer 8", "Question 8"], "a new latest page has the new turns");
			}),
		},
		{
			name: "history: pages back from an item a client holds, as the protocol's history frame names it",
			run: run(async (subject) => {
				const history = historyOf(subject);
				const session = await setUp(subject);
				await converse(subject, session.id, 4);
				const snapshot = await subject.runtime.snapshot(operator, session.id);
				const held = snapshot.items[5]!;
				const page = await history.history(operator, session.id, { before: held.id, limit: 3 });
				a.deepEqual(
					page.items.map((item) => item.id),
					snapshot.items
						.slice(2, 5)
						.map((item) => item.id)
						.reverse(),
				);
				a.ok(page.nextCursor !== undefined);
				const rest = await history.history(operator, session.id, { cursor: page.nextCursor!, limit: 10 });
				a.deepEqual(
					rest.items.map((item) => item.id),
					snapshot.items
						.slice(0, 2)
						.map((item) => item.id)
						.reverse(),
				);
				a.strictEqual(rest.nextCursor, undefined, "the first item has nothing before it");
				const first = await history.history(operator, session.id, { before: snapshot.items[0]!.id });
				a.deepEqual(first.items, []);
			}),
		},
		{
			name: "history: refuses a malformed request as invalid, an unknown item and another organisation's session as not_found",
			run: run(async (subject) => {
				const history = historyOf(subject);
				const session = await setUp(subject);
				await converse(subject, session.id, 2);
				const latest = await history.history(operator, session.id, { limit: 1 });
				const cursor = latest.nextCursor!;
				await a.rejectsWithCode(history.history(operator, session.id, { cursor, before: "x" }), "invalid");
				await a.rejectsWithCode(history.history(operator, session.id, { cursor: "not-a-cursor" }), "invalid");
				await a.rejectsWithCode(history.history(operator, session.id, { limit: 0 }), "invalid");
				await a.rejectsWithCode(history.history(operator, session.id, { before: "no-such-item" }), "not_found");
				await a.rejectsWithCode(history.history(outsider, session.id), "not_found");
				await a.rejectsWithCode(history.history(operator, "no-such-session"), "not_found");
				const capped = await history.history(operator, session.id, { limit: 5000 });
				a.strictEqual(capped.items.length, 4, "a limit above the most a page holds is cut, not refused");
			}),
		},
		...(options.projectAccess === true
			? [
					{
						name: "history: project access refuses an operator outside the project",
						run: run(async (subject, deps) => {
							const history = historyOf(subject);
							const session = await setUp(subject);
							await assertAccessDenied(a, deps, history.history(siteOperator, session.id), {
								operation: "session.history",
								message: "session.history by an operator outside the project",
							});
						}),
					},
				]
			: []),
	];

	return [
		...cases,
		...sessionEndCases,
		...(options.projectAccess === true ? projectAccessCases : []),
		...(options.history === true ? historyCases : []),
	];
}

export function registerRuntimeConformance(
	runner: ConformanceRunner,
	name: string,
	provider: RuntimeConformanceProvider,
	options?: RuntimeConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createRuntimeConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
			...(options?.history === undefined ? {} : { history: options.history }),
		}),
	);
}
