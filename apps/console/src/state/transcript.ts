import type { AssistantItem, DeltaOp, ItemId, RunState, ToolItem, TranscriptItem } from "../protocol-local/index.ts";

/**
 * A transcript: items oldest first, and where each one is. Applying ops is copy-on-write per item: an op replaces only
 * the item it names, and every other item keeps its identity, so a memoised row for it does not render again. One
 * batch of ops copies the array at most once.
 */
export type Transcript = {
	readonly items: readonly TranscriptItem[];
	/** Position of each item in `items`. Owned by whoever owns the transcript; rebuilt when items are prepended. */
	readonly index: ReadonlyMap<ItemId, number>;
};

export const EMPTY: Transcript = { items: [], index: new Map() };

export function fromItems(items: readonly TranscriptItem[]): Transcript {
	return { items, index: indexOf(items) };
}

function indexOf(items: readonly TranscriptItem[]): Map<ItemId, number> {
	const index = new Map<ItemId, number>();
	items.forEach((item, position) => index.set(item.id, position));
	return index;
}

/** Older items from a history page go in front; the index is rebuilt once. */
export function prepend(transcript: Transcript, older: readonly TranscriptItem[]): Transcript {
	if (older.length === 0) return transcript;
	const known = transcript.index;
	const fresh = older.filter((item) => !known.has(item.id));
	return fromItems([...fresh, ...transcript.items]);
}

export type Applied = { transcript: Transcript; run?: RunState; changed: ReadonlySet<ItemId> };

/** Apply ops in order. Returns the same transcript object when nothing changed. */
export function applyOps(transcript: Transcript, ops: readonly DeltaOp[]): Applied {
	let items: TranscriptItem[] | undefined;
	let index = transcript.index as Map<ItemId, number>;
	let indexCopied = false;
	let run: RunState | undefined;
	const changed = new Set<ItemId>();

	const write = (): TranscriptItem[] => {
		items ??= transcript.items.slice();
		return items;
	};
	const current = (): readonly TranscriptItem[] => items ?? transcript.items;
	const at = (id: ItemId): number | undefined => index.get(id);
	const put = (item: TranscriptItem): void => {
		const position = at(item.id);
		const list = write();
		if (position === undefined) {
			if (!indexCopied) {
				index = new Map(index);
				indexCopied = true;
			}
			index.set(item.id, list.length);
			list.push(item);
		} else {
			list[position] = item;
		}
		changed.add(item.id);
	};
	const get = (id: ItemId): TranscriptItem | undefined => {
		const position = at(id);
		return position === undefined ? undefined : current()[position];
	};

	for (const op of ops) {
		switch (op.op) {
			case "item.add":
			case "item.put":
				put(op.item);
				break;
			case "part.add": {
				const item = get(op.id);
				if (item?.kind !== "assistant") break;
				put({ ...item, parts: [...item.parts, op.part] });
				break;
			}
			case "text.append": {
				const item = get(op.id);
				if (item?.kind !== "assistant") break;
				const part = item.parts[op.part];
				if (part === undefined || part.kind === "tool") break;
				const parts = item.parts.slice();
				parts[op.part] = { ...part, text: part.text + op.text };
				put({ ...item, parts } satisfies AssistantItem);
				break;
			}
			case "tool.update": {
				const item = get(op.id);
				if (item?.kind !== "tool") break;
				const next: ToolItem = { ...item };
				if (op.status !== undefined) next.status = op.status;
				if (op.args !== undefined) next.args = op.args;
				if (op.durationMs !== undefined) next.durationMs = op.durationMs;
				if (op.output !== undefined) {
					next.output =
						"set" in op.output
							? op.output.set
							: item.output.slice(op.output.trimStart ?? 0) + (op.output.append ?? "");
				}
				put(next);
				break;
			}
			case "run":
				run = op.state;
				break;
		}
	}
	const next = items === undefined ? transcript : { items, index };
	return run === undefined ? { transcript: next, changed } : { transcript: next, run, changed };
}
