/**
 * Conformance suite for the session runtime: `SessionRuntime`, `SessionDirectory`, `AgentProfiles` and
 * `HostToolBridge`. The model is scripted through `ModelScript`, so the suite knows nothing of Pi; each implementation
 * wires its scripted model, its clock, its audit sink and a sandbox `releaseSession` recorder into the subject.
 */
import type {
	AgentProfile,
	AgentProfiles,
	CallContext,
	HostToolBridge,
	HostToolCall,
	HostToolDefinition,
	HostToolHandler,
	JsonValue,
	SessionDirectory,
	SessionRuntime,
	Subscription,
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
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
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
}

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
			await options.provider(deps, (subject) => body(subject, deps));
		};

	return [
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
}

export function registerRuntimeConformance(
	runner: ConformanceRunner,
	name: string,
	provider: RuntimeConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createRuntimeConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
