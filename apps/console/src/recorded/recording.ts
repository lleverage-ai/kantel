// Writes a recorded session as protocol frames, the same shape as fixtures/sessions: a hello, one snapshot, then a
// delta per commit with `at` giving the pace. The console's dev catalogue uses it to stand up sessions in every state
// the sessions list shows (working, waiting on an answer or an approval, done, failed) without a backend.
//
// Everything written before `live()` is in the snapshot, so a session already in its state when the page loads shows
// it at once; everything after streams at the recorded pace when the host plays it. Deterministic: the same calls with
// the same start give the same frames.

import {
	applyDelta,
	attentionFor,
	type Card,
	type DeltaOp,
	PROTOCOL_VERSION,
	type PresentedFile,
	type ServerFrame,
	type SessionDelta,
	type SessionSnapshot,
	type SessionStatus,
	type ToolItem,
	type TranscriptItem,
	type UserAttachment,
	type UserItemVia,
} from "@harbour/protocol";
import { toolLabel } from "../server-sim/project.ts";

export type ToolStep = {
	name: string;
	args: Record<string, unknown>;
	output?: string;
	/** How long the tool runs, in ms. */
	ms?: number;
	status?: "done" | "error";
	tier?: "isolate" | "container";
	/** The chip's words, where the stand-in labels don't know the tool ("Presenting 4 files"). */
	label?: string;
	/** The files the call presented (`present_files`), as cards under its group. */
	files?: readonly PresentedFile[];
	/**
	 * The model writes the call as the session watches: each string argument arrives in pieces of about `chars`
	 * characters, `gap` ms apart, as `args` ops, before the call runs.
	 */
	write?: { chars?: number; gap?: number };
	/** Output the call prints while it runs, a piece every `gap` ms of its `ms`, before its whole `output` lands. */
	progress?: readonly string[];
};

export class Recording {
	private snapshot: SessionSnapshot;
	private readonly deltas: SessionDelta[] = [];
	private liveFrom: number | undefined;
	private sequence = 0;
	private ids = 0;
	private clock: number;

	constructor(
		readonly sessionId: string,
		title: string,
		start: number,
	) {
		this.clock = start;
		this.snapshot = {
			v: PROTOCOL_VERSION,
			sessionId,
			cursor: "c0",
			status: "idle",
			attention: "done",
			title,
			items: [],
			hasEarlier: false,
			updatedAt: start,
		};
	}

	/** The recording's clock, in epoch ms. */
	get now(): number {
		return this.clock;
	}

	/** Moves the clock on. */
	wait(ms: number): this {
		this.clock += ms;
		return this;
	}

	/**
	 * Everything after this streams live when the host plays the recording; everything before is the snapshot. With
	 * `at`, the live part starts then (when it is later than the clock), so it can line up with the page loading.
	 */
	live(at?: number): this {
		this.liveFrom = this.deltas.length;
		if (at !== undefined) this.clock = Math.max(this.clock, at);
		return this;
	}

	private id(prefix: string): string {
		this.ids++;
		return `${prefix}:${this.ids}`;
	}

	private commit(ops: readonly DeltaOp[]): void {
		this.sequence++;
		const delta: SessionDelta = { sessionId: this.sessionId, cursor: `c${this.sequence}`, at: this.clock, ops };
		this.snapshot = applyDelta(this.snapshot, delta);
		this.deltas.push(delta);
	}

	status(status: SessionStatus): this {
		this.commit([{ op: "status", status, attention: attentionFor(status) }]);
		return this;
	}

	user(text: string, via: UserItemVia = "prompt", attachments?: readonly UserAttachment[]): this {
		const item = { kind: "user" as const, id: this.id("u"), at: this.clock, text, via };
		this.commit([{ op: "append", item: attachments === undefined ? item : { ...item, attachments } }]);
		return this;
	}

	/** An answer, streamed in `chunks` pieces `gap` ms apart, after its `thinking` when it has some. */
	say(
		text: string,
		{ chunks = 1, gap = 120, thinking }: { chunks?: number; gap?: number; thinking?: string } = {},
	): this {
		const id = this.id("a");
		const at = this.clock;
		const pieces = split(text, chunks);
		const thought = thinking === undefined ? {} : { thinking };
		this.commit([
			{ op: "append", item: { kind: "assistant", id, at, text: pieces[0] ?? "", streaming: true, ...thought } },
		]);
		for (const piece of pieces.slice(1)) {
			this.wait(gap);
			this.commit([{ op: "text", itemId: id, append: piece }]);
		}
		this.wait(gap);
		this.commit([{ op: "replace", item: { kind: "assistant", id, at, text, streaming: false, ...thought } }]);
		return this;
	}

