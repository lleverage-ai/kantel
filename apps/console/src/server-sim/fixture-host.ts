// A stand-in for Harbour's session host, so the console runs with no backend. It replays a recorded Pi Durable
// stream at its recorded pace, projects it into Harbour's protocol and serves any number of connections the way the
// real host will: hello, then either the deltas after the client's cursor or a snapshot, then live deltas; history
// in bounded pages. It keeps the newest DELTA_RETENTION deltas, like Jeff's event log keeps its newest 2,000 events,
// so a client that was away longer than that gets a snapshot instead.

import type { AgentEvent, RecordedBatch, RecordingHeader, SnapshotEvent } from "../pi-durable/events.ts";
import type {
	ClientMessage,
	Cursor,
	DeltaOp,
	RunState,
	ServerMessage,
	SessionDelta,
	SessionSnapshot,
} from "../protocol-local/index.ts";
import { applyOps, fromItems, type Transcript } from "../state/transcript.ts";
import { Projector } from "./project.ts";

export const DELTA_RETENTION = 2000;
/** Items in a snapshot's first page and the most a history page returns. */
export const SNAPSHOT_PAGE = 80;
export const HISTORY_LIMIT = 200;

export type Recording = { header: RecordingHeader; snapshot: SnapshotEvent; batches: RecordedBatch[] };

export function parseRecording(text: string): Recording {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const [first, ...rest] = lines.map((line) => JSON.parse(line) as unknown);
	const header = first as RecordingHeader;
	if (header?.recording !== "pi-durable/watchEvents") throw new Error("Not a recorded Pi Durable stream");
	const batches = rest as RecordedBatch[];
	const opening = batches.shift();
	const snapshot = opening?.events[0];
	if (snapshot?.type !== "snapshot") throw new Error("A recording starts with a snapshot batch");
	return { header, snapshot, batches };
}

export type Timers = {
	set: (task: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const realTimers: Timers = { set: (task, ms) => setTimeout(task, ms), clear: (handle) => clearTimeout(handle as number) };

/** Only these ops make a commit Pi defers: streamed text and tool output, stored up to a second later. */
const provisionalOps = new Set<DeltaOp["op"]>(["text.append", "tool.update"]);

export type Connection = {
	send(message: ClientMessage): void;
	/** Drop the connection without a goodbye, as a network failure would. */
	close(): void;
};

export type HostOptions = {
	sessionId?: string;
	/** Playback speed; 1 is the recorded pace. */
	speed?: number;
	/** One-way latency of every message, in ms. */
	latencyMs?: number;
	timers?: Timers;
};

export class FixtureHost {
	readonly sessionId: string;
	readonly title: string;
	private transcript: Transcript;
	private run: RunState;
	private cursor: Cursor = 0;
	private readonly log: SessionDelta[] = [];
	private readonly projector = new Projector();
	private readonly batches: RecordedBatch[];
	private next = 0;
	private playback: unknown;
	private readonly clients = new Set<(message: ServerMessage) => void>();
	private readonly speed: number;
	private readonly latencyMs: number;
	private readonly timers: Timers;
	private startedAt = 0;
	private clock = 0;

	constructor(recording: Recording, options: HostOptions = {}) {
		this.sessionId = options.sessionId ?? "session-1";
		this.title = recording.header.title;
		this.speed = options.speed ?? 1;
		this.latencyMs = options.latencyMs ?? 20;
		this.timers = options.timers ?? realTimers;
		const { items, run } = this.projector.fromSnapshot(recording.snapshot);
		this.transcript = fromItems(items);
		this.run = run;
		this.batches = recording.batches;
	}

	/** Start replaying the recording's live part. */
	play(): void {
		if (this.playback !== undefined || this.next >= this.batches.length) return;
		this.startedAt = this.batches[this.next]?.at ?? 0;
		this.clock = 0;
		this.schedule();
	}

	pause(): void {
		if (this.playback !== undefined) this.timers.clear(this.playback);
		this.playback = undefined;
	}

	get finished(): boolean {
		return this.next >= this.batches.length;
	}

	get head(): Cursor {
		return this.cursor;
	}

	private schedule(): void {
		const batch = this.batches[this.next];
		if (batch === undefined) {
			this.playback = undefined;
			return;
		}
		const due = (batch.at - this.startedAt) / this.speed;
		const wait = Math.max(0, due - this.clock);
		this.playback = this.timers.set(() => {
			this.clock = due;
			this.next++;
			this.commit(batch.events, batch.at);
			this.schedule();
		}, wait);
	}

	/** Apply one recorded commit and publish its delta. */
	private commit(events: readonly AgentEvent[], at: number): void {
		const ops = this.projector.batch(events, at);
		if (ops.length === 0) return;
		const applied = applyOps(this.transcript, ops);
		this.transcript = applied.transcript;
		if (applied.run !== undefined) this.run = applied.run;
		const delta: SessionDelta = { type: "delta", sessionId: this.sessionId, cursor: ++this.cursor, ops };
		if (ops.every((op) => provisionalOps.has(op.op))) delta.provisional = true;
		this.log.push(delta);
		if (this.log.length > DELTA_RETENTION) this.log.shift();
		for (const deliver of this.clients) deliver(delta);
	}

	/** Run every remaining batch at once; for tests and for "skip to the end". */
	drain(): void {
		this.pause();
		while (this.next < this.batches.length) {
			const batch = this.batches[this.next++]!;
			this.commit(batch.events, batch.at);
		}
	}

	snapshot(): SessionSnapshot {
		const items = this.transcript.items;
		const start = Math.max(0, items.length - SNAPSHOT_PAGE);
		return {
			type: "snapshot",
			sessionId: this.sessionId,
			title: this.title,
			cursor: this.cursor,
			items: items.slice(start),
			before: start > 0 ? String(start) : null,
			run: this.run,
			total: items.length,
		};
	}

	/** Open a connection; messages to `receive` arrive asynchronously, after the configured latency. */
	connect(receive: (message: ServerMessage) => void): Connection {
		let open = true;
		const deliver = (message: ServerMessage): void => {
			this.timers.set(() => {
				if (open) receive(message);
			}, this.latencyMs);
		};
		const handle = (message: ClientMessage): void => {
			if (!open) return;
			if (message.type === "hello") this.hello(message.cursor, deliver);
			else if (message.type === "history") {
				const end = Math.min(Number(message.before), this.transcript.items.length);
				const start = Math.max(0, end - Math.min(message.limit, HISTORY_LIMIT));
				deliver({
					type: "history",
					sessionId: this.sessionId,
					items: this.transcript.items.slice(start, end),
					before: start > 0 ? String(start) : null,
				});
			}
		};
		return {
			send: (message) => this.timers.set(() => handle(message), this.latencyMs),
			close: () => {
				open = false;
				this.clients.delete(deliver);
			},
		};
	}

	private hello(cursor: Cursor | undefined, deliver: (message: ServerMessage) => void): void {
		const floor = (this.log[0]?.cursor ?? this.cursor + 1) - 1;
		const canResume = cursor !== undefined && cursor >= floor && cursor <= this.cursor;
		deliver({ type: "welcome", sessionId: this.sessionId, resume: canResume ? "deltas" : "snapshot", head: this.cursor });
		if (canResume) {
			for (const delta of this.log) if (delta.cursor > cursor) deliver(delta);
		} else {
			deliver(this.snapshot());
		}
		this.clients.add(deliver);
	}
}
