// The console's view of one session: connects, says hello with the last cursor it applied, takes a snapshot or the
// missed deltas, and keeps the transcript. Two things are tracked apart, as T3 Code does: connection health (is the
// socket up?) and data freshness (is what is shown the host's latest?). Token deltas are coalesced: streamed text and
// a running tool's output wait up to COALESCE_MS and are applied together, in order, so a fast stream renders about
// ten times a second, as often as the host commits a partial answer (about every 100 ms); anything else flushes at
// once, so the order things happened is the order they show. At 200 ms, with a busy main thread on top, the answer
// visibly grew only every third of a second though the deltas came three times as often.
//
// Deltas are applied with @harbour/protocol's `applyDelta`, which keeps the identity of every item a delta does not
// name. Rows are memoised on the item object, so that is what keeps earlier rows from rendering again.

import {
	applyDelta,
	type ClientFrame,
	type Cursor,
	type DeltaOp,
	PROTOCOL_VERSION,
	type ServerFrame,
	type SessionDelta,
	type SessionSnapshot,
	type SessionStatus,
	type TranscriptItem,
} from "@harbour/protocol";

export const COALESCE_MS = 100;
export const RECONNECT_MS = [500, 1000, 2000, 4000];
export const HISTORY_PAGE = 120;
/** The code of the error frame a transport sends when an earlier page fails; the session itself is unaffected. */
export const HISTORY_ERROR = "history";

/** A connection to the session host: the session API's event stream (`api/http.ts`) or a recorded host. */
export type Connection = {
	send(frame: ClientFrame): void;
	/** Drop the connection without a goodbye, as a network failure would. */
	close(): void;
};
export type Transport = {
	/** `lost` is called when the connection drops on its own, never after `close()`; the client reconnects. */
	connect(receive: (frame: ServerFrame) => void, lost?: () => void): Connection;
};

export type ConnectionHealth =
	| { status: "connecting" }
	| { status: "open" }
	| { status: "offline"; retryAt: number; attempt: number };

export type Freshness =
	/** No data yet. */
	| { state: "loading" }
	/** Connected and behind the host's head; catching up. */
	| { state: "catching-up"; head: Cursor }
	/** Shows everything the host has published. */
	| { state: "current" }
	/** Disconnected: shows what it had at `cursor`. */
	| { state: "stale" };

export type ResumeRecord = { at: number; from: Cursor | undefined; how: "deltas" | "snapshot"; head: Cursor };

export type SessionState = {
	readonly sessionId: string;
	readonly title: string;
	/** Every item loaded, oldest first: the snapshot's page, earlier pages in front, live items behind. */
	readonly items: readonly TranscriptItem[];
	readonly status: SessionStatus;
	/** Last cursor applied. */
	readonly cursor: Cursor | undefined;
	/** True while items before `items[0]` exist on the host. */
	readonly hasEarlier: boolean;
	readonly loadingOlder: boolean;
	/** Why the last earlier page didn't load, until it is asked for again. */
	readonly olderError?: string;
	readonly connection: ConnectionHealth;
	readonly freshness: Freshness;
	readonly resumes: readonly ResumeRecord[];
	/** How many changes the stream has made to the state; each is at most one render. */
	readonly flushes: number;
	readonly error?: string;
};

/** Ops that only grow something already on screen; these wait to be coalesced. */
const streamOnly = (op: DeltaOp): boolean =>
	op.op === "text" ||
	op.op === "usage" ||
	(op.op === "replace" && op.item.kind === "tool" && op.item.status === "running");

const touched = (op: DeltaOp): string | undefined =>
	op.op === "text" ? op.itemId : op.op === "append" || op.op === "replace" ? op.item.id : undefined;

