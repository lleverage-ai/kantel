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
import {
	disclosureChevronClass,
	disclosureClass,
	disclosureSummaryClass,
	disclosureTextClass,
} from "../primitives/controls.tsx";
import { duration } from "../primitives/format.ts";
import { ChevronDownIcon, ChevronRightIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import type { BrowserEntryState } from "./browser-entry.tsx";
import { BrowserGrantCard } from "./browser-grant-card.tsx";
import { BrowsingGroup, browsingBrowser } from "./browsing-group.tsx";
import { type ComposerDock, ComposerDockContext, type FileDropHandler } from "./composer-dock.ts";
import { atScrollEnd, recordRestGesture, restGesture, restsForKey, wheelPixels } from "./composer-model.ts";
import { GeneratedImages, ImagePlaceholders, makingImages } from "./generated-image.tsx";
import { AssistantMessage, type MessageDelivery, NoticeRow, UserMessage } from "./message.tsx";
import { type MessageActionHandlers, MessageActionsContext } from "./message-actions.tsx";
import { QuestionCard } from "./question-card.tsx";
import { SubagentCard } from "./subagent-card.tsx";
import { subagentOf, subagentStatus } from "./subagent-model.ts";
import { imagesAsCards, StepFailed, ToolCallGroup } from "./tool-call.tsx";
import {
	type PreviewImage,
	type ToolInPlaceProps,
	type ToolRenderers,
	ToolRenderersContext,
} from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS, GenericToolCall } from "./tool-renderers.tsx";
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
	browserEntrySlots,
	browserViewSlots,
	closeRows,
	endsInWorkLine,
	finalAnswerIds,
	groupTranscript,
	messageKeys,
	repeatedImageFiles,
	rowOfTurn,
	type TranscriptRow,
	type TurnFold,
	turnAnchor,
	turnFolds,
	workingPlacement,
} from "./transcript-model.ts";
import { VaultApprovalCard } from "./vault-approval-card.tsx";
import { LiveActivity, WorkingIndicator } from "./working-indicator.tsx";
// The wide gutters, the folded rows' spacing, the linked turn's fade and the skeleton's bubble stay in CSS; see the
// file.
import "./transcript.css";

/** The centred reading column (--hb-content-width, as T3 Code's chat column) inside each row. */
const column = "hb-transcript-column mx-auto my-0 max-w-content min-w-0";
/** "Loading earlier messages", or why they didn't load: a pill floating over the list's top, with the float shadow. */
const olderPill =
	"hb-transcript-older absolute top-2.5 left-1/2 z-(--hb-z-float) inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-raised py-1 text-xs whitespace-nowrap shadow-float";

/**
 * A row's space, above it only so two rows' paddings never add up (docs/spacing.md): every row a block under the one
 * above; a line of work under another line of work, the first thing under the person's message and the working
 * header within their block; the person's message a turn under what came before; the first row the gutter. The
 * transcript marks the rows (`closeRows`) because virtua wraps each in its own element, where sibling selectors can't
 * see the row above. From 900px the gutters widen, in transcript.css. Folded rows and rows with nothing to show are
 * adjusted there too, by selectors that look inside the row.
 */
function rowSpace(space: "first" | "turn" | "close" | "block"): string {
	const top = { first: "pt-gutter-narrow", turn: "pt-turn", close: "pt-within", block: "pt-between" }[space];
	return `${top} px-gutter-narrow pb-0`;
}

// The virtualised transcript. Only the rows near the viewport are mounted, whatever the session's length. It follows
// new output only while the reader is at the end, as T3 Code's thread does (transcript-follow.ts has the rules):
// the reader's own input up lets go at once, content changing height never does, and coming back to the end, or the
// "Scroll to end" button, follows again. Following pins the list to its end directly, never through the virtualiser's
// scrollToIndex, which keeps scrolling to its target each time a row is measured and so, while an answer streams,
// would take the reader back to the end after they had scrolled away. Near the top it asks for the previous history
// page, and keeps the reader's place when that page is put in front.

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
// While the session works on a turn (the `working` prop), the turn's "Working for 12s" header, under the person's
// message, and its live activity row ("Thinking") at the end, after T3 Code's (see `workingPlacement`).
const WORKING = { working: true } as const;
const ACTIVITY = { activity: true } as const;
type Entry = TranscriptRow | typeof END | typeof WORKING | typeof ACTIVITY;

