// The Hosts page (compute console, experimental, super-admin): the machines that run sandboxes, each with its state,
// platform, host agent version, CPU, memory and disk in use, the sandboxes on it and whether it can run microVMs. A
// host can be drained, so no new sandboxes land on it, or removed, which revokes its credential. Add a host makes a
// one-time join command to run on the new machine; the host agent dials out, so a host needs no inbound ports. Every
// call goes through the `HostsSource` the host binds; stories bind it to fixtures.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, PauseIcon, PlayIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { CommandBlock } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	expiresText,
	HOST_STATE_LABELS,
	HOST_STATE_STATUS,
	type Host,
	type HostingMode,
	type HostJoin,
	type HostsSource,
	usedShare,
} from "./compute-model.ts";
import { CapacityBar, cellSub, computePage, messageOf, rowHover, table, tableFrame, td, th } from "./parts.tsx";

export interface HostsPageProps {
	readonly source: HostsSource;
	/** A fixed time, for stories. */
	readonly now?: number;
	readonly hosting: HostingMode;
	/** Open Add a host with a join command already made, for a story or an `?add` link. */
	readonly adding?: boolean;
}

type NoticeState = { level: "info" | "error"; text: string };

const count = (value: number, one: string, many: string): string =>
	`${value.toLocaleString("en-GB")} ${value === 1 ? one : many}`;

/** "112 isolates, 14 microVMs", "1 isolate", "None". */
export function sandboxesText(sandboxes: Host["sandboxes"]): string {
	const parts = [
		...(sandboxes.isolates > 0 ? [count(sandboxes.isolates, "isolate", "isolates")] : []),
		...(sandboxes.microvms > 0 ? [count(sandboxes.microvms, "microVM", "microVMs")] : []),
	];
	return parts.length === 0 ? "None" : parts.join(", ");
}

/** "1,210 of 3,840 GB". */
const usedText = (used: number, total: number, unit: string): string =>
	`${used.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} ${unit}`;

/** Labels typed as `key=value, key=value`: the pairs, or what's wrong with the first bad one. */
function parseLabels(text: string): { readonly labels: Record<string, string>; readonly error?: string } {
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

export function HostsPage({ source, now: fixedNow, hosting, adding = false }: HostsPageProps) {
	const { state, reload } = useLoad(() => source.list(), [source]);
	// Hosts changed here, ahead of the next read: a drain shows at once; null is a removed host.
	const [local, setLocal] = useState<ReadonlyMap<string, Host | null>>(new Map());
	const [addOpen, setAddOpen] = useState(adding);
	const [removing, setRemoving] = useState<Host>();
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

	return (
		<div className={computePage}>
			<PageHeader
				title="Hosts"
				lede={`These are the machines that run ${hosting === "hosted" ? "every account's sandboxes" : "sandboxes"}. Each runs the Kantel host agent, which dials out to this control plane, so a host needs no inbound ports.`}
				actions={
					<>
						<Badge tone="accent">Super-admin</Badge>
						<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={openAdd}>
							Add a host
						</Button>
					</>
				}
			/>
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
							Add a host
						</Button>
					}
				>
					Sandboxes need at least one host to run on. Any Linux machine with outbound HTTPS will do.
				</EmptyState>
			) : (
				<>
					<HostsSummary hosts={hosts} />
					<div className={tableFrame}>
						<table className={table}>
							<thead>
								<tr>
									<th className={th} scope="col">
										Name
									</th>
									<th className={th} scope="col">
										State
									</th>
									<th className={th} scope="col">
										Machine
									</th>
									<th className={th} scope="col">
										CPU
									</th>
									<th className={th} scope="col">
										Memory
									</th>
									<th className={th} scope="col">
										Disk
									</th>
									<th className={th} scope="col">
										Sandboxes
									</th>
									<th className={th} scope="col">
										Last seen
									</th>
									<th className={th} scope="col">
										<span className="kt-sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{hosts.map((host) => (
									<HostRow
										key={host.id}
										host={host}
										now={now}
										onDrain={(on) => void drain(host, on)}
										onRemove={() => setRemoving(host)}
									/>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
			<AddHostDialog
				open={addOpen}
				source={source}
				now={now}
				autoJoin={adding}
				onClose={() => {
					setAddOpen(false);
					// A host that ran its command shows up as Joining on the next read.
					reload();
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
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} lines={2} />
				))}
			</div>
		</div>
	);
}

