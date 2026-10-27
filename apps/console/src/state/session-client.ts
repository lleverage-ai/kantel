// The console's view of one session: connects, says hello with the last cursor it applied, takes a snapshot or the
// missed deltas, and keeps the transcript. Two things are tracked apart, as T3 Code does: connection health (is the
// socket up?) and data freshness (is what is shown the host's latest?). Token deltas are coalesced: streamed text and
// tool output wait up to COALESCE_MS and are applied together, in order, so a fast stream renders about five times a
// second; anything else flushes at once, so the order things happened is the order they show.

import type {
	ClientMessage,
	Cursor,
	DeltaOp,
	ItemId,
	RunState,
	ServerMessage,
	SessionDelta,
} from "../protocol-local/index.ts";
import { applyOps, EMPTY, fromItems, prepend, type Transcript } from "./transcript.ts";

export const COALESCE_MS = 200;
export const RECONNECT_MS = [500, 1000, 2000, 4000];
export const HISTORY_PAGE = 120;

export type ConnectionHealth =
	| { status: "connecting" }
	| { status: "open" }
	| { status: "offline"; retryAt: number; attempt: number };

export type Freshness =
	/** No data yet. */
	| { state: "loading" }
	/** Connected and behind the host's head; catching up. */
	| { state: "catching-up"; head: Cursor }
	/** Shows everything the host has published. `provisional` while the newest commit is not yet stored. */
	| { state: "current"; provisional: boolean }
	/** Disconnected: shows what it had at `cursor`. */
	| { state: "stale" };

export type ResumeRecord = { at: number; from: Cursor | undefined; how: "deltas" | "snapshot"; head: Cursor };

export type SessionState = {
	readonly sessionId: string;
	readonly title: string;
	readonly transcript: Transcript;
	readonly run: RunState;
	/** Last cursor applied. */
	readonly cursor: Cursor | undefined;
	readonly before: string | null;
	readonly total: number;
	readonly loadingOlder: boolean;
	readonly connection: ConnectionHealth;
	readonly freshness: Freshness;
	readonly resumes: readonly ResumeRecord[];
	/** Renders, for the profiler panel: how many flushes the store has made. */
	readonly flushes: number;
};

/** A socket to the session host. The fixture host implements it in M0; a WebSocket or SSE client will in M1. */
export type Connection = { send(message: ClientMessage): void; close(): void };
export type Transport = { connect(receive: (message: ServerMessage) => void): Connection };

const streamOnly = (op: DeltaOp): boolean =>
	op.op === "text.append" || (op.op === "tool.update" && op.status === undefined && op.args === undefined);

export class SessionClient {
	private state: SessionState;
	private readonly listeners = new Set<() => void>();
	private connection: Connection | undefined;
	private pending: SessionDelta[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private received: Cursor | undefined;
	private head: Cursor = 0;
	private attempt = 0;
	private stopped = false;

	constructor(
		private readonly transport: Transport,
		sessionId: string,
		private readonly now: () => number = Date.now,
	) {
		this.state = {
			sessionId,
			title: "",
			transcript: EMPTY,
			run: "idle",
			cursor: undefined,
			before: null,
			total: 0,
			loadingOlder: false,
			connection: { status: "connecting" },
			freshness: { state: "loading" },
			resumes: [],
			flushes: 0,
		};
	}

	// useSyncExternalStore
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getState = (): SessionState => this.state;

	private set(patch: Partial<SessionState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	start(): void {
		this.stopped = false;
		this.open();
	}

	stop(): void {
		this.stopped = true;
		this.connection?.close();
		this.connection = undefined;
		clearTimeout(this.flushTimer);
		clearTimeout(this.retryTimer);
	}

	private open(): void {
		this.set({ connection: { status: "connecting" } });
		this.connection = this.transport.connect((message) => this.receive(message));
		this.send({ type: "hello", sessionId: this.state.sessionId, ...(this.received === undefined ? {} : { cursor: this.received }) });
	}

	private send(message: ClientMessage): void {
		this.connection?.send(message);
	}

	/** Drop the connection as a network failure would, then reconnect with backoff and resume from the cursor. */
	simulateDisconnect(offlineMs?: number): void {
		if (this.connection === undefined) return;
		this.flush();
		this.connection.close();
		this.connection = undefined;
		this.scheduleReconnect(offlineMs);
	}

	private scheduleReconnect(delay?: number): void {
		const wait = delay ?? RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)]!;
		this.attempt++;
		this.set({ connection: { status: "offline", retryAt: this.now() + wait, attempt: this.attempt }, freshness: { state: "stale" }, loadingOlder: false });
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			if (!this.stopped) this.open();
		}, wait);
	}

	loadOlder(): void {
		const { before, loadingOlder } = this.state;
		if (before === null || loadingOlder || this.connection === undefined) return;
		this.set({ loadingOlder: true });
		this.send({ type: "history", sessionId: this.state.sessionId, before, limit: HISTORY_PAGE });
	}

	private receive(message: ServerMessage): void {
		switch (message.type) {
			case "welcome":
				this.attempt = 0;
				this.head = message.head;
				this.set({
					connection: { status: "open" },
					freshness: this.received !== undefined && this.received >= message.head ? { state: "current", provisional: false } : { state: "catching-up", head: message.head },
					resumes: [...this.state.resumes, { at: this.now(), from: this.received, how: message.resume, head: message.head }].slice(-5),
				});
				return;
			case "snapshot":
				this.pending = [];
				clearTimeout(this.flushTimer);
				this.flushTimer = undefined;
				this.received = message.cursor;
				this.set({
					title: message.title,
					transcript: fromItems(message.items),
					run: message.run,
					cursor: message.cursor,
					before: message.before,
					total: message.total,
					loadingOlder: false,
					freshness: { state: "current", provisional: false },
					flushes: this.state.flushes + 1,
				});
				return;
			case "history":
				this.set({ transcript: prepend(this.state.transcript, message.items), before: message.before, loadingOlder: false });
				return;
			case "delta":
				this.delta(message);
				return;
		}
	}

	private delta(delta: SessionDelta): void {
		if (this.received !== undefined && delta.cursor <= this.received) return; // already have it
		if (this.received !== undefined && delta.cursor !== this.received + 1) {
			// A gap: something was lost. Start again from what we hold.
			this.connection?.close();
			this.connection = undefined;
			this.open();
			return;
		}
		this.received = delta.cursor;
		this.head = Math.max(this.head, delta.cursor);
		this.pending.push(delta);
		if (delta.ops.every(streamOnly)) {
			this.flushTimer ??= setTimeout(() => this.flush(), COALESCE_MS);
		} else {
			this.flush();
		}
	}

	/** Apply every pending delta, in order, as one change. */
	flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pending.length === 0) return;
		const batch = this.pending;
		this.pending = [];
		const ops = batch.flatMap((delta) => delta.ops);
		const applied = applyOps(this.state.transcript, ops);
		const last = batch.at(-1)!;
		const added = applied.transcript.items.length - this.state.transcript.items.length;
		this.set({
			transcript: applied.transcript,
			run: applied.run ?? this.state.run,
			cursor: last.cursor,
			total: this.state.total + added,
			freshness: last.cursor >= this.head ? { state: "current", provisional: last.provisional === true } : { state: "catching-up", head: this.head },
			flushes: this.state.flushes + 1,
		});
		this.lastChanged = applied.changed;
	}

	/** Items the newest flush changed; the profiler panel reads it. */
	lastChanged: ReadonlySet<ItemId> = new Set();
}
