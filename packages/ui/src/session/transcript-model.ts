import type { ToolItem, TranscriptItem } from "@harbour/protocol";

// The transcript's rows, derived from its items. Consecutive tool calls become one group row (T3 Code's work log
// groups, MessagesTimeline.logic.ts:1758-1889); every other item is a row of its own. Any non-tool item ends a group.
//
// Rows are memoised on their object, so this reuses the previous call's row objects wherever their items are
// unchanged (by identity). While one answer streams, only its row is a new object; every earlier row is the same
// object as before and React skips it.

/** A transcript item that is not a tool call. */
export type MessageItem = Exclude<TranscriptItem, ToolItem>;

export type TranscriptRow =
	| { readonly kind: "item"; readonly id: string; readonly item: MessageItem }
	| {
			readonly kind: "tools";
			/** The first tool's id, so the row keeps its key as calls are added to the group. */
			readonly id: string;
			readonly items: readonly ToolItem[];
			/** The group is the last row: the turn may still add calls to it. */
			readonly live: boolean;
	  };

function sameTools(a: readonly ToolItem[], b: readonly ToolItem[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * Groups a transcript's items into rows. Pass the previous result as `previous` to keep the identity of every row
 * whose items did not change; when nothing changed at all, `previous` itself is returned.
 *
 * A single tool call is still a group (of one), so its row keeps the same kind and key when a second call joins it.
 *
 * A call that started a group in `previous` still starts one. Groups grow at their end as a turn adds calls, never at
 * their start: when an older page is put in front and ends with tool calls, those form their own group before the
 * existing one, rather than merging into it. Merging would change the group's key and could collapse calls the
 * reader is looking at into a summary, moving their place.
 */
export function groupTranscript(
	items: readonly TranscriptItem[],
	previous?: readonly TranscriptRow[],
): readonly TranscriptRow[] {
	const before = new Map<string, TranscriptRow>();
	if (previous !== undefined) for (const row of previous) before.set(row.id, row);
	const starts = (id: string): boolean => before.get(id)?.kind === "tools";

	const rows: TranscriptRow[] = [];
	let tools: ToolItem[] = [];

	const closeGroup = (live: boolean) => {
		const first = tools[0];
		if (first === undefined) return;
		const old = before.get(first.id);
		rows.push(
			old !== undefined && old.kind === "tools" && old.live === live && sameTools(old.items, tools)
				? old
				: { kind: "tools", id: first.id, items: tools, live },
		);
		tools = [];
	};

	for (const item of items) {
		if (item.kind === "tool") {
			if (tools.length > 0 && starts(item.id)) closeGroup(false);
			tools.push(item);
			continue;
		}
		closeGroup(false);
		const old = before.get(item.id);
		rows.push(
			old !== undefined && old.kind === "item" && old.item === item ? old : { kind: "item", id: item.id, item },
		);
	}
	closeGroup(true);

	if (previous !== undefined && previous.length === rows.length && rows.every((row, index) => row === previous[index]))
		return previous;
	return rows;
}

/**
 * The IDs of each turn's final answer: an assistant item with no other answer and no tool call after it before the
 * person's next message (a notice or a card may follow it). These are the answers that get Copy and their time, as in
 * T3 Code, which shows its message meta only on a turn's terminal answer; the words an agent says between its tool
 * calls get none. One pass over the rows, from the end.
 */
export function finalAnswerIds(rows: readonly TranscriptRow[]): ReadonlySet<string> {
	const ids = new Set<string>();
	let workAfter = false;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row === undefined) continue;
		if (row.kind === "tools") {
			workAfter = true;
			continue;
		}
		if (row.item.kind === "user") workAfter = false;
		else if (row.item.kind === "assistant") {
			if (!workAfter) ids.add(row.id);
			workAfter = true;
		}
	}
	return ids;
}
