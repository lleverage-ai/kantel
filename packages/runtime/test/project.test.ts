import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { applyDelta, PROTOCOL_VERSION, type SessionSnapshot } from "@harbour/protocol";
import { ConversationProjector, HARBOUR_USER_ENTRY, toolLabel, UsageTally } from "@harbour/runtime";
import { describe, expect, it } from "vitest";

type Entry = { id: number; kind: string; model?: unknown[]; data?: unknown };

function view(entries: Entry[], live: Record<string, unknown> = {}): ConversationView {
	return { conversation: { id: 1 }, entries, docs: { "pi.live": live } } as unknown as ConversationView;
}

const user = (id: number, text: string, via: string): Entry => ({
	id,
	kind: HARBOUR_USER_ENTRY,
	model: [{ role: "user", content: text, timestamp: 0 }],
	data: { via },
});
const assistant = (id: number, content: unknown[], stopReason = "stop", errorMessage?: string): Entry => ({
	id,
	kind: "pi.assistant",
	model: [{ role: "assistant", content, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) }],
});
const toolResult = (id: number, callId: string, text: string, isError: boolean, codes: string[] = []): Entry => ({
	id,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId: callId, toolName: "x", content: [{ type: "text", text }], isError }],
	data: { diagnostics: codes.map((code) => ({ severity: "error", code, message: code })) },
});
const running = { run: { taskId: 9, inputs: [2] } };

/** Applies every projected view's ops to an empty snapshot, as a client would. */
function replay(projector: ConversationProjector, views: ConversationView[]): SessionSnapshot {
	let snapshot: SessionSnapshot = {
		v: PROTOCOL_VERSION,
		sessionId: "s",
		cursor: "c0",
		status: "idle",
		attention: "done",
		items: [],
		hasEarlier: false,
		updatedAt: 0,
	};
	views.forEach((next, index) => {
		const ops = projector.project(next);
		if (ops.length > 0) snapshot = applyDelta(snapshot, { sessionId: "s", cursor: `c${index + 1}`, at: 0, ops });
	});
	return snapshot;
}

