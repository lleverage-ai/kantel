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
import { QuestionCard } from "./question-card.tsx";
import { ToolCallGroup } from "./tool-call.tsx";
import { groupTranscript, type TranscriptRow } from "./transcript-model.ts";
import { VaultApprovalCard } from "./vault-approval-card.tsx";
import "./transcript.css";

// The virtualised transcript. Only the rows near the viewport are mounted, whatever the session's length. It follows
// new output only while the reader is at the bottom (T3 Code's useTimelineFollow.ts:162-196): scrolling up stops
// following, and returning to the bottom, or the "Scroll to end" button, starts it again. Near the top it asks for
// the previous history page, and keeps the reader's place when that page is put in front.

/** How close to the bottom still counts as at the bottom, in CSS pixels. */
const AT_BOTTOM_PX = 48;
/** How close to the top asks for the previous page. */
const LOAD_OLDER_PX = 600;
/** How far beyond the viewport rows stay mounted. */
const BUFFER_PX = 600;

// A fixed spacer always sits after the last row, so the bottom padding never belongs to a real row: if it did, the
// row that was last would render again, to lose it, every time an item arrived.
const END = { end: true } as const;
type Entry = TranscriptRow | typeof END;

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
	/** For an answer that is streaming: when its turn started, for the working row's timer. */
	turnStartedAt: number | undefined;
	renderCard: ((item: CardItem) => ReactNode) | undefined;
	report: (id: string, phase: RowRenderPhase) => void;
};

/** Whether a row rendered for the first time (it scrolled into view, or arrived) or again. */
export type RowRenderPhase = "mount" | "update";

function rowBody(row: TranscriptRow, turnStartedAt: number | undefined, renderCard: RowProps["renderCard"]): ReactNode {
	if (row.kind === "tools") return <ToolCallGroup items={row.items} live={row.live} />;
	const { item } = row;
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} />;
		case "assistant":
			return <AssistantMessage item={item} turnStartedAt={turnStartedAt} />;
		case "notice":
			return <NoticeRow item={item} />;
		case "card":
			return renderCard === undefined ? <ReadOnlyCard card={item.card} /> : renderCard(item);
	}
}

// Memoised on the row object, which groupTranscript keeps while the row's items are unchanged: while an answer
// streams, every earlier row gets the same props and React skips it.
const Row = memo(function Row({ row, first, turnStart, turnStartedAt, renderCard, report }: RowProps) {
	const mounted = useRef(false);
	report(row.id, mounted.current ? "update" : "mount");
	useRenderProbe("TranscriptRow", row.id);
	useEffect(() => {
		mounted.current = true;
	}, []);
	const kind = row.kind === "tools" ? "tools" : row.item.kind;
	return (
		<div
			className={`hb-transcript-row hb-transcript-row-${kind}${first ? " hb-transcript-row-first" : ""}${turnStart ? " hb-transcript-turn" : ""}`}
			data-row={row.id}
		>
			<div className="hb-transcript-column">{rowBody(row, turnStartedAt, renderCard)}</div>
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
	 * Renders a card item (an approval, a question), with the host's handlers. Keep it stable: every row re-renders
	 * when it changes. Without it cards show read-only, from the same components.
	 */
	renderCard?: (item: CardItem) => ReactNode;
	/** The first page is loading: shows skeleton rows while there are no items. */
	loading?: boolean;
	/** What an empty transcript says. Defaults to "No messages yet". */
	empty?: ReactNode;
	/** An error shown above the list, in an error notice. */
	error?: ReactNode;
	/**
	 * Called while a row renders, with its id and whether it is mounting or rendering again: the console's profiler
	 * and the design loop's wasted-render count. Never causes a render.
	 */
	onRowRender?: (id: string, phase: RowRenderPhase) => void;
	/**
	 * Docked over the transcript's foot, usually a Composer, as T3 Code's thread: the list scrolls under it and its
	 * end makes room for it. A Composer here rests (folds to one line) while the reader scrolls back, comes back at
	 * the end, and takes files dropped anywhere on the transcript.
	 */
	dock?: ReactNode;
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
	renderCard,
	loading = false,
	empty,
	error,
	onRowRender,
	dock,
	className,
}: TranscriptProps) {
	// Rows keep their identity across renders wherever their items are unchanged.
	const previousRows = useRef<readonly TranscriptRow[] | undefined>(undefined);
	const rows = useMemo(() => {
		const next = groupTranscript(items, previousRows.current);
		previousRows.current = next;
		return next;
	}, [items]);
	const entries = useMemo<Entry[]>(() => [...rows, END], [rows]);

	// When each streaming answer's turn started, by row id: the time of the last message the person sent before it,
	// other than a steer (a steer joins the turn under way). The working row times the turn from it. A number, so the
	// streaming row's props stay equal as its text grows. An answer whose prompt is in an unloaded page has none.
	const turnStarts = useMemo(() => {
		const starts = new Map<string, number>();
		let start: number | undefined;
		for (const row of rows) {
			if (row.kind !== "item") continue;
			const { item } = row;
			if (item.kind === "user" && item.via !== "steer") start = item.at;
			else if (item.kind === "assistant" && item.streaming && start !== undefined) starts.set(row.id, start);
		}
		return starts;
	}, [rows]);

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
	const showList = rows.length > 0;

	// Prepending older items: tell the virtualiser to keep the visible content still (virtua's `shift`).
	const firstId = items[0]?.id;
	const prepended = first.current !== undefined && firstId !== first.current && items.length > count.current;

	const toBottom = useCallback(() => {
		const handle = list.current;
		if (handle === null || rows.length === 0) return;
		handle.scrollToIndex(rows.length, { align: "end" });
	}, [rows.length]);

	useLayoutEffect(() => {
		const initial = first.current === undefined && items.length > 0;
		first.current = firstId;
		count.current = items.length;
		if (initial || (following.current && !prepended)) toBottom();
	});

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
			if (offset < LOAD_OLDER_PX && hasOlder && !loadingOlder) onLoadOlder?.();
		},
		[hasOlder, loadingOlder, onLoadOlder],
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
						) : (
							<Row
								key={entry.id}
								row={entry}
								first={index === 0 && !hasOlder}
								turnStart={index > 0 && entry.kind === "item" && entry.item.kind === "user"}
								turnStartedAt={turnStarts.get(entry.id)}
								renderCard={renderCard}
								report={report}
							/>
						)
					}
				</VList>
				{loadingOlder ? (
					<div className="hb-transcript-older" role="status">
						<Spinner size="sm" />
						Loading earlier messages
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
			{body}
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