/** Hosts online, vCPU in use of the total, and sandboxes running, over the table. */
function HostsSummary({ hosts }: { hosts: readonly Host[] }) {
	const online = hosts.filter((host) => host.state === "online").length;
	const vcpus = hosts.reduce((sum, host) => sum + host.vcpus, 0);
	const used = hosts.reduce((sum, host) => sum + host.used.vcpus, 0);
	const running = hosts.reduce((sum, host) => sum + host.sandboxes.isolates + host.sandboxes.microvms, 0);
	const stats = [
		{ label: "Hosts online", value: `${online} of ${hosts.length}` },
		{ label: "vCPU in use", value: `${used.toLocaleString("en-GB")} of ${vcpus.toLocaleString("en-GB")}` },
		{ label: "Sandboxes running", value: running.toLocaleString("en-GB") },
	];
	return (
		<dl className="m-0 flex min-w-0 flex-wrap gap-2">
			{stats.map((stat) => (
				<div
					key={stat.label}
					className="flex min-w-0 flex-auto flex-col gap-1 rounded-panel border border-border bg-panel px-3 py-2"
				>
					<dt className="text-xs whitespace-nowrap text-muted">{stat.label}</dt>
					<dd className="m-0 text-md font-medium whitespace-nowrap text-fg tabular-nums">{stat.value}</dd>
				</div>
			))}
		</dl>
	);
}

