// What takes the space on a host's disk, under its graphs when its row on the Hosts page is opened: how much of the disk
// is used, a bar, and the bytes by what they're for (saved and automatic snapshots, sandboxes, base images, templates,
// bundles and the rest), as the host last measured them, every few minutes. Then the limit on each account's saved
// snapshots on it, where one is set. A host that hasn't measured it yet (one just joined, or an older host agent) says
// so instead.

import { bytesText, compactAge } from "../primitives/format.ts";
import { type Host, type HostDisk, usedShare } from "./compute-model.ts";

/** What takes the space, each with its label: snapshots first, split into saved and automatic by Kantel's records. */
const PARTS: readonly { readonly key: keyof HostDisk; readonly label: string }[] = [
	{ key: "savedSnapshots", label: "Saved snapshots" },
	{ key: "automaticSnapshots", label: "Automatic snapshots" },
	{ key: "sandboxes", label: "Sandboxes" },
	{ key: "images", label: "Base images" },
	{ key: "templates", label: "Templates" },
	{ key: "bundles", label: "Bundles" },
	{ key: "other", label: "Other" },
];

export interface HostDiskUsageProps {
	readonly host: Pick<Host, "name" | "disk" | "savedSnapshotLimitBytes">;
	readonly now: number;
	/** A phone: the figures in one column. */
	readonly narrow?: boolean;
}

/** A host's disk by what takes it, and the limit on saved snapshots. */
export function HostDiskUsage({ host, now, narrow = false }: HostDiskUsageProps) {
	const { disk } = host;
	const limit =
		host.savedSnapshotLimitBytes === undefined
			? "No limit on each account's saved snapshots."
			: `Each account may keep ${bytesText(host.savedSnapshotLimitBytes)} of saved snapshots here.`;
	if (disk === undefined) {
		return (
			<section className="flex min-w-0 flex-col gap-1" aria-label={`${host.name}'s disk`}>
				<h3 className="m-0 text-sm font-medium text-fg">Disk space</h3>
				<p className="m-0 text-sm text-muted">
					Not measured yet. A host measures what takes its disk every few minutes; an older host agent doesn't, so
					update it to see this.
				</p>
				<p className="m-0 text-sm text-muted">{limit}</p>
			</section>
		);
	}
	const share = usedShare(disk.usedBytes, disk.totalBytes);
	const tone = share >= 0.9 ? "bg-status-error" : share >= 0.75 ? "bg-status-approval" : "bg-muted";
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label={`${host.name}'s disk`} data-host-disk>
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
				<h3 className="m-0 text-sm font-medium text-fg">Disk space</h3>
				<span className="text-sm text-muted tabular-nums">
					<span className="text-fg">{bytesText(disk.usedBytes)}</span> of {bytesText(disk.totalBytes)} used, measured{" "}
					{compactAge(disk.measuredAt, now) === "now" ? "just now" : `${compactAge(disk.measuredAt, now)} ago`}
				</span>
			</div>
			<span
				className="block h-1 w-full overflow-hidden rounded-full bg-active"
				role="img"
				aria-label={`${Math.round(share * 100)}% of the disk used`}
			>
				<span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(share * 100)}%` }} />
			</span>
			<dl
				className={`m-0 grid min-w-0 gap-x-6 gap-y-1 text-sm ${narrow ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"}`}
			>
				{PARTS.map((part) => (
					<div key={part.key} className="flex min-w-0 items-baseline justify-between gap-2">
						<dt className="truncate text-muted">{part.label}</dt>
						<dd className="m-0 text-fg tabular-nums">{bytesText(disk[part.key])}</dd>
					</div>
				))}
			</dl>
			<p className="m-0 text-sm text-muted">{limit}</p>
		</section>
	);
}
