import type { Cursor, DraftDocument, PresentedFile, ToolItem } from "@harbour/protocol";
import {
	type BrowserEntryState,
	BrowserLiveView,
	BrowserPanel,
	type BrowserViewSlot,
	Button,
	Composer,
	type ConnectionStateValue,
	type Crumb,
	DotsIcon,
	draftDocument,
	FileIcon,
	IconButton,
	Notice,
	PreviewWarmContext,
	presentedFiles,
	presentedKey,
	presentedKind,
	SentAttachmentsContext,
	SessionHeader,
	Transcript,
} from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TurnSearch } from "../state/linked-turn.ts";
import { type Outgoing, withOutbox } from "../state/outbox.ts";
import type { ConnectionHealth, Freshness, SessionClient } from "../state/session-client.ts";
import {
	browserRequestOf,
	composerState,
	delivering,
	deliveryOf,
	editBlocked,
	offersFollowUp,
	type SessionActions,
	transcriptWorking,
} from "./actions.ts";
import type { BrowserLive, BrowserLiveStore } from "./browser-live.ts";
import { COMPOSER_ACCESS } from "./composer-access.ts";
import { useImagePreviews } from "./image-previews.ts";
import { createAutoOpen } from "./presented.ts";
import { createPreviewCache } from "./preview-cache.ts";
import { fileOfHash, useFileInUrl } from "./preview-url.ts";
import { Profiled, profiling, recordRow } from "./profile.tsx";
import { ProfilePanel } from "./profile-panel.tsx";
import { openAttachmentId, readOpenFile, useSentAttachments } from "./sent-attachments.ts";
import { useSessionBrowser } from "./session-browser.tsx";
import { SessionPreview } from "./session-preview.tsx";
import { ConsoleSubagent, type SubagentLinks } from "./subagent.tsx";

// The console is a host for @harbour/ui: the header, transcript and composer are the library's, and this file only
// maps the session client's state onto their props. Anything that looks like a new component belongs in
// packages/ui, not here (AGENTS.md).

function connectionOf(health: ConnectionHealth): ConnectionStateValue {
	return health.status === "offline" ? { state: "offline", retryAt: health.retryAt } : { state: health.status };
}

/**
 * Data freshness: is what's shown the host's latest? Separate from whether the link is up. A stream fact for the options
 * menu, never the top bar, which holds breadcrumbs only.
 */
function FreshnessText({ freshness, cursor }: { freshness: Freshness; cursor: Cursor | undefined }) {
	switch (freshness.state) {
		case "loading":
			return <>Loading</>;
		case "catching-up":
			return (
				<>
					Catching up to <code>{freshness.head}</code>
				</>
			);
		case "stale":
			return (
				<>
					May be behind, showing <code>{cursor ?? "nothing"}</code>
				</>
			);
		case "current":
			return (
				<>
					Up to date at <code>{cursor ?? "start"}</code>
				</>
			);
	}
}

const NOTHING_OUTGOING: readonly Outgoing[] = [];

/** A browser's live view, as the session screen's link store has it. */
type Tabs = ((end: ReactNode) => ReactNode) | undefined;

/** A browser's view as the timeline's card says it: live, a replay, closed with none, or not known yet. */
export function entryStateOf(view: BrowserLive): BrowserEntryState | undefined {
	if (view.status === "ended") return "ended";
	if (view.status !== "live") return undefined;
	return view.source?.mode === "replay" ? "replay" : "live";
}

/**
 * Where each of the session's browsers is, from the live store, for the timeline's cards: asking for each browser's
 * link (not its stream, which only an open view costs). `undefined` with no store (a recorded session).
 */
function useBrowserStates(
	store: BrowserLiveStore | undefined,
	browsers: readonly BrowserViewSlot[],
): ReadonlyMap<string, BrowserEntryState> | undefined {
	const ids = browsers.map((slot) => slot.browserSessionId).join("\n");
	const subscribe = useCallback(
		(listener: () => void) => {
			if (store === undefined || ids === "") return () => {};
			const stops = ids.split("\n").map((id) => store.subscribe(id, listener));
			return () => {
				for (const stop of stops) stop();
			};
		},
		[store, ids],
	);
	const key = useSyncExternalStore(subscribe, () =>
		store === undefined || ids === ""
			? ""
			: ids
					.split("\n")
					.map((id) => `${id}\t${entryStateOf(store.get(id)) ?? ""}`)
					.join("\n"),
	);
	return useMemo(() => {
		if (store === undefined) return undefined;
		const states = new Map<string, BrowserEntryState>();
		for (const line of key === "" ? [] : key.split("\n")) {
			const [id, state] = line.split("\t");
			if (id !== undefined && state !== undefined && state !== "") states.set(id, state as BrowserEntryState);
		}
		return states;
	}, [store, key]);
}

