/**
 * Conformance suite for the client wire protocol's server side (`SessionStream`), which every target's WebSocket or
 * SSE endpoint implements. A console that follows the protocol must always reach the server's state.
 */
import {
	applyDelta,
	applyFrames,
	type DeltaOp,
	type ServerFrame,
	type SessionStream,
	type SessionStreamWriter,
	type TranscriptItem,
} from "@kantel/protocol";
import {
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface ProtocolSubject {
	readonly stream: SessionStream;
	readonly writer: SessionStreamWriter;
	/** The page size the stream was built with, so the suite can exceed it. */
	readonly pageSize: number;
	/** How many recent deltas it keeps for resuming, so the suite can fall behind it. */
	readonly retainDeltas: number;
}

export type ProtocolConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: ProtocolSubject) => Promise<void>,
) => Promise<void>;

export interface ProtocolConformanceOptions {
	readonly assertions: ConformanceAssertions;
	readonly provider: ProtocolConformanceProvider;
}

const user = (id: string, text: string): TranscriptItem => ({ kind: "user", id, at: 0, text, via: "prompt" });
const assistant = (id: string, text = ""): TranscriptItem => ({
	kind: "assistant",
	id,
	at: 0,
	text,
	streaming: true,
});

/** A small run: a prompt, a streamed answer, a tool chip that finishes, and a status change. */
const RUN: readonly (readonly DeltaOp[])[] = [
	[{ op: "status", status: "running", attention: "working" }],
	[{ op: "append", item: user("u1", "Summarise the log") }],
	[{ op: "append", item: assistant("a1") }],
	[{ op: "text", itemId: "a1", append: "Six crossings" }],
	[{ op: "text", itemId: "a1", append: ", two refused." }],
	[
		{
			op: "append",
			item: {
				kind: "tool",
				id: "t1",
				at: 0,
				callId: "call-1",
				name: "read",
				label: "Reading log.txt",
				status: "running",
			},
		},
	],
	[
		{
			op: "replace",
			item: {
				kind: "tool",
				id: "t1",
				at: 0,
				callId: "call-1",
				name: "read",
				label: "Reading log.txt",
				status: "done",
				output: "ok",
			},
		},
	],
	[
		{
			op: "replace",
			item: { kind: "assistant", id: "a1", at: 0, text: "Six crossings, two refused.", streaming: false },
		},
		{ op: "status", status: "idle", attention: "done" },
	],
];

async function publishAll(writer: SessionStreamWriter, ops: readonly (readonly DeltaOp[])[]) {
	for (const batch of ops) await writer.publish(batch);
}

function comparable(snapshot: { items: readonly TranscriptItem[]; status: string; attention: string; cursor: string }) {
	return { items: snapshot.items, status: snapshot.status, attention: snapshot.attention, cursor: snapshot.cursor };
}

