// A host's sync, when its row on the Hosts page is opened, above its peers: each sticky disk head it should hold in its
// pool (one with sync on keeps every host caught up on the disks its pool used in the last 7 days), whether it holds
// it, is fetching it from a peer (with how far it has got), failed (with the error), or why it can't yet; then its other
// fetches (template snapshots, images, saved snapshots, moves). As the host last reported them, every heartbeat. A host
// whose pool doesn't sync, and that fetches nothing, says so instead.

import { bytesText } from "../primitives/format.ts";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import type { Status } from "../tokens/tokens.ts";
import type {
	Host,
	HostSyncDisk,
	HostSyncDiskState,
	HostSyncFetch,
	HostSync as HostSyncModel,
} from "./compute-model.ts";
import { cellMono, ProgressBar, table, tableFrame, td, th } from "./parts.tsx";

export interface HostSyncProps {
	readonly host: Pick<Host, "name" | "state" | "sync">;
	/** A phone: a short row per disk and fetch instead of the tables. */
	readonly narrow?: boolean;
}

const number = (value: number): string => value.toLocaleString("en-GB");

/** A disk's state as a status and its words. */
export function syncDiskState(state: HostSyncDiskState): { readonly status: Status; readonly text: string } {
	switch (state) {
		case "held":
			return { status: "done", text: "Held" };
		case "fetching":
			return { status: "working", text: "Fetching" };
		case "failed":
			return { status: "error", text: "Failed" };
		case "missing":
			return { status: "waiting", text: "Missing" };
		case "waiting":
			return { status: "idle", text: "Queued" };
		case "no-room":
			return { status: "error", text: "No room" };
		case "no-source":
			return { status: "approval", text: "No copy to fetch" };
	}
}

/** Why a disk's state is what it is, where its words don't say it all: for its title and a phone's row. */
export function syncDiskReason(state: HostSyncDiskState): string | undefined {
	switch (state) {
		case "missing":
			return "Kantel asks the host to fetch it on its next pass, within a minute.";
		case "waiting":
			return "It fetches two at a time, so this one waits for the fetches under way.";
		case "failed":
			return "Kantel asks the host again within 10 minutes, and it goes on from where it stopped.";
		case "no-room":
			return "The host hasn't the disk free for it and the 10 GB a fetch leaves free.";
		case "no-source":
			return "No other host of its pool that can serve it holds it now.";
		default:
			return undefined;
	}
}

/** "Holds 3 of 4 disks": how many of the heads it should hold it has. */
export function syncSummaryText(sync: Pick<HostSyncModel, "disks">): string {
	const total = sync.disks.length;
	if (total === 0) return "No disks to hold";
	const held = sync.disks.filter((disk) => disk.state === "held").length;
	if (held === total) return total === 1 ? "Holds its 1 disk" : `Holds all ${number(total)} disks`;
	return `Holds ${number(held)} of ${number(total)} ${total === 1 ? "disk" : "disks"}`;
}

/** Why it isn't fetching anything now. */
export function syncPausedText(paused: NonNullable<HostSyncModel["paused"]>): string {
	switch (paused) {
		case "draining":
			return "Draining, so it isn't asked to fetch anything new. It catches up once it's undrained.";
		case "away":
			return "Not connected. It catches up once it's back.";
		case "no-sync":
			return "It doesn't fetch from its peers yet: its host agent is too old, or its mesh isn't up.";
	}
}

/** What a fetch is of, in words: a newer host's kind as it came. */
export function fetchKindText(kind: string): string {
	switch (kind) {
		case "sticky":
			return "Sticky disk";
		case "template":
			return "Template snapshot";
		case "rootfs":
			return "Template image";
		case "snapshot":
			return "Saved snapshot";
		case "sandbox":
			return "Sandbox move";
		case "sandbox-memory":
			return "Sandbox move, memory";
		default:
			return kind;
	}
}

