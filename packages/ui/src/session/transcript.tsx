import type { Card, CardItem, TranscriptItem } from "@harbour/protocol";
import {
	type DragEvent,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { VList, type VListHandle } from "virtua";
import { Button } from "../primitives/button.tsx";
import { ChevronDownIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { BrowserGrantCard } from "./browser-grant-card.tsx";
import { type ComposerDock, ComposerDockContext, type FileDropHandler } from "./composer-dock.ts";
import { atScrollEnd, recordRestGesture, restGesture, restsForKey, wheelPixels } from "./composer-model.ts";
import { AssistantMessage, NoticeRow, UserMessage } from "./message.tsx";
import { type MessageActionHandlers, MessageActionsContext } from "./message-actions.tsx";
import { QuestionCard } from "./question-card.tsx";
import { ToolCallGroup } from "./tool-call.tsx";
import {
	type BrowserViewSlot,
	browserViewSlots,
	finalAnswerIds,
	groupTranscript,
	rowOfTurn,
	type TranscriptRow,
	turnAnchor,
	workingPlacement,
} from "./transcript-model.ts";
import { VaultApprovalCard } from "./vault-approval-card.tsx";
import { LiveActivity, WorkingIndicator } from "./working-indicator.tsx";
import "./transcript.css";

// The virtualised transcript. Only the rows near the viewport are mounted, whatever the session's length. It follows
// new output only while the reader is at the bottom (T3 Code's useTimelineFollow.ts:162-196): scrolling up stops
// following, and returning to the bottom, or the "Scroll to end" button, starts it again. Near the top it asks for
// the previous history page, and keeps the reader's place when that page is put in front. Once there is nothing
// older, a paged transcript starts with a quiet "Start of the session" divider, so the reader knows they have it all.

/** How close to the bottom still counts as at the bottom, in CSS pixels. */
const AT_BOTTOM_PX = 48;
/** How close to the top asks for the previous page. */
const LOAD_OLDER_PX = 600;
/** How far beyond the viewport rows stay mounted. */
const BUFFER_PX = 600;
/** How long a linked turn stays highlighted once the list has landed on it (ms); its fade is the CSS's. */
const HIGHLIGHT_MS = 2400;

// A fixed spacer always sits after the last row, so the bottom padding never belongs to a real row: if it did, the
// row that was last would render again, to lose it, every time an item arrived.
const END = { end: true } as const;
// The top of a paged transcript once there is nothing older. It is an entry of the list, not an overlay, so it
// scrolls with the rows; it is put in front as an older page would be, keeping the reader's place.
const START = { start: true } as const;
// While the session works on a turn (the `working` prop), the turn's "Working for 12s" header, under the person's
// message, and its live activity row ("Thinking") at the end, after T3 Code's (see `workingPlacement`).
const WORKING = { working: true } as const;
const ACTIVITY = { activity: true } as const;
type Entry = TranscriptRow | typeof END | typeof START | typeof WORKING | typeof ACTIVITY;

const entryKey = (entry: Entry | undefined): string | undefined =>
	entry === undefined
		? undefined
		: "end" in entry
			? "end"
			: "start" in entry
				? "start"
				: "working" in entry
					? "working"
					: "activity" in entry
						? "activity"
						: entry.id;

/** The session is working on a turn: what the transcript's working row says, and when the turn started. */
export type TranscriptWorking = {
	/**
	 * When the turn started (epoch ms), for the row's timer. Default: when the person last sent a message other than a
	 * steer, if it is loaded.
	 */
	readonly since?: number;
	/** Default "Working". */
	readonly label?: string;
};

/**
 * Without a renderCard, a card shows read-only: everything it says (a vault request's terms and binding code, a
 * question and its options, a browser request's reason), with nothing to press. A host that can act on cards passes
 * renderCard with the same components and their handlers.
 */
function ReadOnlyCard({ card }: { card: Card }) {
	switch (card.type) {
		case "vault.approval":
			return <VaultApprovalCard card={card} />;
		case "question":
			return <QuestionCard card={card} />;
		case "browser.grant":
			return <BrowserGrantCard card={card} />;
	}
}

type RowProps = {
	row: TranscriptRow;
	first: boolean;
	turnStart: boolean;
	/** The row is its turn's final answer, which gets Copy and its time on hover. */
	finalAnswer: boolean;
	renderCard: ((item: CardItem) => ReactNode) | undefined;
	/** The browsers whose live view goes in this row, under their newest call. */
	browserSlots: readonly BrowserViewSlot[] | undefined;
	renderBrowserView: ((slot: BrowserViewSlot) => ReactNode) | undefined;
	report: (id: string, phase: RowRenderPhase) => void;
	/** The linked turn is in this row: the row is highlighted, and a tool call in it opens its group and stands out. */
	highlight: string | undefined;
};

/** Whether a row rendered for the first time (it scrolled into view, or arrived) or again. */
export type RowRenderPhase = "mount" | "update";

function rowBody(
	row: TranscriptRow,
	finalAnswer: boolean,
	renderCard: RowProps["renderCard"],
	browserSlots: RowProps["browserSlots"],
	renderBrowserView: RowProps["renderBrowserView"],
	highlight: RowProps["highlight"],
): ReactNode {
	if (row.kind === "tools") {
		const views =
			browserSlots === undefined || renderBrowserView === undefined
				? undefined
				: new Map(browserSlots.map((slot) => [slot.item.id, renderBrowserView(slot)] as const));
		return (
			<ToolCallGroup
				items={row.items}
				live={row.live}
				{...(views === undefined ? {} : { browserViews: views })}
				{...(highlight === undefined ? {} : { focus: highlight })}
			/>
		);
	}
	const { item } = row;
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} />;
		case "assistant":
			return <AssistantMessage item={item} actions={finalAnswer} />;
		case "notice":
			return <NoticeRow item={item} />;
		case "card":
			return renderCard === undefined ? <ReadOnlyCard card={item.card} /> : renderCard(item);
	}
}

