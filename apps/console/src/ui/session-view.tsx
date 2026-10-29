import type { Cursor } from "@harbour/protocol";
import {
	BrowserLiveView,
	type BrowserViewSlot,
	Button,
	Composer,
	type ConnectionStateValue,
	type Crumb,
	DotsIcon,
	FileIcon,
	IconButton,
	Notice,
	SessionHeader,
	Transcript,
} from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TurnSearch } from "../state/linked-turn.ts";
import type { ConnectionHealth, Freshness, SessionClient } from "../state/session-client.ts";
import {
	browserRequestOf,
	composerState,
	editBlocked,
	offersFollowUp,
	type SessionActions,
	transcriptWorking,
} from "./actions.ts";
import type { BrowserLiveStore } from "./browser-live.ts";
import { Profiled, profiling, recordRow } from "./profile.tsx";
import { ProfilePanel } from "./profile-panel.tsx";

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

/** A browser's live view, as the session screen's link store has it. */
function LiveBrowser({ store, slot }: { store: BrowserLiveStore; slot: BrowserViewSlot }) {
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
			onEnded={() => store.disconnected(id)}
		/>
	);
}

export function SessionView({
	client,
	parents,
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
	actions: SessionActions;
	/** Shows Back, on a phone, to return to the list. */
	onBack?: () => void;
	/** Shows Files, to browse the session's workspace. */
	onFiles?: () => void;
	/** The turn a `#turn=<id>` link names: the transcript lands on it and highlights it once it is loaded. */
	turn?: string;
	/** Where the search for `turn` stands; `missing` says so above the composer. */
	turnSearch?: TurnSearch;
	/** A browser session to scroll to, from an audit link's `#browser=<id>`. */
	focusBrowser?: string;
}) {
	const turnMissing = turn !== undefined && turnSearch === "missing";
	const state = useSyncExternalStore(client.subscribe, client.getState);
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

	const { control, onFork, onEdit, browserLive } = actions;
	const renderBrowserView = useMemo(
		() =>
			browserLive === undefined
				? undefined
				: (slot: BrowserViewSlot) => <LiveBrowser store={browserLive} slot={slot} />,
		[browserLive],
	);
	const browserRequest = useMemo(() => browserRequestOf(state.items), [state.items]);
	const onBrowserDecision = actions.onBrowserDecision;
	const working = useMemo(
		() => transcriptWorking(state.status, actions.promptedAt),
		[state.status, actions.promptedAt],
	);
	// A prompt on its way to a run counts as running: the edit would race it.
	const blocked = editBlocked(control, actions.promptedAt === undefined ? state.status : "running", actions.sending);
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
							<IconButton variant="ghost" label="Files" icon={<FileIcon />} onClick={onFiles} />
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
			<div className="console-main">
				<Profiled id="transcript-list">
					<Transcript
						items={state.items}
						hasOlder={state.hasEarlier}
						loadingOlder={state.loadingOlder}
						olderError={state.olderError === undefined ? undefined : "Couldn't load earlier messages"}
						onLoadOlder={client.loadOlder}
						loading={state.freshness.state === "loading"}
						error={state.error}
						working={working}
						onRowRender={recordRow}
						messageActions={messageActions}
						{...(renderBrowserView === undefined ? {} : { renderBrowserView })}
						{...(turn === undefined ? {} : { turn })}
						{...(focusBrowser === undefined ? {} : { focusBrowser })}
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
								{...actions.pickers}
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
				</Profiled>
			</div>
			{profiling ? <ProfilePanel client={client} /> : null}
		</div>
	);
}
