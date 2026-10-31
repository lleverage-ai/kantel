import type { AssistantItem, ToolImage, ToolItem, TranscriptItem } from "@harbour/protocol";
import { isBrowserCall } from "./browser-steps.ts";
import { isSubagentCall } from "./subagent-model.ts";

// The transcript's rows, derived from its items. Consecutive tool calls become one group row (T3 Code's work log
// groups, MessagesTimeline.logic.ts:1758-1889); every other item is a row of its own. Any non-tool item ends a group.
// A run of calls whose tools the renderer registry puts in one run (`ToolRenderer.run`, tool-renderer-model.ts: the
// browser's tools) is one "run" row of its own, however many steps it takes, so a browsing run is one quiet line, not
// a call and a screenshot per step. What the agent thought between two of its calls ("Thought it through") folds into
// it, into the step it led to; the agent's words end it and stay at the turn's level, as T3 Code's assistant messages
// sit between its work groups. The browser itself is the host's to show, in one place (a panel), not per call.
// A subagent's call (the `subagent` tool) is a row of its own too, a card that opens its session, and ends a group.
// So is a call whose tool renders in place (the renderer registry: `present_files`' cards): it shows once, as itself,
// where it happened, never as a step of a group. A group's other calls stay in it; a call rendered in place between
// two of them ends one group and the next call starts another.
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
			/** A run of calls that reads as one thing (`ToolRenderer.run`): one line, its steps one switch away. */
			readonly kind: "run";
			/** The first call's id, so the row keeps its key as steps are added. */
			readonly id: string;
			/** The run's id (`ToolRun.id`, "browser"). */
			readonly run: string;
			/** The run's calls, with the agent's thoughts between two of them (`isThought`), in order. Starts and ends with a call. */
			readonly items: readonly RunStep[];
			/** The run is the last row: the turn may still add steps to it. */
			readonly live: boolean;
	  }
	/** A subagent's call: a card of its own, keyed by the call's item. */
	| { readonly kind: "subagent"; readonly id: string; readonly item: ToolItem }
	/** A call whose tool renders in place (`ToolRenderer.inPlace`): itself, not a step of a group. */
	| { readonly kind: "call"; readonly id: string; readonly item: ToolItem };

/** One step of a run row: one of its calls, or what the agent thought between two of them. */
export type RunStep = ToolItem | AssistantItem;

