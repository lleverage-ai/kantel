import type {
	AssistantItem,
	Attention,
	DeltaOp,
	ServerFrame,
	SessionDelta,
	SessionSnapshot,
	SessionStatus,
	TranscriptItem,
} from "./index.ts";

export class ProtocolError extends Error {
	readonly code: "unknown_item" | "wrong_session" | "out_of_order" | "invalid";
	constructor(code: ProtocolError["code"], message: string) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
	}
}

/** The attention group a status belongs to. */
export function attentionFor(status: SessionStatus): Attention {
	switch (status) {
		case "running":
			return "working";
		case "waiting":
			return "waiting";
		default:
			return "done";
	}
}

function indexOfItem(items: readonly TranscriptItem[], id: string): number {
	for (let index = items.length - 1; index >= 0; index--) if (items[index]?.id === id) return index;
	return -1;
}

function applyOp(snapshot: SessionSnapshot, items: TranscriptItem[] | undefined, op: DeltaOp) {
	let next = snapshot;
	let list = items;
	const writable = (): TranscriptItem[] => {
		if (list === undefined) list = [...next.items];
		return list;
	};
	switch (op.op) {
		case "append": {
			writable().push(op.item);
			break;
		}
		case "replace": {
			const target = writable();
			const index = indexOfItem(target, op.item.id);
			// An item older than the snapshot's page is not held by this client; nothing to replace.
			if (index >= 0) target[index] = op.item;
			else if (!next.hasEarlier) throw new ProtocolError("unknown_item", `No item ${op.item.id} to replace`);
			break;
		}
		case "text": {
			const target = writable();
			const index = indexOfItem(target, op.itemId);
			if (index < 0) {
				if (next.hasEarlier) break;
				throw new ProtocolError("unknown_item", `No item ${op.itemId} to append text to`);
			}
			const item = target[index];
			if (item?.kind !== "assistant") throw new ProtocolError("invalid", `Item ${op.itemId} is not an assistant item`);
			const field = op.field ?? "text";
			if (field === "document" && item.document === undefined) {
				throw new ProtocolError("invalid", `Item ${op.itemId} has no document to append to`);
			}
			const updated: AssistantItem =
				field === "text"
					? { ...item, text: item.text + op.append }
					: field === "document" && item.document !== undefined
						? { ...item, document: { ...item.document, text: item.document.text + op.append } }
						: { ...item, thinking: (item.thinking ?? "") + op.append };
			target[index] = updated;
			break;
		}
		case "status":
			next = { ...next, status: op.status, attention: op.attention };
			break;
		case "title":
			next = { ...next, title: op.title };
			break;
		case "usage":
			next = { ...next, usage: op.usage };
			break;
	}
	return { snapshot: next, items: list };
}

/**
 * Applies one delta to a snapshot and returns a new snapshot. Items the delta does not touch keep their identity
 * (the same object), so a UI re-renders only what changed.
 */
export function applyDelta(snapshot: SessionSnapshot, delta: SessionDelta): SessionSnapshot {
	if (delta.sessionId !== snapshot.sessionId) {
		throw new ProtocolError("wrong_session", `Delta for ${delta.sessionId} applied to ${snapshot.sessionId}`);
	}
	let current = snapshot;
	let items: TranscriptItem[] | undefined;
	for (const op of delta.ops) {
		const applied = applyOp(current, items, op);
		current = applied.snapshot;
		items = applied.items;
	}
	return { ...current, items: items ?? current.items, cursor: delta.cursor, updatedAt: delta.at };
}

/**
 * Folds server frames into the snapshot they describe: a `snapshot` frame replaces the state, `delta` frames apply in
 * order, and other frames are ignored. Returns undefined until a snapshot has been seen, unless `initial` is given.
 */
export function applyFrames(frames: Iterable<ServerFrame>, initial?: SessionSnapshot): SessionSnapshot | undefined {
	let state = initial;
	for (const frame of frames) {
		if (frame.type === "snapshot") state = frame.snapshot;
		else if (frame.type === "delta") {
			if (state === undefined) throw new ProtocolError("out_of_order", "Delta before any snapshot");
			state = applyDelta(state, frame.delta);
		}
	}
	return state;
}