describe("ConversationProjector", () => {
	it("grows one streaming assistant item with text ops and settles it with the answer entry", () => {
		const projector = new ConversationProjector({ now: () => 5 });
		const prompt = user(1, "Hi", "prompt");
		expect(projector.project(view([prompt], running))).toEqual([
			{ op: "append", item: { kind: "user", id: "u1", at: 5, text: "Hi", via: "prompt" } },
			{ op: "status", status: "running", attention: "working" },
		]);
		const partial = (text: string) => ({
			...running,
			generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text }] } },
		});
		const appended = projector.project(view([prompt], partial("Hel")));
		expect(appended).toEqual([
			{ op: "append", item: { kind: "assistant", id: "p1", at: 5, text: "Hel", streaming: true } },
		]);
		expect(projector.project(view([prompt], partial("Hello")))).toEqual([{ op: "text", itemId: "p1", append: "lo" }]);
		const answered = projector.project(view([prompt, assistant(3, [{ type: "text", text: "Hello!" }])], {}));
		expect(answered).toEqual([
			{ op: "replace", item: { kind: "assistant", id: "p1", at: 5, text: "Hello!", streaming: false } },
			{ op: "status", status: "idle", attention: "done" },
		]);
	});

	it("times a message from its stored message, so a session projected again keeps its times", () => {
		const prompt: Entry = { ...user(1, "Hi", "prompt"), model: [{ role: "user", content: "Hi", timestamp: 1_000 }] };
		const answer: Entry = {
			id: 2,
			kind: "pi.assistant",
			model: [{ role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop", timestamp: 2_000 }],
		};
		const timed: Entry = {
			id: 3,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Again" }],
					stopReason: "stop",
					timestamp: 3_000,
					durationMs: 1_500,
				},
			],
		};
		// Projected long after: the clock says 9,999, but the items keep when they were sent and generated.
		const items = replay(new ConversationProjector({ now: () => 9_999 }), [view([prompt, answer, timed])]).items;
		expect(items.map((item) => [item.id, item.at])).toEqual([
			["u1", 1_000],
			["a2", 2_000],
			["a3", 4_500],
		]);
	});

	it("times a streamed answer by when it finished, not when it started streaming", () => {
		let now = 5;
		const projector = new ConversationProjector({ now: () => now });
		const prompt = user(1, "Hi", "prompt");
		const partial = {
			...running,
			generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Hel" }] } },
		};
		projector.project(view([prompt], partial));
		now = 50;
		const answer: Entry = {
			id: 3,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Hello" }],
					stopReason: "stop",
					timestamp: 10,
					durationMs: 30,
				},
			],
		};
		expect(projector.project(view([prompt, answer], {}))[0]).toEqual({
			op: "replace",
			item: { kind: "assistant", id: "p1", at: 40, text: "Hello", streaming: false },
		});
	});

	it("replaces a tool item when its result lands, marking errors and interruptions", () => {
		const projector = new ConversationProjector({ now: () => 1 });
		const calls = assistant(
			2,
			[
				{ type: "toolCall", id: "c1", name: "lookup", arguments: { key: "a" } },
				{ type: "toolCall", id: "c2", name: "missing", arguments: {} },
				{ type: "toolCall", id: "c3", name: "slow", arguments: {} },
			],
			"toolUse",
		);
		const snapshot = replay(projector, [
			view([user(1, "Go", "prompt"), calls], running),
			view(
				[
					user(1, "Go", "prompt"),
					calls,
					toolResult(4, "c1", "found", false),
					toolResult(5, "c2", "not available", true, ["tool_unavailable"]),
					toolResult(6, "c3", "", true, ["aborted"]),
				],
				{},
			),
		]);
		const tools = snapshot.items.filter((item) => item.kind === "tool");
		expect(tools.map((item) => [item.name, item.status, item.label])).toEqual([
			["lookup", "done", toolLabel("lookup")],
			["missing", "error", toolLabel("missing")],
			["slow", "interrupted", toolLabel("slow")],
		]);
		expect(tools[0]).toMatchObject({ callId: "c1", args: { key: "a" }, output: "found", endedAt: 1 });
	});

	it("shows a steer as a user item sent by steer", () => {
		const projector = new ConversationProjector({ now: () => 0 });
		const snapshot = replay(projector, [view([user(1, "Go", "prompt"), user(3, "Faster", "steer")], running)]);
		expect(snapshot.items.map((item) => (item.kind === "user" ? item.via : item.kind))).toEqual(["prompt", "steer"]);
	});

	it("reports failed after a run whose last response is a model error, with a notice", () => {
		const projector = new ConversationProjector({ now: () => 0 });
		const snapshot = replay(projector, [
			view([user(1, "Go", "prompt")], running),
			view([user(1, "Go", "prompt"), assistant(2, [], "error", "rate limited")], {}),
		]);
		expect(snapshot.status).toBe("failed");
		expect(snapshot.items.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "rate limited" });
	});

	it("keeps a closed session done whatever later views say", () => {
		const projector = new ConversationProjector({ now: () => 0 });
		expect(projector.close()).toEqual([{ op: "status", status: "done", attention: "done" }]);
		expect(projector.project(view([], running))).toEqual([]);
		expect(projector.status).toBe("done");
	});
});