/** The share of a fetch's blocks in place, as a whole percentage, rounded down so 100% means done. */
export function fetchPercent(fetch: Pick<HostSyncFetch, "blocks" | "blocksInPlace">): number {
	if (fetch.blocks <= 0) return 0;
	return Math.floor((Math.min(fetch.blocksInPlace, fetch.blocks) / fetch.blocks) * 100);
}

/**
 * "40% of 12 GB in place, 1.2 GB fetched": how far a fetch has got. A queued one with no blocks yet says it's waiting.
 * Only blocks that differ from the version it started from travel, so what's fetched may be far less than its size.
 */
export function fetchProgressText(fetch: HostSyncFetch): string {
	if (fetch.blocks === 0) return fetch.state === "queued" ? "Waiting its turn" : "Starting";
	const parts = [`${fetchPercent(fetch)}% of ${bytesText(fetch.totalBytes)} in place`];
	if (fetch.bytes !== undefined && fetch.bytes > 0) parts.push(`${bytesText(fetch.bytes)} fetched`);
	return parts.join(", ");
}

/** Whether a host is caught up: its pool syncs, it isn't paused, and it holds every head it should. */
export function syncedUp(host: Pick<Host, "sync">): boolean {
	const sync = host.sync;
	return sync !== undefined && sync.paused === undefined && sync.disks.every((disk) => disk.state === "held");
}

/** The fetch of a disk's head, where the host reports one. */
const fetchOf = (disk: HostSyncDisk, fetches: readonly HostSyncFetch[]) =>
	fetches.find((fetch) => fetch.kind === "sticky" && fetch.objectId === disk.diskId && fetch.version === disk.version);

const State = ({ state }: { state: HostSyncDiskState }) => {
	const { status, text } = syncDiskState(state);
	return <StatusLabel status={status}>{text}</StatusLabel>;
};

/** A fetch's bar and words, and its error where it has one. */
function FetchProgress({ fetch, label }: { fetch: HostSyncFetch; label: string }) {
	return (
		<span className="flex min-w-0 flex-col gap-1">
			<ProgressBar
				label={`${label} fetched`}
				value={fetch.blocksInPlace}
				max={fetch.blocks}
				failed={fetch.state === "failed"}
			/>
			<span className="text-sm text-muted tabular-nums">{fetchProgressText(fetch)}</span>
			{fetch.error === undefined ? null : (
				<span className="block max-w-(--kt-popover-width) truncate text-sm text-status-error" title={fetch.error}>
					{fetch.error}
				</span>
			)}
		</span>
	);
}

/**
 * A disk's progress: its fetch's, else why it isn't fetching, else nothing (None in the table). A phone's row wraps the
 * reason rather than cutting it short, and leaves out None.
 */
function DiskProgress({
	disk,
	fetch,
	narrow = false,
}: {
	disk: HostSyncDisk;
	fetch: HostSyncFetch | undefined;
	narrow?: boolean;
}) {
	if (fetch !== undefined) return <FetchProgress fetch={fetch} label={disk.name} />;
	const reason = syncDiskReason(disk.state);
	if (reason === undefined) return narrow ? null : <span className="text-faint">None</span>;
	return narrow ? (
		<span className="text-sm text-muted">{reason}</span>
	) : (
		<span className="block max-w-(--kt-popover-width) truncate text-sm text-muted" title={reason}>
			{reason}
		</span>
	);
}

const DiskName = ({ disk }: { disk: HostSyncDisk }) => (
	<span
		className="block max-w-(--kt-popover-width) truncate font-mono text-code font-medium text-fg"
		title={disk.version}
	>
		{disk.name}
	</span>
);