	/** A tool call that runs for `ms` and ends done (or `status`). */
	tool(step: ToolStep): this {
		this.start(step);
		this.run(step);
		return this.finish(step);
	}

	private current: { id: string; callId: string; at: number } | undefined;

	/** Starts a tool call and leaves it running; `finish` ends it. */
	start(step: ToolStep): this {
		const callId = this.id("call");
		const id = `tool:${callId}`;
		this.current = { id, callId, at: this.clock };
		if (step.write === undefined) {
			this.commit([{ op: "append", item: this.toolItem(step, "running") }]);
			return this;
		}
		// The call as the model writes it: no arguments, then each string growing, then the whole call.
		const { chars = 24, gap = 40 } = step.write;
		const item = this.toolItem({ ...step, args: {} }, "running");
		this.commit([{ op: "append", item: { ...item, streaming: true } }]);
		for (const [key, value] of Object.entries(step.args)) {
			if (typeof value !== "string") continue;
			for (let index = 0; index < Math.max(1, value.length); index += chars) {
				this.wait(gap);
				this.commit([{ op: "args", itemId: id, path: [key], append: value.slice(index, index + chars) }]);
			}
		}
		this.wait(gap);
		this.commit([{ op: "replace", item: this.toolItem(step, "running") }]);
		return this;
	}

	/** A tool call that prints `progress` while it runs, then ends with `output`. */
	private run(step: ToolStep): this {
		const progress = step.progress ?? [];
		const ms = step.ms ?? 800;
		const gap = Math.floor(ms / (progress.length + 1));
		let output = "";
		for (const piece of progress) {
			this.wait(gap);
			output += piece;
			this.commit([{ op: "replace", item: { ...this.toolItem(step, "running"), output } }]);
		}
		this.wait(ms - gap * progress.length);
		return this;
	}

	finish(step: ToolStep): this {
		const item = this.toolItem(step, step.status ?? "done");
		this.commit([{ op: "replace", item }]);
		this.current = undefined;
		return this;
	}

	private toolItem(step: ToolStep, status: "running" | "done" | "error"): ToolItem {
		const current = this.current;
		if (current === undefined) throw new Error("No tool call is running");
		return {
			kind: "tool",
			id: current.id,
			at: current.at,
			callId: current.callId,
			name: step.name,
			label: step.label ?? toolLabel(step.name, step.args, status),
			status,
			args: step.args,
			...(status === "running" || step.output === undefined ? {} : { output: step.output }),
			...(status !== "done" || step.files === undefined ? {} : { files: step.files }),
			...(step.tier === undefined ? {} : { tier: step.tier }),
			...(status === "running" ? {} : { endedAt: this.clock }),
		};
	}

	card(card: Card): this {
		this.commit([{ op: "append", item: { kind: "card", id: this.id("card"), at: this.clock, card } }]);
		return this;
	}

	notice(level: "info" | "warning" | "error", text: string, code?: string): this {
		const item: TranscriptItem = {
			kind: "notice",
			id: this.id("n"),
			at: this.clock,
			level,
			text,
			...(code === undefined ? {} : { code }),
		};
		this.commit([{ op: "append", item }]);
		return this;
	}

	/** The recording as protocol frames: hello, the snapshot at `live()`, then the live deltas. */
	frames(): ServerFrame[] {
		const from = this.liveFrom ?? this.deltas.length;
		let snapshot: SessionSnapshot = {
			v: PROTOCOL_VERSION,
			sessionId: this.sessionId,
			cursor: "c0",
			status: "idle",
			attention: "done",
			items: [],
			hasEarlier: false,
			updatedAt: this.deltas[0]?.at ?? this.clock,
			...(this.snapshot.title === undefined ? {} : { title: this.snapshot.title }),
		};
		for (const delta of this.deltas.slice(0, from)) snapshot = applyDelta(snapshot, delta);
		return [
			{ type: "hello", v: PROTOCOL_VERSION, sessionId: this.sessionId, cursor: snapshot.cursor, resumed: false },
			{ type: "snapshot", snapshot },
			...this.deltas.slice(from).map((delta): ServerFrame => ({ type: "delta", delta })),
		];
	}
}

/** Splits text into about `count` pieces at word boundaries, keeping every character. */
function split(text: string, count: number): string[] {
	if (count <= 1) return [text];
	const words = text.split(/(?<=\s)/);
	const per = Math.max(1, Math.ceil(words.length / count));
	const pieces: string[] = [];
	for (let index = 0; index < words.length; index += per) pieces.push(words.slice(index, index + per).join(""));
	return pieces;
}
