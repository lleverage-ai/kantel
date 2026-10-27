import type { RowRenderPhase } from "@harbour/ui";
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

// React Profiler evidence. With ?profile=1 the transcript list is wrapped in React's <Profiler> for its commit
// timings, and @harbour/ui's Transcript reports every row it renders, mount or update, through onRowRender. The
// counts are kept here. The panel and the evidence script read them: while a long answer streams, only the
// streaming row (and the transcript list itself) should appear. Off by default, so normal use pays nothing.

export const profiling = typeof location !== "undefined" && new URLSearchParams(location.search).has("profile");

export type RenderRecord = {
	id: string;
	phase: "mount" | "update" | "nested-update";
	actualMs: number;
	commitAt: number;
};

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

export const profileStore: ProfileStore | undefined = profiling ? createStore() : undefined;
if (profileStore !== undefined) window.__harbourProfile = profileStore;

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, _base, _start, commitTime) => {
	const store = profileStore;
	if (store === undefined) return;
	if (store.records.length < 20_000) store.records.push({ id, phase, actualMs: actualDuration, commitAt: commitTime });
	const bucket = phase === "mount" ? store.mounts : store.updates;
	bucket[id] = (bucket[id] ?? 0) + 1;
};

/** The transcript's onRowRender while profiling; undefined otherwise, so rows report to nothing. */
export const recordRow: ((id: string, phase: RowRenderPhase) => void) | undefined =
	profileStore === undefined
		? undefined
		: (id, phase) => {
				const bucket = phase === "mount" ? profileStore.mounts : profileStore.updates;
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
