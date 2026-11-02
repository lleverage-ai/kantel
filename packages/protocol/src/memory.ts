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
	/**
	 * How many bytes of recent deltas (as `approximateBytes` counts them) are kept for resuming, at most; older cursors
	 * get a snapshot. A tool call's arguments and output travel in its deltas, so a count alone lets a long session's
	 * window hold hundreds of megabytes. Default 2 MiB.
	 */
	readonly retainBytes?: number;
	readonly title?: string;
	readonly now?: () => number;
}

export type MemorySessionStream = SessionStream & SessionStreamWriter;

/** The default `retainBytes`. */
export const DEFAULT_RETAIN_BYTES = 2 * 1024 * 1024;

/**
 * Roughly how much memory `value` holds: two bytes for each character of its strings and keys, and a few for anything
 * else. Cheap (no serialising) and enough to bound a buffer by, not a measurement.
 */
export function approximateBytes(value: unknown): number {
	let bytes = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (typeof next === "string") bytes += 2 * next.length;
		else if (Array.isArray(next)) {
			bytes += 8;
			for (const item of next) pending.push(item);
		} else if (typeof next === "object" && next !== null) {
			bytes += 8;
			for (const [key, item] of Object.entries(next)) {
				bytes += 2 * key.length;
				pending.push(item);
			}
		} else bytes += 8;
	}
	return bytes;
}

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
	const retainBytes = options.retainBytes ?? DEFAULT_RETAIN_BYTES;
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
	// Each retained delta's `approximateBytes`, beside it, and their sum.
	const recentBytes: number[] = [];
	let heldBytes = 0;
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
			const size = approximateBytes(delta.ops);
			recent.push(delta);
			recentBytes.push(size);
			heldBytes += size;
			let drop = 0;
			while (drop < recent.length && (recent.length - drop > retain || heldBytes > retainBytes)) {
				heldBytes -= recentBytes[drop]!;
				drop += 1;
			}
			if (drop > 0) {
				recent.splice(0, drop);
				recentBytes.splice(0, drop);
			}
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