describe("a tool call streaming in", () => {
	const prompt = user(1, "Write it", "prompt");
	const writing = (args: unknown, text = "") => ({
		...running,
		generation: {
			attempt: 1,
			message: {
				role: "assistant",
				content: [
					...(text === "" ? [] : [{ type: "text", text }]),
					{ type: "toolCall", id: "w1", name: "write", arguments: args },
				],
			},
		},
	});

	it("shows the call as it is written, growing its strings with args ops", () => {
		const projector = new ConversationProjector({ now: () => 7 });
		projector.project(view([prompt], running));
		expect(projector.project(view([prompt], writing({})))).toEqual([
			{
				op: "append",
				item: {
					kind: "tool",
					id: "ts1:w1",
					at: 7,
					callId: "w1",
					name: "write",
					label: toolLabel("write", {}),
					status: "running",
					args: {},
					streaming: true,
				},
			},
		]);
		expect(projector.project(view([prompt], writing({ path: "a.py", content: "imp" })))).toEqual([
			{ op: "args", itemId: "ts1:w1", path: ["path"], append: "a.py" },
			{ op: "args", itemId: "ts1:w1", path: ["content"], append: "imp" },
		]);
		expect(projector.project(view([prompt], writing({ path: "a.py", content: "imp" })))).toEqual([]);
		expect(projector.project(view([prompt], writing({ path: "a.py", content: "import sys\n" })))).toEqual([
			{ op: "args", itemId: "ts1:w1", path: ["content"], append: "ort sys\n" },
		]);
	});

	it("settles the streamed item in place when the answer's entry lands, then its result", () => {
		const projector = new ConversationProjector({ now: () => 7 });
		const args = { path: "a.py", content: "import sys\n" };
		const call = assistant(2, [{ type: "toolCall", id: "w1", name: "write", arguments: args }], "toolUse");
		const snapshot = replay(projector, [
			view([prompt], running),
			view([prompt], writing({ path: "a.p" }, "On it.")),
			view([prompt], writing({ path: "a.py", content: "import" }, "On it.")),
			view([prompt, call], running),
			view([prompt, call, toolResult(3, "w1", "Wrote 11 bytes", false)], {}),
		]);
		expect(snapshot.items.map((item) => [item.kind, item.id])).toEqual([
			["user", "u1"],
			["assistant", "p1"],
			["tool", "ts1:w1"],
		]);
		const tool = snapshot.items[2];
		expect(tool).toMatchObject({ status: "done", args, output: "Wrote 11 bytes" });
		expect(tool).not.toHaveProperty("streaming");
	});

	it("replaces the item for a change an append can't say", () => {
		const projector = new ConversationProjector({ now: () => 0 });
		projector.project(view([prompt], writing({ command: "ls" })));
		const ops = projector.project(view([prompt], writing({ command: "ls", timeout: 5 })));
		expect(ops).toEqual([{ op: "replace", item: expect.objectContaining({ args: { command: "ls", timeout: 5 } }) }]);
	});

	it("leaves a call the generation dropped interrupted", () => {
		const projector = new ConversationProjector({ now: () => 3 });
		const snapshot = replay(projector, [
			view([prompt], writing({ path: "a.py" })),
			view([prompt], { ...running, generation: { attempt: 2, message: { role: "assistant", content: [] } } }),
		]);
		expect(snapshot.items.at(-1)).toMatchObject({ kind: "tool", status: "interrupted", endedAt: 3 });
		expect(snapshot.items.at(-1)).not.toHaveProperty("streaming");
	});

	it("follows the provider's partial JSON character by character, mostly as args ops", () => {
		const args = {
			path: "notes/plan.py",
			edits: [
				{ oldText: 'print("hi")\n', newText: 'print("h\u00e9llo \\\\ \\n")\n\tdone()' },
				{ oldText: "x = 1", newText: "x = 2" },
			],
		};
		const json = JSON.stringify(args);
		const projector = new ConversationProjector({ now: () => 0 });
		let snapshot: SessionSnapshot = replay(projector, [view([prompt], running)]);
		const kinds = new Map<string, number>();
		for (let end = 0; end <= json.length; end++) {
			const parsed = parseStreamingJson(json.slice(0, end));
			const live = {
				...running,
				generation: {
					attempt: 1,
					message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: parsed }] },
				},
			};
			const ops = projector.project(view([prompt], live));
			for (const op of ops) kinds.set(op.op, (kinds.get(op.op) ?? 0) + 1);
			if (ops.length > 0) snapshot = applyDelta(snapshot, { sessionId: "s", cursor: `c${end + 2}`, at: 0, ops });
			// What the client holds is always what the provider has parsed so far.
			expect(snapshot.items.at(-1)).toMatchObject({ kind: "tool", streaming: true, args: parsed });
		}
		expect(snapshot.items.at(-1)).toMatchObject({ args });
		// Each value's characters arrive as appends. Only the call's first showing is a whole item, and each empty array
		// or object opening (`"edits": [`, then `{`, twice) a replace.
		expect(kinds.get("append")).toBe(1);
		expect(kinds.get("args") ?? 0).toBeGreaterThan(50);
		expect(kinds.get("replace")).toBe(3);
	});

	it("leaves a document to its draft", () => {
		const projector = new ConversationProjector({ now: () => 0 });
		const ops = projector.project(
			view([prompt], {
				...running,
				generation: {
					attempt: 1,
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "d", name: "create_document", arguments: { title: "Plan" } }],
					},
				},
			}),
		);
		expect(ops.some((op) => (op.op === "append" || op.op === "replace") && op.item.kind === "tool")).toBe(false);
	});
});