export class SessionClient {
	private state: SessionState;
	private readonly listeners = new Set<() => void>();
	private connection: Connection | undefined;
	/** The state as a protocol snapshot, which `applyDelta` works on. */
	private view: SessionSnapshot | undefined;
	private pending: SessionDelta[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Last cursor received, applied or still coalescing. */
	private received: Cursor | undefined;
	/** The host's head when it said hello, until a delta reaches it. */
	private catchUpTo: Cursor | undefined;
	private resumeFrom: Cursor | undefined;
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
			items: [],
			status: "idle",
			cursor: undefined,
			hasEarlier: false,
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
		// Apply what was received but still coalescing, so a later start() resumes from a cursor that is on screen.
		this.flush();
		this.connection?.close();
		this.connection = undefined;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	private open(): void {
		this.set({ connection: { status: "connecting" } });
		const connection: Connection = this.transport.connect(
			(frame) => this.receive(frame),
			() => this.lost(connection),
		);
		this.connection = connection;
		this.resumeFrom = this.received;
		this.send({
			type: "hello",
			v: PROTOCOL_VERSION,
			sessionId: this.state.sessionId,
			...(this.received === undefined ? {} : { after: this.received }),
		});
	}

	private send(frame: ClientFrame): void {
		this.connection?.send(frame);
	}

	/** Drop the connection as a network failure would, then reconnect with backoff and resume from the cursor. */
	simulateDisconnect(offlineMs?: number): void {
		if (this.connection === undefined) return;
		this.flush();
		this.connection.close();
		this.connection = undefined;
		this.scheduleReconnect(offlineMs);
	}

	/** The connection dropped by itself (the stream ended or the network went): reconnect with backoff. */
	private lost(connection: Connection): void {
		if (this.stopped || this.connection !== connection) return;
		this.flush();
		this.connection = undefined;
		this.scheduleReconnect();
	}

	private scheduleReconnect(delay?: number): void {
		const wait = delay ?? RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)]!;
		this.attempt++;
		this.set({
			connection: { status: "offline", retryAt: this.now() + wait, attempt: this.attempt },
			freshness: { state: "stale" },
			loadingOlder: false,
		});
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			if (!this.stopped) this.open();
		}, wait);
	}

	loadOlder = (): void => {
		const { hasEarlier, loadingOlder, items } = this.state;
		const first = items[0];
		if (!hasEarlier || loadingOlder || first === undefined || this.connection === undefined) return;
		this.set({ loadingOlder: true, olderError: undefined });
		this.send({ type: "history", sessionId: this.state.sessionId, before: first.id, limit: HISTORY_PAGE });
	};

	private receive(frame: ServerFrame): void {
		switch (frame.type) {
			case "hello": {
				this.attempt = 0;
				const current = this.received !== undefined && this.received === frame.cursor;
				this.catchUpTo = current ? undefined : frame.cursor;
				const how: ResumeRecord["how"] = frame.resumed ? "deltas" : "snapshot";
				this.set({
					connection: { status: "open" },
					freshness: current ? { state: "current" } : { state: "catching-up", head: frame.cursor },
					resumes: [...this.state.resumes, { at: this.now(), from: this.resumeFrom, how, head: frame.cursor }].slice(
						-5,
					),
				});
				return;
			}
			case "snapshot":
				this.snapshot(frame.snapshot);
				return;
			case "history": {
				const known = new Set(this.state.items.map((item) => item.id));
				const older = frame.page.items.filter((item) => !known.has(item.id));
				const items = [...older, ...this.state.items];
				if (this.view !== undefined) this.view = { ...this.view, items, hasEarlier: frame.page.hasEarlier };
				this.set({ items, hasEarlier: frame.page.hasEarlier, loadingOlder: false, olderError: undefined });
				return;
			}
			case "delta":
				this.delta(frame.delta);
				return;
			case "error":
				// An earlier page that failed leaves the session as it was: the transcript offers to try again.
				if (frame.code === HISTORY_ERROR) this.set({ olderError: frame.message, loadingOlder: false });
				else this.set({ error: `${frame.code}: ${frame.message}`, loadingOlder: false });
				return;
		}
	}

	private snapshot(snapshot: SessionSnapshot): void {
		this.pending = [];
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.received = snapshot.cursor;
		if (this.catchUpTo === snapshot.cursor) this.catchUpTo = undefined;
		this.view = snapshot;
		this.set({
			title: snapshot.title ?? "",
			items: snapshot.items,
			status: snapshot.status,
			cursor: snapshot.cursor,
			hasEarlier: snapshot.hasEarlier,
			loadingOlder: false,
			freshness: this.catchUpTo === undefined ? { state: "current" } : { state: "catching-up", head: this.catchUpTo },
			flushes: this.state.flushes + 1,
		});
	}

	private delta(delta: SessionDelta): void {
		if (delta.sessionId !== this.state.sessionId || this.view === undefined) return;
		if (delta.cursor === this.received) return; // already have it
		this.received = delta.cursor;
		if (delta.cursor === this.catchUpTo) this.catchUpTo = undefined;
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
		const view = this.view;
		if (this.pending.length === 0 || view === undefined) return;
		const batch = this.pending;
		this.pending = [];
		const last = batch.at(-1)!;
		// One merged delta copies the item list once, however many deltas were waiting.
		const ops = batch.flatMap((delta) => delta.ops);
		let next: SessionSnapshot;
		try {
			next = applyDelta(view, { sessionId: view.sessionId, cursor: last.cursor, at: last.at, ops });
		} catch (reason) {
			// The stream and this client disagree; start again from a fresh snapshot.
			this.set({ error: String(reason) });
			this.received = undefined;
			this.connection?.close();
			this.connection = undefined;
			if (!this.stopped) this.open();
			return;
		}
		this.view = next;
		const changed = new Set<string>();
		for (const op of ops) {
			const id = touched(op);
			if (id !== undefined) changed.add(id);
		}
		this.lastChanged = changed;
		this.set({
			items: next.items,
			status: next.status,
			title: next.title ?? this.state.title,
			cursor: last.cursor,
			freshness: this.catchUpTo === undefined ? { state: "current" } : { state: "catching-up", head: this.catchUpTo },
			flushes: this.state.flushes + 1,
		});
	}

	/** Items the newest flush changed; the profiler panel reads it. */
	lastChanged: ReadonlySet<string> = new Set();
}
