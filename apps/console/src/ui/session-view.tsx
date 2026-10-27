import type { Cursor, SessionStatus } from "@harbour/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionHealth, Freshness, SessionClient } from "../state/session-client.ts";
import { Profiled, profiling } from "./profile.tsx";
import { ProfilePanel } from "./profile-panel.tsx";
import { Transcript } from "./transcript.tsx";

function useNow(enabled: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [enabled]);
	return now;
}

/** Connection health: is the link to the host up? Separate from whether the data is current. */
function ConnectionPill({ health }: { health: ConnectionHealth }) {
	const now = useNow(health.status === "offline");
	if (health.status === "open")
		return (
			<span className="pill pill-ok" title="Connected to the session host">
				<i />
				Connected
			</span>
		);
	if (health.status === "connecting")
		return (
			<span className="pill pill-wait">
				<i />
				Connecting…
			</span>
		);
	const wait = Math.max(0, Math.ceil((health.retryAt - now) / 1000));
	return (
		<span className="pill pill-off">
			<i />
			{wait > 0 ? `Offline · retrying in ${wait} s` : "Reconnecting…"}
		</span>
	);
}

/** Data freshness: is what's shown the host's latest? */
function freshnessText(freshness: Freshness, cursor: Cursor | undefined): string {
	switch (freshness.state) {
		case "loading":
			return "Loading";
		case "catching-up":
			return `Catching up to ${freshness.head}`;
		case "stale":
			return `Showing ${cursor ?? "nothing"}, may be behind`;
		case "current":
			return `Up to date · ${cursor ?? "start"}`;
	}
}

const runLabel: Record<SessionStatus, string> = {
	idle: "Done",
	running: "Working",
	waiting: "Waiting on you",
	done: "Done",
	failed: "Failed",
	cancelled: "Stopped",
};

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
	const loaded = state.items.length;
	const last = state.resumes.at(-1);

	return (
		<div className="app">
			<header className="bar">
				<div className="bar-main">
					<div className="title-line">
						<span className={`run run-${state.status}`}>{runLabel[state.status]}</span>
						<h1 title={state.title}>{state.title || "Session"}</h1>
					</div>
					<div className="meta">
						<ConnectionPill health={state.connection} />
						<span className="fresh">{freshnessText(state.freshness, state.cursor)}</span>
					</div>
				</div>
				<button
					type="button"
					className="menu-button"
					aria-expanded={menu}
					aria-label="Session options"
					onClick={() => setMenu((open) => !open)}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
						<circle cx="8" cy="8" r="1.3" fill="currentColor" />
						<circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
					</svg>
				</button>
				{menu ? (
					<div className="menu" role="menu">
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								client.simulateDisconnect(3000);
								setMenu(false);
							}}
							disabled={state.connection.status !== "open"}
						>
							Drop the connection for 3 s
						</button>
						<div className="menu-label">Recorded session</div>
						{fixtures.map((fixture) => (
							<a
								key={fixture.id}
								role="menuitem"
								href={`?session=${fixture.id}${profiling ? "&profile=1" : ""}`}
								aria-current={fixture.id === current}
							>
								{fixture.label}
							</a>
						))}
						<div className="menu-label">Stream</div>
						<div className="menu-facts">
							<span>
								{loaded.toLocaleString("en-GB")} items loaded
								{state.hasEarlier ? ", earlier ones on scroll" : ", the whole session"}
							</span>
							<span>{state.flushes.toLocaleString("en-GB")} renders from the stream</span>
							{last ? (
								<span>
									Last resume: from {last.from ?? "start"} by {last.how}
								</span>
							) : null}
						</div>
					</div>
				) : null}
			</header>
			<main className="main">
				<Profiled id="transcript-list">
					<Transcript
						items={state.items}
						hasOlder={state.hasEarlier}
						loadingOlder={state.loadingOlder}
						onLoadOlder={client.loadOlder}
					/>
				</Profiled>
			</main>
			<footer className="composer">
				<div className="column">
					<div className="composer-box" aria-disabled="true">
						<span>Replaying a recorded session. Steering arrives with the live host.</span>
					</div>
				</div>
			</footer>
			{profiling ? <ProfilePanel client={client} /> : null}
		</div>
	);
}
