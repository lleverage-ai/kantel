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
		// Floats above the composer.
		<aside
			className="fixed z-(--hb-z-overlay) right-2.5 bottom-[calc(var(--hb-step-12)*2)] w-sidebar max-w-[calc(100vw-var(--hb-step-5))] py-2 px-2.5 border border-border-strong rounded-panel bg-raised shadow-float text-fg text-xs"
			aria-label="React Profiler"
		>
			<div className="flex items-center gap-1">
				<strong className="flex-1 font-medium">React Profiler</strong>
				<Button size="sm" variant="secondary" onClick={() => store.reset(state.items.map((item) => item.id))}>
					Reset
				</Button>
				<Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					{open ? "Hide" : "Show"}
				</Button>
			</div>
			{open ? (
				<>
					<div className="grid grid-cols-[1fr_1fr] gap-x-2 gap-y-0.5 mt-2 mx-0 mb-1 text-muted tabular-nums">
						<span>List renders: {store.updates[list] ?? 0}</span>
						<span>Rows mounted: {mounted}</span>
						<span>Rows re-rendered: {updated.length}</span>
						<span className={`col-span-full ${earlier.length === 0 ? "text-status-done" : "text-status-error"}`}>
							Earlier rows re-rendered: {earlier.length} of {store.baseline.size}
						</span>
					</div>
					<ol className="mt-1 mx-0 mb-0 pl-4 text-muted">
						{updated.slice(0, 8).map(([id, count]) => (
							<li key={id}>
								<code className="font-mono text-2xs">{id}</code> <span>{count} times</span>
							</li>
						))}
					</ol>
				</>
			) : null}
		</aside>
	);
}
