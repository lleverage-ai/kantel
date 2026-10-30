import type { Card, CardItem, PresentedFile, ToolItem, TranscriptItem } from "@harbour/protocol";
import {
	type DragEvent,
	Fragment,
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
import { PresentedFiles } from "../presented/presented-file-card.tsx";
import { presentedKey } from "../presented/presented-file-model.ts";
import { Button } from "../primitives/button.tsx";
import { ChevronDownIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import type { BrowserEntryState } from "./browser-entry.tsx";
import { BrowserGrantCard } from "./browser-grant-card.tsx";
import { BrowsingGroup, browsingBrowser } from "./browsing-group.tsx";
import { type ComposerDock, ComposerDockContext, type FileDropHandler } from "./composer-dock.ts";
import { atScrollEnd, recordRestGesture, restGesture, restsForKey, wheelPixels } from "./composer-model.ts";
import { AssistantMessage, NoticeRow, UserMessage } from "./message.tsx";
import { type MessageActionHandlers, MessageActionsContext } from "./message-actions.tsx";
import { QuestionCard } from "./question-card.tsx";
import { SubagentCard } from "./subagent-card.tsx";
import { subagentOf } from "./subagent-model.ts";
import { ToolCallGroup } from "./tool-call.tsx";
import {
	FOLLOWING,
	type Follow,
	type FollowEvent,
	isAtEnd,
	type Navigation,
	nextFollow,
	releases,
	scrollKey,
	upwardScrollDetector,
} from "./transcript-follow.ts";
import {
	activeBrowsingRow,
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
// new output only while the reader is at the end, as T3 Code's thread does (transcript-follow.ts has the rules):
// the reader's own input up lets go at once, content changing height never does, and coming back to the end, or the
// "Scroll to end" button, follows again. Following pins the list to its end directly, never through the virtualiser's
// scrollToIndex, which keeps scrolling to its target each time a row is measured and so, while an answer streams,
// would take the reader back to the end after they had scrolled away. Near the top it asks for the previous history
// page, and keeps the reader's place when that page is put in front. Once there is nothing older, a paged transcript
// starts with a quiet "Start of the session" divider, so the reader knows they have it all.

/** How close to the top asks for the previous page. */
const LOAD_OLDER_PX = 600;
/** How far beyond the viewport rows stay mounted. */
const BUFFER_PX = 600;
/** How long a linked turn stays highlighted once the list has landed on it (ms); its fade is the CSS's. */
const HIGHLIGHT_MS = 2400;
/** The most frames a landing on a linked turn keeps correcting itself while the rows around it are measured. */
const LANDING_FRAMES = 60;

/**
 * Whether a wheel over `target` scrolls something inside the list rather than the list: a code block or a tool's
 * output that can still scroll that way, or one that keeps its scrolling to itself (T3 Code's timelineScrollTarget.ts).
 */
function innerScrollerTakes(target: EventTarget | null, list: HTMLElement, deltaY: number): boolean {
	for (
		let element = target instanceof Element ? target : null;
		element && element !== list;
		element = element.parentElement
	) {
		const style = getComputedStyle(element);
		if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
		const canScroll =
			deltaY < 0 ? element.scrollTop > 0 : element.scrollTop < element.scrollHeight - element.clientHeight;
		if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return true;
	}
	return false;
}

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
	renderSubagent: ((item: ToolItem) => ReactNode) | undefined;
	/** The browsers whose live view goes in this row, under their newest call. */
	browserSlots: readonly BrowserViewSlot[] | undefined;
	renderBrowserView: ((slot: BrowserViewSlot) => ReactNode) | undefined;
	onShowBrowser: ((browserSessionId: string) => void) | undefined;
	/** The browser the host's panel shows; given to browsing rows only, so other rows never re-render for it. */
	shownBrowser: string | undefined;
	/** Where a browsing row's browser is, as the host knows; given to browsing rows only. */
	browserState: BrowserEntryState | undefined;
	/** A browsing row that may still take steps: its turn is working and only the agent's words follow it. */
	browsingActive: boolean;
	report: (id: string, phase: RowRenderPhase) => void;
	/** The linked turn is in this row: the row is highlighted, and a tool call in it opens its group and stands out. */
	highlight: string | undefined;
	/** Opens a presented file's viewer; without it the cards only show what the files are. */
	onOpenFile: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key of the file open in the viewer, when it is one this row presented. */
	openFile: string | undefined;
};

/** Whether a row of tool calls presented the file with this key. */
function presents(row: TranscriptRow, key: string): boolean {
	return row.kind === "tools" && row.items.some((item) => item.files?.some((file) => presentedKey(file) === key));
}

/** A subagent's card with nothing to open: what the call says, from the call alone. */
function ReadOnlySubagent({ item }: { item: ToolItem }) {
	return (
		<SubagentCard
			{...subagentOf(item)}
			status={item.status}
			startedAt={item.at}
			{...(item.endedAt === undefined ? {} : { endedAt: item.endedAt })}
		/>
	);
}

/** Where a browsing row's browser is, from the host's states: `undefined` for other rows and unknown browsers. */
function rowBrowserState(
	row: TranscriptRow,
	states: ReadonlyMap<string, BrowserEntryState> | undefined,
): BrowserEntryState | undefined {
	if (states === undefined || row.kind !== "browsing") return undefined;
	const browser = browsingBrowser(row.items.filter((step): step is ToolItem => step.kind === "tool"));
	return browser === undefined ? undefined : states.get(browser);
}

/** Whether a row rendered for the first time (it scrolled into view, or arrived) or again. */
export type RowRenderPhase = "mount" | "update";

function rowBody(
	row: TranscriptRow,
	finalAnswer: boolean,
	renderCard: RowProps["renderCard"],
	renderSubagent: RowProps["renderSubagent"],
	browserSlots: RowProps["browserSlots"],
	renderBrowserView: RowProps["renderBrowserView"],
	onShowBrowser: RowProps["onShowBrowser"],
	shownBrowser: RowProps["shownBrowser"],
	browserState: RowProps["browserState"],
	browsingActive: RowProps["browsingActive"],
	highlight: RowProps["highlight"],
	onOpenFile: RowProps["onOpenFile"],
	openFile: RowProps["openFile"],
): ReactNode {
	if (row.kind === "subagent") {
		return renderSubagent === undefined ? <ReadOnlySubagent item={row.item} /> : renderSubagent(row.item);
	}
	if (row.kind === "browsing") {
		const views =
			browserSlots === undefined || renderBrowserView === undefined
				? undefined
				: browserSlots.map((slot) => <Fragment key={slot.browserSessionId}>{renderBrowserView(slot)}</Fragment>);
		return (
			<BrowsingGroup
				items={row.items}
				{...(views === undefined ? {} : { browserView: views })}
				{...(onShowBrowser === undefined ? {} : { onShowBrowser })}
				{...(shownBrowser === undefined ? {} : { shownBrowser })}
				{...(browserState === undefined ? {} : { browserState })}
				{...(highlight === undefined ? {} : { focus: highlight })}
				active={browsingActive}
			/>
		);
	}
	if (row.kind === "tools") {
		const views =
			browserSlots === undefined || renderBrowserView === undefined
				? undefined
				: new Map(browserSlots.map((slot) => [slot.item.id, renderBrowserView(slot)] as const));
		// The files the calls presented stay in view under the group, folded or not.
		const presenting = row.items.filter((item) => item.status === "done" && (item.files?.length ?? 0) > 0);
		return (
			<>
				<ToolCallGroup
					items={row.items}
					live={row.live}
					{...(views === undefined ? {} : { browserViews: views })}
					{...(highlight === undefined ? {} : { focus: highlight })}
				/>
				{presenting.map((item) => (
					<PresentedFiles key={item.id} item={item} onOpen={onOpenFile} openKey={openFile} />
				))}
			</>
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
	renderSubagent,
	browserSlots,
	renderBrowserView,
	onShowBrowser,
	shownBrowser,
	browserState,
	browsingActive,
	report,
	highlight,
	onOpenFile,
	openFile,
}: RowProps) {
	const mounted = useRef(false);
	report(row.id, mounted.current ? "update" : "mount");
	useRenderProbe("TranscriptRow", row.id);
	useEffect(() => {
		mounted.current = true;
	}, []);
	const kind = row.kind === "item" ? row.item.kind : row.kind;
	return (
		<div
			className={`hb-transcript-row hb-transcript-row-${kind}${first ? " hb-transcript-row-first" : ""}${turnStart ? " hb-transcript-turn" : ""}${highlight === undefined ? "" : " hb-transcript-row-linked"}`}
			id={turnAnchor(row.id)}
			data-row={row.id}
		>
			<div className="hb-transcript-column">
				{rowBody(
					row,
					finalAnswer,
					renderCard,
					renderSubagent,
					browserSlots,
					renderBrowserView,
					onShowBrowser,
					shownBrowser,
					browserState,
					browsingActive,
					highlight,
					onOpenFile,
					openFile,
				)}
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
	 * Renders a subagent's call (the `subagent` tool), usually a `SubagentCard` that links to the subagent's session.
	 * Keep it stable: every subagent's row re-renders when it changes. Without it the card shows what the call says,
	 * with nothing to open.
	 */
	renderSubagent?: (item: ToolItem) => ReactNode;
	/**
	 * Renders a browser's live view (usually a `BrowserLiveView` with the host's link) in the transcript, under the
	 * browsing run that used the browser last. Keep it stable: every row with a browser re-renders when it changes. A
	 * host that shows the browser in a panel of its own leaves it out and passes `onShowBrowser`; without either, a
	 * browsing run is its one line, with each step's screenshots in the step's detail.
	 */
	renderBrowserView?: (slot: BrowserViewSlot) => ReactNode;
	/** Shows a browser in the host's panel: a browsing run's "Show browser" calls it with the browser the run used. */
	onShowBrowser?: (browserSessionId: string) => void;
	/** The browser the host's panel shows now: a browsing run on it says it is showing. */
	shownBrowser?: string;
	/**
	 * Where each browser is, by its id, as the host knows (live, or closed with a replay): what a browsing run's card
	 * says and offers. Browsers not in it go by their calls.
	 */
	browserStates?: ReadonlyMap<string, BrowserEntryState>;
	/**
	 * A browser session to show (an audit link's `#browser=<id>`): once its view is in the loaded transcript, the list
	 * scrolls to it, once per ID, and stops following the end.
	 */
	focusBrowser?: string;
	/**
	 * Opens a file a call presented (`present_files`) in the host's viewer, from its card under the call's group. Keep it
	 * stable: every row with a presented file re-renders when it changes. Without it the cards show read-only.
	 */
	onOpenFile?: (file: PresentedFile, item: ToolItem) => void;
	/** The key (`presentedKey`) of the presented file open in the host's viewer: its card shows it is open. */
	openFile?: string;
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
	renderSubagent,
	renderBrowserView,
	onShowBrowser,
	shownBrowser,
	browserStates,
	focusBrowser,
	onOpenFile,
	openFile,
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
	const activeBrowsing = useMemo(() => (showWorking ? activeBrowsingRow(rows) : undefined), [rows, showWorking]);
	const { headerAfter, activity } = placement;
	const entries = useMemo<Entry[]>(() => {
		const head: Entry[] = atStart ? [START] : [];
		if (!showWorking) return [...head, ...rows, END];
		const foot: Entry[] = activity ? [ACTIVITY, END] : [END];
		// The header under the turn's message goes in that message's own entry (headerRow, below); with the message in an
		// older page, at the end, before the activity. Never an entry of its own in the middle: virtua keeps its sizes by
		// index, so taking one out when the turn settles would give every row after it its neighbour's size, and its
		// correction for that would throw a reader who had scrolled up back to the end.
		return headerAfter < 0 ? [...head, ...rows, WORKING, ...foot] : [...head, ...rows, ...foot];
	}, [rows, atStart, showWorking, headerAfter, activity]);
	const headerRow = showWorking && headerAfter >= 0 ? rows[headerAfter]?.id : undefined;

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
	// Following lives in a ref the list's listeners read as events arrive; a render reads only whether Scroll to end
	// shows, so scrolling re-renders nothing unless that changes.
	const follow = useRef<Follow>(FOLLOWING);
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

	const viewportOf = useCallback((): HTMLElement | null => {
		const viewport = frame.current?.firstElementChild;
		return viewport instanceof HTMLElement ? viewport : null;
	}, []);

	// The end, at once: one write of the list's own scroll offset, which the virtualiser takes as any scroll. Rows it
	// then measures change the content's height, and the observer below pins again while following.
	const pin = useCallback(() => {
		const viewport = viewportOf();
		if (viewport === null) return;
		const end = viewport.scrollHeight - viewport.clientHeight;
		if (viewport.scrollTop < end - 0.5) viewport.scrollTop = end;
	}, [viewportOf]);

	// Landing on a linked turn or a browser's view: the transcript's own scroll, which may go up, so the scroll events
	// it causes are held from being taken for the reader's while it lands. The reader's input stops it.
	const holds = useRef(0);
	const landing = useRef<(() => void) | undefined>(undefined);
	const stopLanding = useCallback(() => landing.current?.(), []);
	const land = useCallback(
		(index: number) => {
			stopLanding();
			holds.current += 1;
			let frameId = 0;
			let frames = 0;
			let still = 0;
			const stop = () => {
				cancelAnimationFrame(frameId);
				landing.current = undefined;
				// After the frame, so the scroll event of the last write is still held.
				requestAnimationFrame(() => {
					holds.current -= 1;
				});
			};
			landing.current = stop;
			// Rows around the turn are measured as they mount, which moves it, so the landing corrects itself until the
			// turn has stayed put for a few frames.
			const step = () => {
				const handle = list.current;
				const viewport = viewportOf();
				if (handle === null || viewport === null) return stop();
				const end = viewport.scrollHeight - viewport.clientHeight;
				const centre = handle.getItemOffset(index) + (handle.getItemSize(index) - viewport.clientHeight) / 2;
				const target = Math.max(0, Math.min(end, centre));
				if (Math.abs(viewport.scrollTop - target) > 1) {
					viewport.scrollTop = target;
					still = 0;
				} else still += 1;
				frames += 1;
				if (still >= 3 || frames >= LANDING_FRAMES) return stop();
				frameId = requestAnimationFrame(step);
			};
			step();
		},
		[stopLanding, viewportOf],
	);
	useEffect(() => stopLanding, [stopLanding]);

	// One change of following, from the list's events or the transcript's own moves. Coming back to following pins the
	// list to its very end.
	const moveFollow = useCallback(
		(event: FollowEvent) => {
			const before = follow.current;
			const after = nextFollow(before, event);
			if (after === before) return;
			follow.current = after;
			setShowEnd(after.mode === "released" && !after.atEnd);
			if (after.mode === "following") {
				setResting(false);
				pin();
			}
		},
		[pin],
	);

	useLayoutEffect(() => {
		const initial =
			(first.current === undefined ||
				first.current === "end" ||
				first.current === "working" ||
				first.current === "activity") &&
			rows.length > 0;
		first.current = firstKey;
		count.current = entries.length;
		// Opening a quiet session, the virtualiser lands on the last row itself, settling a few frames sooner than a raw
		// write it takes for the reader's scroll. Only then: its scroll stays under way until rows stop being measured
		// for 150 ms, which a running turn never lets happen, and it can't be cancelled.
		if (initial && !showWorking && entries.length > 1)
			list.current?.scrollToIndex(entries.length - 1, { align: "end" });
		else if (initial || (follow.current.mode === "following" && !prepended)) pin();
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
		moveFollow({ type: "jumped" });
		land(index);
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
		moveFollow({ type: "jumped" });
		land(index);
	}, [focusBrowser, slots, entries, moveFollow, land]);

	// The list's events. The reader's input that can take the list from its end lets go of it (transcript-follow.ts);
	// a scroll then says whether the list is in the end band, which follows again once the reader has left it and come
	// back. While following, the observer keeps the end in view as the content grows (a streamed answer, thinking, a
	// tool's output, a card, the working row) and as the viewport changes size (a phone's keyboard, a window resized);
	// while not, a change of height only says whether the list is still at its end, and never moves it.
	useEffect(() => {
		if (!showList) return;
		const viewport = viewportOf();
		const content = viewport?.firstElementChild;
		if (viewport === null || !(content instanceof HTMLElement)) return;
		const metrics = () => ({ top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight });
		const band = () => moveFollow({ type: isAtEnd(metrics()) ? "reachedEnd" : "leftEnd" });
		const navigate = (navigation: Navigation) => {
			if (!releases(navigation, metrics())) return;
			stopLanding();
			moveFollow({ type: "navigated" });
		};
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.deltaY === 0 || innerScrollerTakes(event.target, viewport, event.deltaY)) return;
			navigate({ source: "wheel", up: event.deltaY < 0 });
		};
		const onKey = (event: KeyboardEvent) => {
			const key = scrollKey(event.key);
			if (key === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.isComposing) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("input, textarea, select, [contenteditable]")) return;
			navigate({ source: "key", up: key.up });
		};
		const onPointer = (event: PointerEvent) => navigate({ source: "pointer", onScrollbar: event.target === viewport });
		const onTouch = () => navigate({ source: "touch" });
		const scrolledUp = upwardScrollDetector({ top: viewport.scrollTop, height: viewport.scrollHeight });
		const onScroll = () => {
			const scroll = metrics();
			// An upward scroll with no input seen (an embedded frame's scroll chaining out) is the reader's too.
			if (scrolledUp({ ...scroll, programmatic: holds.current > 0 }) && !isAtEnd(scroll)) {
				navigate({ source: "scroll" });
			}
			band();
			if (isAtEnd(scroll)) setResting(false);
		};
		const resized = () => {
			if (follow.current.mode === "following") pin();
			else band();
		};
		const observer = new ResizeObserver(resized);
		// virtua measures its rows in its own ResizeObserver and grows its content at once, inside that callback. A
		// ResizeObserver only hears of an element shallower than the ones it has just reported in the next frame, so the
		// end would show a streamed batch's last lines missing for a frame. The content's style changing (its height,
		// written by virtua) is heard before that frame is painted.
		const restyled = new MutationObserver(resized);
		viewport.addEventListener("wheel", onWheel, { passive: true });
		viewport.addEventListener("keydown", onKey);
		viewport.addEventListener("pointerdown", onPointer, { passive: true });
		viewport.addEventListener("touchmove", onTouch, { passive: true });
		viewport.addEventListener("scroll", onScroll, { passive: true });
		observer.observe(content);
		observer.observe(viewport);
		restyled.observe(content, { attributes: true, attributeFilter: ["style"] });
		return () => {
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("keydown", onKey);
			viewport.removeEventListener("pointerdown", onPointer);
			viewport.removeEventListener("touchmove", onTouch);
			viewport.removeEventListener("scroll", onScroll);
			observer.disconnect();
			restyled.disconnect();
		};
	}, [showList, viewportOf, moveFollow, pin, stopLanding]);

	// The virtualiser's offset, for paging only. After a failed page only "Try again" asks again, or every scroll
	// event would.
	const onScroll = useCallback(
		(offset: number) => {
			if (offset < LOAD_OLDER_PX && hasOlder && !loadingOlder && !olderError) onLoadOlder?.();
		},
		[hasOlder, loadingOlder, olderError, onLoadOlder],
	);

	const scrollToEnd = useCallback(() => {
		stopLanding();
		moveFollow({ type: "followEnd" });
		setResting(false);
		pin();
	}, [moveFollow, pin, stopLanding]);

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
	// that way (T3 Code's composerScrollGesture.ts). Scrolling down in the end band never rests it, so the composer
	// doesn't fold and unfold on every notch down to the end; reaching the end wakes it. Following is the list's events'
	// business above, not this.
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
				downAtEnd: !up && isAtEnd(scroll),
			});
			if (rests) setResting(true);
		};
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.deltaY === 0) return;
			record(event.timeStamp, event.deltaY, wheelPixels(event.deltaY, event.deltaMode, viewport.clientHeight));
		};
		const onKey = (event: KeyboardEvent) => {
			if (restsForKey(event.key, position())) setResting(true);
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

	const workingHeader = (
		<div className="hb-transcript-row hb-transcript-row-working">
			<div className="hb-transcript-column">
				<WorkingIndicator since={workingSince} {...(workingLabel === undefined ? {} : { label: workingLabel })} />
			</div>
		</div>
	);

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
							<Fragment key="working">{workingHeader}</Fragment>
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
							<Fragment key={entry.id}>
								<Row
									row={entry}
									first={index === 0 && !hasOlder}
									turnStart={index > (atStart ? 1 : 0) && entry.kind === "item" && entry.item.kind === "user"}
									finalAnswer={finalAnswers.has(entry.id)}
									renderCard={renderCard}
									renderSubagent={renderSubagent}
									browserSlots={slots.get(entry.id)}
									renderBrowserView={renderBrowserView}
									onShowBrowser={onShowBrowser}
									shownBrowser={entry.kind === "browsing" ? shownBrowser : undefined}
									browserState={rowBrowserState(entry, browserStates)}
									browsingActive={entry.id === activeBrowsing}
									report={report}
									highlight={highlight?.row === entry.id ? highlight.item : undefined}
									onOpenFile={onOpenFile}
									openFile={openFile !== undefined && presents(entry, openFile) ? openFile : undefined}
								/>
								{entry.id === headerRow ? workingHeader : null}
							</Fragment>
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