describe("toolLabel", () => {
	it("says in plain words what a browser tool is doing, and names any other tool", () => {
		expect(toolLabel("browser_open", { url: "https://en.wikipedia.org/wiki/Harbour" })).toBe(
			"Opening en.wikipedia.org",
		);
		expect(toolLabel("browser_open", {})).toBe("Opening a browser");
		expect(toolLabel("browser_act", { action: "goto", url: "https://example.com/a" })).toBe("Going to example.com");
		expect(toolLabel("browser_act", { action: "look" })).toBe("Reading the page");
		expect(toolLabel("browser_act", { action: "press", key: "Enter" })).toBe("Pressing Enter");
		expect(toolLabel("browser_act", { action: "goto", url: "not a url" })).toBe("Going to a page");
		expect(toolLabel("browser_screenshot", {})).toBe("Taking a screenshot");
		expect(toolLabel("lookup", { url: "https://example.com" })).toBe("Calling lookup");
	});

	it("names what present_files presents", () => {
		expect(toolLabel("present_files", { filepaths: ["/workspace/out/report.pdf"] })).toBe("Presenting report.pdf");
		expect(toolLabel("present_files", { filepaths: ["a.md", "b.md"] })).toBe("Presenting 2 files");
		expect(toolLabel("present_files", {})).toBe("Presenting files");
	});
});

