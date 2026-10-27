import { Button } from "@harbour/ui";
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
	const list = "transcript-list";
	const updated = Object.entries(store.updates)
		.filter(([id]) => id !== list)
		.sort((a, b) => b[1] - a[1]);
	const mounted = Object.keys(store.mounts).filter((id) => id !== list).length;
	const state = client.getState();
	const earlier = updated.filter(([id]) => store.baseline.has(id));
	return (
		<aside className={`profile${open ? "" : " profile-closed"}`} aria-label="React Profiler">
			<div className="profile-head">
				<strong>React Profiler</strong>
				<Button size="sm" variant="secondary" onClick={() => store.reset(state.items.map((item) => item.id))}>
					Reset
				</Button>
				<Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					{open ? "Hide" : "Show"}
				</Button>
			</div>
			{open ? (
				<>
					<div className="profile-facts">
						<span>List renders: {store.updates[list] ?? 0}</span>
						<span>Rows mounted: {mounted}</span>
						<span>Rows re-rendered: {updated.length}</span>
						<span className={earlier.length === 0 ? "ok" : "bad"}>
							Earlier rows re-rendered: {earlier.length} of {store.baseline.size}
						</span>
					</div>
					<ol className="profile-list">
						{updated.slice(0, 8).map(([id, count]) => (
							<li key={id}>
								<code>{id}</code> <span>{count} times</span>
							</li>
						))}
					</ol>
				</>
			) : null}
		</aside>
	);
}
