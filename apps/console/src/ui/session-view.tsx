import type { Cursor, SessionStatus } from "@harbour/protocol";
import {
	Button,
	Composer,
	type ConnectionStateValue,
	DotsIcon,
	IconButton,
	SessionHeader,
	type Status,
	Transcript,
} from "@harbour/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConnectionHealth, Freshness, SessionClient } from "../state/session-client.ts";
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

const noop = () => {};

export function SessionView({
	client,
	fixtures,
	current,
}: {
	client: SessionClient;
	fixtures: readonly { id: string; label: string }[];
	current: string;
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

	return (
		<div className="console hb-app">
			<SessionHeader
				title={state.title}
				status={statusOf[state.status]}
				connection={connectionOf(state.connection)}
				loading={state.freshness.state === "loading" && state.title === ""}
				meta={<FreshnessText freshness={state.freshness} cursor={state.cursor} />}
				actions={
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
								<div className="console-menu-label">Recorded session</div>
								{fixtures.map((fixture) => (
									<a
										key={fixture.id}
										className="console-menu-link hb-focusable"
										href={`?session=${fixture.id}${profiling ? "&profile=1" : ""}`}
										aria-current={fixture.id === current ? "page" : undefined}
									>
										{fixture.label}
									</a>
								))}
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
				}
			/>
			<main className="console-main">
				<Profiled id="transcript-list">
					<Transcript
						items={state.items}
						hasOlder={state.hasEarlier}
						loadingOlder={state.loadingOlder}
						onLoadOlder={client.loadOlder}
						loading={state.freshness.state === "loading"}
						error={state.error}
						onRowRender={recordRow}
					/>
				</Profiled>
			</main>
			<footer className="console-composer">
				<Composer
					state="disabled"
					disabledReason="Replaying a recorded session. Steering arrives with the live host."
					label="Message"
					onSend={noop}
				/>
			</footer>
			{profiling ? <ProfilePanel client={client} /> : null}
		</div>
	);
}