describe("presented files", () => {
	const file = { workspaceId: "ws-1", path: "out/report.md", name: "report.md", mimeType: "text/markdown", size: 12 };
	const call = (id: number, name: string): Entry =>
		assistant(id, [{ type: "toolCall", id: `c${id}`, name, arguments: { filepaths: [file.path] } }], "toolUse");
	const result = (id: number, callId: string, details: unknown, isError = false): Entry => ({
		id,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "present_files",
				content: [{ type: "text", text: "Presented 1 file" }],
				isError,
				details,
			},
		],
		data: { diagnostics: [] },
	});

	it("puts a present_files call's files on its tool item, checked and bounded", () => {
		const bad = [{ ...file, size: -1 }, { path: "x" }, "nope", { ...file, path: "" }];
		const long = { ...file, path: "out/long.md", preview: "x".repeat(5_000) };
		const items = replay(new ConversationProjector({ now: () => 1 }), [
			view([
				user(1, "Go", "prompt"),
				call(2, "present_files"),
				result(3, "c2", { presentedFiles: [file, ...bad, long] }),
			]),
		]).items;
		const tool = items.find((item) => item.kind === "tool");
		expect(tool?.kind === "tool" ? tool.label : undefined).toBe("Presenting report.md");
		const files = tool?.kind === "tool" ? tool.files : undefined;
		expect(files?.map((presented) => presented.path)).toEqual(["out/report.md", "out/long.md"]);
		expect(files?.[1]?.preview).toHaveLength(600);
	});

	it("takes generate_image's images, with the model that made them, and the model from no other tool", () => {
		const image = { ...file, path: "images/cat.png", name: "cat.png", mimeType: "image/png", model: "gpt-image-1" };
		const items = replay(new ConversationProjector({ now: () => 1 }), [
			view([
				user(1, "Go", "prompt"),
				call(2, "generate_image"),
				result(3, "c2", { presentedFiles: [image] }),
				call(4, "present_files"),
				result(5, "c4", { presentedFiles: [image] }),
			]),
		]).items;
		const tools = items.flatMap((item) => (item.kind === "tool" ? [item] : []));
		expect(tools.map((tool) => tool.files?.[0]?.model)).toEqual(["gpt-image-1", undefined]);
	});

	it("names what generate_image makes", () => {
		expect(toolLabel("generate_image", { prompt: "x" })).toBe("Making an image");
		expect(toolLabel("generate_image", { prompt: "x", count: 3 })).toBe("Making 3 images");
		expect(toolLabel("generate_image", { prompt: "x", reference_images: ["a.png"] })).toBe("Editing an image");
	});

	// The console renders a present_files call as its files' cards, with no tool-call row (its tool renderer registry,
	// packages/ui/src/session/tool-renderer-model.ts). That is presentation only: what the API and the event stream
	// carry is the call itself, for an app built on Harbour to show its own way.
	it("keeps a presenting call in what the API sends as the call it was: its name, arguments and output", () => {
		const projector = new ConversationProjector({ now: () => 1 });
		const entries = [user(1, "Go", "prompt"), call(2, "present_files"), result(3, "c2", { presentedFiles: [file] })];
		const ops = projector.project(view(entries));
		const appended = ops.flatMap((op) => (op.op === "append" && op.item.kind === "tool" ? [op.item] : []));
		// The stream appends the call as a tool item, as for any tool.
		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({
			kind: "tool",
			callId: "c2",
			name: "present_files",
			args: { filepaths: [file.path] },
		});
		// And the session's transcript has it finished, with its output beside its files.
		const items = replay(new ConversationProjector({ now: () => 1 }), [view(entries)]).items;
		expect(items.find((item) => item.kind === "tool")).toMatchObject({
			kind: "tool",
			callId: "c2",
			name: "present_files",
			args: { filepaths: [file.path] },
			status: "done",
			output: "Presented 1 file",
			files: [file],
		});
	});

	it("ignores presented files from any other tool, and from a call that failed", () => {
		const items = replay(new ConversationProjector({ now: () => 1 }), [
			view([
				user(1, "Go", "prompt"),
				call(2, "bash"),
				result(3, "c2", { presentedFiles: [file] }),
				call(4, "present_files"),
				result(5, "c4", { presentedFiles: [file] }, true),
			]),
		]).items;
		const tools = items.flatMap((item) => (item.kind === "tool" ? [item] : []));
		expect(tools).toHaveLength(2);
		expect(tools.map((tool) => tool.files)).toEqual([undefined, undefined]);
	});

	it("marks create_document's file as a document with its title, and no other tool's", () => {
		const document = { ...file, path: "documents/plan.md", name: "plan.md", title: "The plan", document: true };
		const items = replay(new ConversationProjector({ now: () => 1 }), [
			view([
				user(1, "Go", "prompt"),
				call(2, "create_document"),
				result(3, "c2", { presentedFiles: [document] }),
				call(4, "present_files"),
				result(5, "c4", { presentedFiles: [document] }),
			]),
		]).items;
		const files = items.flatMap((item) => (item.kind === "tool" ? (item.files ?? []) : []));
		expect(files.map((presented) => [presented.title, presented.document])).toEqual([
			["The plan", true],
			["The plan", undefined],
		]);
	});
});

