// The Disks page (compute console, under Settings, experimental): an account's sticky disks, the named, versioned
// caches microVMs get a copy-on-write copy of and that a commit makes the next version of. Grouped by the pool each is
// in, as Hosts groups hosts; a row has the disk's name, size, versions, the hosts with a version and what they take,
// and how old its head is, and opening it lists each host. New disk names it, sizes it and puts it in a pool; Delete
// removes it and its versions on every host. Shown only where the deployment has turned sticky disks on. Every call
// goes through the `StickyDisksSource` the host binds; stories bind it to fixtures.

import { useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { bytesText, compactAge } from "../primitives/format.ts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import type { ComputeAccount, StickyDisk, StickyDiskPool, StickyDisksSource } from "./compute-model.ts";
import { computePage, messageOf, None, table, tableFrame } from "./parts.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";
import {
	allocatedText,
	allocatedTotal,
	defaultPoolId,
	groupTitle,
	headVersion,
	hostLabel,
	hostsText,
	hostsTitle,
	orderedPools,
	poolChoiceLabel,
	type StickyDiskGroup,
	type StickyDiskHost,
	sizeGbError,
	sizeGbText,
	stickyDiskGroups,
	stickyDiskHosts,
	stickyDiskNameError,
	versionsText,
} from "./sticky-disks.ts";

export interface StickyDisksPageProps {
	readonly source: StickyDisksSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** A phone: rows of two lines instead of the table. */
	readonly narrow?: boolean;
	/** Open New disk when the page opens, for a story. */
	readonly creating?: boolean;
	/** Disks whose rows start open, by ID, for a story. */
	readonly opened?: readonly string[];
}

/** A date for a cell's hover text. */
const when = (at: number): string => new Date(at).toLocaleString("en-GB");

export function StickyDisksPage({
	source,
	account,
	now: fixedNow,
	narrow = false,
	creating = false,
	opened = [],
}: StickyDisksPageProps) {
	const disksRead = useLoad(() => source.list(account.id), [source, account.id]);
	const poolsRead = useLoad(() => source.pools(account.id), [source, account.id]);
	// Disks made or deleted here, ahead of the next read: null for one deleted.
	const [local, setLocal] = useState<ReadonlyMap<string, StickyDisk | null>>(new Map());
	const [newOpen, setNewOpen] = useState(creating);
	const [deleting, setDeleting] = useState<StickyDisk>();
	const [notice, setNotice] = useState<string>();
	const now = fixedNow ?? Date.now();

	const listed = disksRead.state.status === "ready" ? disksRead.state.value : undefined;
	// Pools that can't be read leave the disks grouped by what the page can tell, and New disk without a choice.
	const pools = poolsRead.state.status === "ready" ? poolsRead.state.value : [];
	const poolsFailed = poolsRead.state.status === "error";
	const disks = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((disk) => [disk.id, disk]));
		for (const [id, disk] of local) {
			if (disk === null) byId.delete(id);
			else byId.set(id, disk);
		}
		return [...byId.values()];
	}, [listed, local]);
	const groups = useMemo(() => (disks === undefined ? undefined : stickyDiskGroups(disks, pools)), [disks, pools]);

	const keep = (id: string, disk: StickyDisk | null) => {
		setLocal((current) => new Map(current).set(id, disk));
		disksRead.reload();
	};

	const newDisk = (
		<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
			New disk
		</Button>
	);
	const empty = disks !== undefined && disks.length === 0;

	return (
		<div className={computePage}>
			<SettingsPageHeader title="Disks" actions={empty ? undefined : newDisk} narrow={narrow} />
			{notice === undefined ? null : (
				<Notice
					level="info"
					action={
						<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
							Dismiss
						</Button>
					}
				>
					{notice}
				</Notice>
			)}
			{/* Only beside disks: with none, or none read, there is nothing the pools would name. */}
			{poolsRead.state.status === "error" && disks !== undefined && !empty ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={poolsRead.reload}>
							Try again
						</Button>
					}
				>
					{messageOf(poolsRead.state.error, "Kantel couldn't read the pools, so they're shown by ID.")}
				</Notice>
			) : null}
			{disksRead.state.status === "error" && disks === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={disksRead.reload}>
							Try again
						</Button>
					}
				>
					{messageOf(disksRead.state.error, "Kantel couldn't read the disks.")}
				</Notice>
			) : groups === undefined || poolsRead.state.status === "loading" ? (
				<DisksSkeleton />
			) : empty ? (
				<EmptyState title="No disks yet" action={newDisk}>
					Caches each sandbox gets its own copy of, kept warm between them. Experimental.
				</EmptyState>
			) : (
				<DiskList
					groups={groups}
					poolsRead={!poolsFailed}
					now={now}
					narrow={narrow}
					opened={opened}
					onDelete={setDeleting}
				/>
			)}
			{newOpen ? (
				<NewDiskDialog
					pools={pools}
					onClose={() => setNewOpen(false)}
					onCreate={async (input) => {
						const made = await source.create({ accountId: account.id, ...input });
						setNewOpen(false);
						keep(made.id, made);
					}}
				/>
			) : null}
			<DeleteDialog
				disk={deleting}
				onClose={() => setDeleting(undefined)}
				onDelete={async (disk) => {
					await source.remove(disk.id);
					keep(disk.id, null);
					setNotice(`Deleted ${disk.name}.`);
				}}
			/>
		</div>
	);
}

function DisksSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-2" aria-busy="true">
			{[0, 1, 2].map((row) => (
				<Skeleton key={row} />
			))}
		</div>
	);
}

/** The table's cells: no frame round it, a hairline under the head and under every row, as Hosts has them. */
const head = "h-control-md border-b border-border px-2 py-0 text-sm font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-2.5 align-middle whitespace-nowrap";
const cellOpen = "px-2 py-2.5 align-middle whitespace-nowrap";
const COLUMNS = 7;

const count = (n: number, one: string, many: string): string => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** A pool's heading over its disks: its name, Default or Shared, and how many disks it has. */
function GroupHeading({ group, poolsRead }: { group: StickyDiskGroup; poolsRead: boolean }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<span className={`min-w-0 wrap-anywhere ${group.pool === undefined ? "text-muted" : "font-medium text-fg"}`}>
					{groupTitle(group, poolsRead)}
				</span>
				{group.pool?.default === true ? <Badge tone="accent">Default</Badge> : null}
				{group.pool?.shared === true ? <Badge>Shared</Badge> : null}
			</span>
			<span className="text-sm font-regular text-muted">
				{group.id === ""
					? "Each joins the pool of the first sandbox it's attached to."
					: count(group.disks.length, "disk", "disks")}
			</span>
		</div>
	);
}

type RowProps = {
	disk: StickyDisk;
	now: number;
	opened: boolean;
	onDelete: (disk: StickyDisk) => void;
};

function DiskList({
	groups,
	poolsRead,
	now,
	narrow,
	opened,
	onDelete,
}: {
	groups: readonly StickyDiskGroup[];
	/** The pools were read: false, a pool not known is named by its ID. */
	poolsRead: boolean;
	now: number;
	narrow: boolean;
	opened: readonly string[];
	onDelete: (disk: StickyDisk) => void;
}) {
	const row = (disk: StickyDisk): RowProps => ({ disk, now, opened: opened.includes(disk.id), onDelete });
	if (narrow) {
		return (
			<div className="flex min-w-0 flex-col gap-6">
				{groups.map((group) => (
					<section key={group.id} className="flex min-w-0 flex-col" aria-label={`Pool ${groupTitle(group, poolsRead)}`}>
						<div className="border-b border-border pb-2">
							<GroupHeading group={group} poolsRead={poolsRead} />
						</div>
						<ul className="m-0 flex list-none flex-col p-0">
							{group.disks.map((disk) => (
								<DiskPhoneRow key={disk.id} {...row(disk)} />
							))}
						</ul>
					</section>
				))}
			</div>
		);
	}
	return (
		<SideScroll className={tableFrame}>
			<table className={table}>
				<thead>
					<tr>
						<th className={head} scope="col">
							Name
						</th>
						<th className={`${head} text-right`} scope="col">
							Size
						</th>
						<th className={`${head} text-right`} scope="col">
							Versions
						</th>
						<th className={head} scope="col">
							Hosts
						</th>
						<th className={`${head} text-right`} scope="col">
							Allocated
						</th>
						<th className={head} scope="col">
							Last commit
						</th>
						<th className={head} scope="col">
							<span className="kt-sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				{groups.map((group, index) => (
					<tbody key={group.id}>
						<tr>
							{/* A hairline over every pool but the first: the frame drops the line under each tbody's last row. */}
							<th
								className={`${cell} bg-panel text-left font-regular ${index === 0 ? "" : "border-t"}`}
								colSpan={COLUMNS}
								scope="rowgroup"
							>
								<GroupHeading group={group} poolsRead={poolsRead} />
							</th>
						</tr>
						{group.disks.map((disk) => (
							<DiskRow key={disk.id} {...row(disk)} />
						))}
					</tbody>
				))}
			</table>
		</SideScroll>
	);
}