// Memoised on the row object, which groupTranscript keeps while the row's items are unchanged: while an answer
// streams, every earlier row gets the same props and React skips it.
const Row = memo(function Row({
	row,
	first,
	turnStart,
	finalAnswer,
	renderCard,
	browserSlots,
	renderBrowserView,
	report,
	highlight,
}: RowProps) {
	const mounted = useRef(false);
	report(row.id, mounted.current ? "update" : "mount");
	useRenderProbe("TranscriptRow", row.id);
	useEffect(() => {
		mounted.current = true;
	}, []);
	const kind = row.kind === "tools" ? "tools" : row.item.kind;
	return (
		<div
			className={`hb-transcript-row hb-transcript-row-${kind}${first ? " hb-transcript-row-first" : ""}${turnStart ? " hb-transcript-turn" : ""}${highlight === undefined ? "" : " hb-transcript-row-linked"}`}
			id={turnAnchor(row.id)}
			data-row={row.id}
		>
			<div className="hb-transcript-column">
				{rowBody(row, finalAnswer, renderCard, browserSlots, renderBrowserView, highlight)}
			</div>
		</div>
	);
});

function LoadingRows() {
	return (
		<div className="hb-transcript-loading" aria-busy="true">
			<span className="hb-sr-only" role="status">
				Loading messages
			</span>
			{[0, 1].map((turn) => (
				<div key={turn} className="hb-transcript-column hb-transcript-skeleton-turn">
					<div className="hb-transcript-skeleton-user">
						<Skeleton width="45%" />
					</div>
					<div className="hb-transcript-skeleton-tools">
						<Skeleton width="35%" />
						<Skeleton width="28%" />
					</div>
					<Skeleton lines={3} />
				</div>
			))}
		</div>
	);
}