describe("a document streaming in", () => {
	const prompt = user(1, "Write it up", "prompt");
	const partial = (args: unknown, text = "") => ({
		...running,
		generation: {
			attempt: 1,
			message: {
				role: "assistant",
				content: [
					...(text === "" ? [] : [{ type: "text", text }]),
					{ type: "toolCall", id: "call-1", name: "create_document", arguments: args },
				],
			},
		},
	});

	it("carries the draft on the streaming answer, growing with document text ops, and drops it with the answer", () => {
		const projector = new ConversationProjector({ now: () => 5 });
		projector.project(view([prompt], running));
		expect(projector.project(view([prompt], partial({})))).toEqual([]);
		expect(projector.project(view([prompt], partial({ title: "Plan", content: "# Pl" })))).toEqual([
			{
				op: "append",
				item: {
					kind: "assistant",
					id: "p1",
					at: 5,
					text: "",
					streaming: true,
					document: { callId: "call-1", title: "Plan", text: "# Pl" },
				},
			},
		]);
		expect(projector.project(view([prompt], partial({ title: "Plan", content: "# Plan\n\nOne" })))).toEqual([
			{ op: "text", itemId: "p1", append: "an\n\nOne", field: "document" },
		]);
		const call = assistant(
			3,
			[{ type: "toolCall", id: "call-1", name: "create_document", arguments: { title: "Plan", content: "# Plan" } }],
			"toolUse",
		);
		const ops = projector.project(view([prompt, call], running));
		expect(ops[0]).toEqual({
			op: "replace",
			item: { kind: "assistant", id: "p1", at: 5, text: "", streaming: false },
		});
		expect(ops[1]).toMatchObject({
			op: "append",
			item: { kind: "tool", name: "create_document", label: "Writing Plan" },
		});
	});

	it("replays to the same snapshot a client builds, the draft included", () => {
		const snapshot = replay(new ConversationProjector({ now: () => 5 }), [
			view([prompt], running),
			view([prompt], partial({ title: "Plan" }, "Here it is.")),
			view([prompt], partial({ title: "Plan", content: "# Plan" }, "Here it is.")),
			view([prompt], partial({ title: "Plan B", content: "# B" }, "Here it is.")),
		]);
		const answer = snapshot.items.at(-1);
		expect(answer?.kind === "assistant" ? answer.document : undefined).toEqual({
			callId: "call-1",
			title: "Plan B",
			text: "# B",
		});
	});

	it("labels create_document by its title", () => {
		expect(toolLabel("create_document", { title: "Quarterly plan" })).toBe("Writing Quarterly plan");
		expect(toolLabel("create_document", {})).toBe("Writing a document");
	});
});

describe("ConversationProjector usage", () => {
	const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	});
	const answered = (id: number, text: string, used: unknown, stopReason = "stop"): Entry => ({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }], stopReason, usage: used }],
	});
	const prompt = user(1, "Hi", "prompt");

	it("publishes the session's running total, cache reads and writes included, after each response", () => {
		const projector = new ConversationProjector({ now: () => 5 });
		const first = answered(2, "One", usage(2, 251, 0, 22_328, 0.25));
		const ops = projector.project(view([prompt, first]));
		expect(ops).toContainEqual({
			op: "usage",
			usage: { inputTokens: 2, outputTokens: 251, cacheReadTokens: 0, cacheWriteTokens: 22_328, costUsd: 0.25 },
		});
		// Nothing new: no usage op.
		expect(projector.project(view([prompt, first])).filter((op) => op.op === "usage")).toEqual([]);
		const second = answered(3, "Two", usage(2, 592, 22_328, 98, 0.5));
		expect(projector.project(view([prompt, first, second])).filter((op) => op.op === "usage")).toEqual([
			{
				op: "usage",
				usage: { inputTokens: 4, outputTokens: 843, cacheReadTokens: 22_328, cacheWriteTokens: 22_426, costUsd: 0.75 },
			},
		]);
	});

	it("counts a failed response's usage, and none for a response that reports none", () => {
		const failed = answered(2, "", usage(10, 3, 0, 0, 0), "error");
		const bare = assistant(3, [{ type: "text", text: "No usage here" }]);
		const snapshot = replay(new ConversationProjector({ now: () => 5 }), [view([prompt, failed, bare])]);
		expect(snapshot.usage).toEqual({
			inputTokens: 10,
			outputTokens: 3,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
		expect(replay(new ConversationProjector({ now: () => 5 }), [view([prompt, bare])]).usage).toBeUndefined();
	});

	it("keeps a session's total across projections that share its tally, counting a shared entry once", () => {
		const tally = new UsageTally();
		const first = answered(2, "One", usage(100, 10, 0, 0, 0));
		new ConversationProjector({ now: () => 5, usage: tally }).project(view([prompt, first]));
		const abandoned = answered(3, "Two", usage(200, 20, 0, 0, 0));
		new ConversationProjector({ now: () => 5, usage: tally }).project(view([prompt, first, abandoned]));
		// An edit projects the forked conversation on a new stream: it shares the first answer, not the abandoned one.
		const edited = answered(5, "Three", usage(300, 30, 0, 0, 0));
		const snapshot = replay(new ConversationProjector({ now: () => 5, usage: tally }), [view([prompt, first, edited])]);
		expect(snapshot.usage).toMatchObject({ inputTokens: 600, outputTokens: 60 });
	});
});