const entryKey = (entry: Entry | undefined): string | undefined =>
	entry === undefined
		? undefined
		: "end" in entry
			? "end"
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
		case "connection.approval":
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
	/** The row is a line of work under another, so it sits within their block rather than a block apart. */
	close: boolean;
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
	/** A browsing row's browser card: the browser it opened, or `null` when another row has the card. */
	browserEntry: BrowserViewSlot | null | undefined;
	/** A browsing row that may still take steps: its turn is working and only the agent's words follow it. */
	browsingActive: boolean;
	report: (id: string, phase: RowRenderPhase) => void;
	/** The linked turn is in this row: the row is highlighted, and a tool call in it opens its group and stands out. */
	highlight: string | undefined;
	/** Opens a presented file's viewer; without it the cards only show what the files are. */
	onOpenFile: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key of the file open in the viewer, when it is one this row presented. */
	openFile: string | undefined;
	/** A person's message the host sent and the session doesn't have yet: on its way, or failed. */
	delivery: MessageDelivery | undefined;
	/** The finished turn's fold this row starts: the row carries its "Worked for" line. */
	foldLine: TurnFold | undefined;
	/**
	 * The row is in a finished turn's fold: `closed` while the fold is closed (the row shows only what stays in view: the
	 * files its calls presented, its browser's card, its failed calls), `open` while it is open (every call shows).
	 */
	fold: "closed" | "open" | undefined;
	onToggleFold: (id: string) => void;
	/** Files this row's calls present again that an earlier `generate_image` showed (`repeatedImageFiles`): no cards. */
	repeated: string | undefined;
	/** The transcript's tool renderers, for a call rendered in place. */
	renderers: ToolRenderers;
	/** The host's image previews, for the cards of presented images. */
	previewImage: PreviewImage | undefined;
};

/** "Worked for 1m 12s": a finished turn's fold line, from the person's message to the answer. No step count. */
export function turnFoldSummary(fold: Pick<TurnFold, "elapsed">): string {
	return `Worked for ${duration(fold.elapsed)}`;
}

/**
 * A finished turn's "Worked for" line: a button that shows and hides the turn's work, in the rows under it. It looks
 * and works as a Disclosure's summary; the work it shows is in rows of its own, so it names no one region it controls.
 * Closed, it carries an alert mark when a step it hides failed (`StepFailed`).
 */
function TurnFoldLine({ fold, open, onToggle }: { fold: TurnFold; open: boolean; onToggle: (id: string) => void }) {
	return (
		<div className={`${disclosureClass} hb-turn-fold${open ? " hb-disclosure-open" : ""}`}>
			<button
				type="button"
				// As wide as its words, not the column: `!` because the Disclosure summary's own w-full is a utility on the same
				// property, and two utilities for one property are ordered by Tailwind's sort, not by which comes later.
				className={`${disclosureSummaryClass} w-auto! max-w-full`}
				aria-expanded={open}
				onClick={() => onToggle(fold.id)}
			>
				<ChevronRightIcon size="sm" className={disclosureChevronClass(open)} />
				<span className={disclosureTextClass}>{turnFoldSummary(fold)}</span>
				{open ? null : <StepFailed failed={fold.failed} />}
			</button>
		</div>
	);
}

/** Whether a row's tool calls presented the file with this key. */
function presents(row: TranscriptRow, key: string): boolean {
	const has = (item: ToolItem) => item.files?.some((file) => presentedKey(file) === key) === true;
	if (row.kind === "call") return has(row.item);
	return row.kind === "tools" && row.items.some(has);
}

/** A call rendered in place: its renderer's own, or the generic row should its renderer have gone from the registry. */
function InPlaceCall({
	item,
	renderers,
	...props
}: Omit<ToolInPlaceProps, "item"> & { item: ToolItem; renderers: ToolRenderers }) {
	const Render = renderers.get(item.name)?.inPlace;
	return Render === undefined ? (
		<GenericToolCall item={item} linked={props.linked} />
	) : (
		<Render item={item} {...props} />
	);
}

/** A subagent's card with nothing to open: what the call says, from the call alone. */
function ReadOnlySubagent({ item }: { item: ToolItem }) {
	return (
		<SubagentCard
			{...subagentOf(item)}
			status={subagentStatus(item)}
			startedAt={item.at}
			{...(item.endedAt === undefined ? {} : { endedAt: item.endedAt })}
		/>
	);
}

