// Sticky disks' words and sums (compute console, Disks): the disks grouped by the pool they are in, the hosts each
// disk's versions were committed on and what they took there, why a new disk's name or size won't do, and the rules the
// page keeps its own changes and dialogs by. Kept apart from the page so they're tested on their own.
//
// A version names only the host it was committed on. The API lists no host's copies (a pool's hosts fetch versions
// from one another), so the page reports where versions were committed, not every host that has one.

import { bytesText } from "../primitives/format.ts";
import {
	STICKY_DISK_MAX_GB,
	STICKY_DISK_NAME_PATTERN,
	type StickyDisk,
	type StickyDiskPool,
	type StickyDiskVersion,
} from "./compute-model.ts";

/** The most versions the API lists for a disk: with that many, there may be more. */
export const VERSIONS_LISTED = 20;

/** A pool and its disks, as the Disks page lists them. */
export interface StickyDiskGroup {
	/** The pool's ID; empty for the disks in no pool yet. */
	readonly id: string;
	/** The pool, where the viewer may see it. Absent: a shared pool they can't, or no pool yet (`id` empty). */
	readonly pool?: StickyDiskPool;
	readonly disks: readonly StickyDisk[];
}

const byPool = (a: StickyDiskPool, b: StickyDiskPool): number =>
	(a.shared === true) !== (b.shared === true)
		? a.shared === true
			? 1
			: -1
		: a.default !== b.default
			? a.default
				? -1
				: 1
			: a.name.localeCompare(b.name);

/**
 * The disks by pool, only pools that have one: the account's own pools (the default first, then by name), the
 * deployment's shared ones, pools the viewer can't see, then disks in no pool yet. Each pool's disks by name.
 */
export function stickyDiskGroups(
	disks: readonly StickyDisk[],
	pools: readonly StickyDiskPool[],
): readonly StickyDiskGroup[] {
	const ordered = [...pools].sort(byPool);
	const known = new Map(ordered.map((pool) => [pool.id, pool]));
	const sorted = [...disks].sort((a, b) => a.name.localeCompare(b.name));
	const ids = [
		...ordered.map((pool) => pool.id),
		...[...new Set(sorted.map((disk) => disk.poolId ?? ""))].filter((id) => id !== "" && !known.has(id)).sort(),
		"",
	];
	return ids.flatMap((id): StickyDiskGroup[] => {
		const inPool = sorted.filter((disk) => (disk.poolId ?? "") === id);
		if (inPool.length === 0) return [];
		const pool = known.get(id);
		return [{ id, ...(pool === undefined ? {} : { pool }), disks: inPool }];
	});
}

/**
 * A group's heading: the pool's name, or what stands in for one the viewer can't see. With `poolsRead` false (the pools
 * couldn't be read), a pool not known is any pool, so it's named by its ID.
 */
export function groupTitle(group: Pick<StickyDiskGroup, "id" | "pool">, poolsRead = true): string {
	if (group.pool !== undefined) return group.pool.name;
	if (group.id === "") return "No pool yet";
	return poolsRead ? "Shared pool" : group.id;
}

/** A host that committed versions of a disk: how many of the listed versions, and what they took there. */
export interface StickyDiskHost {
	readonly hostId: string;
	/** Absent where the viewer may not see the host. */
	readonly hostName?: string;
	/** How many of the listed versions were committed on it. */
	readonly versions: number;
	/** Those versions' allocated bytes added up. Versions share unchanged blocks, so they take at most this. */
	readonly allocatedBytes: number;
}

/**
 * The hosts the disk's listed versions were committed on (each version's `hostId`), the one with most allocated first,
 * then by name. Not every host with a copy: one fetched from another host isn't a version of its own.
 */
export function commitHosts(disk: Pick<StickyDisk, "versions">): readonly StickyDiskHost[] {
	const hosts = new Map<string, StickyDiskHost>();
	for (const version of disk.versions) {
		const seen = hosts.get(version.hostId);
		hosts.set(version.hostId, {
			hostId: version.hostId,
			...((seen?.hostName ?? version.hostName) === undefined ? {} : { hostName: seen?.hostName ?? version.hostName }),
			versions: (seen?.versions ?? 0) + 1,
			allocatedBytes: (seen?.allocatedBytes ?? 0) + version.allocatedBytes,
		});
	}
	return [...hosts.values()].sort(
		(a, b) =>
			b.allocatedBytes - a.allocatedBytes ||
			(a.hostName ?? "￿").localeCompare(b.hostName ?? "￿") ||
			a.hostId.localeCompare(b.hostId),
	);
}

/** A host as a row names it: its name, or "Shared host" for one the viewer can't see. */
export const hostLabel = (host: Pick<StickyDiskHost, "hostName">): string => host.hostName ?? "Shared host";

/** Every listed version's allocated bytes, as committed, added up. */
export const allocatedTotal = (disk: Pick<StickyDisk, "versions">): number =>
	disk.versions.reduce((sum, version) => sum + version.allocatedBytes, 0);