const Chevron = ({ open }: { open: boolean }) => (
	<span className="flex h-5 items-center text-muted">
		{open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
	</span>
);

/** Delete, in the row's ⋯. */
function DiskMenu({ disk, onDelete }: { disk: StickyDisk; onDelete: (disk: StickyDisk) => void }) {
	return (
		<Menu
			label={`Actions for ${disk.name}`}
			icon={<EllipsisIcon />}
			align="end"
			entries={[
				{
					kind: "item",
					id: "delete",
					label: "Delete",
					icon: <TrashIcon />,
					danger: true,
					onSelect: () => onDelete(disk),
				},
			]}
		/>
	);
}

/**
 * How old the head (the last commit) is, with its ID and when on hover. A phone's row, with no column heading to say
 * what the age is, says it.
 */
function HeadAge({ disk, now, phone = false }: { disk: StickyDisk; now: number; phone?: boolean }) {
	const version = headVersion(disk);
	if (version === undefined) return <span className="text-faint">{phone ? "Not committed" : "Never"}</span>;
	return (
		<span className="text-muted" title={`${version.id}, committed ${when(version.createdAt)}`}>
			{phone ? "Committed " : ""}
			{compactAge(version.createdAt, now)} ago
		</span>
	);
}

function DiskRow({ disk, now, opened, onDelete }: RowProps) {
	const [open, setOpen] = useState(opened);
	const hosts = stickyDiskHosts(disk);
	const allocated = allocatedText(allocatedTotal(disk));
	const detailsId = useId();
	const at = open ? cellOpen : cell;
	return (
		<>
			<tr className={`hover:bg-hover ${open ? "bg-hover" : ""}`} data-disk={disk.id}>
				<td className={at}>
					<button
						type="button"
						className="kt-focusable -ml-1 flex min-w-0 items-start gap-1 rounded-control px-1 text-left"
						aria-expanded={open}
						aria-controls={detailsId}
						onClick={() => setOpen(!open)}
					>
						<Chevron open={open} />
						<span className="flex min-w-0 flex-col">
							<span className="block max-w-(--kt-popover-width) truncate font-mono text-code font-medium text-fg">
								{disk.name}
							</span>
							{disk.description === undefined ? null : (
								<span className="block max-w-(--kt-popover-width) truncate text-sm text-muted" title={disk.description}>
									{disk.description}
								</span>
							)}
						</span>
					</button>
				</td>
				<td className={`${at} text-right tabular-nums`}>{sizeGbText(disk.sizeGb)}</td>
				<td className={`${at} text-right tabular-nums`}>{versionsText(disk.versions.length)}</td>
				<td className={at}>
					{hosts.length === 0 ? (
						<None className="text-faint" />
					) : (
						<span className="block max-w-(--kt-popover-width) truncate text-muted" title={hostsTitle(hosts)}>
							{hostsText(hosts)}
						</span>
					)}
				</td>
				<td className={`${at} text-right tabular-nums`}>
					{allocated === undefined ? (
						<None className="text-faint" />
					) : (
						<span title={hostsTitle(hosts)}>{allocated}</span>
					)}
				</td>
				<td className={at}>
					<HeadAge disk={disk} now={now} />
				</td>
				<td className={`${at} w-0 text-right`}>
					<DiskMenu disk={disk} onDelete={onDelete} />
				</td>
			</tr>
			{open ? (
				<tr className="bg-hover" id={detailsId}>
					<td className={`${cell} pt-1 pb-4 pl-8`} colSpan={COLUMNS}>
						<DiskHosts hosts={hosts} />
					</td>
				</tr>
			) : null}
		</>
	);
}

/** A phone's row: the name and ⋯, then its size, versions, what it takes and its head's age. Tapping lists its hosts. */
function DiskPhoneRow({ disk, now, opened, onDelete }: RowProps) {
	const [open, setOpen] = useState(opened);
	const hosts = stickyDiskHosts(disk);
	const allocated = allocatedText(allocatedTotal(disk));
	const detailsId = useId();
	return (
		<li className="flex min-w-0 flex-col gap-3 border-b border-border py-3" data-disk={disk.id}>
			<div className="flex min-w-0 items-center gap-2">
				<button
					type="button"
					className="kt-focusable flex min-w-0 flex-1 flex-col gap-1 rounded-control text-left"
					aria-expanded={open}
					aria-controls={detailsId}
					onClick={() => setOpen(!open)}
				>
					<span className="min-w-0 truncate font-mono text-code font-medium text-fg">{disk.name}</span>
					<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
						<span>{sizeGbText(disk.sizeGb)}</span>
						<span>
							{versionsText(disk.versions.length)} {disk.versions.length === 1 ? "version" : "versions"}
						</span>
						{allocated === undefined ? null : <span>{allocated} allocated</span>}
						<HeadAge disk={disk} now={now} phone />
					</span>
				</button>
				<DiskMenu disk={disk} onDelete={onDelete} />
			</div>
			{open ? (
				<div id={detailsId} className="flex min-w-0 flex-col gap-2">
					{disk.description === undefined ? null : <p className="m-0 text-sm text-muted">{disk.description}</p>}
					<DiskHosts hosts={hosts} />
				</div>
			) : null}
		</li>
	);
}

/** An opened disk: each host with a version, how many it has and what they take there. */
function DiskHosts({ hosts }: { hosts: readonly StickyDiskHost[] }) {
	if (hosts.length === 0) {
		return <p className="m-0 text-sm text-muted">No versions yet. A sandbox's commit makes the first.</p>;
	}
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<ul className="m-0 flex max-w-(--kt-card-width) min-w-0 list-none flex-col p-0">
				{hosts.map((host) => (
					<li
						key={host.hostId}
						className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-b-0"
						data-disk-host={host.hostName === undefined ? "shared" : host.hostId}
					>
						<span className={`min-w-0 truncate ${host.hostName === undefined ? "text-muted" : "font-medium text-fg"}`}>
							{hostLabel(host)}
						</span>
						<span className="flex flex-none items-center gap-3 tabular-nums">
							<span className="text-muted">{count(host.versions, "version", "versions")}</span>
							<span className="text-fg">{bytesText(host.allocatedBytes)}</span>
						</span>
					</li>
				))}
			</ul>
			<p className="m-0 text-sm text-muted">Versions share unchanged blocks, so a host may use less.</p>
		</div>
	);
}