/** Where a browsing row's browser is, from the host's states: `undefined` for other rows and unknown browsers. */
function rowBrowserState(
	row: TranscriptRow,
	states: ReadonlyMap<string, BrowserEntryState> | undefined,
	entry: BrowserViewSlot | null | undefined,
): BrowserEntryState | undefined {
	if (states === undefined || row.kind !== "browsing" || entry === null) return undefined;
	const browser =
		entry?.browserSessionId ?? browsingBrowser(row.items.filter((step): step is ToolItem => step.kind === "tool"));
	return browser === undefined ? undefined : states.get(browser);
}

/** A browsing row's card for a host with a panel: its browser's slot where it opened one, else `null`. */
function rowBrowserEntry(
	row: TranscriptRow,
	entries: ReadonlyMap<string, BrowserViewSlot>,
	panel: boolean,
): BrowserViewSlot | null | undefined {
	if (!panel || row.kind !== "browsing") return undefined;
	return entries.get(row.id) ?? null;
}

/** A row's place in a finished turn's fold: closed, open, or in none. */
function foldState(fold: TurnFold | undefined, open: ReadonlySet<string>): RowProps["fold"] {
	if (fold === undefined) return undefined;
	return open.has(fold.id) ? "open" : "closed";
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
	browserEntry: RowProps["browserEntry"],
	browsingActive: RowProps["browsingActive"],
	highlight: RowProps["highlight"],
	onOpenFile: RowProps["onOpenFile"],
	openFile: RowProps["openFile"],
	delivery: RowProps["delivery"],
	fold: RowProps["fold"],
	repeated: RowProps["repeated"],
	renderers: RowProps["renderers"],
	previewImage: RowProps["previewImage"],
): ReactNode {
	// A closed fold hides the agent's words before its answer. A subagent is never in one (`turnFolds`): its card stays.
	if (fold === "closed" && (row.kind === "subagent" || row.kind === "item")) return null;
	if (row.kind === "call") {
		const { item } = row;
		const shows = renderers.shows(item);
		// As the generic row, the call is a step of the turn's work: a closed fold hides it, failed or not; the fold's
		// line marks a failed one.
		if (fold === "closed" && !shows) return null;
		if (!shows) return <GenericToolCall item={item} linked={highlight === item.id} />;
		// Files an earlier `generate_image` already showed as pictures get no second card.
		const skip = new Set(repeated?.split("\n"));
		const files = skip.size === 0 ? item.files : item.files?.filter((file) => !skip.has(presentedKey(file)));
		if (files !== undefined && files.length === 0) return null;
		return (
			<InPlaceCall
				item={files === item.files || files === undefined ? item : { ...item, files }}
				renderers={renderers}
				onOpenFile={onOpenFile}
				openFile={openFile}
				previewImage={previewImage}
				linked={highlight === item.id}
			/>
		);
	}
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
				{...(browserEntry === undefined ? {} : { browserEntry })}
				{...(highlight === undefined ? {} : { focus: highlight })}
				active={browsingActive}
				folded={fold === "closed"}
			/>
		);
	}
	if (row.kind === "tools") {
		const views =
			browserSlots === undefined || renderBrowserView === undefined
				? undefined
				: new Map(browserSlots.map((slot) => [slot.item.id, renderBrowserView(slot)] as const));
		// The files the calls presented stay in view under the group, folded or not: a generated image as its picture.
		// The library's presenting tools render in place, out of any group (tool-renderers.tsx); this is for a host's
		// registry that leaves them out.
		const skip = new Set(repeated?.split("\n"));
		const presenting = row.items.flatMap((item) => {
			if (item.status !== "done" || (item.files?.length ?? 0) === 0) return [];
			if (imagesAsCards(item) || skip.size === 0) return [item];
			const files = item.files?.filter((file) => !skip.has(presentedKey(file))) ?? [];
			return files.length === 0 ? [] : [{ ...item, files }];
		});
		// While `generate_image` runs, a placeholder the shape of each image to come.
		const making = row.items.filter(makingImages);
		return (
			<>
				<ToolCallGroup
					items={row.items}
					// In an open fold every call shows: the turn's line is the one "Worked for" in it.
					live={row.live || fold === "open"}
					folded={fold === "closed"}
					{...(views === undefined ? {} : { browserViews: views })}
					{...(highlight === undefined ? {} : { focus: highlight })}
				/>
				{making.map((item) => (
					<ImagePlaceholders key={item.id} item={item} />
				))}
				{presenting.map((item) =>
					imagesAsCards(item) ? (
						<GeneratedImages
							key={item.id}
							item={item}
							onOpen={onOpenFile}
							openKey={openFile}
							previewImage={previewImage}
						/>
					) : (
						<PresentedFiles
							key={item.id}
							item={item}
							onOpen={onOpenFile}
							openKey={openFile}
							previewImage={previewImage}
						/>
					),
				)}
			</>
		);
	}
	const { item } = row;
	switch (item.kind) {
		case "user":
			return delivery === undefined ? <UserMessage item={item} /> : <UserMessage item={item} delivery={delivery} />;
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
	close,
	finalAnswer,
	renderCard,
	renderSubagent,
	browserSlots,
	renderBrowserView,
	onShowBrowser,
	shownBrowser,
	browserState,
	browserEntry,
	browsingActive,
	report,
	highlight,
	onOpenFile,
	openFile,
	delivery,
	foldLine,
	fold,
	onToggleFold,
	repeated,
	renderers,
	previewImage,
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
			className={`hb-transcript-row hb-transcript-row-${kind}${first ? " hb-transcript-row-first" : ""}${turnStart ? " hb-transcript-turn" : ""}${close ? " hb-transcript-row-close" : ""}${highlight === undefined ? "" : " hb-transcript-row-linked"}${fold === "closed" ? " hb-transcript-row-folded" : ""}${foldLine === undefined ? "" : " hb-transcript-row-fold-line"} ${rowSpace(first ? "first" : turnStart ? "turn" : close ? "close" : "block")}`}
			id={turnAnchor(row.id)}
			data-row={row.id}
		>
			<div className={column}>
				{foldLine === undefined ? null : (
					<TurnFoldLine fold={foldLine} open={fold === "open"} onToggle={onToggleFold} />
				)}
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
					browserEntry,
					browsingActive,
					highlight,
					onOpenFile,
					openFile,
					delivery,
					fold,
					repeated,
					renderers,
					previewImage,
				)}
			</div>
		</div>
	);
});

