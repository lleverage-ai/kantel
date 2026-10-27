import type { ConversationView } from "@earendil-works/pi-durable";
import { applyDelta, PROTOCOL_VERSION, type SessionSnapshot } from "@harbour/protocol";
import { ConversationProjector, HARBOUR_USER_ENTRY, toolLabel } from "@harbour/runtime";
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
