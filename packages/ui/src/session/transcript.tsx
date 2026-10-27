import type { Card, CardItem, TranscriptItem } from "@harbour/protocol";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { Button } from "../primitives/button.tsx";
import { ChevronDownIcon } from "../primitives/icons.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { BrowserGrantCard } from "./browser-grant-card.tsx";
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
	renderCard: ((item: CardItem) => ReactNode) | undefined;
	report: (id: string, phase: RowRenderPhase) => void;
};

/** Whether a row rendered for the first time (it scrolled into view, or arrived) or again. */
export type RowRenderPhase = "mount" | "update";

function rowBody(row: TranscriptRow, renderCard: RowProps["renderCard"]): ReactNode {
	if (row.kind === "tools") return <ToolCallGroup items={row.items} live={row.live} />;
	const { item } = row;
	switch (item.kind) {
		case "user":
			return <UserMessage item={item} />;
		case "assistant":
			return <AssistantMessage item={item} />;
		case "notice":
			return <NoticeRow item={item} />;
		case "card":
			return renderCard === undefined ? <ReadOnlyCard card={item.card} /> : renderCard(item);
	}
}

// Memoised on the row object, which groupTranscript keeps while the row's items are unchanged: while an answer
// streams, every earlier row gets the same props and React skips it.
const Row = memo(function Row({ row, first, turnStart, renderCard, report }: RowProps) {
	const mounted = useRef(false);
	report(row.id, mounted.current ? "update" : "mount");
	useEffect(() => {
		mounted.current = true;
	}, []);
	const kind = row.kind === "tools" ? "tools" : row.item.kind;
	return (
		<div
			className={`hb-transcript-row hb-transcript-row-${kind}${first ? " hb-transcript-row-first" : ""}${turnStart ? " hb-transcript-turn" : ""}`}
			data-row={row.id}
		>
			<div className="hb-transcript-column">{rowBody(row, renderCard)}</div>
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
	className?: string;
};

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

	// The render hook lives in a ref, so a new callback from the host never re-renders the rows.
	const onRowRenderRef = useRef(onRowRender);
	onRowRenderRef.current = onRowRender;
	const report = useCallback((id: string, phase: RowRenderPhase) => onRowRenderRef.current?.(id, phase), []);

	const list = useRef<VListHandle>(null);
	const frame = useRef<HTMLElement>(null);
	const following = useRef(true);
	const [showEnd, setShowEnd] = useState(false);
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
			if (atBottom) following.current = true;
			else if (offset < lastOffset.current) following.current = false;
			lastOffset.current = offset;
			setShowEnd(!following.current);
			if (offset < LOAD_OLDER_PX && hasOlder && !loadingOlder) onLoadOlder?.();
		},
		[hasOlder, loadingOlder, onLoadOlder],
	);

	const scrollToEnd = useCallback(() => {
		following.current = true;
		setShowEnd(false);
		toBottom();
	}, [toBottom]);

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
		<div className={`hb-transcript${className ? ` ${className}` : ""}`}>
			{error ? (
				<div className="hb-transcript-error">
					<div className="hb-transcript-column">
						<Notice level="error">{error}</Notice>
					</div>
				</div>
			) : null}
			{body}
		</div>
	);
}