describe("connection approval cards", () => {
	const card = {
		proposalId: "proposal_1",
		status: "pending",
		bindingCode: "K7-42",
		what: "POST api.example.com/v1/issues through Example",
		why: "Open an issue",
		host: "api.example.com",
		methods: ["POST"],
		pathPrefix: "/v1/issues",
		termsSource: "agent-proposed",
		expiresAt: 99,
		link: "https://harbour.test/requests/proposal_1",
		request: {
			connectionId: "conn_1",
			connectionName: "Example",
			kind: "http",
			method: "POST",
			url: "https://api.example.com/v1/issues",
			digest: "d".repeat(64),
		},
	};
	const call = (id: number, name: string): Entry =>
		assistant(id, [{ type: "toolCall", id: `c${id}`, name, arguments: {} }], "toolUse");
	const result = (id: number, callId: string, name: string, details: unknown): Entry => ({
		id,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: [{ type: "text", text: "HTTP 201" }],
				isError: false,
				details,
			},
		],
		data: { diagnostics: [] },
	});
	const waiting = (name: string, details: unknown) => ({
		...running,
		tools: [{ callId: "c2", name, status: "running", details }],
	});

	it("shows a waiting connection call's approval card, then settles it in place", () => {
		const projector = new ConversationProjector({ now: () => 7 });
		const entries = [user(1, "Go", "prompt"), call(2, "connection_request")];
		const shown = projector.project(view(entries, waiting("connection_request", { connectionApproval: card })));
		expect(shown).toContainEqual({
			op: "append",
			item: { kind: "card", id: "c:proposal_1", at: 7, card: { type: "connection.approval", ...card } },
		});
		// The same details again change nothing.
		expect(
			projector
				.project(view(entries, waiting("connection_request", { connectionApproval: card })))
				.filter((op) => op.op !== "status"),
		).toEqual([]);
		const approved = { ...card, status: "approved", termsSource: "approved" };
		const settled = projector.project(
			view([...entries, result(3, "c2", "connection_request", { connectionApproval: approved })], {}),
		);
		expect(settled).toContainEqual({
			op: "replace",
			item: { kind: "card", id: "c:proposal_1", at: 7, card: { type: "connection.approval", ...approved } },
		});
	});

	it("takes a card only from the connection tools, and only a well-formed one", () => {
		const items = replay(new ConversationProjector({ now: () => 1 }), [
			view(
				[
					user(1, "Go", "prompt"),
					call(2, "present_files"),
					result(3, "c2", "present_files", { connectionApproval: card }),
					call(4, "connection_call"),
					result(5, "c4", "connection_call", { connectionApproval: { ...card, status: "maybe" } }),
				],
				{},
			),
		]).items;
		expect(items.filter((item) => item.kind === "card")).toEqual([]);
	});
});