export function createProtocolConformance(options: ProtocolConformanceOptions): readonly ConformanceCase[] {
	const assert = options.assertions;
	const createCase = (name: string, test: (subject: ProtocolSubject) => Promise<void>): ConformanceCase => ({
		name,
		run: () => options.provider(createDeps(), test),
	});

	return [
		createCase("answers a fresh hello with hello, then a snapshot", async ({ stream, writer }) => {
			await publishAll(writer, RUN.slice(0, 3));
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(undefined, (frame) => frames.push(frame));
			await connection.close();
			assert.partialDeepEqual(frames[0], { type: "hello", v: 1, sessionId: stream.sessionId, resumed: false });
			assert.strictEqual(frames[1]?.type, "snapshot");
			assert.strictEqual(frames.length, 2);
			const hello = frames[0] as Extract<ServerFrame, { type: "hello" }>;
			const snapshot = frames[1] as Extract<ServerFrame, { type: "snapshot" }>;
			assert.strictEqual(snapshot.snapshot.cursor, hello.cursor);
			assert.strictEqual(snapshot.snapshot.items.length, 2);
		}),

		createCase("live deltas applied to the first snapshot equal a fresh snapshot", async ({ stream, writer }) => {
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(undefined, (frame) => frames.push(frame));
			await publishAll(writer, RUN);
			await connection.close();
			const rebuilt = applyFrames(frames);
			const fresh = await stream.snapshot();
			assert.ok(rebuilt, "frames held a snapshot");
			assert.deepEqual(comparable(rebuilt!), comparable(fresh));
			assert.strictEqual(fresh.status, "idle");
			assert.strictEqual(fresh.attention, "done");
		}),

		createCase("resumes after a held cursor with only the later deltas", async ({ stream, writer }) => {
			await publishAll(writer, RUN.slice(0, 4));
			const first = await stream.snapshot();
			await publishAll(writer, RUN.slice(4));
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(first.cursor, (frame) => frames.push(frame));
			await connection.close();
			assert.partialDeepEqual(frames[0], { type: "hello", resumed: true });
			assert.ok(
				frames.slice(1).every((frame) => frame.type === "delta"),
				"only deltas follow a resumed hello",
			);
			assert.strictEqual(frames.length - 1, RUN.length - 4);
			const rebuilt = applyFrames(frames, first);
			assert.deepEqual(comparable(rebuilt!), comparable(await stream.snapshot()));
		}),

		createCase("falls back to a snapshot for a cursor it cannot resume from", async ({ stream, writer }) => {
			await publishAll(writer, RUN);
			const frames: ServerFrame[] = [];
			const connection = await stream.connect("not-a-cursor", (frame) => frames.push(frame));
			await connection.close();
			assert.partialDeepEqual(frames[0], { type: "hello", resumed: false });
			assert.strictEqual(frames[1]?.type, "snapshot");
		}),

		createCase("falls back to a snapshot once the client has fallen behind the retained deltas", async (subject) => {
			const { stream, writer, retainDeltas } = subject;
			await writer.publish([{ op: "append", item: user("u0", "start") }]);
			const behind = (await stream.snapshot()).cursor;
			for (let index = 0; index <= retainDeltas; index++) {
				await writer.publish([{ op: "title", title: `title ${index}` }]);
			}
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(behind, (frame) => frames.push(frame));
			await connection.close();
			assert.partialDeepEqual(frames[0], { type: "hello", resumed: false });
			assert.strictEqual(frames[1]?.type, "snapshot");
		}),

		createCase("bounds a snapshot to one page and pages earlier items through history", async (subject) => {
			const { stream, writer, pageSize } = subject;
			const total = pageSize * 2 + 3;
			for (let index = 0; index < total; index++) {
				await writer.publish([{ op: "append", item: user(`u${index}`, `message ${index}`) }]);
			}
			const snapshot = await stream.snapshot();
			assert.ok(snapshot.items.length <= pageSize, "a snapshot holds at most one page");
			assert.strictEqual(snapshot.hasEarlier, true);
			const seen = [...snapshot.items];
			let hasEarlier = snapshot.hasEarlier;
			while (hasEarlier) {
				const page = await stream.history(seen[0]!.id, pageSize);
				assert.ok(page.items.length > 0 && page.items.length <= pageSize, "history pages are bounded");
				seen.unshift(...page.items);
				hasEarlier = page.hasEarlier;
			}
			assert.deepEqual(
				seen.map((item) => item.id),
				Array.from({ length: total }, (_, index) => `u${index}`),
			);
		}),

		createCase("keeps the identity of items a delta does not touch", async ({ stream, writer }) => {
			await publishAll(writer, RUN.slice(0, 3));
			const before = await stream.snapshot();
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(before.cursor, (frame) => frames.push(frame));
			await writer.publish([{ op: "text", itemId: "a1", append: "hello" }]);
			await connection.close();
			const delta = frames.find((frame) => frame.type === "delta");
			assert.ok(delta, "a live delta arrived");
			const after = applyDelta(before, (delta as Extract<ServerFrame, { type: "delta" }>).delta);
			assert.ok(after.items[0] === before.items[0], "the untouched user item is the same object");
			assert.ok(after.items[1] !== before.items[1], "the streamed assistant item is new");
			assert.partialDeepEqual(after.items[1], { text: "hello" });
		}),

		createCase("stops delivering frames after close", async ({ stream, writer }) => {
			const frames: ServerFrame[] = [];
			const connection = await stream.connect(undefined, (frame) => frames.push(frame));
			await connection.close();
			await connection.close();
			const count = frames.length;
			await publishAll(writer, RUN.slice(0, 2));
			assert.strictEqual(frames.length, count);
		}),

		// The card's type, and the deprecated type transcripts written before #324 carry.
		...(["connection.approval", "vault.approval"] as const).map((type) =>
			createCase(`carries a ${type} card with its binding code`, async ({ stream, writer }) => {
				await writer.publish([
					{
						op: "append",
						item: {
							kind: "card",
							id: "card-1",
							at: 0,
							card: {
								type,
								proposalId: "prop-1",
								status: "pending",
								bindingCode: "K7Q-2MX",
								what: "Linear API access",
								why: "Read the ticket",
								host: "api.linear.app",
								methods: ["POST"],
								pathPrefix: "/graphql",
								injectionTemplate: "Bearer {key}",
								termsSource: "agent-proposed",
								expiresAt: 0,
								link: "https://harbour.example/connections/requests/prop-1",
							},
						},
					},
					{ op: "status", status: "waiting", attention: "waiting" },
				]);
				const snapshot = await stream.snapshot();
				assert.partialDeepEqual(snapshot.items.at(-1), {
					kind: "card",
					card: { type, bindingCode: "K7Q-2MX" },
				});
				assert.strictEqual(snapshot.attention, "waiting");
			}),
		),
	];
}

export function registerProtocolConformance(
	runner: ConformanceRunner,
	name: string,
	provider: ProtocolConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createProtocolConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
