import type { AssistantItem, ToolImage, ToolItem, TranscriptItem } from "@harbour/protocol";

// The transcript's rows, derived from its items. Consecutive tool calls become one group row (T3 Code's work log
// groups, MessagesTimeline.logic.ts:1758-1889); every other item is a row of its own. Any non-tool item ends a group.
// A run of browser calls is one "browsing" row of its own, however many steps it takes: the words the agent says
// between two of its calls fold into it (they narrate the steps), so a browsing turn is one quiet line, not a call, a
// sentence and a screenshot per step. The browser itself is the host's to show, in one place (a panel), not per call.
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
	  }
	| {
			readonly kind: "browsing";
			/** The first browser call's id, so the row keeps its key as steps are added. */
			readonly id: string;
			/** The browser calls, with the agent's words between two of them, in order. Starts and ends with a call. */
			readonly items: readonly BrowsingStep[];
			/** The run is the last row: the turn may still add steps to it. */
			readonly live: boolean;
	  };

/** One step of a browsing row: a browser call, or what the agent said between two of them. */
export type BrowsingStep = ToolItem | AssistantItem;

/** A call to one of the browser's tools (`@harbour/browser`: `browser_request`, `browser_open`, `browser_act`, ...). */
export function isBrowserCall(item: TranscriptItem): item is ToolItem {
	return item.kind === "tool" && isBrowserTool(item.name);
}

const isBrowserTool = (name: string): boolean => name.startsWith("browser_");

function sameTools<T>(a: readonly T[], b: readonly T[]): boolean {
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
	const starts = (id: string): boolean => {
		const kind = before.get(id)?.kind;
		return kind === "tools" || kind === "browsing";
	};

	const rows: TranscriptRow[] = [];
	let tools: ToolItem[] = [];
	let browsing: BrowsingStep[] = [];

	const closeBrowsing = (live: boolean) => {
		const first = browsing[0];
		if (first === undefined) return;
		const old = before.get(first.id);
		rows.push(
			old !== undefined && old.kind === "browsing" && old.live === live && sameTools(old.items, browsing)
				? old
				: { kind: "browsing", id: first.id, items: browsing, live },
		);
		browsing = [];
	};

	// The agent's words fold into a browsing run only between two of its calls: words after the last call may be the
	// turn's answer, so they stay a row of their own until another browser call follows them.
	const narratesBrowsing = (from: number): boolean => {
		for (let index = from + 1; index < items.length; index++) {
			const next = items[index];
			if (next?.kind === "assistant") continue;
			return next !== undefined && isBrowserCall(next) && !starts(next.id);
		}
		return false;
	};

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

	for (const [index, item] of items.entries()) {
		if (item.kind === "tool" && isBrowserTool(item.name)) {
			closeGroup(false);
			if (browsing.length > 0 && starts(item.id)) closeBrowsing(false);
			browsing.push(item);
			continue;
		}
		if (item.kind === "assistant" && browsing.length > 0 && narratesBrowsing(index)) {
			browsing.push(item);
			continue;
		}
		closeBrowsing(false);
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
	closeBrowsing(true);

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
		const item = (row.items as readonly TranscriptItem[]).find((candidate) => isTurn(candidate, turn));
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
	// A browsing row's words sit between two of its calls, so only a call of it can be what runs now.
	if (row.kind === "browsing")
		return row.live && row.items.some((step) => step.kind === "tool" && step.status === "running");
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
		if (row.kind === "tools" || row.kind === "browsing") {
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
		if (row.kind === "item") continue;
		for (const item of row.items) {
			if (item.kind !== "tool") continue;
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

/** The session's browsers, for a host that shows the browser in one place (a panel) rather than in the transcript. */
export type SessionBrowsers = {
	/** One slot per browser the calls name, in the order the session first used them. */
	readonly browsers: readonly BrowserViewSlot[];
	/** The browser used most recently: the one to show unless a person picks another. */
	readonly latest?: string;
	/** The newest browser call while it runs (its label says what the agent is doing), even before it names a browser. */
	readonly running?: ToolItem;
};

/**
 * Each browser the session's calls name, in order of first use, with its newest call and the last screenshot any call
 * on it left; which was used last; and the browser call running now, if any. Pass the previous result as `previous`
 * to keep its identity, and each unchanged slot's, while nothing about the browsers changed (an answer streaming, say).
 */
export function sessionBrowsers(items: readonly TranscriptItem[], previous?: SessionBrowsers): SessionBrowsers {
	const newest = new Map<string, BrowserViewSlot>();
	let running: ToolItem | undefined;
	let latest: string | undefined;
	for (const item of items) {
		if (!isBrowserCall(item)) continue;
		running = item.status === "running" ? item : undefined;
		const id = item.browserSessionId;
		if (id === undefined) continue;
		latest = id;
		const screenshot = item.images?.at(-1) ?? newest.get(id)?.screenshot;
		newest.set(id, { browserSessionId: id, item, ...(screenshot === undefined ? {} : { screenshot }) });
	}
	const before = new Map(previous?.browsers.map((slot) => [slot.browserSessionId, slot]));
	const browsers = [...newest.values()].map((slot) => {
		const old = before.get(slot.browserSessionId);
		return old !== undefined && sameSlot(old, slot) ? old : slot;
	});
	if (
		previous !== undefined &&
		previous.running === running &&
		previous.latest === latest &&
		previous.browsers.length === browsers.length &&
		browsers.every((slot, index) => slot === previous.browsers[index])
	)
		return previous;
	return {
		browsers,
		...(latest === undefined ? {} : { latest }),
		...(running === undefined ? {} : { running }),
	};
}
