// Branching a session's history (`SessionBranching`): a fork into a new session from an answer, and an edit that
// rewinds the session to a message and reruns it, kept across a restart; watchers moved onto the rewound transcript.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { type AgentProfile, KantelError } from "@kantel/contracts";
import type { ServerFrame, TranscriptItem } from "@kantel/protocol";
import { createSessionRuntime } from "@kantel/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-branch";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

function databaseFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "kantel-branch-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "kantel.db");
}

/** One process on the database file: its own runtime and scripted model. */
async function processOn(file: string) {
	const db = await openNodeSqliteDatabase(file);
	const { models, script } = createScriptedModel();
	const store = await createSqlSessionStore(db);
	const service = createSessionRuntime({ store, storage: (session) => sqlPiStorage(db, session.id), models });
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await service.close();
		await db.close();
	};
	cleanups.push(close);
	return { service, script, close };
}

type Process = Awaited<ReturnType<typeof processOn>>;

/** Sends `text` and waits for the scripted answer `answer`. */
async function turn(process: Process, sessionId: string, text: string, answer: string) {
	process.script.reply({ text: answer });
	const submission = await process.service.runtime.prompt(ctx, sessionId, { text });
	expect(await process.service.runtime.wait(ctx, sessionId, submission.id)).toMatchObject({ answer });
}

const shown = (items: readonly TranscriptItem[]) =>
	items.flatMap((item) => (item.kind === "user" || item.kind === "assistant" ? [`${item.kind}: ${item.text}`] : []));

const itemOf = (items: readonly TranscriptItem[], text: string) => {
	const item = items.find((candidate) => "text" in candidate && candidate.text === text);
	if (item === undefined) throw new Error(`No item "${text}"`);
	return item.id;
};

const code = async (operation: Promise<unknown>) => {
	try {
		await operation;
	} catch (error) {
		return error instanceof KantelError ? error.code : String(error);
	}
	return "resolved";
};

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function conversationIn(process: Process) {
	await process.service.profiles.put(ctx, profile);
	const session = await process.service.runtime.create(ctx, { projectId: "proj", agentId: "worker", title: "Plan" });
	await turn(process, session.id, "First question", "First answer");
	await turn(process, session.id, "Second question", "Second answer");
	await turn(process, session.id, "Third question", "Third answer");
	return session;
}

describe("fork", () => {
	it("starts a new idle session with the history up to the answer, and sends it to the model from there", async () => {
		const process = await processOn(databaseFile());
		const source = await conversationIn(process);
		const before = (await process.service.runtime.snapshot(ctx, source.id)).items;

		const fork = await process.service.branching.fork(ctx, source.id, { itemId: itemOf(before, "Second answer") });
		expect(fork).toMatchObject({ projectId: "proj", agentId: "worker", title: "Plan (fork)", status: "idle" });
		expect(fork.id).not.toBe(source.id);
		const forked = await process.service.runtime.snapshot(ctx, fork.id);
		expect(shown(forked.items)).toEqual([
			"user: First question",
			"assistant: First answer",
			"user: Second question",
			"assistant: Second answer",
		]);
		// The times the messages were sent and answered come with them.
		expect(forked.items.map((item) => item.at)).toEqual(before.slice(0, 4).map((item) => item.at));

		await turn(process, fork.id, "A different third question", "A different third answer");
		expect(process.script.requests.at(-1)?.messages).toEqual([
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
			{ role: "user", text: "Second question" },
			{ role: "assistant", text: "Second answer" },
			{ role: "user", text: "A different third question" },
		]);
		// The source is as it was.
		expect(shown((await process.service.runtime.snapshot(ctx, source.id)).items)).toEqual(shown(before));
	});

	it("names a title when asked, and refuses an item that is not an answer", async () => {
		const process = await processOn(databaseFile());
		const source = await conversationIn(process);
		const items = (await process.service.runtime.snapshot(ctx, source.id)).items;
		const titled = await process.service.branching.fork(ctx, source.id, {
			itemId: itemOf(items, "First answer"),
			title: "Another way",
		});
		expect(titled.title).toBe("Another way");
		expect(
			await code(process.service.branching.fork(ctx, source.id, { itemId: itemOf(items, "First question") })),
		).toBe("not_found");
		expect(await code(process.service.branching.fork(ctx, source.id, { itemId: "nope" }))).toBe("not_found");
		expect(await code(process.service.branching.fork(ctx, "no-session", { itemId: "a1" }))).toBe("not_found");
	});
});

