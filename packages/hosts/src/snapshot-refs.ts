/**
 * A snapshot's `ref` as the compute API keeps it (docs/design/disk-store.md, "Phase 3 notes"). A saved snapshot taken on
 * a host that syncs snapshots (`HOST_FEATURES.snapshotSync`) is named by its ID alone (`SAVED_SNAPSHOT_ID`), unique
 * across hosts: the hosts holding it are the catalogue's (`disk_holders`, kind `snapshot`), its first the host it was
 * taken on (`TakenSnapshot.hostId`), and a sandbox made from it may go on any of them, or on another host that fetches
 * it first. Any other snapshot is `{hostId}/{snapshotId}`, on that host: an automatic one, one taken on a host from
 * before snapshot sync, and every saved snapshot from before this. Such a ref still names its host as the snapshot's
 * first holder, and copies of it are held under it too. A ref naming a host always means that host's copy, so the
 * compute API names a copy on a host for a call to that host (its files, its delete) as `{hostId}/{snapshotId}`.
 */

/** A saved snapshot's ID on its hosts, which is its ref alone: `ssnap_` and 32 hex digits. */
export const SAVED_SNAPSHOT_ID = /^ssnap_[0-9a-f]{32}$/;

/** A new saved snapshot's ID (`SAVED_SNAPSHOT_ID`). */
export const savedSnapshotId = (): string =>
	`ssnap_${[...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

/** Whether a ref is a saved snapshot's ID alone, which names no host (`SAVED_SNAPSHOT_ID`). */
export const isSavedSnapshotRef = (ref: string): boolean => SAVED_SNAPSHOT_ID.test(ref);

/** The ref of a host's snapshot `snapshotId`: its ID alone for a saved snapshot's (`SAVED_SNAPSHOT_ID`), else `{hostId}/{snapshotId}`. */
export const snapshotRef = (hostId: string, snapshotId: string): string =>
	isSavedSnapshotRef(snapshotId) ? snapshotId : `${hostId}/${snapshotId}`;

/**
 * A ref's parts: the snapshot's ID on its hosts, and the host the ref names, absent for a saved snapshot's ID alone.
 * Undefined for anything else (another backend's ref, or none).
 */
export function parseSnapshotRef(ref: string): { readonly hostId?: string; readonly snapshotId: string } | undefined {
	if (isSavedSnapshotRef(ref)) return { snapshotId: ref };
	const [hostId, snapshotId, extra] = ref.split("/");
	if (hostId === undefined || snapshotId === undefined || extra !== undefined || hostId === "" || snapshotId === "") {
		return undefined;
	}
	return { hostId, snapshotId };
}