function LiveBrowser({
	store,
	slot,
	tabs,
}: {
	store: BrowserLiveStore | undefined;
	slot: BrowserViewSlot;
	tabs: Tabs;
}) {
	if (store === undefined) {
		// No live links here (a recorded session): the last screenshot the browser left.
		return (
			<BrowserLiveView
				status="unavailable"
				item={slot.item}
				{...(slot.screenshot === undefined ? {} : { screenshot: slot.screenshot })}
				{...(slot.page === undefined ? {} : { page: slot.page })}
				{...(tabs === undefined ? {} : { tabs })}
			/>
		);
	}
	return <StoredBrowser store={store} slot={slot} tabs={tabs} />;
}

function StoredBrowser({ store, slot, tabs }: { store: BrowserLiveStore; slot: BrowserViewSlot; tabs: Tabs }) {
	const id = slot.browserSessionId;
	const live = useSyncExternalStore(
		useCallback((listener: () => void) => store.subscribe(id, listener), [store, id]),
		() => store.get(id),
	);
	return (
		<BrowserLiveView
			status={live.status}
			item={slot.item}
			{...(live.source === undefined ? {} : { source: live.source })}
			{...(slot.screenshot === undefined ? {} : { screenshot: slot.screenshot })}
			{...(slot.page === undefined ? {} : { page: slot.page })}
			{...(tabs === undefined ? {} : { tabs })}
			onEnded={() => store.disconnected(id)}
		/>
	);
}

