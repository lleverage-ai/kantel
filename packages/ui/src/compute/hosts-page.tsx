// The Hosts page (compute console, experimental): for a super-admin the deployment's hosts, in Admin, and for anyone
// else, where the deployment allows it, the account's own (`owner`), in Settings, which run only its sandboxes. The
// machines that run sandboxes, each with its state, platform, live CPU and memory, disk in use, the sandboxes on it and
// its host agent's version, flagged when it's out of date; opening a row shows its CPU, memory and disk as graphs over
// the last 10 minutes. A host can be drained, so no new sandboxes land on it, updated to the version it should run
// (where the source offers it; the page reads again every few seconds until it's back on it), or removed, which
// revokes its credential. Add host makes a one-time join command to run on the new machine and waits for it to join; the host
// agent dials out, so a host needs no inbound ports. Every call goes through the `HostsSource` the host binds; stories
// bind it to fixtures.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Disclosure, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { bytesText, compactAge } from "../primitives/format.ts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { DownloadIcon, EllipsisIcon, PauseIcon, PlayIcon, SettingsIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	HOST_STATE_LABELS,
	HOST_STATE_STATUS,
	type Host,
	type HostingMode,
	type HostsSource,
	usedShare,
} from "./compute-model.ts";
import { HostDiskUsage } from "./host-disk.tsx";
import { HostJoinCommand, type HostJoinInput, JoinWaiting } from "./host-join.tsx";
import { HostCpu, HostGraphs, HostMemory, useHostUsage } from "./host-usage.tsx";
import { lineOf, ROW_SPAN_MS, seriesOf } from "./live-usage.ts";
import { computePage, messageOf, Sparkline, table, tableFrame } from "./parts.tsx";

export interface HostsPageProps {
	readonly source: HostsSource;
	/** A fixed time, for stories. */
	readonly now?: number;
	readonly hosting: HostingMode;
	/** Open Add host at once, for a story or an `?add` link. */
	readonly adding?: boolean;
	/** The account whose own hosts these are; absent, they are the deployment's, for a super-admin. */
	readonly owner?: { readonly name: string; readonly kind: "personal" | "organisation" };
	/** A phone: a row per host instead of the table. */
	readonly narrow?: boolean;
	/** Stops Add host reading the hosts while it waits, for a story. */
	readonly poll?: boolean;
	/** The host whose graphs show at first, for a story. */
	readonly opened?: string;
	/** The host whose Update dialog is open at first, for a story. */
	readonly confirmUpdate?: string;
	/** The host whose saved snapshot limit dialog is open at first, for a story. */
	readonly limiting?: string;
}

type NoticeState = { level: "info" | "error"; text: string };

const count = (value: number, one: string, many: string): string =>
	`${value.toLocaleString("en-GB")} ${value === 1 ? one : many}`;

const number = (value: number): string => value.toLocaleString("en-GB");

/** "112 isolates, 14 microVMs", "1 isolate", "None". */
export function sandboxesText(sandboxes: Host["sandboxes"]): string {
	const parts = [
		...(sandboxes.isolates > 0 ? [count(sandboxes.isolates, "isolate", "isolates")] : []),
		...(sandboxes.microvms > 0 ? [count(sandboxes.microvms, "microVM", "microVMs")] : []),
	];
	return parts.length === 0 ? "None" : parts.join(", ");
}

const running = (host: Host): number => host.sandboxes.isolates + host.sandboxes.microvms;

/** Labels typed as `key=value, key=value`: the pairs, or what's wrong with the first bad one. */
export function parseLabels(text: string): { readonly labels: Record<string, string>; readonly error?: string } {
	const labels: Record<string, string> = {};
	for (const raw of text.split(",")) {
		const pair = raw.trim();
		if (pair === "") continue;
		const match = /^([a-z0-9][a-z0-9._-]*)=([^\s=,]+)$/i.exec(pair);
		if (match === null) return { labels, error: `Write ${pair} as key=value, such as site=fsn1.` };
		labels[match[1] as string] = match[2] as string;
	}
	return { labels };
}

/** How long after a read the page reads the hosts again while one is updating, and otherwise. */
const UPDATE_POLL_MS = 5000;
const REFRESH_MS = 60_000;

