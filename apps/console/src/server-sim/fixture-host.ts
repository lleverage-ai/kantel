// A stand-in for Harbour's session host, so the console runs with no backend. It serves a frame fixture through
// @harbour/protocol's reference stream (createMemorySessionStream): the fixture's snapshot is published first, then
// its deltas at their recorded pace. Connections get what the real host will send: hello, then either the deltas
// after the client's cursor or a snapshot, then live deltas; history in bounded pages. Every frame crosses a small
// simulated latency, in order, as it would over a socket.

import type {
	ClientFrame,
	Cursor,
	DeltaOp,
	ServerFrame,
	SessionDelta,
	SessionSnapshot,
	StreamConnection,
} from "@harbour/protocol";
import { createMemorySessionStream, type MemorySessionStream } from "@harbour/protocol/memory";
import type { Connection, Transport } from "../state/session-client.ts";

/** Deltas kept for resuming, like Jeff's event log keeps its newest 2,000 events. Older cursors get a snapshot. */
export const DELTA_RETENTION = 2000;
/** Items in a snapshot's page; earlier ones come from history. */
export const SNAPSHOT_PAGE = 80;

export type Timers = {
	set: (task: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const realTimers: Timers = {
	set: (task, ms) => setTimeout(task, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type HostOptions = {
	/** Playback speed; 1 is the recorded pace. */
	speed?: number;
	/** One-way latency of every frame, in ms. */
	latencyMs?: number;
	timers?: Timers;
};

function report(reason: unknown): void {
	console.error("Fixture host:", reason);
}

export class FixtureHost implements Transport {
	readonly sessionId: string;
	readonly title: string;
	private readonly stream: MemorySessionStream;
	private readonly deltas: readonly SessionDelta[];
	private next = 0;
	private playback: unknown;
	private readonly speed: number;
	private readonly latencyMs: number;
	private readonly timers: Timers;
	private clock: number;
	private startedAt = 0;
	private elapsed = 0;
	private headCursor: Cursor;
	/** Deltas published since the fixture's snapshot. */
	published = 0;

	constructor(frames: readonly ServerFrame[], options: HostOptions = {}) {
		const first = frames.find((frame) => frame.type === "snapshot");
		if (first?.type !== "snapshot") throw new Error("A frame fixture starts with a snapshot");
		const snapshot: SessionSnapshot = first.snapshot;
		this.sessionId = snapshot.sessionId;
		this.title = snapshot.title ?? "";
		this.deltas = frames.flatMap((frame) => (frame.type === "delta" ? [frame.delta] : []));
		this.speed = options.speed ?? 1;
		this.latencyMs = options.latencyMs ?? 20;
		this.timers = options.timers ?? realTimers;
		this.clock = snapshot.updatedAt;
		this.stream = createMemorySessionStream({
			sessionId: snapshot.sessionId,
			pageSize: SNAPSHOT_PAGE,
			retainDeltas: DELTA_RETENTION,
			...(snapshot.title === undefined ? {} : { title: snapshot.title }),
			now: () => this.clock,
		});
		// The host follows its own stream to know its head. The reference stream registers a listener and fans out
		// synchronously, so `head` is current as soon as a publish returns.
		this.headCursor = snapshot.cursor;
		void this.stream.connect(undefined, (frame) => {
			if (frame.type === "hello") this.headCursor = frame.cursor;
			else if (frame.type === "delta") this.headCursor = frame.delta.cursor;
		});
		// Seed the stream with the fixture's starting state, as one commit.
		const seed: DeltaOp[] = snapshot.items.map((item) => ({ op: "append", item }));
		seed.push({ op: "status", status: snapshot.status, attention: snapshot.attention });
		if (snapshot.usage !== undefined) seed.push({ op: "usage", usage: snapshot.usage });
		this.stream.publish(seed).catch(report);
	}

	/** Start replaying the fixture's deltas. */
	play(): void {
		if (this.playback !== undefined || this.finished) return;
		this.startedAt = this.deltas[this.next]?.at ?? 0;
		this.elapsed = 0;
		this.schedule();
	}

	pause(): void {
		if (this.playback !== undefined) this.timers.clear(this.playback);
		this.playback = undefined;
	}

	get finished(): boolean {
		return this.next >= this.deltas.length;
	}

	/** The newest cursor the host has published. */
	get head(): Cursor {
		return this.headCursor;
	}

	private schedule(): void {
		const delta = this.deltas[this.next];
		if (delta === undefined) {
			this.playback = undefined;
			return;
		}
		const due = (delta.at - this.startedAt) / this.speed;
		const wait = Math.max(0, due - this.elapsed);
		this.playback = this.timers.set(() => {
			this.elapsed = due;
			this.publish();
			this.schedule();
		}, wait);
	}

	private publish(): void {
		const delta = this.deltas[this.next++];
		if (delta === undefined) return;
		this.clock = delta.at;
		this.published++;
		this.stream.publish(delta.ops).catch(report);
	}

	/** Publish every remaining delta at once; for tests and for "skip to the end". */
	drain(): void {
		this.pause();
		while (!this.finished) this.publish();
	}

	snapshot(): Promise<SessionSnapshot> {
		return this.stream.snapshot();
	}

	/** Open a connection; frames to `receive` arrive asynchronously, after the configured latency. */
	connect(receive: (frame: ServerFrame) => void): Connection {
		let open = true;
		let upstream: Promise<StreamConnection> | undefined;
		const deliver = (frame: ServerFrame): void => {
			this.timers.set(() => {
				if (open) receive(frame);
			}, this.latencyMs);
		};
		const handle = (frame: ClientFrame): void => {
			if (!open) return;
			if (frame.sessionId !== this.sessionId) {
				deliver({ type: "error", code: "unknown_session", message: `No session ${frame.sessionId}` });
				return;
			}
			if (frame.type === "hello") {
				void upstream?.then((connection) => connection.close());
				upstream = this.stream.connect(frame.after, deliver);
				return;
			}
			this.stream.history(frame.before, frame.limit).then(
				(page) => deliver({ type: "history", page }),
				(reason: unknown) => deliver({ type: "error", code: "history", message: String(reason) }),
			);
		};
		return {
			send: (frame) => {
				this.timers.set(() => handle(frame), this.latencyMs);
			},
			close: () => {
				open = false;
				void upstream?.then((connection) => connection.close());
			},
		};
	}
}