export function SessionView({
	client,
	parents,
	subagents,
	actions,
	onBack,
	onFiles,
	turn,
	turnSearch,
	focusBrowser,
}: {
	client: SessionClient;
	/**
	 * The top bar's trail above this session, outermost first: its project, then for a subagent's session the sessions
	 * that started it. Each goes back to its level.
	 */
	parents?: readonly Crumb[];
	/** How subagent cards link to their sessions; without it they show what the call says, with nothing to open. */
	subagents?: SubagentLinks;
	actions: SessionActions;
	/** Shows Back, on a phone, to return to the list. */
	onBack?: () => void;
	/** Shows Files, to browse the session's workspace: at one file, from the preview's Show in the workspace. */
	onFiles?: (path?: string) => void;
	/** The turn a `#turn=<id>` link names: the transcript lands on it and highlights it once it is loaded. */
	turn?: string;
	/** Where the search for `turn` stands; `missing` says so above the composer. */
	turnSearch?: TurnSearch;
	/** A browser session to scroll to, from an audit link's `#browser=<id>`. */
	focusBrowser?: string;
}) {
	const turnMissing = turn !== undefined && turnSearch === "missing";
	const state = useSyncExternalStore(client.subscribe, client.getState);
	const renderSubagent = useMemo(
		() =>
			subagents === undefined
				? undefined
				: (item: ToolItem) => <ConsoleSubagent key={item.callId} item={item} links={subagents} />,
		[subagents],
	);
	const [menu, setMenu] = useState(false);
	const menuRoot = useRef<HTMLDivElement>(null);
	const loaded = state.items.length;
	const last = state.resumes.at(-1);

	// Escape or a click outside closes the menu.
	useEffect(() => {
		if (!menu) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenu(false);
		};
		const onPointer = (event: PointerEvent) => {
			if (!menuRoot.current?.contains(event.target as Node)) setMenu(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
		};
	}, [menu]);

	const { control, onFork, onEdit, browserLive, readPresented, writePresented, readAttachment } = actions;

	// The presented file open in the viewer. A file a call presents for the first time while the screen is open opens
	// on its own; any file opens from its card.
	const [openFile, setOpenFile] = useState<PresentedFile>();
	const [autoOpen] = useState(createAutoOpen);
	const ready = state.freshness.state !== "loading";
	useEffect(() => {
		if (!ready || readPresented === undefined) return;
		const next = autoOpen.next(state.items);
		if (next !== undefined) setOpenFile(next);
	}, [autoOpen, ready, state.items, readPresented]);
	const onOpenFile = useCallback((file: PresentedFile) => setOpenFile(file), []);
	const closeFile = useCallback(() => setOpenFile(undefined), []);
	const readOpen = useMemo(() => readOpenFile(readPresented, readAttachment), [readPresented, readAttachment]);
	const openIsAttachment = openAttachmentId(openFile) !== undefined;
	// A presented image shows as itself in the transcript, read from the workspace as its card mounts; opening it shows
	// that same read in the panel.
	const imagePreviews = useImagePreviews(readPresented);
	const previewImage = imagePreviews?.url;
	// Every file the panel opens is read once into this cache (and kept while the session is open): opening it again,
	// or opening one whose card was hovered, shows it in the panel's first frame. An image its card has read opens
	// from that read and its picture, already decoded (`peek`), or joins the card's read while it is under way.
	const previewCache = useMemo(() => {
		if (readOpen === undefined) return undefined;
		const isPicture = (file: PresentedFile) =>
			imagePreviews !== undefined && openAttachmentId(file) === undefined && presentedKind(file) === "image";
		const read = (file: PresentedFile, signal: AbortSignal) =>
			isPicture(file) && imagePreviews !== undefined
				? imagePreviews.picture(file).then((picture) => picture ?? readOpen(file, signal))
				: readOpen(file, signal);
		return createPreviewCache(read, presentedKey, {
			nameOf: (file: PresentedFile) => file.name,
			peek: (file: PresentedFile) => (isPicture(file) ? imagePreviews?.shown(file) : undefined),
		});
	}, [readOpen, imagePreviews]);
	const warmFile = useMemo(
		() => (previewCache === undefined ? undefined : (file: PresentedFile) => previewCache.load(file)),
		[previewCache],
	);
	// A file sent with a message opens from its card in the same panel; its image shows as a thumbnail on the card.
	const sentAttachments = useSentAttachments(readAttachment, openFile, onOpenFile, warmFile);
	// Previous and Next move through the files the session presented, in the order it presented them.
	const siblings = useMemo(() => {
		const seen = new Set<string>();
		const files: PresentedFile[] = [];
		for (const { file } of presentedFiles(state.items)) {
			const key = presentedKey(file);
			if (seen.has(key)) continue;
			seen.add(key);
			files.push(file);
		}
		return files;
	}, [state.items]);
	// The open file in the URL (`#file=`): Back closes it, and a link with one opens it once the session has loaded.
	useFileInUrl(openFile === undefined ? undefined : presentedKey(openFile), (key) =>
		setOpenFile(key === undefined ? undefined : siblings.find((file) => presentedKey(file) === key)),
	);
	const [linkedFile, setLinkedFile] = useState(() => fileOfHash(location.hash));
	useEffect(() => {
		if (linkedFile === undefined || !ready) return;
		const found = siblings.find((file) => presentedKey(file) === linkedFile);
		if (found !== undefined) setOpenFile(found);
		setLinkedFile(undefined);
	}, [linkedFile, ready, siblings]);
	const onRevealFile = useMemo(
		() => (onFiles === undefined || openIsAttachment ? undefined : (file: PresentedFile) => onFiles(file.path)),
		[onFiles, openIsAttachment],
	);

	// A document the agent is writing (`create_document`) streams into the same panel, until the person closes it; the
	// saved document then opens there as its call finishes, starting from the draft's text.
	const draft = useMemo(() => draftDocument(state.items), [state.items]);
	const [closedDraft, setClosedDraft] = useState<string>();
	const shownDraft =
		draft !== undefined && draft.callId !== closedDraft && readPresented !== undefined ? draft : undefined;
	const lastDraft = useRef<DraftDocument>(undefined);
	if (shownDraft !== undefined) lastDraft.current = shownDraft;
	const closeDraft = useCallback(() => setClosedDraft(draft?.callId), [draft?.callId]);
	const panelOpen = shownDraft !== undefined || openFile !== undefined;

	// The session's browser, in the same place at the right: an open file takes it, and a browsing run's "Show
	// browser" puts the browser back.
	const browser = useSessionBrowser(state.items, focusBrowser);
	const showPanelBrowser = browser.show;
	const onShowBrowser = useCallback(
		(browserSessionId: string) => {
			setOpenFile(undefined);
			showPanelBrowser(browserSessionId);
		},
		[showPanelBrowser],
	);
	const browserPanel = panelOpen ? undefined : browser.panel;
	const browserStates = useBrowserStates(browserLive, browser.browsers);
	const browserRequest = useMemo(() => browserRequestOf(state.items), [state.items]);
	const onBrowserDecision = actions.onBrowserDecision;
	const working = useMemo(
		() => transcriptWorking(state.status, actions.promptedAt),
		[state.status, actions.promptedAt],
	);
	// A prompt on its way to a run counts as running: the edit would race it.
	const blocked = editBlocked(
		control,
		actions.promptedAt === undefined ? state.status : "running",
		actions.sending || delivering(actions.outbox),
	);
	// The transcript shows what was just sent at once, after the session's items, until the stream brings it.
	const outbox = actions.outbox ?? NOTHING_OUTGOING;
	const items = useMemo(() => withOutbox(state.items, outbox), [state.items, outbox]);
	const { onRetrySend, onEditUnsent } = actions;
	const delivery = useMemo(() => deliveryOf(outbox, onRetrySend, onEditUnsent), [outbox, onRetrySend, onEditUnsent]);
	const messageActions = useMemo(
		() => ({
			// A recorded session can't be forked or edited: neither is offered.
			...(onFork === undefined || !control.live ? {} : { fork: onFork }),
			...(onEdit === undefined || !control.live ? {} : { edit: onEdit }),
			...(blocked === undefined ? {} : { editBlocked: blocked }),
		}),
		[onFork, onEdit, control.live, blocked],
	);

	return (
		<div className="console">
			<SessionHeader
				title={state.title}
				{...(parents === undefined ? {} : { parents })}
				connection={connectionOf(state.connection)}
				loading={state.freshness.state === "loading" && state.title === ""}
				onBack={onBack}
				actions={
					<div className="console-actions">
						{onFiles === undefined ? null : (
							<IconButton variant="ghost" label="Files" icon={<FileIcon />} onClick={() => onFiles()} />
						)}
						<div className="console-menu-root" ref={menuRoot}>
							<IconButton
								variant="ghost"
								label="Session options"
								icon={<DotsIcon />}
								aria-expanded={menu}
								onClick={() => setMenu((open) => !open)}
							/>
							{menu ? (
								<div className="console-menu">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											client.simulateDisconnect(3000);
											setMenu(false);
										}}
										disabled={state.connection.status !== "open"}
									>
										Drop the connection for 3s
									</Button>
									<div className="console-menu-label">Stream</div>
									<ul className="console-menu-facts">
										<li>
											<FreshnessText freshness={state.freshness} cursor={state.cursor} />
										</li>
										<li>
											{loaded.toLocaleString("en-GB")} items loaded
											{state.hasEarlier ? ", earlier ones on scroll" : ", the whole session"}
										</li>
										<li>{state.flushes.toLocaleString("en-GB")} renders from the stream</li>
										{last ? (
											<li>
												Last resume from <code>{last.from ?? "start"}</code> by {last.how}
											</li>
										) : null}
									</ul>
								</div>
							) : null}
						</div>
					</div>
				}
			/>
			<div
				className={`console-main${panelOpen ? " console-main-split" : ""}${browserPanel === undefined ? "" : " console-main-browser"}`}
			>
				<div className="console-main-transcript">
					<Profiled id="transcript-list">
						<PreviewWarmContext.Provider value={warmFile}>
							<SentAttachmentsContext.Provider value={sentAttachments}>
								<Transcript
									items={items}
									{...(delivery === undefined ? {} : { delivery })}
									hasOlder={state.hasEarlier}
									loadingOlder={state.loadingOlder}
									olderError={state.olderError === undefined ? undefined : "Couldn't load earlier messages"}
									onLoadOlder={client.loadOlder}
									loading={state.freshness.state === "loading"}
									error={state.error}
									working={working}
									onRowRender={recordRow}
									messageActions={messageActions}
									onShowBrowser={onShowBrowser}
									{...(browserPanel === undefined ? {} : { shownBrowser: browserPanel.browserSessionId })}
									{...(browserStates === undefined ? {} : { browserStates })}
									{...(renderSubagent === undefined ? {} : { renderSubagent })}
									{...(turn === undefined ? {} : { turn })}
									{...(focusBrowser === undefined ? {} : { focusBrowser })}
									{...(readPresented === undefined ? {} : { onOpenFile })}
									{...(openFile === undefined ? {} : { openFile: presentedKey(openFile) })}
									{...(previewImage === undefined ? {} : { previewImage })}
									dock={
										<Composer
											state={composerState(control, state.status, actions.sending)}
											disabledReason={control.live ? undefined : control.reason}
											label="Message"
											banner={
												actions.failure === undefined && browserRequest === undefined && !turnMissing ? undefined : (
													<>
														{turnMissing ? (
															<Notice level="info">The turn this link names isn't in the session.</Notice>
														) : null}
														{actions.failure === undefined ? null : <Notice level="error">{actions.failure}</Notice>}
														{browserRequest === undefined ? null : (
															<Notice
																level="warning"
																action={
																	onBrowserDecision === undefined || !control.live ? undefined : (
																		<span className="console-browser-actions">
																			<Button
																				size="sm"
																				disabled={actions.sending}
																				onClick={() => onBrowserDecision(browserRequest.callId, true)}
																			>
																				Allow
																			</Button>
																			<Button
																				variant="ghost"
																				size="sm"
																				disabled={actions.sending}
																				onClick={() => onBrowserDecision(browserRequest.callId, false)}
																			>
																				Decline
																			</Button>
																		</span>
																	)
																}
															>
																The agent asks for a browser
																{browserRequest.sites.length === 0 ? "" : ` on ${browserRequest.sites.join(", ")}`}
																{browserRequest.reason === "" ? "." : `: ${browserRequest.reason}`}
															</Notice>
														)}
													</>
												)
											}
											value={actions.draft}
											onChange={actions.onDraft}
											{...(actions.onEngage === undefined ? {} : { onEngage: actions.onEngage })}
											{...actions.pickers}
											{...COMPOSER_ACCESS}
											{...(actions.files ?? { attachUnavailable: "Attaching files isn't available here" })}
											footer={
												offersFollowUp(control, state.status, actions.sending, actions.draft) ? (
													<Button variant="ghost" size="sm" onClick={() => actions.onFollowUp(actions.draft.trim())}>
														Send after this run
													</Button>
												) : undefined
											}
											onSend={actions.onSend}
											onSteer={actions.onSteer}
											onStop={actions.onStop}
										/>
									}
								/>
							</SentAttachmentsContext.Provider>
						</PreviewWarmContext.Provider>
					</Profiled>
				</div>
				{readOpen === undefined ? null : (
					// One panel for every file, kept mounted: a file opening while another is open swaps the body in place.
					<SessionPreview
						className="console-file-panel"
						file={shownDraft === undefined ? openFile : undefined}
						draft={shownDraft}
						lastDraft={lastDraft.current}
						siblings={openIsAttachment ? [] : siblings}
						cache={previewCache}
						write={openIsAttachment ? undefined : writePresented}
						sharesOf={openIsAttachment ? undefined : actions.sharesOf}
						sharer={actions.sharer}
						onClose={shownDraft === undefined ? closeFile : closeDraft}
						onNavigate={onOpenFile}
						onReveal={onRevealFile}
					/>
				)}
				{browserPanel === undefined ? null : (
					<BrowserPanel
						className="console-browser"
						{...(browser.step === undefined ? {} : { step: browser.step })}
						running={browser.running}
						onHide={browser.hide}
					>
						{/* Keyed by browser: the same browser's view stays mounted, so its live page never reloads. */}
						<LiveBrowser
							key={browserPanel.browserSessionId}
							store={browserLive}
							slot={browserPanel}
							tabs={browser.tabs}
						/>
					</BrowserPanel>
				)}
			</div>
			{profiling ? <ProfilePanel client={client} /> : null}
		</div>
	);
}
