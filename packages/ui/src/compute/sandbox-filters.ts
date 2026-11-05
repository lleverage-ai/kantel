// What the Sandboxes list shows: a search over each sandbox's name, address and ID, and a filter each for its state,
// its latest snapshot and its type, the dropdowns over the table (after boat.dev's, Tom, 5 Nov 2026).

import { DAY } from "../primitives/format.ts";
import type { Sandbox, SandboxKind, SandboxState } from "./compute-model.ts";

export type StateFilter = "all" | "running" | "stopped" | "error";
export type SnapshotFilter = "all" | "day" | "older" | "none";
export type TypeFilter = "all" | SandboxKind;

export interface SandboxFilters {
	readonly state: StateFilter;
	readonly snapshot: SnapshotFilter;
	readonly type: TypeFilter;
	readonly search: string;
}

export const NO_FILTERS: SandboxFilters = { state: "all", snapshot: "all", type: "all", search: "" };

/** Each filter's options, the first being "any". The label is the menu's row; `short`, the trigger's once chosen. */
export const STATE_FILTERS: readonly { value: StateFilter; label: string }[] = [
	{ value: "all", label: "Any state" },
	{ value: "running", label: "Running" },
	{ value: "stopped", label: "Stopped" },
	{ value: "error", label: "Error" },
];

export const SNAPSHOT_FILTERS: readonly { value: SnapshotFilter; label: string; short: string }[] = [
	{ value: "all", label: "Any snapshot", short: "Any" },
	{ value: "day", label: "Saved in the last day", short: "Last day" },
	{ value: "older", label: "Older than a day", short: "Older" },
	{ value: "none", label: "No snapshot yet", short: "None" },
];

export const TYPE_FILTERS: readonly { value: TypeFilter; label: string }[] = [
	{ value: "all", label: "Any type" },
	{ value: "microvm", label: "MicroVM" },
	{ value: "isolate", label: "Isolate" },
];

/** Which state filter a state counts under: starting and stopping are running's, paused is stopped's. */
export const stateBucket = (state: SandboxState): Exclude<StateFilter, "all"> =>
	state === "error" ? "error" : state === "stopped" || state === "paused" ? "stopped" : "running";

/** Which snapshot filter a sandbox counts under. */
export function snapshotBucket(box: Pick<Sandbox, "snapshot">, now: number): Exclude<SnapshotFilter, "all"> {
	if (box.snapshot === undefined) return "none";
	return now - box.snapshot.takenAt <= DAY ? "day" : "older";
}

/** Whether the search is in its name, its address or its ID, trimmed and case-blind. Empty matches everything. */
export function matchesSearch(box: Pick<Sandbox, "id" | "name" | "hostname">, search: string): boolean {
	const needle = search.trim().toLowerCase();
	if (needle === "") return true;
	return [box.name, box.hostname, box.id].some((field) => field.toLowerCase().includes(needle));
}

/** The sandboxes the filters and the search leave, in the order given. */
export function sandboxesShown(
	sandboxes: readonly Sandbox[],
	filters: SandboxFilters,
	now: number,
): readonly Sandbox[] {
	return sandboxes.filter(
		(box) =>
			(filters.state === "all" || stateBucket(box.state) === filters.state) &&
			(filters.snapshot === "all" || snapshotBucket(box, now) === filters.snapshot) &&
			(filters.type === "all" || box.kind === filters.type) &&
			matchesSearch(box, filters.search),
	);
}

/** How many sandboxes each option of a filter would leave, the other filters and the search as they are. */
export function filterCounts<K extends "state" | "snapshot" | "type">(
	sandboxes: readonly Sandbox[],
	filters: SandboxFilters,
	key: K,
	options: readonly { value: SandboxFilters[K] }[],
	now: number,
): ReadonlyMap<SandboxFilters[K], number> {
	return new Map(
		options.map((option) => [option.value, sandboxesShown(sandboxes, { ...filters, [key]: option.value }, now).length]),
	);
}

/** Whether anything narrows the list. */
export const filtered = (filters: SandboxFilters): boolean =>
	filters.state !== "all" || filters.snapshot !== "all" || filters.type !== "all" || filters.search.trim() !== "";