/** A host's sync: each disk head it should hold and where it stands on it, then its other fetches. */
export function HostSync({ host, narrow = false }: HostSyncProps) {
	const { sync } = host;
	const heading = <h3 className="m-0 text-sm font-medium text-fg">Sync</h3>;
	if (sync === undefined) {
		return (
			<section className="flex min-w-0 flex-col gap-1" aria-label={`${host.name}'s sync`} data-host-sync="none">
				{heading}
				<p className="m-0 text-sm text-muted">
					{host.state === "offline"
						? "Not connected, so what it holds isn't known."
						: "Its pool doesn't sync disks between its hosts, and it's fetching nothing."}
				</p>
			</section>
		);
	}
	const disks = sync.disks;
	const wanted = new Set(disks.map((disk) => `${disk.diskId}/${disk.version}`));
	const others = sync.fetches.filter(
		(fetch) => fetch.kind !== "sticky" || !wanted.has(`${fetch.objectId}/${fetch.version}`),
	);
	const missing = disks.some((disk) => disk.state !== "held");
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label={`${host.name}'s sync`} data-host-sync>
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
				{heading}
				<span className={`min-w-0 text-sm ${missing ? "text-fg" : "text-muted"}`}>{syncSummaryText(sync)}</span>
			</div>
			{sync.paused === undefined ? null : <p className="m-0 text-sm text-muted">{syncPausedText(sync.paused)}</p>}
			{disks.length === 0 ? (
				<p className="m-0 text-sm text-muted">
					Its pool has no sticky disk a sandbox used in the last 7 days, so there's none to keep here.
				</p>
			) : narrow ? (
				<ul className="m-0 flex list-none flex-col p-0">
					{disks.map((disk) => {
						const fetch = fetchOf(disk, sync.fetches);
						return (
							<li
								key={disk.diskId}
								className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
								data-sync-disk={disk.diskId}
							>
								<span className="flex min-w-0 items-center justify-between gap-3">
									<DiskName disk={disk} />
									<State state={disk.state} />
								</span>
								<span className="text-sm text-muted tabular-nums">About {bytesText(disk.allocatedBytes)}</span>
								<DiskProgress disk={disk} fetch={fetch} narrow />
							</li>
						);
					})}
				</ul>
			) : (
				<SideScroll className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Disk
								</th>
								<th className={th} scope="col">
									State
								</th>
								<th className={`${th} text-right`} scope="col">
									Size
								</th>
								<th className={th} scope="col">
									Progress
								</th>
							</tr>
						</thead>
						<tbody>
							{disks.map((disk) => (
								<tr key={disk.diskId} data-sync-disk={disk.diskId}>
									<td className={td}>
										<DiskName disk={disk} />
									</td>
									<td className={td}>
										<State state={disk.state} />
									</td>
									<td
										className={`${td} text-right tabular-nums`}
										title="What the head took on the host it was committed on"
									>
										{bytesText(disk.allocatedBytes)}
									</td>
									<td className={td}>
										<DiskProgress disk={disk} fetch={fetchOf(disk, sync.fetches)} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</SideScroll>
			)}
			{others.length === 0 ? null : (
				<div className="flex min-w-0 flex-col gap-2" data-sync-fetches>
					<h4 className="m-0 text-sm font-medium text-fg">Other fetches</h4>
					<ul className="m-0 flex list-none flex-col p-0">
						{others.map((fetch) => (
							<li
								key={`${fetch.kind}/${fetch.objectId}/${fetch.version}`}
								className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0 sm:flex-row sm:items-start sm:gap-6"
							>
								<span className="flex min-w-0 flex-col sm:w-(--kt-popover-width)">
									<span className="text-sm text-fg">{fetchKindText(fetch.kind)}</span>
									<span className={`${cellMono} truncate text-sm`} title={`${fetch.objectId} ${fetch.version}`}>
										{fetch.objectId}
									</span>
								</span>
								<span className="flex min-w-0 flex-1 flex-col gap-1">
									<StatusLabel
										status={fetch.state === "failed" ? "error" : fetch.state === "running" ? "working" : "idle"}
									>
										{fetch.state === "failed" ? "Failed" : fetch.state === "running" ? "Fetching" : "Queued"}
									</StatusLabel>
									<FetchProgress fetch={fetch} label={fetchKindText(fetch.kind)} />
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