/** "1.2 GB", or a dash's absence (undefined) for a disk with no versions yet. */
export const allocatedText = (bytes: number): string | undefined => (bytes === 0 ? undefined : bytesText(bytes));

/** "hetzner-fsn1-01", "hetzner-fsn1-01 and 2 more": a row's hosts in one line; undefined for none. */
export function hostsText(hosts: readonly Pick<StickyDiskHost, "hostName">[]): string | undefined {
	const [first] = hosts;
	if (first === undefined) return undefined;
	return hosts.length === 1 ? hostLabel(first) : `${hostLabel(first)} and ${hosts.length - 1} more`;
}

/** Each host on a line with what it takes, for a row's hover text. */
export const hostsTitle = (hosts: readonly StickyDiskHost[]): string =>
	hosts.map((host) => `${hostLabel(host)}: ${bytesText(host.allocatedBytes)}`).join("\n");

/** "3", or "20+" where the API listed as many as it lists. */
export const versionsText = (count: number): string => (count >= VERSIONS_LISTED ? `${VERSIONS_LISTED}+` : `${count}`);

/** The disk's head version, where it has one and it's among those listed. */
export function headVersion(disk: Pick<StickyDisk, "head" | "versions">): StickyDiskVersion | undefined {
	return disk.head === undefined ? undefined : disk.versions.find((version) => version.id === disk.head);
}

/** "150 GB", "1,024 GB". */
export const sizeGbText = (gb: number): string => `${gb.toLocaleString("en-GB")} GB`;

/** Why a new disk's name won't do, or undefined when it will (or there's none yet to judge). */
export function stickyDiskNameError(name: string): string | undefined {
	if (name === "") return undefined;
	return STICKY_DISK_NAME_PATTERN.test(name)
		? undefined
		: "Lower-case letters, digits and hyphens, starting with a letter or digit, up to 63.";
}

/** Why a new disk's size won't do, or undefined when it will (or there's none yet to judge). */
export function sizeGbError(text: string): string | undefined {
	if (text.trim() === "") return undefined;
	const gb = Number(text);
	return Number.isInteger(gb) && gb >= 1 && gb <= STICKY_DISK_MAX_GB
		? undefined
		: `A whole number of GB from 1 to ${STICKY_DISK_MAX_GB.toLocaleString("en-GB")}.`;
}

/** The pool a new disk starts on: the account's default, else a shared default, else the first; empty for none. */
export function defaultPoolId(pools: readonly StickyDiskPool[]): string {
	return (
		pools.find((pool) => pool.default && pool.shared !== true)?.id ??
		pools.find((pool) => pool.default)?.id ??
		pools[0]?.id ??
		""
	);
}

/** A pool as a choice: its name, and that it's the default or shared where that isn't already its name. */
export function poolChoiceLabel(pool: StickyDiskPool): string {
	const notes = [
		...(pool.shared === true ? ["shared"] : []),
		...(pool.default && pool.name !== "default" ? ["default"] : []),
	];
	return notes.length === 0 ? pool.name : `${pool.name} (${notes.join(", ")})`;
}

/** Pools in the order a choice lists them: the account's own (default first), then shared ones. */
export const orderedPools = (pools: readonly StickyDiskPool[]): readonly StickyDiskPool[] => [...pools].sort(byPool);

/** The pool a new disk is made in: the one picked, while it's still a choice, else the default (empty for none). */
export function chosenPool(picked: string | undefined, pools: readonly StickyDiskPool[]): string {
	return picked !== undefined && pools.some((pool) => pool.id === picked) ? picked : defaultPoolId(pools);
}

/** A disk made (the disk) or deleted (null) on the page, numbered in the order the changes completed. */
export interface LocalChange {
	readonly disk: StickyDisk | null;
	readonly seq: number;
}

/**
 * The disks a read answered, with the page's own changes it can't have seen: only those numbered after `readAt`, the
 * last change's number when the read began. A read begun after a change saw it, so it, not the change, is shown.
 */
export function withLocalChanges(
	listed: readonly StickyDisk[],
	readAt: number,
	changes: ReadonlyMap<string, LocalChange>,
): readonly StickyDisk[] {
	const byId = new Map(listed.map((disk) => [disk.id, disk]));
	for (const [id, change] of changes) {
		if (change.seq <= readAt) continue;
		if (change.disk === null) byId.delete(id);
		else byId.set(id, change.disk);
	}
	return [...byId.values()];
}

/** A dialog opened on the page, numbered so a request it started can tell whether it is still the one showing. */
export interface DialogSession {
	readonly session: number;
}

/** The dialog showing once `session`'s request has finished: closed if it's still that one, else left as it is. */
export const endSession = <T extends DialogSession>(current: T | undefined, session: number): T | undefined =>
	current?.session === session ? undefined : current;