/** New disk: its name, size and pool, and what it's for. */
function NewDiskDialog({
	pools,
	onClose,
	onCreate,
}: {
	pools: readonly StickyDiskPool[];
	onClose: () => void;
	onCreate: (input: { name: string; sizeGb: number; poolId?: string; description?: string }) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [size, setSize] = useState("");
	const [pool, setPool] = useState(() => defaultPoolId(pools));
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	// The API's refusal: a name already taken goes under the name, anything else under the form.
	const [taken, setTaken] = useState<string>();
	const [failure, setFailure] = useState<string>();
	const trimmed = name.trim();
	const nameError = stickyDiskNameError(trimmed) ?? taken;
	const sizeError = sizeGbError(size);
	const valid = trimmed !== "" && size.trim() !== "" && nameError === undefined && sizeError === undefined;

	const submit = () => {
		if (!valid || busy) return;
		setBusy(true);
		setFailure(undefined);
		onCreate({
			name: trimmed,
			sizeGb: Number(size),
			...(pool === "" ? {} : { poolId: pool }),
			...(description.trim() === "" ? {} : { description: description.trim() }),
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				const message = messageOf(caught, "Kantel couldn't make the disk. Try again.");
				if ((caught as { readonly code?: unknown } | null)?.code === "conflict") setTaken(message);
				else setFailure(message);
			},
		);
	};

	return (
		<Dialog
			open
			title="New disk"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Create
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					hint="Lower-case letters, digits and hyphens."
					value={name}
					onChange={(event) => {
						setName(event.currentTarget.value);
						setTaken(undefined);
					}}
					placeholder="ci-cache"
					mono
					spellCheck={false}
					autoCapitalize="off"
					maxLength={63}
					required
					{...(nameError === undefined ? {} : { error: nameError })}
				/>
				<TextField
					label="Size (GB)"
					hint="What each sandbox's copy can hold."
					value={size}
					onChange={(event) => setSize(event.currentTarget.value)}
					placeholder="100"
					inputMode="numeric"
					width="short"
					required
					{...(sizeError === undefined ? {} : { error: sizeError })}
				/>
				{pools.length === 0 ? null : (
					<SelectField
						label="Pool"
						hint="Only sandboxes in this pool can attach it."
						value={pool}
						onChange={(event) => setPool(event.currentTarget.value)}
						options={orderedPools(pools).map((each) => ({ value: each.id, label: poolChoiceLabel(each) }))}
					/>
				)}
				<TextField
					label="Description"
					hint="Optional. What it's for."
					value={description}
					onChange={(event) => setDescription(event.currentTarget.value)}
					maxLength={500}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function DeleteDialog({
	disk,
	onClose,
	onDelete,
}: {
	disk: StickyDisk | undefined;
	onClose: () => void;
	onDelete: (disk: StickyDisk) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={disk !== undefined}
			title="Delete this disk?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (disk === undefined) return;
							setBusy(true);
							onDelete(disk).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete it. Try again."));
								},
							);
						}}
					>
						Delete
					</Button>
				</>
			}
		>
			<p>
				<strong>{disk?.name}</strong> and its versions go from every host. Sandboxes with a copy keep it until they're
				deleted.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
