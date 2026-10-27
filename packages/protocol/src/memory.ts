import {
	applyDelta,
	attentionFor,
	type Cursor,
	type DeltaOp,
	type HistoryPage,
	PROTOCOL_VERSION,
	ProtocolError,
	type ServerFrame,
	type SessionDelta,
	type SessionSnapshot,
	type SessionStream,
	type SessionStreamWriter,
	type StreamConnection,
	type TranscriptItem,
} from "./index.ts";

export interface MemorySessionStreamOptions {
	readonly sessionId: string;
	/** How many items a snapshot holds; earlier ones come from `history`. Default 50. */
	readonly pageSize?: number;
	/** How many recent deltas are kept for resuming; older cursors get a snapshot. Default 1,000. */
	readonly retainDeltas?: number;
	readonly title?: string;
	readonly now?: () => number;
}

export type MemorySessionStream = SessionStream & SessionStreamWriter;

const cursorOf = (sequence: number): Cursor => `c${sequence}`;
const sequenceOf = (cursor: Cursor): number | undefined => {
	const match = /^c(\d+)$/.exec(cursor);
	return match ? Number(match[1]) : undefined;
};

/**
 * The reference `SessionStream`: the full transcript in memory, a bounded window of recent deltas for resuming, and
 * synchronous fan-out to connections in publish order.
 */
export function createMemorySessionStream(options: MemorySessionStreamOptions): MemorySessionStream {
	const sessionId = options.sessionId;
	const pageSize = options.pageSize ?? 50;
	const retain = options.retainDeltas ?? 1000;
	const now = options.now ?? Date.now;
	let sequence = 0;
	// The whole state, with every item; snapshots are cut from it.
	let full: SessionSnapshot = {
		v: PROTOCOL_VERSION,
		sessionId,
		cursor: cursorOf(0),
		status: "idle",
		attention: attentionFor("idle"),
		...(options.title === undefined ? {} : { title: options.title }),
		items: [],
		hasEarlier: false,
		updatedAt: now(),
	};
	const recent: SessionDelta[] = [];
	const listeners = new Set<(frame: ServerFrame) => void>();

	const cut = (): SessionSnapshot => {
		const start = Math.max(0, full.items.length - pageSize);
		return { ...full, items: full.items.slice(start), hasEarlier: start > 0 };
	};

	return {
		sessionId,
		async publish(ops: readonly DeltaOp[]): Promise<SessionDelta> {
			sequence += 1;
			const delta: SessionDelta = { sessionId, cursor: cursorOf(sequence), at: now(), ops: [...ops] };
			full = applyDelta(full, delta);
			recent.push(delta);
			if (recent.length > retain) recent.splice(0, recent.length - retain);
			for (const listener of listeners) listener({ type: "delta", delta });
			return delta;
		},
		async connect(after, onFrame): Promise<StreamConnection> {
			const afterSequence = after === undefined ? undefined : sequenceOf(after);
			const oldest = recent.length > 0 ? sequenceOf(recent[0]!.cursor)! - 1 : sequence;
			const canResume = afterSequence !== undefined && afterSequence <= sequence && afterSequence >= oldest;
			onFrame({ type: "hello", v: PROTOCOL_VERSION, sessionId, cursor: full.cursor, resumed: canResume });
			if (canResume) {
				for (const delta of recent) {
					if (sequenceOf(delta.cursor)! > afterSequence!) onFrame({ type: "delta", delta });
				}
			} else {
				onFrame({ type: "snapshot", snapshot: cut() });
			}
			let open = true;
			const listener = (frame: ServerFrame) => {
				if (open) onFrame(frame);
			};
			listeners.add(listener);
			return {
				async close() {
					open = false;
					listeners.delete(listener);
				},
			};
		},
		async snapshot() {
			return cut();
		},
		async history(before: string, limit: number): Promise<HistoryPage> {
			const items: readonly TranscriptItem[] = full.items;
			const end = items.findIndex((item) => item.id === before);
			if (end < 0) throw new ProtocolError("unknown_item", `No item ${before} in session ${sessionId}`);
			const bounded = Math.max(0, Math.min(limit, 500));
			const start = Math.max(0, end - bounded);
			return { sessionId, items: items.slice(start, end), hasEarlier: start > 0 };
		},
	};
}