describe("edit", () => {
	it("rewinds to the message, reruns it edited, and keeps the rewind across a restart", async () => {
		const file = databaseFile();
		const first = await processOn(file);
		const session = await conversationIn(first);
		const items = (await first.service.runtime.snapshot(ctx, session.id)).items;

		first.script.reply({ text: "A better second answer" });
		const submission = await first.service.branching.edit(ctx, session.id, {
			itemId: itemOf(items, "Second question"),
			text: "A better second question",
		});
		expect(submission).toMatchObject({ sessionId: session.id, via: "prompt" });
		expect(await first.service.runtime.wait(ctx, session.id, submission.id)).toMatchObject({
			answer: "A better second answer",
		});
		const expected = [
			"user: First question",
			"assistant: First answer",
			"user: A better second question",
			"assistant: A better second answer",
		];
		expect(shown((await first.service.runtime.snapshot(ctx, session.id)).items)).toEqual(expected);
		// The model saw the history up to the edited message, not what came after it.
		expect(first.script.requests.at(-1)?.messages).toEqual([
			{ role: "user", text: "First question" },
			{ role: "assistant", text: "First answer" },
			{ role: "user", text: "A better second question" },
		]);
		const page = await first.service.history.history(ctx, session.id, { limit: 10 });
		expect(shown(page.items.toReversed())).toEqual(expected);

		await first.close();
		const second = await processOn(file);
		expect(shown((await second.service.runtime.snapshot(ctx, session.id)).items)).toEqual(expected);
		await turn(second, session.id, "Then what?", "Then this");
		expect(second.script.requests.at(-1)?.messages.map((message) => message.text)).toEqual([
			"First question",
			"First answer",
			"A better second question",
			"A better second answer",
			"Then what?",
		]);
	});

	it("edits the first message from an empty history, and again after an earlier edit", async () => {
		const process = await processOn(databaseFile());
		const session = await conversationIn(process);
		let items = (await process.service.runtime.snapshot(ctx, session.id)).items;
		process.script.reply({ text: "Answer one" });
		const one = await process.service.branching.edit(ctx, session.id, {
			itemId: itemOf(items, "First question"),
			text: "Question one",
		});
		await process.service.runtime.wait(ctx, session.id, one.id);
		await turn(process, session.id, "Question two", "Answer two");
		items = (await process.service.runtime.snapshot(ctx, session.id)).items;
		expect(shown(items)).toEqual([
			"user: Question one",
			"assistant: Answer one",
			"user: Question two",
			"assistant: Answer two",
		]);
		process.script.reply({ text: "Answer two, again" });
		const two = await process.service.branching.edit(ctx, session.id, {
			itemId: itemOf(items, "Question two"),
			text: "Question two, again",
		});
		await process.service.runtime.wait(ctx, session.id, two.id);
		expect(shown((await process.service.runtime.snapshot(ctx, session.id)).items)).toEqual([
			"user: Question one",
			"assistant: Answer one",
			"user: Question two, again",
			"assistant: Answer two, again",
		]);
		expect(process.script.requests.at(-1)?.messages.map((message) => message.text)).toEqual([
			"Question one",
			"Answer one",
			"Question two, again",
		]);
	});

	it("moves a watcher onto the rewound transcript with a fresh snapshot", async () => {
		const process = await processOn(databaseFile());
		const session = await conversationIn(process);
		const frames: ServerFrame[] = [];
		const watch = await process.service.runtime.watch(ctx, session.id, {}, (frame) => frames.push(frame));
		const items = (await process.service.runtime.snapshot(ctx, session.id)).items;
		const firstCursor = frames[0]?.type === "hello" ? frames[0].cursor : "";
		process.script.reply({ text: "Third, rethought" });
		const submission = await process.service.branching.edit(ctx, session.id, {
			itemId: itemOf(items, "Third question"),
			text: "Third, rephrased",
		});
		await process.service.runtime.wait(ctx, session.id, submission.id);
		await until(
			() => frames.some((frame) => frame.type === "delta" && frame.delta.ops.some((op) => op.op === "status")),
			"the rerun's deltas",
		);
		const hellos = frames.filter((frame) => frame.type === "hello");
		expect(hellos).toHaveLength(2);
		const rewound = hellos[1]!;
		expect(rewound).toMatchObject({ resumed: false });
		// A new generation: a client that reconnects with an old cursor gets a snapshot, not a false resume.
		expect(rewound.cursor.split(".")[0]).not.toBe(firstCursor.split(".")[0]);
		const snapshot = frames.slice(frames.indexOf(rewound)).find((frame) => frame.type === "snapshot");
		expect(snapshot?.type === "snapshot" ? shown(snapshot.snapshot.items) : []).toEqual([
			"user: First question",
			"assistant: First answer",
			"user: Second question",
			"assistant: Second answer",
		]);
		await watch.close();
		const after = frames.length;
		await turn(process, session.id, "More", "Done");
		expect(frames).toHaveLength(after);
	});

	it("refuses while a run is going, an item that is not a person's message, empty text and a closed session", async () => {
		const process = await processOn(databaseFile());
		const session = await conversationIn(process);
		const items = (await process.service.runtime.snapshot(ctx, session.id)).items;
		const question = itemOf(items, "Second question");
		expect(
			await code(process.service.branching.edit(ctx, session.id, { itemId: itemOf(items, "First answer"), text: "x" })),
		).toBe("not_found");
		expect(await code(process.service.branching.edit(ctx, session.id, { itemId: question, text: "  " }))).toBe(
			"invalid",
		);

		let release: (() => void) | undefined;
		process.script.reply(() => new Promise((resolve) => (release = () => resolve({ text: "Late" }))));
		const running = await process.service.runtime.prompt(ctx, session.id, { text: "Slow one" });
		await until(() => release !== undefined, "the model call");
		expect(await code(process.service.branching.edit(ctx, session.id, { itemId: question, text: "x" }))).toBe(
			"conflict",
		);
		release?.();
		await process.service.runtime.wait(ctx, session.id, running.id);

		await process.service.runtime.close(ctx, session.id);
		expect(await code(process.service.branching.edit(ctx, session.id, { itemId: question, text: "x" }))).toBe(
			"conflict",
		);
	});
});
