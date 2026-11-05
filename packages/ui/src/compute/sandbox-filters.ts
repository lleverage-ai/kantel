// What the Sandboxes list shows: a search over each sandbox's name, address and ID, and a filter each for its state,
// its latest snapshot, its type and who made it, the dropdowns over the table (after boat.dev's, Tom, 5 Nov 2026).

import { DAY } from "../primitives/format.ts";
import type { Sandbox, SandboxKind, SandboxState } from "./compute-model.ts";

export type StateFilter = "all" | "running" | "stopped" | "error";
export type SnapshotFilter = "all" | "day" | "older" | "none";
export type TypeFilter = "all" | SandboxKind;
/** `all`, or the ID of the person or API key that made it. */
export type CreatorFilter = string;

export interface SandboxFilters {
	readonly state: StateFilter;
	readonly snapshot: SnapshotFilter;
	readonly type: TypeFilter;
	/** Who made it; absent is anyone, as `all` is. */
	readonly creator?: CreatorFilter;
	readonly search: string;
}

export const NO_FILTERS: SandboxFilters = { state: "all", snapshot: "all", type: "all", creator: "all", search: "" };

const anyCreator = (filters: SandboxFilters): boolean => filters.creator === undefined || filters.creator === "all";

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

/**
 * Which snapshot filter a sandbox counts under: `unknown`, which no filter but Any picks, for a snapshot whose time the
 * source doesn't say.
 */
export function snapshotBucket(
	box: Pick<Sandbox, "snapshot">,
	now: number,
): Exclude<SnapshotFilter, "all"> | "unknown" {
	if (box.snapshot === undefined) return "none";
	if (box.snapshot.takenAt === undefined) return "unknown";
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
			(anyCreator(filters) || box.creator?.id === filters.creator) &&
			matchesSearch(box, filters.search),
	);
}

/** How many sandboxes each option of a filter would leave, the other filters and the search as they are. */
export function filterCounts<K extends "state" | "snapshot" | "type" | "creator">(
	sandboxes: readonly Sandbox[],
	filters: SandboxFilters,
	key: K,
	options: readonly { value: NonNullable<SandboxFilters[K]> }[],
	now: number,
): ReadonlyMap<NonNullable<SandboxFilters[K]>, number> {
	return new Map(
		options.map((option) => [option.value, sandboxesShown(sandboxes, { ...filters, [key]: option.value }, now).length]),
	);
}

/** Whether anything narrows the list. */
export const filtered = (filters: SandboxFilters): boolean =>
	filters.state !== "all" ||
	filters.snapshot !== "all" ||
	filters.type !== "all" ||
	!anyCreator(filters) ||
	filters.search.trim() !== "";

/** Who made a sandbox, as the list says it: "You" for the viewer, an API key's name with "(API key)". */
export function creatorText(box: Pick<Sandbox, "createdBy" | "creator">, viewerId: string | undefined): string {
	if (box.creator !== undefined && viewerId !== undefined && box.creator.id === viewerId) return "You";
	const name = box.createdBy || box.creator?.id || "";
	return box.creator?.kind === "api_key" && name !== "" ? `${name} (API key)` : name;
}

/**
 * The Created by filter's options: Anyone, then You (the viewer, whether or not they made any here), then everyone
 * else who made one, by name.
 */
export function creatorFilters(
	sandboxes: readonly Pick<Sandbox, "createdBy" | "creator">[],
	viewerId: string | undefined,
): readonly { value: CreatorFilter; label: string }[] {
	const others = new Map<string, string>();
	for (const box of sandboxes) {
		if (box.creator === undefined || box.creator.id === viewerId || others.has(box.creator.id)) continue;
		others.set(box.creator.id, creatorText(box, viewerId));
	}
	return [
		{ value: "all", label: "Anyone" },
		...(viewerId === undefined ? [] : [{ value: viewerId, label: "You" }]),
		...[...others].sort(([, a], [, b]) => a.localeCompare(b)).map(([value, label]) => ({ value, label })),
	];
}

/** How many people and API keys made the sandboxes listed. */
export const creatorCount = (sandboxes: readonly Pick<Sandbox, "creator">[]): number =>
	new Set(sandboxes.flatMap((box) => (box.creator === undefined ? [] : [box.creator.id]))).size;
