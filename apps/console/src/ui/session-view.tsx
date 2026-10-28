import type { Cursor, SessionStatus, TranscriptItem } from "@harbour/protocol";
import {
	Button,
	Composer,
	type ConnectionStateValue,
	DotsIcon,
	FileIcon,
	IconButton,
	Notice,
	SessionHeader,
	type Status,
	Transcript,
} from "@harbour/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { needsOf } from "../state/needs.ts";
import type { ConnectionHealth, Freshness, SessionClient } from "../state/session-client.ts";
import { composerState, offersFollowUp, type SessionActions } from "./actions.ts";
import { Profiled, profiling, recordRow } from "./profile.tsx";
import { ProfilePanel } from "./profile-panel.tsx";

// The console is a host for @harbour/ui: the header, transcript and composer are the library's, and this file only
// maps the session client's state onto their props. Anything that looks like a new component belongs in
// packages/ui, not here (AGENTS.md).

/** The protocol's run status in the library's words. A finished run reads Done; a stopped one is idle. */
const statusOf: Record<SessionStatus, Status> = {
	idle: "done",
	running: "working",
	waiting: "waiting",
	done: "done",
	failed: "error",
	cancelled: "idle",
};

/** The header's status: a waiting session says whether it needs an approval or an answer, as the list does. */
export function headerStatus(status: SessionStatus, items: readonly TranscriptItem[]): Status {
	if (status === "waiting" && needsOf(items) === "approval") return "approval";
	return statusOf[status];
}

function connectionOf(health: ConnectionHealth): ConnectionStateValue {
	return health.status === "offline" ? { state: "offline", retryAt: health.retryAt } : { state: health.status };
}

/** Data freshness: is what's shown the host's latest? Separate from whether the link is up. */
function FreshnessText({ freshness, cursor }: { freshness: Freshness; cursor: Cursor | undefined }) {
	switch (freshness.state) {
		case "loading":
			return <span className="console-fresh">Loading</span>;
		case "catching-up":
			return (
				<span className="console-fresh">
					Catching up to <code>{freshness.head}</code>
				</span>
			);
		case "stale":
			return (
				<span className="console-fresh console-fresh-stale">
					May be behind, showing <code>{cursor ?? "nothing"}</code>
				</span>
			);
		case "current":
			return (
				<span className="console-fresh">
					Up to date at <code>{cursor ?? "start"}</code>
				</span>
			);
	}
}

export function SessionView({
	client,
	project,
	actions,
	onBack,
	onFiles,
}: {
	client: SessionClient;
	/** The project's name, shown with the session's facts. */
	project?: string;
	actions: SessionActions;
	/** Shows Back, on a phone, to return to the list. */
	onBack?: () => void;
	/** Shows Files, to browse the session's workspace. */
	onFiles?: () => void;
}) {
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

	const { control } = actions;

	return (
		<div className="console">
			<SessionHeader
				title={state.title}
				status={headerStatus(state.status, state.items)}
				connection={connectionOf(state.connection)}
				loading={state.freshness.state === "loading" && state.title === ""}
				onBack={onBack}
				meta={
					<>
						{project === undefined ? null : <span className="console-project">{project}</span>}
						<FreshnessText freshness={state.freshness} cursor={state.cursor} />
					</>
				}
				actions={
					<div className="console-actions">
						{onFiles === undefined ? null : (
							<Button variant="ghost" size="sm" icon={<FileIcon />} onClick={onFiles}>
								Files
							</Button>
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
						onRowRender={recordRow}
						dock={
							<Composer
								state={composerState(control, state.status, actions.sending)}
								disabledReason={control.live ? undefined : control.reason}
								label="Message"
								banner={actions.failure === undefined ? undefined : <Notice level="error">{actions.failure}</Notice>}
								value={actions.draft}
								onChange={actions.onDraft}
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
