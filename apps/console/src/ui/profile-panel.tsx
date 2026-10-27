import { useEffect, useState } from "react";
import type { SessionClient } from "../state/session-client.ts";
import { profileStore } from "./profile.tsx";

// The Profiler's findings, live: which rows React rendered since "Reset", and how often. Shown with ?profile=1.

export function ProfilePanel({ client }: { client: SessionClient }) {
	const [, tick] = useState(0);
	const [open, setOpen] = useState(true);
	useEffect(() => {
		const timer = setInterval(() => tick((value) => value + 1), 500);
		return () => clearInterval(timer);
	}, []);
	const store = profileStore;
	if (store === undefined) return null;
	const updated = Object.entries(store.updates).sort((a, b) => b[1] - a[1]);
	const mounted = Object.keys(store.mounts).length;
	const state = client.getState();
	const items = state.transcript.items;
	const streamingId = items.findLast((item) => item.kind === "assistant" && item.status === "streaming")?.id;
	const earlier = updated.filter(([id]) => id !== streamingId && !id.startsWith("tool:") && items.findIndex((item) => item.id === id) < items.length - 8);
	return (
		<aside className={`profile${open ? "" : " profile-closed"}`} aria-label="React Profiler">
			<div className="profile-head">
				<strong>React Profiler</strong>
				<button type="button" onClick={() => store.reset()}>Reset</button>
				<button type="button" onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Show"}</button>
			</div>
			{open ? (
				<>
					<div className="profile-facts">
						<span>Stream renders: {state.flushes}</span>
						<span>Rows mounted: {mounted}</span>
						<span>Rows re-rendered: {updated.length}</span>
						<span className={earlier.length === 0 ? "ok" : "bad"}>Earlier turns re-rendered: {earlier.length}</span>
					</div>
					<ol className="profile-list">
						{updated.slice(0, 8).map(([id, count]) => (
							<li key={id}>
								<code>{id}</code> <span>{count}×</span>
							</li>
						))}
					</ol>
				</>
			) : null}
		</aside>
	);
}