export type TranscriptProps = {
	items: readonly TranscriptItem[];
	/** Items before `items[0]` exist; scrolling near the top calls `onLoadOlder`. */
	hasOlder?: boolean;
	loadingOlder?: boolean;
	onLoadOlder?: () => void;
	/**
	 * Loading the previous page failed: says why at the top, with "Try again" (which calls `onLoadOlder`). While it is
	 * set, scrolling near the top doesn't ask again on its own.
	 */
	olderError?: ReactNode;
	/**
	 * Renders a card item (an approval, a question), with the host's handlers. Keep it stable: every row re-renders
	 * when it changes. Without it cards show read-only, from the same components.
	 */
	renderCard?: (item: CardItem) => ReactNode;
	/**
	 * Renders a browser's live view (usually a `BrowserLiveView` with the host's link), under the newest call on each
	 * browser the calls name. Keep it stable: every row with a browser re-renders when it changes. Without it a browser
	 * call shows its screenshots only.
	 */
	renderBrowserView?: (slot: BrowserViewSlot) => ReactNode;
	/**
	 * A browser session to show (an audit link's `#browser=<id>`): once its view is in the loaded transcript, the list
	 * scrolls to it, once per ID, and stops following the end.
	 */
	focusBrowser?: string;
	/** The first page is loading: shows skeleton rows while there are no items. */
	loading?: boolean;
	/** What an empty transcript says. Defaults to "No messages yet". */
	empty?: ReactNode;
	/** An error shown above the list, in an error notice. */
	error?: ReactNode;
	/**
	 * The session is working on a turn: from the moment a message is sent until the run settles, a live "Working for
	 * 12s" header with a divider sits under the person's message (`WorkingIndicator`), and the turn ends with a live
	 * activity row, a brain and "Thinking" (`LiveActivity`), unless a call is running or an answer is streaming, which
	 * show the activity themselves; after T3 Code's. `true` times it from the person's last message; pass `{ since }` to
	 * time it from when the host knows the turn started (an optimistic send, say).
	 */
	working?: boolean | TranscriptWorking;
	/**
	 * Called while a row renders, with its id and whether it is mounting or rendering again: the console's profiler
	 * and the design loop's wasted-render count. Never causes a render.
	 */
	onRowRender?: (id: string, phase: RowRenderPhase) => void;
	/**
	 * The host's Fork from this response and Edit from here, for the messages' actions; left out, a message has only
	 * Copy and its time. Messages render again only when one of its fields changes, such as `editBlocked` while a run
	 * goes, so keep the functions stable.
	 */
	messageActions?: MessageActionHandlers;
	/**
	 * Docked over the transcript's foot, usually a Composer, as T3 Code's thread: the list scrolls under it and its
	 * end makes room for it. A Composer here rests (folds to one line) while the reader scrolls back, comes back at
	 * the end, and takes files dropped anywhere on the transcript.
	 */
	dock?: ReactNode;
	/**
	 * The turn a link names (a page's `#turn=<id>`): an item's ID, a tool call's `callId` or a message's `requestId`
	 * (`isTurn`). Once its item is among `items`, the list scrolls it to the middle of the view, stops following the end
	 * and highlights it briefly; a tool call in a folded group opens the group. It lands once per turn: set another to
	 * land again. Paging back to a turn that isn't loaded yet is the host's (see `findTurn`).
	 */
	turn?: string;
	className?: string;
};

/** Files dropped on a docked transcript: what the composer accepts, said plainly in the overlay. */
type DropTarget = { handler: FileDropHandler; hint: string };

