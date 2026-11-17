// What the Sandboxes list shows: a search over each sandbox's name, address and ID, and a filter each for its state,
// its latest snapshot, its type, who made it, its pool, its host and its labels, the dropdowns over the table (after
// boat.dev's, Tom, 5 Nov 2026).

import { DAY } from "../primitives/format.ts";
import type { Sandbox, SandboxKind, SandboxState } from "./compute-model.ts";

export type StateFilter = "all" | "running" | "stopped" | "error";
export type SnapshotFilter = "all" | "day" | "older" | "none";
export type TypeFilter = "all" | SandboxKind;
/** `all`, or the ID of the person or API key that made it. */
export type CreatorFilter = string;
/** `all`, or a pool's ID. */
export type PoolFilter = string;
/** `all`, or a host's ID. */
export type HostFilter = string;
/** `all`, or one label as `key=value`. */
export type LabelFilter = string;

export interface SandboxFilters {
	readonly state: StateFilter;
	readonly snapshot: SnapshotFilter;
	readonly type: TypeFilter;
	/** Who made it; absent is anyone, as `all` is. */
	readonly creator?: CreatorFilter;
	/** The pool it was placed in; absent is any, as `all` is. */
	readonly pool?: PoolFilter;
	/** The host it runs on (or last ran on); absent is any, as `all` is. */
	readonly host?: HostFilter;
	/** A label it has, as `key=value`; absent is any, as `all` is. */
	readonly label?: LabelFilter;
	readonly search: string;
}

export const NO_FILTERS: SandboxFilters = {
	state: "all",
	snapshot: "all",
	type: "all",
	creator: "all",
	pool: "all",
	host: "all",
	label: "all",
	search: "",
};

/** The filters that may be absent, which is "any". */
type OptionalFilter = "creator" | "pool" | "host" | "label";

/** Whether an optional filter lets every sandbox through. */
export const anyOf = (filters: SandboxFilters, key: OptionalFilter): boolean =>
	filters[key] === undefined || filters[key] === "all";

/** A label as the Label filter and the API's `label.key=value` say it. */
export const labelText = (key: string, value: string): string => `${key}=${value}`;

/** Whether a sandbox has the label `key=value`. */
function hasLabel(box: Pick<Sandbox, "labels">, label: string): boolean {
	return Object.entries(box.labels ?? {}).some(([key, value]) => labelText(key, value) === label);
}

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
			(anyOf(filters, "creator") || box.creator?.id === filters.creator) &&
			(anyOf(filters, "pool") || box.poolId === filters.pool) &&
			(anyOf(filters, "host") || box.hostId === filters.host) &&
			(anyOf(filters, "label") || hasLabel(box, filters.label ?? "")) &&
			matchesSearch(box, filters.search),
	);
}

/** How many sandboxes each option of a filter would leave, the other filters and the search as they are. */
export function filterCounts<K extends "state" | "snapshot" | "type" | OptionalFilter>(
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
	!anyOf(filters, "creator") ||
	!anyOf(filters, "pool") ||
	!anyOf(filters, "host") ||
	!anyOf(filters, "label") ||
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

/**
 * The Pool filter's options: Any pool, then each pool a listed sandbox is in (and the chosen one, though none is), by name. A pool the account's list doesn't
 * name (it couldn't be read, or the sandbox is another account's host's) goes by its ID.
 */
export function poolFilters(
	sandboxes: readonly Pick<Sandbox, "poolId">[],
	poolNames: ReadonlyMap<string, string>,
	chosen: PoolFilter = "all",
): readonly { value: PoolFilter; label: string }[] {
	const ids = new Set(sandboxes.flatMap((box) => (box.poolId === undefined ? [] : [box.poolId])));
	if (chosen !== "all") ids.add(chosen);
	return [
		{ value: "all", label: "Any pool" },
		...[...ids]
			.map((id) => ({ value: id, label: poolNames.get(id) ?? id }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	];
}

/** The Host filter's options: Any host, then each host a listed sandbox is on (and the chosen one), by name. */
export function hostFilters(
	sandboxes: readonly Pick<Sandbox, "hostId" | "hostName">[],
	chosen: HostFilter = "all",
): readonly { value: HostFilter; label: string }[] {
	const hosts = new Map<string, string>(chosen === "all" ? [] : [[chosen, chosen]]);
	for (const box of sandboxes) {
		if (box.hostId === undefined) continue;
		if (!hosts.has(box.hostId) || box.hostName !== undefined) hosts.set(box.hostId, box.hostName ?? box.hostId);
	}
	return [
		{ value: "all", label: "Any host" },
		...[...hosts].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
	];
}

/** The Label filter's options: Any label, then each `key=value` a listed sandbox has (and the chosen one), in order. */
export function labelFilters(
	sandboxes: readonly Pick<Sandbox, "labels">[],
	chosen: LabelFilter = "all",
): readonly { value: LabelFilter; label: string }[] {
	const labels = new Set(
		sandboxes.flatMap((box) => Object.entries(box.labels ?? {}).map(([key, value]) => labelText(key, value))),
	);
	if (chosen !== "all") labels.add(chosen);
	return [
		{ value: "all", label: "Any label" },
		...[...labels].sort((a, b) => a.localeCompare(b)).map((label) => ({ value: label, label })),
	];
}