function HostRow({
	host,
	now,
	onDrain,
	onRemove,
}: {
	host: Host;
	now: number;
	onDrain: (on: boolean) => void;
	onRemove: () => void;
}) {
	const labels = Object.entries(host.labels);
	const entries: MenuEntry[] = [
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
		{ kind: "separator", id: "sep-remove" },
		{ kind: "item", id: "remove", label: "Remove", icon: <TrashIcon />, danger: true, onSelect: onRemove },
	];
	return (
		<tr className={`kt-host-row ${rowHover}`} data-host={host.id}>
			<td className={td}>
				<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{host.name}</span>
				{labels.length === 0 ? null : (
					<span className="mt-1 flex flex-wrap gap-1">
						{labels.map(([key, value]) => (
							<Badge key={key}>{`${key}=${value}`}</Badge>
						))}
					</span>
				)}
			</td>
			<td className={td}>
				<StatusLabel status={HOST_STATE_STATUS[host.state]}>{HOST_STATE_LABELS[host.state]}</StatusLabel>
			</td>
			{/* The machine: its OS, then its architecture and the host agent's version, then what it can run. */}
			<td className={td}>
				<span className="block whitespace-nowrap text-fg">{host.os}</span>
				<span className={`${cellSub} whitespace-nowrap`}>
					{host.arch}, agent <span className="font-mono text-code">{host.version}</span>
				</span>
				<span className="mt-1 flex flex-wrap items-center gap-1">
					{host.kvm ? <Badge>KVM</Badge> : <span className="text-xs text-muted">No KVM: isolates only</span>}
					{host.kvm && host.nestedVirtualisation ? <Badge tone="accent">Nested</Badge> : null}
					{host.updateAvailable === undefined ? null : (
						<Badge tone="approval">{`Update to ${host.updateAvailable}`}</Badge>
					)}
				</span>
			</td>
			<td className={td}>
				<CapacityBar share={usedShare(host.used.vcpus, host.vcpus)}>
					{usedText(host.used.vcpus, host.vcpus, "vCPU")}
				</CapacityBar>
			</td>
			<td className={td}>
				<CapacityBar share={usedShare(host.used.memoryGb, host.memoryGb)}>
					{usedText(host.used.memoryGb, host.memoryGb, "GB")}
				</CapacityBar>
			</td>
			<td className={td}>
				<CapacityBar share={usedShare(host.used.diskGb, host.diskGb)}>
					{usedText(host.used.diskGb, host.diskGb, "GB")}
				</CapacityBar>
			</td>
			<td className={td}>
				{host.sandboxes.isolates + host.sandboxes.microvms === 0 ? (
					<span className="text-muted">None</span>
				) : (
					<span className="flex flex-col" title={sandboxesText(host.sandboxes)}>
						<span className="text-fg">{count(host.sandboxes.isolates, "isolate", "isolates")}</span>
						<span className={cellSub}>{count(host.sandboxes.microvms, "microVM", "microVMs")}</span>
					</span>
				)}
			</td>
			<td className={td}>
				<span className="text-muted" title={new Date(host.lastSeenAt).toLocaleString("en-GB")}>
					{compactAge(host.lastSeenAt, now)}
				</span>
			</td>
			<td className={`${td} w-0 text-right`}>
				<Menu label={`Actions for ${host.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />
			</td>
		</tr>
	);
}

/**
 * Add a host: an optional name and labels, then Create join command, which shows the one-line command to run on the
 * new machine with its token's expiry, what the machine needs, and what happens next.
 */
function AddHostDialog({
	open,
	source,
	now,
	autoJoin,
	onClose,
}: {
	open: boolean;
	source: HostsSource;
	now: number;
	/** Make the command as soon as it opens, with no name or labels. */
	autoJoin: boolean;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [labelsText, setLabelsText] = useState("");
	const [join, setJoin] = useState<HostJoin>();
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const { labels, error: labelsError } = parseLabels(labelsText);

	const create = useCallback(
		(input: { name?: string; labels?: Record<string, string> }) => {
			setBusy(true);
			setFailure(undefined);
			source.join(input).then(
				(made) => {
					setBusy(false);
					setJoin(made);
				},
				(caught: unknown) => {
					setBusy(false);
					setFailure(messageOf(caught, "Kantel couldn't make a join command. Try again."));
				},
			);
		},
		[source],
	);
	const joined = useRef(false);
	useEffect(() => {
		if (!open || !autoJoin || joined.current) return;
		joined.current = true;
		create({});
	}, [open, autoJoin, create]);

	const close = () => {
		setName("");
		setLabelsText("");
		setJoin(undefined);
		setFailure(undefined);
		onClose();
	};
	const submit = () => {
		if (join !== undefined || labelsError !== undefined) return;
		create({
			...(name.trim() === "" ? {} : { name: name.trim() }),
			...(Object.keys(labels).length === 0 ? {} : { labels }),
		});
	};

	return (
		<Dialog
			open={open}
			title="Add a host"
			onClose={close}
			onSubmit={submit}
			actions={
				join === undefined ? (
					<>
						<Button onClick={close}>Cancel</Button>
						<Button type="submit" variant="primary" busy={busy} disabled={labelsError !== undefined}>
							Create join command
						</Button>
					</>
				) : (
					<Button variant="primary" onClick={close}>
						Done
					</Button>
				)
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				{join === undefined ? (
					<>
						<TextField
							label="Name"
							hint="Optional. Leave it empty to use the machine's hostname."
							value={name}
							onChange={(event) => setName(event.currentTarget.value)}
							placeholder="hetzner-fsn1-03"
							mono
							spellCheck={false}
						/>
						<TextField
							label="Labels"
							hint="Optional. Comma-separated key=value pairs, to tell hosts apart."
							value={labelsText}
							onChange={(event) => setLabelsText(event.currentTarget.value)}
							placeholder="site=fsn1, tier=microvm"
							mono
							spellCheck={false}
							{...(labelsError === undefined ? {} : { error: labelsError })}
						/>
					</>
				) : (
					<div className="flex min-w-0 flex-col gap-1">
						<CommandBlock command={join.command} label="Run this on the new host" />
						<span className="text-xs text-muted">
							{`The token in it works once. ${expiresText(join.expiresAt, now)}.`}
						</span>
					</div>
				)}
				<div className="flex min-w-0 flex-col gap-1">
					<span className="text-sm font-medium text-fg">What the host needs</span>
					<ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
						<li>Linux on x86_64 or aarch64</li>
						<li>/dev/kvm for microVMs; isolates run without it</li>
						<li>Root, to install the agent</li>
						<li>Outbound HTTPS only, with no inbound ports</li>
					</ul>
				</div>
				<p className="m-0">
					The command installs the Kantel host agent and registers it with this control plane. The host then shows up
					here as Joining, then Online.
				</p>
			</div>
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