function hasFiles(event: DragEvent): boolean {
	return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

/**
 * A session's transcript: user bubbles, assistant answers, grouped tool calls, notices and cards, in a virtualised
 * list that follows new output while the reader is at the bottom. Key it by session, so a new session starts at its
 * end rather than being taken for older history.
 */
export function Transcript({
	items,
	hasOlder = false,
	loadingOlder = false,
	onLoadOlder,
	olderError,
	renderCard,
	renderBrowserView,
	focusBrowser,
	loading = false,
	empty,
	error,
	working,
	onRowRender,
	messageActions,
	dock,
	turn,
	className,
}: TranscriptProps) {
	const { fork, edit, editBlocked } = messageActions ?? {};
	const actionHandlers = useMemo<MessageActionHandlers>(
		() => ({
			...(fork === undefined ? {} : { fork }),
			...(edit === undefined ? {} : { edit }),
			...(editBlocked === undefined ? {} : { editBlocked }),
		}),
		[fork, edit, editBlocked],
	);
	// Rows keep their identity across renders wherever their items are unchanged.
	const previousRows = useRef<readonly TranscriptRow[] | undefined>(undefined);
	const rows = useMemo(() => {
		const next = groupTranscript(items, previousRows.current);
		previousRows.current = next;
		return next;
	}, [items]);
	// Each browser's live view, under its newest call. Rows keep their slots' identity while they don't change.
	const previousSlots = useRef<ReadonlyMap<string, readonly BrowserViewSlot[]> | undefined>(undefined);
	const slots = useMemo(() => {
		const next = browserViewSlots(rows, previousSlots.current);
		previousSlots.current = next;
		return next;
	}, [rows]);
	// A paged transcript (one with `onLoadOlder`) that has every item says where the session starts.
	const paged = onLoadOlder !== undefined;
	const atStart = paged && !hasOlder && rows.length > 0;
	const showWorking = working !== undefined && working !== false;
	const placement = useMemo(() => workingPlacement(rows), [rows]);
	const { headerAfter, activity } = placement;
	const entries = useMemo<Entry[]>(() => {
		const head: Entry[] = atStart ? [START] : [];
		if (!showWorking) return [...head, ...rows, END];
		const foot: Entry[] = activity ? [ACTIVITY, END] : [END];
		// The header under the turn's message; with that message in an older page, at the end, before the activity.
		if (headerAfter < 0) return [...head, ...rows, WORKING, ...foot];
		return [...head, ...rows.slice(0, headerAfter + 1), WORKING, ...rows.slice(headerAfter + 1), ...foot];
	}, [rows, atStart, showWorking, headerAfter, activity]);

	// The working header times the turn from the last message the person sent, other than a steer (a steer joins the
	// turn under way), unless the host says when it started. With that message in an unloaded page it says "Working".
	const lastTurnStart = useMemo(() => {
		const row = headerAfter < 0 ? undefined : rows[headerAfter];
		return row?.kind === "item" && row.item.kind === "user" ? row.item.at : undefined;
	}, [rows, headerAfter]);
	const workingSince = typeof working === "object" ? (working.since ?? lastTurnStart) : lastTurnStart;
	const workingLabel = typeof working === "object" ? working.label : undefined;

	// Each turn's final answer: an answer with no answer or tool call after it before the person's next message. Only
	// these get Copy and their time, as in T3 Code; the words an agent says between tool calls don't.
	const finalAnswers = useMemo(() => finalAnswerIds(rows), [rows]);

	// The render hook lives in a ref, so a new callback from the host never re-renders the rows.
	const onRowRenderRef = useRef(onRowRender);
	onRowRenderRef.current = onRowRender;
	const report = useCallback((id: string, phase: RowRenderPhase) => onRowRenderRef.current?.(id, phase), []);

	const list = useRef<VListHandle>(null);
	const frame = useRef<HTMLElement>(null);
	const following = useRef(true);
	const [showEnd, setShowEnd] = useState(false);
	// A docked composer rests while the reader is away from the end; see the dock below.
	const [resting, setResting] = useState(false);
	const first = useRef<string | undefined>(undefined);
	const count = useRef(0);
	// The working row alone is a list too: a message just sent, before its turn's first item arrives.
	const showList = rows.length > 0 || showWorking;

	// Prepending older rows, or the start divider: tell the virtualiser to keep the visible content still (virtua's
	// `shift`). Compared on the list's entries, so a page that arrives with the divider is one shift, not two.
	const firstKey = entryKey(entries[0]);
	const prepended =
		first.current !== undefined &&
		firstKey !== first.current &&
		firstKey !== "end" &&
		first.current !== "working" &&
		first.current !== "activity" &&
		entries.length > count.current &&
		count.current > 1;

	const toBottom = useCallback(() => {
		const handle = list.current;
		if (handle === null || entries.length <= 1) return;
		handle.scrollToIndex(entries.length - 1, { align: "end" });
	}, [entries.length]);

	useLayoutEffect(() => {
		const initial =
			(first.current === undefined ||
				first.current === "end" ||
				first.current === "working" ||
				first.current === "activity") &&
			rows.length > 0;
		first.current = firstKey;
		count.current = entries.length;
		if (initial || (following.current && !prepended)) toBottom();
	});

	// A linked turn: once its item is loaded, the list lands on it, stops following and highlights it. This runs after
	// the effect above, so a transcript opened at a turn lands there rather than at its end.
	const landed = useRef<string | undefined>(undefined);
	const [highlight, setHighlight] = useState<{ readonly row: string; readonly item: string }>();
	useLayoutEffect(() => {
		if (turn === undefined || turn === "") {
			landed.current = undefined;
			return;
		}
		if (landed.current === turn) return;
		const found = rowOfTurn(rows, turn);
		const handle = list.current;
		if (found === undefined || handle === null) return;
		const index = entries.indexOf(found.row);
		if (index < 0) return;
		landed.current = turn;
		following.current = false;
		setShowEnd(true);
		handle.scrollToIndex(index, { align: "center" });
		setHighlight({ row: found.row.id, item: found.item.id });
	});
	useEffect(() => {
		if (highlight === undefined) return;
		const timer = setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
		return () => clearTimeout(timer);
	}, [highlight]);
	// The browser an audit link names: scroll to the row holding its view, once, after the jump to the end above.
	const focused = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (focusBrowser === undefined || focused.current === focusBrowser) return;
		let rowId: string | undefined;
		for (const [id, held] of slots) {
			if (held.some((slot) => slot.browserSessionId === focusBrowser)) rowId = id;
		}
		if (rowId === undefined) return;
		const index = entries.findIndex((entry) => entryKey(entry) === rowId);
		if (index === -1 || list.current === null) return;
		focused.current = focusBrowser;
		following.current = false;
		setShowEnd(true);
		list.current.scrollToIndex(index, { align: "center" });
	}, [focusBrowser, slots, entries]);

	// While following, keep the bottom in view as the last row grows (a streamed answer, a tool's output) and as the
	// viewport itself changes size (a phone's keyboard opening, a window resized).
	useEffect(() => {
		if (!showList) return;
		const viewport = frame.current?.firstElementChild;
		const content = viewport?.firstElementChild;
		if (!(viewport instanceof HTMLElement) || !(content instanceof HTMLElement)) return;
		const observer = new ResizeObserver(() => {
			if (following.current) viewport.scrollTop = viewport.scrollHeight;
		});
		observer.observe(content);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [showList]);

	// Following stops only when the reader moves up (the offset falls while away from the bottom), never because rows
	// were measured taller after a jump to the end: that scroll event is not the reader's, and the observer above
	// brings the end back into view. Reaching the bottom by any means starts following again.
	const lastOffset = useRef(0);
	const onScroll = useCallback(
		(offset: number) => {
			const handle = list.current;
			if (handle === null) return;
			const distance = handle.scrollSize - (offset + handle.viewportSize);
			const atBottom = distance <= AT_BOTTOM_PX;
			if (atBottom) {
				following.current = true;
				setResting(false);
			} else if (offset < lastOffset.current) following.current = false;
			lastOffset.current = offset;
			setShowEnd(!following.current);
			// After a failed page only "Try again" asks again, or every scroll event would.
			if (offset < LOAD_OLDER_PX && hasOlder && !loadingOlder && !olderError) onLoadOlder?.();
		},
		[hasOlder, loadingOlder, olderError, onLoadOlder],
	);

	const scrollToEnd = useCallback(() => {
		following.current = true;
		setShowEnd(false);
		setResting(false);
		toBottom();
	}, [toBottom]);

	// The dock. Its height becomes the room at the list's end, measured as it changes. While the composer rests the
	// room stays as it was, so folding it doesn't move what the reader is looking at (T3 Code keeps the expanded
	// inset too, MessagesTimeline.tsx).
	const docked = dock !== undefined && dock !== null && dock !== false;
	const root = useRef<HTMLDivElement>(null);
	const dockElement = useRef<HTMLDivElement>(null);
	const restingRef = useRef(resting);
	restingRef.current = resting;
	const inset = useRef(0);
	useLayoutEffect(() => {
		const element = dockElement.current;
		const host = root.current;
		if (!docked || element === null || host === null) return;
		const apply = (height: number) => {
			const next = restingRef.current ? Math.max(height, inset.current) : height;
			if (next === inset.current) return;
			inset.current = next;
			host.style.setProperty("--hb-transcript-dock-height", `${next}px`);
		};
		apply(Math.ceil(element.getBoundingClientRect().height));
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => apply(Math.ceil(element.getBoundingClientRect().height)));
		observer.observe(element);
		return () => observer.disconnect();
	}, [docked]);

	// Resting: a wheel gesture of 24px or more, a Page Up or Home, or a finger dragging the list, while it can scroll
	// that way (T3 Code's composerScrollGesture.ts). Scrolling down at the end never rests it; reaching the end wakes it.
	useEffect(() => {
		if (!docked || !showList) return;
		const viewport = frame.current?.firstElementChild;
		if (!(viewport instanceof HTMLElement)) return;
		const gesture = restGesture();
		const position = () => ({
			top: viewport.scrollTop,
			height: viewport.scrollHeight,
			client: viewport.clientHeight,
		});
		const record = (now: number, deltaY: number, pixels: number) => {
			const scroll = position();
			const atEnd = atScrollEnd(scroll);
			const up = deltaY < 0;
			const rests = recordRestGesture(gesture, {
				now,
				pixels,
				canScroll: up ? scroll.top > 0 : !atEnd,
				downAtEnd: !up && atEnd,
			});
			if (!rests) return;
			// The reader is leaving the end: stop following now, before the scroll event says so, or the re-render
			// that rests the composer would pin the list back to its end.
			if (up) following.current = false;
			setResting(true);
		};
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.deltaY === 0) return;
			record(event.timeStamp, event.deltaY, wheelPixels(event.deltaY, event.deltaMode, viewport.clientHeight));
		};
		const onKey = (event: KeyboardEvent) => {
			if (!restsForKey(event.key, position())) return;
			if (event.key === "PageUp" || event.key === "Home") following.current = false;
			setResting(true);
		};
		let lastY: number | undefined;
		const onTouchStart = (event: TouchEvent) => {
			lastY = event.touches[0]?.clientY;
		};
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			if (y === undefined || lastY === undefined) return;
			// A finger moving down scrolls the list up.
			const deltaY = lastY - y;
			lastY = y;
			if (deltaY !== 0) record(event.timeStamp, deltaY, Math.abs(deltaY));
		};
		viewport.addEventListener("wheel", onWheel, { passive: true });
		viewport.addEventListener("keydown", onKey);
		viewport.addEventListener("touchstart", onTouchStart, { passive: true });
		viewport.addEventListener("touchmove", onTouchMove, { passive: true });
		return () => {
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("keydown", onKey);
			viewport.removeEventListener("touchstart", onTouchStart);
			viewport.removeEventListener("touchmove", onTouchMove);
		};
	}, [docked, showList]);

	// Files dragged anywhere over a docked transcript go to the composer, while it takes files.
	const dropTarget = useRef<DropTarget | null>(null);
	const [dropHint, setDropHint] = useState<string | undefined>(undefined);
	const [dragDepth, setDragDepth] = useState(0);
	const dragging = dragDepth > 0 && dropHint !== undefined;
	const wake = useCallback(() => setResting(false), []);
	const acceptDrops = useCallback((handler: FileDropHandler, hint: string) => {
		const target = { handler, hint };
		dropTarget.current = target;
		setDropHint(hint);
		return () => {
			if (dropTarget.current !== target) return;
			dropTarget.current = null;
			setDropHint(undefined);
			setDragDepth(0);
		};
	}, []);
	const dockContext = useMemo<ComposerDock>(
		() => ({ resting, wake, dragging, acceptDrops }),
		[resting, wake, dragging, acceptDrops],
	);
	// Attached whenever docked and checked per event, so a drag that starts the moment the composer registers counts.
	const takesDrop = (event: DragEvent) => dropTarget.current !== null && hasFiles(event);
	const dragHandlers = docked
		? {
				onDragEnter: (event: DragEvent<HTMLDivElement>) => {
					if (!takesDrop(event)) return;
					event.preventDefault();
					setDragDepth((depth) => depth + 1);
				},
				onDragOver: (event: DragEvent<HTMLDivElement>) => {
					if (!takesDrop(event)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				},
				onDragLeave: (event: DragEvent<HTMLDivElement>) => {
					if (!hasFiles(event)) return;
					setDragDepth((depth) => Math.max(0, depth - 1));
				},
				onDrop: (event: DragEvent<HTMLDivElement>) => {
					if (!takesDrop(event)) return;
					event.preventDefault();
					setDragDepth(0);
					dropTarget.current?.handler([...event.dataTransfer.files]);
				},
			}
		: {};

	let body: ReactNode;
	if (showList) {
		body = (
			<section className="hb-transcript-frame" aria-label="Transcript" ref={frame}>
				<VList<Entry>
					ref={list}
					data={entries}
					shift={prepended}
					onScroll={onScroll}
					className="hb-transcript-list hb-focusable"
					tabIndex={0}
					bufferSize={BUFFER_PX}
				>
					{(entry, index) =>
						"end" in entry ? (
							<div key="end" className="hb-transcript-end" aria-hidden="true" />
						) : "working" in entry ? (
							<div key="working" className="hb-transcript-row hb-transcript-row-working">
								<div className="hb-transcript-column">
									<WorkingIndicator
										since={workingSince}
										{...(workingLabel === undefined ? {} : { label: workingLabel })}
									/>
								</div>
							</div>
						) : "activity" in entry ? (
							<div key="activity" className="hb-transcript-row hb-transcript-row-activity">
								<div className="hb-transcript-column">
									<LiveActivity />
								</div>
							</div>
						) : "start" in entry ? (
							<div key="start" className="hb-transcript-start">
								<div className="hb-transcript-column hb-transcript-start-rule">Start of the session</div>
							</div>
						) : (
							<Row
								key={entry.id}
								row={entry}
								first={index === 0 && !hasOlder}
								turnStart={index > (atStart ? 1 : 0) && entry.kind === "item" && entry.item.kind === "user"}
								finalAnswer={finalAnswers.has(entry.id)}
								renderCard={renderCard}
								browserSlots={slots.get(entry.id)}
								renderBrowserView={renderBrowserView}
								report={report}
								highlight={highlight?.row === entry.id ? highlight.item : undefined}
							/>
						)
					}
				</VList>
				{loadingOlder ? (
					<div className="hb-transcript-older" role="status">
						<Spinner size="sm" />
						Loading earlier messages
					</div>
				) : olderError && hasOlder ? (
					<div className="hb-transcript-older hb-transcript-older-error" role="alert">
						<span className="hb-transcript-older-text">{olderError}</span>
						{onLoadOlder === undefined ? null : (
							<Button variant="ghost" size="sm" onClick={onLoadOlder}>
								Try again
							</Button>
						)}
					</div>
				) : null}
				{showEnd ? (
					<Button
						className="hb-transcript-scroll-end"
						variant="secondary"
						icon={<ChevronDownIcon size="sm" />}
						onClick={scrollToEnd}
					>
						Scroll to end
					</Button>
				) : null}
			</section>
		);
	} else if (loading) {
		body = <LoadingRows />;
	} else {
		body = (
			<div className="hb-transcript-empty">
				{empty ?? <EmptyState title="No messages yet">Send a message to start the session.</EmptyState>}
			</div>
		);
	}

	return (
		// A file drop here is a pointer-only shortcut; the composer's paperclip is the keyboard's way.
		<div
			ref={root}
			className={`hb-transcript${docked ? " hb-transcript-docked" : ""}${className ? ` ${className}` : ""}`}
			{...dragHandlers}
		>
			{error ? (
				<div className="hb-transcript-error">
					<div className="hb-transcript-column">
						<Notice level="error">{error}</Notice>
					</div>
				</div>
			) : null}
			<MessageActionsContext.Provider value={actionHandlers}>{body}</MessageActionsContext.Provider>
			{docked ? (
				<ComposerDockContext.Provider value={dockContext}>
					<div className="hb-transcript-dock" ref={dockElement}>
						<div className="hb-transcript-dock-lane">{dock}</div>
					</div>
				</ComposerDockContext.Provider>
			) : null}
			{dragging ? (
				<div className="hb-transcript-drop" aria-hidden="true">
					<span className="hb-transcript-drop-label">Drop files to attach</span>
					{dropHint ? <span className="hb-transcript-drop-limits">{dropHint}</span> : null}
				</div>
			) : null}
		</div>
	);
}