function LoadingRows({ docked }: { docked: boolean }) {
	return (
		<div
			className={`hb-transcript-loading min-h-0 flex-1 overflow-hidden ${docked ? "px-4 pt-4 pb-(--hb-transcript-dock-height)" : "p-4"}`}
			aria-busy="true"
		>
			<span className="hb-sr-only" role="status">
				Loading messages
			</span>
			{[0, 1].map((turn) => (
				<div key={turn} className={`${column} hb-transcript-skeleton-turn flex flex-col gap-3 pb-8`}>
					<div className="hb-transcript-skeleton-user">
						<Skeleton width="45%" />
					</div>
					<div className="hb-transcript-skeleton-tools flex flex-col gap-1.5">
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
	/**
	 * A URL to show an image file a call presented as itself (an object URL of its bytes, say), or undefined when there is
	 * none. Keep it stable and cache what it reads: each image card asks once as it mounts. Without it, an image is a
	 * file's card with its icon.
	 */
	previewImage?: PreviewImage;
	/**
	 * How tools' calls render: which render in place of the generic tool-call row (out of any "Worked for" group, so
	 * they show once) and which keep the row with a label or detail of their own. Default: the library's
	 * (`defaultToolRenderers`); extend it with `toolRenderers([...defaultToolRenderers, ...yours])`, made once. Only
	 * presentation: `items` keep every call as the session's API sent it.
	 */
	toolRenderers?: ToolRenderers;
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
	 * Messages the host shows before the session has them, by item ID: an optimistic send puts the person's message in
	 * `items` at once, under an ID of its own with the send's `requestId`, and says here that it is on its way or failed
	 * (`MessageDelivery`). When the session's copy arrives with the same `requestId`, the host drops its own and the row
	 * updates in place. Keep the map and its values stable while nothing changes: a message's row renders again when
	 * its value does.
	 */
	delivery?: ReadonlyMap<string, MessageDelivery>;
	/**
	 * Docked over the transcript's foot, usually a Composer, as T3 Code's thread: the list scrolls under it and its
	 * end makes room for it. A Composer here rests (folds to one line) while the reader scrolls back, comes back at
	 * the end, and takes files dropped anywhere on the transcript.
	 */
	dock?: ReactNode;
	/**
	 * While there are no items, the dock sits in the middle of the page under `empty` rather than at its foot, as
	 * claude.ai and Claude Code on the web open a new chat: the new session's screen. Once items arrive it docks at the
	 * foot as usual.
	 */
	centreDockWhenEmpty?: boolean;
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
	previewImage,
	toolRenderers: renderers = DEFAULT_TOOL_RENDERERS,
	loading = false,
	empty,
	error,
	working,
	onRowRender,
	messageActions,
	delivery,
	dock,
	centreDockWhenEmpty,
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
		const next = groupTranscript(items, previousRows.current, renderers.inPlace);
		previousRows.current = next;
		return next;
	}, [items, renderers]);
	// A message's row is keyed by its requestId, so a message sent optimistically and the session's copy are one row.
	const keys = useMemo(() => messageKeys(rows), [rows]);
	// Each browser's live view, under its newest call. Rows keep their slots' identity while they don't change.
	const previousSlots = useRef<ReadonlyMap<string, readonly BrowserViewSlot[]> | undefined>(undefined);
	const slots = useMemo(() => {
		const next = browserViewSlots(rows, previousSlots.current);
		previousSlots.current = next;
		return next;
	}, [rows]);
	// Each browser's timeline card, on the browsing row that opened it.
	const previousEntries = useRef<ReadonlyMap<string, BrowserViewSlot> | undefined>(undefined);
	const browserEntries = useMemo(() => {
		const next = browserEntrySlots(rows, previousEntries.current);
		previousEntries.current = next;
		return next;
	}, [rows]);
	const showWorking = working !== undefined && working !== false;
	const placement = useMemo(() => workingPlacement(rows), [rows]);
	const activeBrowsing = useMemo(() => (showWorking ? activeBrowsingRow(rows) : undefined), [rows, showWorking]);
	const { headerAfter, activity } = placement;
	const entries = useMemo<Entry[]>(() => {
		if (!showWorking) return [...rows, END];
		const foot: Entry[] = activity ? [ACTIVITY, END] : [END];
		// The header under the turn's message goes in that message's own entry (headerRow, below); with the message in an
		// older page, at the end, before the activity. Never an entry of its own in the middle: virtua keeps its sizes by
		// index, so taking one out when the turn settles would give every row after it its neighbour's size, and its
		// correction for that would throw a reader who had scrolled up back to the end.
		return headerAfter < 0 ? [...rows, WORKING, ...foot] : [...rows, ...foot];
	}, [rows, showWorking, headerAfter, activity]);
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
	// A line of work right under another sits close to it; every other row is a block apart (docs/spacing.md).
	const close = useMemo(() => closeRows(rows, finalAnswers), [rows, finalAnswers]);
	const last = rows.at(-1);
	const activityClose = last !== undefined && endsInWorkLine(last);
	const repeated = useMemo(() => repeatedImageFiles(rows), [rows]);

	// Each finished turn's work, folded under its "Worked for" line. Closed by default, on every load: only the folds a
	// person opened in this view are open. The turn under way streams at the top level and folds when it ends.
	const previousFolds = useRef<ReadonlyMap<string, TurnFold> | undefined>(undefined);
	const folds = useMemo(() => {
		const next = turnFolds(rows, showWorking, previousFolds.current, renderers.shows);
		previousFolds.current = next;
		return next;
	}, [rows, showWorking, renderers]);
	const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
	const toggleFold = useCallback((id: string) => {
		setOpenFolds((open) => {
			const next = new Set(open);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}, []);
	const openFold = useCallback((rowId: string) => {
		const id = previousFolds.current?.get(rowId)?.id;
		if (id === undefined) return;
		setOpenFolds((open) => (open.has(id) ? open : new Set([...open, id])));
	}, []);

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

	// Prepending older rows: tell the virtualiser to keep the visible content still (virtua's `shift`). Compared on the
	// list's keys, so a first message the session takes over from the host's own copy is not taken for an older page.
	const head = entryKey(entries[0]);
	const firstKey = head === undefined ? undefined : (keys.get(head) ?? head);
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
		// A linked call in a folded turn: the fold opens to show it, and stays open.
		openFold(found.row.id);
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
	// Empty and asked to, the dock sits in the middle with the empty state instead (`centreDockWhenEmpty`).
	const centred = docked && centreDockWhenEmpty === true && !showList && !loading;
	const root = useRef<HTMLDivElement>(null);
	const dockElement = useRef<HTMLDivElement>(null);
	const restingRef = useRef(resting);
	restingRef.current = resting;
	const inset = useRef(0);
	const footDocked = docked && !centred;
	useLayoutEffect(() => {
		const element = dockElement.current;
		const host = root.current;
		if (!footDocked || element === null || host === null) return;
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
	}, [footDocked]);

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
		<div className={`hb-transcript-row hb-transcript-row-working ${rowSpace("close")}`}>
			<div className={column}>
				<WorkingIndicator since={workingSince} {...(workingLabel === undefined ? {} : { label: workingLabel })} />
			</div>
		</div>
	);

	let body: ReactNode;
	if (showList) {
		body = (
			<section className="hb-transcript-frame relative min-h-0 flex-1" aria-label="Transcript" ref={frame}>
				<VList<Entry>
					ref={list}
					data={entries}
					shift={prepended}
					onScroll={onScroll}
					className="hb-transcript-list hb-focusable absolute inset-0 overscroll-contain"
					tabIndex={0}
					bufferSize={BUFFER_PX}
				>
					{(entry, index) =>
						"end" in entry ? (
							<div
								key="end"
								// Docked, the end makes room for the composer floating over the list's foot, as tall as the dock is
								// measured, plus the usual gap.
								className={`hb-transcript-end ${docked ? "h-[calc(var(--hb-transcript-dock-height)+var(--hb-gap-between))]" : "h-turn"}`}
								aria-hidden="true"
							/>
						) : "working" in entry ? (
							<Fragment key="working">{workingHeader}</Fragment>
						) : "activity" in entry ? (
							<div
								key="activity"
								className={`hb-transcript-row hb-transcript-row-activity${activityClose ? " hb-transcript-row-close" : ""} ${rowSpace(activityClose ? "close" : "block")}`}
							>
								<div className={column}>
									<LiveActivity />
								</div>
							</div>
						) : (
							<Fragment key={keys.get(entry.id) ?? entry.id}>
								<Row
									row={entry}
									first={index === 0 && !hasOlder}
									turnStart={index > 0 && entry.kind === "item" && entry.item.kind === "user"}
									close={close.has(entry.id)}
									finalAnswer={finalAnswers.has(entry.id)}
									renderCard={renderCard}
									renderSubagent={renderSubagent}
									browserSlots={slots.get(entry.id)}
									renderBrowserView={renderBrowserView}
									onShowBrowser={onShowBrowser}
									shownBrowser={entry.kind === "browsing" ? shownBrowser : undefined}
									browserState={rowBrowserState(
										entry,
										browserStates,
										rowBrowserEntry(entry, browserEntries, onShowBrowser !== undefined),
									)}
									browserEntry={rowBrowserEntry(entry, browserEntries, onShowBrowser !== undefined)}
									browsingActive={entry.id === activeBrowsing}
									report={report}
									highlight={highlight?.row === entry.id ? highlight.item : undefined}
									onOpenFile={onOpenFile}
									openFile={openFile !== undefined && presents(entry, openFile) ? openFile : undefined}
									delivery={entry.kind === "item" ? delivery?.get(entry.id) : undefined}
									foldLine={folds.get(entry.id)?.id === entry.id ? folds.get(entry.id) : undefined}
									fold={foldState(folds.get(entry.id), openFolds)}
									onToggleFold={toggleFold}
									repeated={repeated.get(entry.id)}
									renderers={renderers}
									previewImage={previewImage}
								/>
								{entry.id === headerRow ? workingHeader : null}
							</Fragment>
						)
					}
				</VList>
				{loadingOlder ? (
					<div className={`${olderPill} px-3 text-muted`} role="status">
						<Spinner size="sm" />
						Loading earlier messages
					</div>
				) : olderError && hasOlder ? (
					<div className={`${olderPill} hb-transcript-older-error pr-1 pl-3 text-fg`} role="alert">
						<span className="hb-transcript-older-text max-w-popover overflow-hidden text-ellipsis">{olderError}</span>
						{onLoadOlder === undefined ? null : (
							// A pill in the pill: `!` because the Button's own utilities set its radius too.
							<Button variant="ghost" size="sm" className="rounded-full!" onClick={onLoadOlder}>
								Try again
							</Button>
						)}
					</div>
				) : null}
				{showEnd ? (
					<Button
						// Floats over the list; docked, just above the composer (T3 Code: the measured clearance plus 4px). `!` where
						// the Button's own utilities set the same property (its radius and colour); the secondary variant's
						// raised background and active hover are this button's own already.
						className={`hb-transcript-scroll-end absolute left-1/2 z-(--hb-z-float) -translate-x-1/2 rounded-full! text-muted! shadow-float hover:enabled:text-fg! ${docked ? "bottom-[calc(var(--hb-transcript-dock-height)+var(--hb-step-1))]" : "bottom-4"}`}
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
		body = <LoadingRows docked={docked} />;
	} else if (centred) {
		// The greeting and the composer together, a little above the middle (claude.ai's new chat): the space under them
		// is twice the space over them.
		body = (
			<div className="hb-transcript-empty hb-transcript-empty-centred flex min-h-0 flex-1 flex-col overflow-y-auto px-gutter-narrow sm:px-gutter">
				<div className="min-h-gutter flex-1" />
				<div className="flex flex-none flex-col gap-between">
					{empty ?? <EmptyState title="No messages yet">Send a message to start the session.</EmptyState>}
					<ComposerDockContext.Provider value={dockContext}>
						<div className="hb-transcript-dock-lane mx-auto my-0 w-full max-w-content">{dock}</div>
					</ComposerDockContext.Provider>
				</div>
				<div className="min-h-gutter flex-2" />
			</div>
		);
	} else {
		body = (
			<div
				className={`hb-transcript-empty flex min-h-0 flex-1 items-center justify-center px-4 pt-0 ${docked ? "pb-(--hb-transcript-dock-height)" : "pb-0"}`}
			>
				{empty ?? <EmptyState title="No messages yet">Send a message to start the session.</EmptyState>}
			</div>
		);
	}

	return (
		// A file drop here is a pointer-only shortcut; the composer's paperclip is the keyboard's way.
		<div
			ref={root}
			className={`hb-transcript relative flex h-full min-h-0 flex-col${docked ? " hb-transcript-docked" : ""}${className ? ` ${className}` : ""}`}
			{...dragHandlers}
		>
			{error ? (
				<div className="hb-transcript-error flex-none px-4 pt-2 pb-0">
					<div className={column}>
						<Notice level="error">{error}</Notice>
					</div>
				</div>
			) : null}
			<ToolRenderersContext.Provider value={renderers}>
				<MessageActionsContext.Provider value={actionHandlers}>{body}</MessageActionsContext.Provider>
			</ToolRenderersContext.Provider>
			{docked && !centred ? (
				<ComposerDockContext.Provider value={dockContext}>
					<div
						// The composer keeps the transcript's gutters at its sides and the window's at its foot (docs/spacing.md).
						// The lane takes the pointer; the gutters beside it scroll the list.
						className="hb-transcript-dock pointer-events-none absolute right-0 bottom-0 left-0 z-(--hb-z-float) px-gutter-narrow pt-1.5 pb-[calc(var(--hb-gutter-narrow)+env(safe-area-inset-bottom))] sm:pt-2 sm:pb-[calc(var(--hb-gutter)+env(safe-area-inset-bottom))]"
						ref={dockElement}
					>
						<div className="hb-transcript-dock-lane pointer-events-auto mx-auto my-0 max-w-content">{dock}</div>
					</div>
				</ComposerDockContext.Provider>
			) : null}
			{dragging ? (
				<div
					// Files dragged over a docked transcript: a dashed frame and one line saying where they go.
					className="hb-transcript-drop pointer-events-none absolute inset-2 z-(--hb-z-overlay) flex flex-col items-center justify-center gap-1.5 rounded-bubble border-dashed border-drop-line bg-drop-fill [border-width:var(--hb-ring)]"
					aria-hidden="true"
				>
					<span className="hb-transcript-drop-label rounded-full bg-raised px-4 py-1.5 text-sm font-medium text-fg shadow-float">
						Drop files to attach
					</span>
					{dropHint ? (
						<span className="hb-transcript-drop-limits rounded-full bg-raised px-2.5 py-0.5 text-xs text-muted">
							{dropHint}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}
