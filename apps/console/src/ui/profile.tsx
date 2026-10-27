import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

// React Profiler evidence. With ?profile=1 every transcript row is wrapped in React's <Profiler>, whose onRender runs
// only when that row's subtree actually rendered in a commit, and the counts are kept here. The panel and the
// evidence script read them: while a long answer streams, only the streaming row (and the transcript list itself)
// should appear. Off by default, so normal use pays nothing.

export const profiling = typeof location !== "undefined" && new URLSearchParams(location.search).has("profile");

export type RenderRecord = { id: string; phase: "mount" | "update" | "nested-update"; actualMs: number; commitAt: number };

type ProfileStore = {
	records: RenderRecord[];
	/** Rows rendered per id since the last reset; phase "update" only. */
	updates: Record<string, number>;
	mounts: Record<string, number>;
	resetAt: number;
	/** Rows that existed at the reset: the earlier turns. One of these rendering again is a regression. */
	baseline: Set<string>;
	reset(ids?: Iterable<string>): void;
};

function createStore(): ProfileStore {
	const store: ProfileStore = {
		records: [],
		updates: {},
		mounts: {},
		resetAt: 0,
		baseline: new Set(),
		reset(ids) {
			store.records = [];
			store.updates = {};
			store.mounts = {};
			store.baseline = new Set(ids ?? []);
			store.resetAt = performance.now();
		},
	};
	return store;
}

declare global {
	interface Window {
		__harbourProfile?: ProfileStore;
	}
}

export const profileStore: ProfileStore | undefined = profiling ? (window.__harbourProfile = createStore()) : undefined;

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _base, _start, commitTime) => {
	const store = profileStore;
	if (store === undefined) return;
	if (store.records.length < 20_000) store.records.push({ id, phase, actualMs: actualDuration, commitAt: commitTime });
	const bucket = phase === "mount" ? store.mounts : store.updates;
	bucket[id] = (bucket[id] ?? 0) + 1;
};

export function Profiled({ id, children }: { id: string; children: ReactNode }) {
	if (!profiling) return children;
	return (
		<Profiler id={id} onRender={onRender}>
			{children}
		</Profiler>
	);
}
