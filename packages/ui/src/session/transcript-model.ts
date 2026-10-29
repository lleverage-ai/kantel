import type { ToolImage, ToolItem, TranscriptItem } from "@harbour/protocol";

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
 * Whether `item` is the turn a link names (`#turn=<id>`): its own ID, a tool call's `callId` (an audit event's
 * `session.tool` subject) or a message's `requestId` (the one its client sent it with). An empty turn names nothing.
 */
export function isTurn(item: TranscriptItem, turn: string): boolean {
	if (turn === "") return false;
	if (item.id === turn) return true;
	if (item.kind === "tool") return item.callId === turn;
	if (item.kind === "user") return item.requestId === turn;
	return false;
}

/** The item a turn names among `items`, or undefined when it isn't loaded (or isn't in the session). */
export function findTurn(items: readonly TranscriptItem[], turn: string): TranscriptItem | undefined {
	return items.find((item) => isTurn(item, turn));
}

/** The row a turn's item is in, and the item: for a group of tool calls, the call itself. */
export function rowOfTurn(
	rows: readonly TranscriptRow[],
	turn: string,
): { readonly row: TranscriptRow; readonly item: TranscriptItem } | undefined {
	for (const row of rows) {
		if (row.kind === "item") {
			if (isTurn(row.item, turn)) return { row, item: row.item };
			continue;
		}
		const item = row.items.find((candidate) => isTurn(candidate, turn));
		if (item !== undefined) return { row, item };
	}
	return undefined;
}

/**
 * Where a working turn's two live rows go, after T3 Code's timeline (MessagesTimeline.logic.ts:1646-1684 and
 * 2093-2133): the turn's "Working for 12s" header right under the person's message that started it, and a live
 * activity row ("Thinking") at the end, unless the last row already shows what the agent is doing.
 *
 * - `headerAfter`: the index of the row the header follows: the last message the person sent other than a steer (a steer
 *   joins the turn under way). -1 when that message isn't loaded (it is in an older page): the header then goes at
 *   the end, before the activity row.
 * - `activity`: whether the transcript ends with the activity row. Not when the last row is an answer streaming (its
 *   words, its thought or its own "Thinking" are the activity) or a group of calls with one still running (the call
 *   is). Between steps, with every call finished and nothing streaming, the agent is thinking.
 */
export function workingPlacement(rows: readonly TranscriptRow[]): { headerAfter: number; activity: boolean } {
	let headerAfter = -1;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row?.kind === "item" && row.item.kind === "user" && row.item.via !== "steer") {
			headerAfter = index;
			break;
		}
	}
	return { headerAfter, activity: !showsActivity(rows.at(-1)) };
}

/** The row already says what the agent is doing: an answer streaming, or a call still running. */
function showsActivity(row: TranscriptRow | undefined): boolean {
	if (row === undefined) return false;
	if (row.kind === "tools") return row.live && row.items.some((item) => item.status === "running");
	return row.item.kind === "assistant" && row.item.streaming;
}

/** The DOM ID of a row's anchor, from its item's ID: `turn-<id>`, so a page can link to a mounted row. */
export const turnAnchor = (itemId: string): string => `turn-${itemId}`;

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

/** Where a browser's live view goes: under the newest call on it, with the last screenshot it left. */
export type BrowserViewSlot = {
	readonly browserSessionId: string;
	/** The newest call on the browser, which the view sits under. */
	readonly item: ToolItem;
	/** The newest image any call on the browser returned, for before the view connects and after the browser closes. */
	readonly screenshot?: ToolImage;
};

const sameSlot = (a: BrowserViewSlot | undefined, b: BrowserViewSlot): boolean =>
	a !== undefined && a.browserSessionId === b.browserSessionId && a.item === b.item && a.screenshot === b.screenshot;

/**
 * Each browser's view slot, by the id of the tool row it goes in: one per browser the transcript's calls name
 * (`ToolItem.browserSessionId`), under its newest call, so the view moves down the transcript with the browser.
 * Pass the previous result as `previous` to keep the identity of every row's slots that did not change, so only the
 * rows the view leaves or joins render again.
 */
export function browserViewSlots(
	rows: readonly TranscriptRow[],
	previous?: ReadonlyMap<string, readonly BrowserViewSlot[]>,
): ReadonlyMap<string, readonly BrowserViewSlot[]> {
	const newest = new Map<string, { rowId: string; item: ToolItem; screenshot?: ToolImage }>();
	for (const row of rows) {
		if (row.kind !== "tools") continue;
		for (const item of row.items) {
			const id = item.browserSessionId;
			if (id === undefined) continue;
			const screenshot = item.images?.at(-1) ?? newest.get(id)?.screenshot;
			newest.set(id, { rowId: row.id, item, ...(screenshot === undefined ? {} : { screenshot }) });
		}
	}
	const byRow = new Map<string, BrowserViewSlot[]>();
	for (const [browserSessionId, { rowId, item, screenshot }] of newest) {
		const slot: BrowserViewSlot = { browserSessionId, item, ...(screenshot === undefined ? {} : { screenshot }) };
		const list = byRow.get(rowId) ?? [];
		list.push(slot);
		byRow.set(rowId, list);
	}
	const result = new Map<string, readonly BrowserViewSlot[]>();
	for (const [rowId, slots] of byRow) {
		const before = previous?.get(rowId);
		const same =
			before !== undefined && before.length === slots.length && slots.every((slot, i) => sameSlot(before[i], slot));
		result.set(rowId, same ? before : slots);
	}
	return result;
}