/** What the agent thought with no words (a "Thought it through" row): no text, no document, a thought. */
export function isThought(item: TranscriptItem): item is AssistantItem {
	return (
		item.kind === "assistant" &&
		item.text.trim() === "" &&
		item.document === undefined &&
		item.thinking !== undefined &&
		!item.streaming
	);
}

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
 *
 * `inPlace` says which calls render in place (the registry's `ToolRenderers.inPlace`): each is a row of its own. By
 * default none is. `run` says which run a call is a step of (the id of its registry entry's `ToolRun`): consecutive
 * calls of one run are one `run` row, with the agent's words between two of them. By default none is. Both must go by
 * the tool's name alone, so a call keeps its row from when it starts to when it ends.
 */
export function groupTranscript(
	items: readonly TranscriptItem[],
	previous?: readonly TranscriptRow[],
	inPlace: (item: ToolItem) => boolean = () => false,
	run: (item: ToolItem) => string | undefined = () => undefined,
): readonly TranscriptRow[] {
	const before = new Map<string, TranscriptRow>();
	if (previous !== undefined) for (const row of previous) before.set(row.id, row);
	const starts = (id: string): boolean => {
		const kind = before.get(id)?.kind;
		return kind === "tools" || kind === "run";
	};

	const rows: TranscriptRow[] = [];
	let tools: ToolItem[] = [];
	let steps: RunStep[] = [];
	let stepsOf: string | undefined;

	const closeRun = (live: boolean) => {
		const first = steps[0];
		if (first === undefined || stepsOf === undefined) return;
		const old = before.get(first.id);
		rows.push(
			old !== undefined && old.kind === "run" && old.run === stepsOf && old.live === live && sameTools(old.items, steps)
				? old
				: { kind: "run", id: first.id, run: stepsOf, items: steps, live },
		);
		steps = [];
		stepsOf = undefined;
	};

	// A thought folds into a run only between two of its calls (into the step it led to): one after the last call may
	// lead to the turn's answer, so it stays a row of its own until another call of the run follows it. The agent's
	// words never fold: they end the run, and stay in view at the turn's level.
	const leadsOn = (from: number): boolean => {
		for (let index = from + 1; index < items.length; index++) {
			const next = items[index];
			if (next !== undefined && isThought(next)) continue;
			return next !== undefined && next.kind === "tool" && run(next) === stepsOf && !starts(next.id);
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
		const of = item.kind === "tool" ? run(item) : undefined;
		if (item.kind === "tool" && of !== undefined) {
			closeGroup(false);
			if (steps.length > 0 && (of !== stepsOf || starts(item.id))) closeRun(false);
			stepsOf = of;
			steps.push(item);
			continue;
		}
		if (isThought(item) && steps.length > 0 && leadsOn(index)) {
			steps.push(item);
			continue;
		}
		closeRun(false);
		if (item.kind === "tool" && isSubagentCall(item)) {
			closeGroup(false);
			const old = before.get(item.id);
			rows.push(
				old !== undefined && old.kind === "subagent" && old.item === item
					? old
					: { kind: "subagent", id: item.id, item },
			);
			continue;
		}
		if (item.kind === "tool" && inPlace(item)) {
			closeGroup(false);
			const old = before.get(item.id);
			rows.push(
				old !== undefined && old.kind === "call" && old.item === item ? old : { kind: "call", id: item.id, item },
			);
			continue;
		}
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
	closeRun(true);

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
		if (row.kind === "item" || row.kind === "subagent" || row.kind === "call") {
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
	// A run still under way already says the agent is working (its line spins between steps too), so no "Thinking" row
	// comes and goes under it at every step.
	return { headerAfter, activity: !showsActivity(rows.at(-1)) && activeRunRow(rows) === undefined };
}

/**
 * The run that may still take steps while the session works: the last row other than the agent's words, when it is a
 * run. Words after a run's last call are rows of their own until the next call folds them in, so the run stays
 * "Browsing" while the agent narrates or thinks between steps. Call it only while the session works.
 */
export function activeRunRow(rows: readonly TranscriptRow[]): string | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row === undefined) continue;
		if (row.kind === "item" && row.item.kind === "assistant") continue;
		return row.kind === "run" ? row.id : undefined;
	}
	return undefined;
}

/** The row already says what the agent is doing: an answer streaming, or a call still running. */
function showsActivity(row: TranscriptRow | undefined): boolean {
	if (row === undefined) return false;
	if (row.kind === "tools") return row.live && row.items.some((item) => item.status === "running");
	// A call rendered in place shows itself running (its generic row's spinner, or the renderer's own).
	if (row.kind === "call") return row.item.status === "running";
	// A run's words sit between two of its calls, so only a call of it can be what runs now.
	if (row.kind === "run")
		return row.live && row.items.some((step) => step.kind === "tool" && step.status === "running");
	return row.item.kind === "assistant" && row.item.streaming;
}

/**
 * Whether a row is one line of the agent's work: a group of calls, a run (a browsing run), or a thought with no answer under
 * it ("Thought it through"). Lines of work in a row are one block, so they stack close (docs/spacing.md: within a
 * block); everything else (the person's message, an answer, a card, a subagent) is a block of its own.
 */
export function isWorkLine(row: TranscriptRow): boolean {
	if (row.kind === "tools" || row.kind === "run") return true;
	// A call rendered in place (its files' cards, its images) is a block of its own, as a subagent's card is.
	if (row.kind === "subagent" || row.kind === "call") return false;
	const { item } = row;
	return item.kind === "assistant" && item.text === "" && item.document === undefined && item.thinking !== undefined;
}

/** Whether a row ends with a line of work, rather than with something it shows under it: presented files. */
export function endsInWorkLine(row: TranscriptRow): boolean {
	if (!isWorkLine(row)) return false;
	return row.kind !== "tools" || !row.items.some((item) => item.status === "done" && (item.files?.length ?? 0) > 0);
}

/**
 * The rows that sit close under the row before them rather than a block apart: a line of work right under another,
 * and whatever comes first under a message with an actions row (Copy and the time, shown on hover): the person's
 * message, or a turn's final answer (`finalAnswers`) with a card or a notice after it. The actions row already stands
 * a block's room between them. The transcript spaces every other row a block apart, and a person's message a turn
 * apart.
 */
export function closeRows(
	rows: readonly TranscriptRow[],
	finalAnswers: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
	const close = new Set<string>();
	for (let index = 1; index < rows.length; index++) {
		const row = rows[index];
		const before = rows[index - 1];
		if (row === undefined || before === undefined) continue;
		const underActions = before.kind === "item" && (before.item.kind === "user" || finalAnswers.has(before.id));
		const underWork = isWorkLine(row) && endsInWorkLine(before);
		if (underActions || underWork) close.add(row.id);
	}
	return close;
}

/** The DOM ID of a row's anchor, from its item's ID: `turn-<id>`, so a page can link to a mounted row. */
export const turnAnchor = (itemId: string): string => `turn-${itemId}`;

/**
 * The list keys of the rows not keyed by their ID, by row ID: a person's message with a `requestId` is keyed by that,
 * so the host's own copy of a message it has just sent (an optimistic send, under an ID of its own) and the session's
 * copy, when it arrives with the same `requestId`, are one row that updates in place rather than mounting again. A
 * `requestId` on more than one message keys none of them, so no two rows ever share a key.
 */
export function messageKeys(rows: readonly TranscriptRow[]): ReadonlyMap<string, string> {
	const keys = new Map<string, string>();
	const seen = new Map<string, string | undefined>();
	for (const row of rows) {
		if (row.kind !== "item" || row.item.kind !== "user" || row.item.requestId === undefined) continue;
		const { requestId } = row.item;
		if (seen.has(requestId)) {
			const other = seen.get(requestId);
			if (other !== undefined) keys.delete(other);
			seen.set(requestId, undefined);
			continue;
		}
		seen.set(requestId, row.id);
		keys.set(row.id, `request:${requestId}`);
	}
	return keys;
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
		if (row.kind === "tools" || row.kind === "run" || row.kind === "subagent" || row.kind === "call") {
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

/**
 * A finished turn's work, folded under one "Worked for 1m 12s" line, after T3 Code's turn folds (`deriveTurnFolds` in
 * pingdotgg/t3code's `MessagesTimeline.logic.ts`): every call and word the agent said before its answer, failed calls
 * included (T3 hides those too). The answer stays out of it, and so do the person's steers, cards and notices, the
 * turn's subagents and its runs: a subagent's card is never a step of a working section, so it stays in view where it
 * ran (T3 keeps a live subagent's card out of its fold, `liveSubagentCardEntryIds`; Harbour keeps every one), and a
 * run (a browsing run) is already one line of its own, so folding it again would put its steps two switches away. The
 * agent's words beside a run (`narratesRun`) stay in view with it. The rows stay rows of the transcript (a folded one
 * shows only what must stay in view, such as the files a call presented), so folding a turn when it ends never changes
 * how many rows the list has.
 */
export type TurnFold = {
	/** The first folded row's id: that row carries the fold's line. */
	readonly id: string;
	/** The folded rows' ids, in order. */
	readonly rows: readonly string[];
	/** How long the turn took: from the person's message (else the first folded row) to the answer, in ms. */
	readonly elapsed: number;
	/**
	 * Whether a tool call it folds failed or was interrupted: the closed line carries an alert mark, as it folds away with
	 * the rest. The line says neither how many steps it folds nor how many failed.
	 */
	readonly failed: boolean;
};

const failedCall = (item: ToolItem): boolean => item.status === "error" || item.status === "interrupted";

/**
 * Whether a tool call in a row that folds away failed. A call rendered in place isn't one while it shows as itself
 * (`shows`): it is in view, not folded away.
 */
function rowFailed(row: TranscriptRow, shows: (item: ToolItem) => boolean): boolean {
	if (row.kind === "item" || row.kind === "subagent") return false;
	if (row.kind === "call") return !shows(row.item) && failedCall(row.item);
	return row.items.some((step) => step.kind === "tool" && failedCall(step));
}

/**
 * The files a later call presents again that `generate_image` already showed as pictures (an agent used to present
 * each image it made): by row, the keys (`workspaceId:path`) joined by newlines, a string so a row's props compare
 * equal while they don't change. Their cards would repeat the pictures above them.
 */
export function repeatedImageFiles(rows: readonly TranscriptRow[]): ReadonlyMap<string, string> {
	const shown = new Set<string>();
	const repeated = new Map<string, string>();
	for (const row of rows) {
		if (row.kind !== "tools" && row.kind !== "call") continue;
		const keys: string[] = [];
		for (const item of row.kind === "call" ? [row.item] : row.items) {
			if (item.status !== "done") continue;
			for (const file of item.files ?? []) {
				const key = `${file.workspaceId}:${file.path}`;
				if (item.name === "generate_image") shown.add(key);
				else if (shown.has(key)) keys.push(key);
			}
		}
		if (keys.length > 0) repeated.set(row.id, keys.join("\n"));
	}
	return repeated;
}

/** When a row's work started, for a fold with no message of the person's loaded before it. */
function rowStart(row: TranscriptRow): number {
	if (row.kind === "item" || row.kind === "subagent" || row.kind === "call") return row.item.at;
	return row.items[0]?.at ?? 0;
}

/**
 * A row of a finished turn's work, before the answer: its calls, runs, subagents and the agent's words. All but the
 * subagents and runs fold (`foldsAway`).
 */
const foldable = (row: TranscriptRow): boolean => row.kind !== "item" || row.item.kind === "assistant";

/**
 * A row a finished turn folds away under its line: any of its work but a subagent, whose card stays in view, and a run,
 * which is one line of the turn already (its failed steps are said on that line).
 */
const foldsAway = (row: TranscriptRow): boolean => foldable(row) && row.kind !== "subagent" && row.kind !== "run";

/** A row of the agent's words, not only a thought: what it said. */
const saysWords = (row: TranscriptRow | undefined): boolean =>
	row?.kind === "item" && row.item.kind === "assistant" && !isThought(row.item);

/** A row of a thought alone ("Thought it through"). */
const thoughtRow = (row: TranscriptRow | undefined): boolean => row?.kind === "item" && isThought(row.item);

/**
 * Whether a row is the agent's words beside a run (`run` rows: a browsing run), with only thoughts between: what it
 * said about the run, before or after it ("Skyscanner is showing a bot check. I'll try Google Flights instead."). It
 * stays in view at the turn's level with the run, out of the turn's fold, between `start` and `end`.
 */
function narratesRun(rows: readonly TranscriptRow[], index: number, start: number, end: number): boolean {
	if (!saysWords(rows[index])) return false;
	for (const step of [-1, 1]) {
		let at = index + step;
		while (at > start && at < end && thoughtRow(rows[at])) at += step;
		if (at > start && at < end && rows[at]?.kind === "run") return true;
	}
	return false;
}

/** A row still doing something: a call running, or an answer streaming. Its turn isn't finished. */
function busy(row: TranscriptRow): boolean {
	if (row.kind === "item") return row.item.kind === "assistant" && row.item.streaming;
	if (row.kind === "subagent" || row.kind === "call") return row.item.status === "running";
	return row.items.some((step) => (step.kind === "tool" ? step.status === "running" : step.streaming));
}

/** A turn starts at a message the person sent, other than a steer (a steer joins the turn under way). */
const startsTurn = (row: TranscriptRow): boolean =>
	row.kind === "item" && row.item.kind === "user" && row.item.via !== "steer";

/**
 * Each finished turn's fold, by the id of every row it folds. A turn folds once it has ended with an answer: an answer
 * with words, after all of the turn's work. One that stopped without an answer (it failed, or was stopped) stays
 * unfolded, so what happened stays in view, as T3 Code leaves a failed run open. With `working`, the last turn is under
 * way and doesn't fold: its work streams at the top level until it ends. Pass the previous result as `previous` to keep
 * each unchanged fold's identity, so only the rows of a fold that changed render again.
 *
 * `shows` says which calls rendered in place show as themselves (the registry's `ToolRenderers.shows`): those stay in
 * view in a closed fold and aren't steps. A turn whose work is only such calls has nothing to fold, so no line.
 */
export function turnFolds(
	rows: readonly TranscriptRow[],
	working: boolean,
	previous?: ReadonlyMap<string, TurnFold>,
	shows: (item: ToolItem) => boolean = (item) => item.status === "done",
): ReadonlyMap<string, TurnFold> {
	const folds = new Map<string, TurnFold>();
	const starts: number[] = [];
	for (const [index, row] of rows.entries()) if (startsTurn(row)) starts.push(index);
	// A page that starts mid-turn: its first rows are the end of a turn whose message isn't loaded.
	if (starts[0] !== 0) starts.unshift(-1);
	for (const [turn, start] of starts.entries()) {
		const end = starts[turn + 1] ?? rows.length;
		if (working && end === rows.length) continue;
		let answer = -1;
		for (let index = end - 1; index > start; index--) {
			const row = rows[index];
			if (row === undefined || !foldable(row)) continue;
			if (row.kind === "item" && row.item.kind === "assistant" && row.item.text.trim() !== "") answer = index;
			break;
		}
		if (answer < 0) continue;
		const members: string[] = [];
		let unfinished = false;
		let failed = false;
		let hides = false;
		for (let index = start + 1; index < answer; index++) {
			const row = rows[index];
			if (row === undefined || !foldable(row)) continue;
			// A subagent still working keeps the turn open, as any running call does.
			if (busy(row)) unfinished = true;
			if (!foldsAway(row) || narratesRun(rows, index, start, answer)) continue;
			if (rowFailed(row, shows)) failed = true;
			if (row.kind !== "call" || !shows(row.item)) hides = true;
			members.push(row.id);
		}
		const first = rows[start + 1];
		const answered = rows[answer];
		if (unfinished || !hides || first === undefined || answered?.kind !== "item") continue;
		const opened = start >= 0 ? rows[start] : undefined;
		const began = opened?.kind === "item" ? opened.item.at : rowStart(first);
		const id = members[0] as string;
		const elapsed = Math.max(0, answered.item.at - began);
		const before = previous?.get(id);
		const fold =
			before !== undefined &&
			before.id === id &&
			before.elapsed === elapsed &&
			before.failed === failed &&
			before.rows.length === members.length &&
			before.rows.every((row, index) => row === members[index])
				? before
				: { id, rows: members, elapsed, failed };
		for (const member of members) folds.set(member, fold);
	}
	return folds;
}

/** The page a browser call left the browser on, as far as its result says: its URL and title. */
export type BrowserCallPage = { readonly url?: string; readonly title?: string };

/**
 * The page a browser call says it left the browser on: `URL:` and `Title:` lines in a step's result (`browser_act`,
 * `browser_open` at a URL), "Screenshot of <url> (<title>)." from `browser_screenshot`, or the URL `browser_open` was
 * asked to open. `undefined` when the call says nothing about a page (a request, a close, one still running).
 */
export function browserPageOf(item: ToolItem): BrowserCallPage | undefined {
	const output = item.output ?? "";
	const url = output.match(/^URL: (\S+)\s*$/m)?.[1];
	const title = output.match(/^Title: (.*)$/m)?.[1]?.trim();
	if (url !== undefined) return { url, ...(title ? { title } : {}) };
	const shot = output.match(/^Screenshot of (\S+) \((.*)\)\.\s*$/m);
	if (shot?.[1] !== undefined) return { url: shot[1], ...(shot[2]?.trim() ? { title: shot[2].trim() } : {}) };
	if (item.name === "browser_open" || (item.name === "browser_act" && isGoto(item.args))) {
		const asked = (item.args as { url?: unknown } | undefined)?.url;
		if (typeof asked === "string" && /^https?:\/\//i.test(asked)) return { url: asked };
	}
	return undefined;
}

const isGoto = (args: unknown): boolean =>
	typeof args === "object" && args !== null && (args as { action?: unknown }).action === "goto";

/** Where a browser's live view goes: under the newest call on it, with the last screenshot it left. */
export type BrowserViewSlot = {
	readonly browserSessionId: string;
	/** The newest call on the browser, which the view sits under. */
	readonly item: ToolItem;
	/** The newest image any call on the browser returned, for before the view connects and after the browser closes. */
	readonly screenshot?: ToolImage;
	/** The newest page any call on the browser said it was on, for its tab and address bar. */
	readonly page?: BrowserCallPage;
	/** The browser has closed: its last call closed it. */
	readonly closed?: boolean;
};

const samePage = (a: BrowserCallPage | undefined, b: BrowserCallPage | undefined): boolean =>
	a === b || (a !== undefined && b !== undefined && a.url === b.url && a.title === b.title);

// Pages are parsed again from the calls each time: an equal page counts as the same.
const sameSlot = (a: BrowserViewSlot | undefined, b: BrowserViewSlot): boolean =>
	a !== undefined &&
	a.browserSessionId === b.browserSessionId &&
	a.item === b.item &&
	a.screenshot === b.screenshot &&
	samePage(a.page, b.page) &&
	a.closed === b.closed;

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
	const newest = new Map<
		string,
		{ rowId: string; item: ToolItem; screenshot?: ToolImage; page?: BrowserCallPage; closed?: boolean }
	>();
	for (const row of rows) {
		if (row.kind === "item" || row.kind === "subagent" || row.kind === "call") continue;
		for (const item of row.items) {
			if (item.kind !== "tool") continue;
			const id = item.browserSessionId;
			if (id === undefined) continue;
			const before = newest.get(id);
			const screenshot = item.images?.at(-1) ?? before?.screenshot;
			const page = browserPageOf(item) ?? before?.page;
			const closed = item.name === "browser_close" && item.status === "done";
			newest.set(id, {
				rowId: row.id,
				item,
				...(screenshot === undefined ? {} : { screenshot }),
				...(page === undefined ? {} : { page }),
				...(closed ? { closed } : {}),
			});
		}
	}
	const byRow = new Map<string, BrowserViewSlot[]>();
	for (const [browserSessionId, { rowId, item, screenshot, page, closed }] of newest) {
		const slot: BrowserViewSlot = {
			browserSessionId,
			item,
			...(screenshot === undefined ? {} : { screenshot }),
			...(page === undefined ? {} : { page }),
			...(closed ? { closed } : {}),
		};
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

/**
 * Each browser's timeline card, by the id of the run row it goes in: the first run whose calls name the browser
 * (where it was opened), with the browser's newest page, screenshot and closed state from every row. A browser has
 * one card however many runs use it, so a later run that only closes it never shows a card with no page. Pass the
 * previous result as `previous` to keep the identity of every card that did not change.
 */
export function browserEntrySlots(
	rows: readonly TranscriptRow[],
	previous?: ReadonlyMap<string, BrowserViewSlot>,
): ReadonlyMap<string, BrowserViewSlot> {
	const first = new Map<string, string>();
	const newest = new Map<string, BrowserViewSlot>();
	for (const row of rows) {
		if (row.kind !== "run") continue;
		for (const item of row.items) {
			if (!isBrowserCall(item)) continue;
			const id = item.browserSessionId;
			if (id === undefined) continue;
			if (!first.has(id)) first.set(id, row.id);
			const before = newest.get(id);
			const screenshot = item.images?.at(-1) ?? before?.screenshot;
			const page = browserPageOf(item) ?? before?.page;
			const closed = item.name === "browser_close" && item.status === "done";
			newest.set(id, {
				browserSessionId: id,
				item,
				...(screenshot === undefined ? {} : { screenshot }),
				...(page === undefined ? {} : { page }),
				...(closed ? { closed } : {}),
			});
		}
	}
	const result = new Map<string, BrowserViewSlot>();
	for (const [id, rowId] of first) {
		const slot = newest.get(id);
		if (slot === undefined || result.has(rowId)) continue;
		const before = previous?.get(rowId);
		result.set(rowId, sameSlot(before, slot) ? (before as BrowserViewSlot) : slot);
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
		const before = newest.get(id);
		const screenshot = item.images?.at(-1) ?? before?.screenshot;
		const page = browserPageOf(item) ?? before?.page;
		const closed = item.name === "browser_close" && item.status === "done";
		newest.set(id, {
			browserSessionId: id,
			item,
			...(screenshot === undefined ? {} : { screenshot }),
			...(page === undefined ? {} : { page }),
			...(closed ? { closed } : {}),
		});
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