const head = "h-control-md border-b border-border px-2 py-0 text-sm font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-2.5 align-middle whitespace-nowrap";
/** An opened row's cell: its graphs under it carry the hairline. */
const cellOpen = "px-2 py-2.5 align-middle whitespace-nowrap";

export function HostsPage({
	source,
	now: fixedNow,
	hosting,
	adding = false,
	owner,
	narrow = false,
	poll = true,
	opened,
	confirmUpdate,
	limiting: limitingAtFirst,
}: HostsPageProps) {
	const { state, reload, pending } = useLoad(() => source.list(), [source]);
	// Hosts changed here, ahead of the next read: a drain shows at once; null is a removed host.
	const [local, setLocal] = useState<ReadonlyMap<string, Host | null>>(new Map());
	const [addOpen, setAddOpen] = useState(adding);
	const [removing, setRemoving] = useState<Host>();
	// By ID, so the dialog shows the host as last read.
	const [updatingId, setUpdatingId] = useState(confirmUpdate);
	const [limitingId, setLimitingId] = useState(limitingAtFirst);
	const [notice, setNotice] = useState<NoticeState>();
	const now = fixedNow ?? Date.now();

	const listed = state.status === "ready" ? state.value : undefined;
	const hosts = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((host) => [host.id, host]));
		for (const [id, host] of local) {
			if (host === null) byId.delete(id);
			else byId.set(id, host);
		}
		return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [listed, local]);

	// Read again a while after each read settles: every few seconds while a host is updating, so it shows its new version
	// once it's back, and otherwise every minute, so a host that falls out of date (or a release the control plane read
	// after this page's first read) shows without a reload. Never while a read is under way, so a slow one isn't dropped.
	const awaiting = hosts?.some((host) => host.updating !== undefined) ?? false;
	useEffect(() => {
		if (!poll || pending || state.status !== "ready") return;
		const timer = setTimeout(reload, awaiting ? UPDATE_POLL_MS : REFRESH_MS);
		return () => clearTimeout(timer);
	}, [awaiting, poll, pending, reload, state]);

	// Once a read has what this page changed, the page forgets its own copy.
	useEffect(() => {
		if (listed === undefined) return;
		setLocal((current) => (current.size === 0 ? current : new Map()));
	}, [listed]);

	const change = useCallback((id: string, host: Host | null) => {
		setLocal((current) => new Map(current).set(id, host));
	}, []);

	const drain = async (host: Host, on: boolean) => {
		// Shown at once; the answer replaces it, and a failure puts it back.
		change(host.id, { ...host, state: on ? "draining" : "online" });
		try {
			change(host.id, await (on ? source.drain(host.id) : source.undrain(host.id)));
			setNotice({
				level: "info",
				text: on
					? `Draining ${host.name}. No new sandboxes land on it; the ones running keep running.`
					: `${host.name} takes new sandboxes again.`,
			});
		} catch (caught) {
			change(host.id, host);
			setNotice({
				level: "error",
				text: messageOf(caught, `Kantel couldn't ${on ? "drain" : "undrain"} ${host.name}. Try again.`),
			});
		}
	};

	const openAdd = () => setAddOpen(true);
	const addButton = (
		<Button variant="primary" size="md" icon={<PlusIcon size="sm" />} onClick={openAdd}>
			{narrow ? "Add" : "Add host"}
		</Button>
	);

	// The deployment's hosts only: Kantel's latest release read again now, rather than within the hour.
	const [checking, setChecking] = useState(false);
	const check = owner === undefined ? source.checkForUpdates : undefined;
	const checkForUpdates = async () => {
		if (check === undefined) return;
		setChecking(true);
		try {
			const found = await check();
			setNotice({
				level: "info",
				text:
					found.latestVersion === undefined
						? "Kantel couldn't find a kantel-host release."
						: `The latest kantel-host is ${found.latestVersion}. Hosts behind it show Update.`,
			});
			reload();
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't check for updates. Try again.") });
		} finally {
			setChecking(false);
		}
	};
	const rows = (host: Host) => ({
		host,
		source,
		now,
		onDrain: (on: boolean) => void drain(host, on),
		onRemove: () => setRemoving(host),
		...(source.update === undefined ? {} : { onUpdate: () => setUpdatingId(host.id) }),
		...(source.setSnapshotLimit === undefined ? {} : { onLimit: () => setLimitingId(host.id) }),
		opened: host.id === opened,
	});

	return (
		<div className={computePage}>
			{/* The title and Add on one line, on a phone too, as Sandboxes has them. */}
			<header className="kt-page-header flex min-h-control-md min-w-0 items-center justify-between gap-4 border-b border-border pb-3">
				<h1 className={`kt-page-header-title m-0 truncate font-strong leading-tight text-fg text-heading`}>Hosts</h1>
				{check === undefined ? (
					addButton
				) : (
					<div className="flex flex-none items-center gap-2">
						<Button size="md" icon={<DownloadIcon size="sm" />} busy={checking} onClick={() => void checkForUpdates()}>
							{narrow ? "Updates" : "Check for updates"}
						</Button>
						{addButton}
					</div>
				)}
			</header>
			{owner === undefined ? null : (
				<p className="m-0 max-w-[60ch] text-muted">
					{`Machines of your own that run ${owner.kind === "personal" ? "your" : `${owner.name}'s`} sandboxes, and no one else's.`}{" "}
					{hosting === "hosted" ? "A machine at home, behind NAT or on a tailnet will do." : null}
				</p>
			)}
			{notice === undefined ? null : (
				<Notice
					level={notice.level}
					action={
						<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
							Dismiss
						</Button>
					}
				>
					{notice.text}
				</Notice>
			)}
			{state.status === "error" && hosts === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the hosts.")}
				</Notice>
			) : hosts === undefined ? (
				<HostsSkeleton />
			) : hosts.length === 0 ? (
				<EmptyState
					title="No hosts yet"
					action={
						<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={openAdd}>
							Add host
						</Button>
					}
				>
					Any Linux machine with outbound HTTPS. It dials out, so it needs no open ports.
				</EmptyState>
			) : (
				<>
					<HostsSummary hosts={hosts} />
					{narrow ? (
						<ul className="kt-host-rows m-0 flex list-none flex-col p-0">
							{hosts.map((host) => (
								<HostPhoneRow key={host.id} {...rows(host)} />
							))}
						</ul>
					) : (
						<SideScroll className={tableFrame}>
							<table className={table}>
								<thead>
									<tr>
										<th className={head} scope="col">
											Name
										</th>
										<th className={head} scope="col">
											State
										</th>
										<th className={head} scope="col">
											Machine
										</th>
										<th className={head} scope="col">
											{source.usage === undefined ? "CPU (vCPU)" : "CPU"}
										</th>
										<th className={head} scope="col">
											Memory (GB)
										</th>
										<th className={head} scope="col">
											Disk (GB)
										</th>
										<th className={`${head} text-right`} scope="col">
											Sandboxes
										</th>
										<th className={head} scope="col">
											Agent
										</th>
										<th className={head} scope="col">
											<span className="kt-sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{hosts.map((host) => (
										<HostRow key={host.id} {...rows(host)} />
									))}
								</tbody>
							</table>
						</SideScroll>
					)}
				</>
			)}
			<AddHostDialog
				open={addOpen}
				source={source}
				now={now}
				poll={poll}
				onJoined={(host) => {
					setAddOpen(false);
					setNotice({ level: "info", text: `${host.name} joined. It shows as Online once its agent checks in.` });
					reload();
				}}
				onClose={() => {
					setAddOpen(false);
					// A host that ran its command shows up as Joining on the next read.
					reload();
				}}
			/>
			<UpdateDialog
				host={hosts?.find((host) => host.id === updatingId)}
				onClose={() => setUpdatingId(undefined)}
				onUpdate={async (host) => {
					if (source.update === undefined) return;
					const updated = await source.update(host.id);
					change(host.id, updated);
					setNotice({
						level: "info",
						text: `Updating ${host.name} to ${updated.updating?.version ?? host.updateAvailable}. It's back in a few seconds; its sandboxes keep running.`,
					});
				}}
			/>
			<SnapshotLimitDialog
				host={hosts?.find((host) => host.id === limitingId)}
				onClose={() => setLimitingId(undefined)}
				onSet={async (host, bytes) => {
					if (source.setSnapshotLimit === undefined) return;
					change(host.id, await source.setSnapshotLimit(host.id, bytes));
					setNotice({
						level: "info",
						text:
							bytes === null
								? `No limit on saved snapshots on ${host.name} now.`
								: `Each account may keep ${bytesText(bytes)} of saved snapshots on ${host.name} now.`,
					});
				}}
			/>
			<RemoveDialog
				host={removing}
				onClose={() => setRemoving(undefined)}
				onRemove={async (host) => {
					await source.remove(host.id);
					change(host.id, null);
					setNotice({ level: "info", text: `Removed ${host.name}. Its credential no longer works.` });
				}}
			/>
		</div>
	);
}

function HostsSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-2" aria-busy="true">
			{[0, 1, 2].map((row) => (
				<Skeleton key={row} lines={2} />
			))}
		</div>
	);
}

/** Hosts online, vCPU in use of the total, sandboxes running, and any out of date, in a line over the table. */
function HostsSummary({ hosts }: { hosts: readonly Host[] }) {
	const online = hosts.filter((host) => host.state === "online").length;
	const behind = hosts.filter((host) => host.updateAvailable !== undefined && host.updating === undefined).length;
	const vcpus = hosts.reduce((sum, host) => sum + host.vcpus, 0);
	const used = hosts.reduce((sum, host) => sum + host.used.vcpus, 0);
	const sandboxes = hosts.reduce((sum, host) => sum + running(host), 0);
	const stats = [
		{ value: `${online} of ${hosts.length}`, label: "online" },
		{ value: `${number(used)} of ${number(vcpus)}`, label: "vCPU in use" },
		{ value: number(sandboxes), label: sandboxes === 1 ? "sandbox running" : "sandboxes running" },
		...(behind === 0 ? [] : [{ value: number(behind), label: "out of date" }]),
	];
	return (
		<dl className="kt-host-summary m-0 flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-sm">
			{stats.map((stat) => (
				<div key={stat.label} className="flex min-w-0 flex-row-reverse items-baseline gap-1.5 whitespace-nowrap">
					<dt className="text-muted">{stat.label}</dt>
					<dd className="m-0 font-medium text-fg tabular-nums">{stat.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** A host's state, and how long since an offline one was last seen. */
function HostState({ host, now }: { host: Host; now: number }) {
	return (
		<StatusLabel status={HOST_STATE_STATUS[host.state]}>
			{HOST_STATE_LABELS[host.state]}
			{host.state === "offline" ? (
				<span className="text-muted" title={new Date(host.lastSeenAt).toLocaleString("en-GB")}>
					{" "}
					{compactAge(host.lastSeenAt, now)}
				</span>
			) : null}
		</StatusLabel>
	);
}

/** Update when it's out of date, drain or undrain, then Remove: a host's ⋯. */
function hostMenu(
	host: Host,
	onDrain: (on: boolean) => void,
	onRemove: () => void,
	onUpdate?: () => void,
	onLimit?: () => void,
) {
	const update: MenuEntry[] =
		onUpdate === undefined || host.updateAvailable === undefined || host.updating !== undefined
			? []
			: [
					{
						kind: "item",
						id: "update",
						label: `Update to ${host.updateAvailable}`,
						icon: <DownloadIcon />,
						// It updates over its connection: an offline host is updated once it's back.
						disabled: host.state === "offline" || host.state === "joining",
						onSelect: onUpdate,
					},
				];
	const entries: MenuEntry[] = [
		...update,
		host.state === "draining"
			? { kind: "item", id: "undrain", label: "Undrain", icon: <PlayIcon />, onSelect: () => onDrain(false) }
			: {
					kind: "item",
					id: "drain",
					label: "Drain",
					icon: <PauseIcon />,
					disabled: host.state !== "online",
					onSelect: () => onDrain(true),
				},
		...(onLimit === undefined
			? []
			: [
					{
						kind: "item" as const,
						id: "snapshot-limit",
						label: "Saved snapshot limit",
						icon: <SettingsIcon />,
						onSelect: onLimit,
					},
				]),
		{ kind: "separator", id: "sep-remove" },
		{ kind: "item", id: "remove", label: "Remove", icon: <TrashIcon />, danger: true, onSelect: onRemove },
	];
	return <Menu label={`Actions for ${host.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />;
}

/** Used of total, the used figure in the text colour, with a bar under it. */
function Capacity({ used, total }: { used: number; total: number }) {
	const share = usedShare(used, total);
	const tone = share >= 0.9 ? "bg-status-error" : share >= 0.75 ? "bg-status-approval" : "bg-muted";
	return (
		<span className="kt-capacity flex w-24 min-w-0 flex-col gap-1">
			<span className="text-muted tabular-nums">
				<span className="text-fg">{number(used)}</span> of {number(total)}
			</span>
			<span className="block h-1 w-full overflow-hidden rounded-full bg-active" aria-hidden="true">
				<span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.round(share * 100)}%` }} />
			</span>
		</span>
	);
}

/** The host agent's version, and under it whether it's updating or out of date, so the column stays narrow. */
function Agent({ host }: { host: Host }) {
	return (
		<span className="flex flex-col items-start gap-1">
			<span className="font-mono text-code text-muted">{host.version}</span>
			{host.updating !== undefined ? (
				<span className="flex items-center gap-1 text-sm text-muted">
					<Spinner size="sm" />
					Updating to {host.updating.version}
				</span>
			) : host.updateAvailable === undefined ? null : (
				<span title={`It should run ${host.updateAvailable}`}>
					<Badge tone="approval">Out of date</Badge>
				</span>
			)}
		</span>
	);
}

/** "Ubuntu 24.04 x86_64", and when it has no /dev/kvm, that it runs isolates only. */
function Machine({ host }: { host: Host }) {
	return (
		<span className="flex flex-col">
			<span className="text-fg">
				{host.os} <span className="text-muted">{host.arch}</span>
			</span>
			{host.kvm ? null : <span className="text-sm text-muted">No KVM, isolates only</span>}
		</span>
	);
}

type RowProps = {
	host: Host;
	source: HostsSource;
	now: number;
	onDrain: (on: boolean) => void;
	onRemove: () => void;
	/** Absent: hosts aren't updated from here. */
	onUpdate?: () => void;
	/** Absent: the saved snapshot limit isn't set from here. */
	onLimit?: () => void;
	/** Its graphs show at first. */
	opened: boolean;
};

/** The columns a host's row has, for its opened graphs' one cell. */
const COLUMNS = 9;

/** A row's chevron: right when it's closed, down when it's open. */
const Chevron = ({ open }: { open: boolean }) => (
	<span className="flex-none text-faint" aria-hidden="true">
		{open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
	</span>
);

function HostRow({ host, source, now, onDrain, onRemove, onUpdate, onLimit, opened }: RowProps) {
	const labels = Object.entries(host.labels);
	const [open, setOpen] = useState(opened);
	const live = useHostUsage(source, host);
	const graphsId = `host-graphs-${host.id}`;
	const shows = source.usage !== undefined && live.status !== "off";
	return (
		<>
			<tr className={`kt-host-row hover:bg-hover ${open ? "bg-hover" : ""}`} data-host={host.id}>
				<td className={open ? cellOpen : cell}>
					<button
						type="button"
						className="kt-focusable -ml-1 flex min-w-0 items-start gap-1 rounded-control px-1 text-left"
						aria-expanded={open}
						aria-controls={graphsId}
						onClick={() => setOpen(!open)}
					>
						<span className="flex h-5 items-center">
							<Chevron open={open} />
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="block max-w-(--kt-popover-width) truncate font-medium text-fg">{host.name}</span>
							{labels.length === 0 ? null : (
								<span className="block max-w-(--kt-popover-width) truncate font-mono text-code text-muted">
									{labels.map(([key, value]) => `${key}=${value}`).join(" ")}
								</span>
							)}
						</span>
					</button>
				</td>
				<td className={open ? cellOpen : cell}>
					<HostState host={host} now={now} />
				</td>
				<td className={open ? cellOpen : cell}>
					<Machine host={host} />
				</td>
				<td className={open ? cellOpen : cell}>
					{shows ? <HostCpu host={host} live={live} /> : <Capacity used={host.used.vcpus} total={host.vcpus} />}
				</td>
				<td className={open ? cellOpen : cell}>
					{shows ? (
						<HostMemory host={host} live={live} />
					) : (
						<Capacity used={host.used.memoryGb} total={host.memoryGb} />
					)}
				</td>
				<td className={open ? cellOpen : cell}>
					<Capacity used={host.used.diskGb} total={host.diskGb} />
				</td>
				<td className={`${open ? cellOpen : cell} text-right tabular-nums`} title={sandboxesText(host.sandboxes)}>
					{number(running(host))}
				</td>
				<td className={open ? cellOpen : cell}>
					<Agent host={host} />
				</td>
				<td className={`${open ? cellOpen : cell} w-0 text-right`}>
					{hostMenu(host, onDrain, onRemove, onUpdate, onLimit)}
				</td>
			</tr>
			{open ? (
				<tr className="kt-host-graphs bg-hover" id={graphsId}>
					<td className={`${cell} pt-1 pb-4 pl-8`} colSpan={COLUMNS}>
						<div className="flex min-w-0 flex-col gap-6">
							<HostGraphs host={host} live={live} />
							<HostDiskUsage host={host} now={now} />
						</div>
					</td>
				</tr>
			) : null}
		</>
	);
}

/**
 * A phone's row: the name with its CPU line and state beside it, then the machine, its vCPU and sandboxes, and ⋯.
 * Tapping it opens its graphs under it.
 */
function HostPhoneRow({ host, source, now, onDrain, onRemove, onUpdate, onLimit, opened }: RowProps) {
	const [open, setOpen] = useState(opened);
	const live = useHostUsage(source, host);
	const graphsId = `host-graphs-${host.id}`;
	return (
		<li className="kt-host-row flex min-w-0 flex-col gap-3 border-b border-border py-3" data-host={host.id}>
			<div className="flex min-w-0 items-center gap-2">
				<button
					type="button"
					className="kt-focusable flex min-w-0 flex-1 flex-col gap-1 rounded-control text-left"
					aria-expanded={open}
					aria-controls={graphsId}
					onClick={() => setOpen(!open)}
				>
					<span className="flex min-w-0 items-center gap-3">
						<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{host.name}</span>
						{source.usage !== undefined && live.status !== "off" ? (
							<Sparkline
								{...lineOf(seriesOf(live), (point) => point.cpu, ROW_SPAN_MS)}
								loading={live.status === "loading"}
								label={`${host.name}'s CPU over the last 2 minutes`}
							/>
						) : null}
						<HostState host={host} now={now} />
					</span>
					<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
						<span>
							{host.os}, {host.arch}
						</span>
						<span>
							{number(host.used.vcpus)} of {number(host.vcpus)} vCPU
						</span>
						<span>{count(running(host), "sandbox", "sandboxes")}</span>
						{host.updating !== undefined ? (
							<span>Updating to {host.updating.version}</span>
						) : host.updateAvailable === undefined ? null : (
							<span className="text-status-approval">Out of date</span>
						)}
					</span>
				</button>
				{hostMenu(host, onDrain, onRemove, onUpdate, onLimit)}
			</div>
			{open ? (
				<div id={graphsId} className="flex min-w-0 flex-col gap-6">
					<HostGraphs host={host} live={live} narrow />
					<HostDiskUsage host={host} now={now} narrow />
				</div>
			) : null}
		</li>
	);
}

/**
 * Add host: the join command, made as it opens, the loopback warning where it needs one, the new host's name and
 * labels folded away, and a wait for the host that closes the dialog once it joins.
 */
function AddHostDialog({
	open,
	source,
	now,
	poll,
	onJoined,
	onClose,
}: {
	open: boolean;
	source: HostsSource;
	now: number;
	poll: boolean;
	onJoined: (host: Host) => void;
	onClose: () => void;
}) {
	return (
		<Dialog
			open={open}
			title="Add host"
			onClose={onClose}
			actions={
				<>
					<span className="mr-auto flex items-center">{poll ? <JoinWaiting /> : null}</span>
					<Button onClick={onClose}>Done</Button>
				</>
			}
		>
			{open ? <AddHostBody source={source} now={now} poll={poll} onJoined={onJoined} /> : null}
		</Dialog>
	);
}

function AddHostBody({
	source,
	now,
	poll,
	onJoined,
}: {
	source: HostsSource;
	now: number;
	poll: boolean;
	onJoined: (host: Host) => void;
}) {
	const [name, setName] = useState("");
	const [labelsText, setLabelsText] = useState("");
	const [input, setInput] = useState<HostJoinInput>({});
	const { labels, error: labelsError } = parseLabels(labelsText);
	const pending: HostJoinInput = {
		...(name.trim() === "" ? {} : { name: name.trim() }),
		...(Object.keys(labels).length === 0 ? {} : { labels }),
	};
	const changed = JSON.stringify(pending) !== JSON.stringify(input);
	return (
		<div className="flex min-w-0 flex-col gap-3 pt-1 text-fg">
			<span className="text-sm font-medium">Run this on the host</span>
			<HostJoinCommand source={source} input={input} now={now} onJoined={onJoined} poll={poll} />
			<Disclosure summary="Name and labels">
				<div className="flex min-w-0 flex-col gap-3">
					<TextField
						label="Name"
						hint="Optional. Empty uses the machine's hostname."
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder="hetzner-fsn1-03"
						mono
						spellCheck={false}
					/>
					<TextField
						label="Labels"
						hint="Optional. Comma-separated key=value pairs."
						value={labelsText}
						onChange={(event) => setLabelsText(event.currentTarget.value)}
						placeholder="site=fsn1, tier=microvm"
						mono
						spellCheck={false}
						{...(labelsError === undefined ? {} : { error: labelsError })}
					/>
					<div>
						<Button disabled={!changed || labelsError !== undefined} onClick={() => setInput(pending)}>
							Make the command again
						</Button>
					</div>
				</div>
			</Disclosure>
		</div>
	);
}

/** The bytes a limit in GB as typed is: a whole or decimal number of GB. Undefined when it isn't one. */
export function limitBytes(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
	const bytes = Math.round(Number(trimmed) * 1024 ** 3);
	return bytes > 0 ? bytes : undefined;
}

/** Saved snapshot limit: how many GB of saved snapshots each account may keep on the host, or none. */
function SnapshotLimitDialog({
	host,
	onClose,
	onSet,
}: {
	host: Host | undefined;
	onClose: () => void;
	onSet: (host: Host, bytes: number | null) => Promise<void>;
}) {
	const [text, setText] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const shown =
		text ??
		(host?.savedSnapshotLimitBytes === undefined
			? ""
			: String(Math.round((host.savedSnapshotLimitBytes / 1024 ** 3) * 10) / 10));
	const close = () => {
		setText(undefined);
		setFailure(undefined);
		onClose();
	};
	const set = (bytes: number | null) => {
		if (host === undefined) return;
		setBusy(true);
		onSet(host, bytes).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't set the limit. Try again."));
			},
		);
	};
	const submit = () => {
		const bytes = limitBytes(shown);
		if (bytes === undefined) {
			setFailure("Enter a number of GB, such as 50.");
			return;
		}
		set(bytes);
	};
	return (
		<Dialog
			open={host !== undefined}
			title="Saved snapshot limit"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					{host?.savedSnapshotLimitBytes === undefined ? null : (
						<Button busy={busy} onClick={() => set(null)}>
							Remove limit
						</Button>
					)}
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={shown.trim() === ""}>
						Set limit
					</Button>
				</>
			}
		>
			<p>
				How much each account may keep in saved snapshots on <strong>{host?.name}</strong>. Saving past it is refused,
				with what the account has saved here. Snapshots already saved stay.
			</p>
			<div className="pt-2">
				<TextField
					label="Limit per account (GB)"
					value={shown}
					onChange={(event) => setText(event.currentTarget.value)}
					placeholder="50"
					inputMode="decimal"
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function UpdateDialog({
	host,
	onClose,
	onUpdate,
}: {
	host: Host | undefined;
	onClose: () => void;
	onUpdate: (host: Host) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={host !== undefined}
			title="Update this host?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="primary"
						busy={busy}
						onClick={() => {
							if (host === undefined) return;
							setBusy(true);
							onUpdate(host).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't update it. Try again."));
								},
							);
						}}
					>
						Update
					</Button>
				</>
			}
		>
			<p>
				<strong>{host?.name}</strong> fetches kantel-host {host?.updateAvailable}, checks it against the release's
				checksums and restarts on it. Its sandboxes keep running, but SSH sessions, terminals and port connections to
				them drop for the few seconds it takes to reconnect.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function RemoveDialog({
	host,
	onClose,
	onRemove,
}: {
	host: Host | undefined;
	onClose: () => void;
	onRemove: (host: Host) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={host !== undefined}
			title="Remove this host?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (host === undefined) return;
							setBusy(true);
							onRemove(host).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't remove it. Try again."));
								},
							);
						}}
					>
						Remove
					</Button>
				</>
			}
		>
			<p>
				This revokes <strong>{host?.name}</strong>'s credential, so it's cut off at once. Its sandboxes can't be reached
				until it joins again.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
