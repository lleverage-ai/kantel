// Pools on the Hosts page (compute console, experimental): the hosts grouped by the pool they are in, each pool's
// heading with what its hosts hold and its menu (Add host here, Rename, Make default, Delete), the dialogs that name,
// delete and move into a pool, and the pool picker Add host shows when there is more than one. A pool is a set of an
// account's hosts, each host in exactly one; new hosts join the default unless their join names another. Only a
// drained host with no sandboxes moves, so Move to pool says so first and shows Kantel's reason when it refuses.

import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { DefaultIcon, EllipsisIcon, RenameIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { HOST_STATE_LABELS, type Host, POOL_NAME_PATTERN, type Pool } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

/** A pool and the hosts in it, as the Hosts page lists them. */
export interface PoolGroup {
	readonly pool: Pool;
	readonly hosts: readonly Host[];
}

/**
 * The hosts by pool: the default first, then the rest by name, each pool listed even when it has no hosts. A host in no
 * pool the list has (one not yet put in a pool, or in one deleted since the list was read) is in the default, as Kantel
 * puts it on its next read.
 */
export function poolGroups(hosts: readonly Host[], pools: readonly Pool[]): PoolGroup[] {
	const ordered = [...pools].sort((a, b) =>
		a.default === b.default ? a.name.localeCompare(b.name) : a.default ? -1 : 1,
	);
	const known = new Set(ordered.map((pool) => pool.id));
	const fallback = ordered.find((pool) => pool.default)?.id ?? ordered[0]?.id;
	return ordered.map((pool) => ({
		pool,
		hosts: hosts.filter((host) =>
			host.poolId !== undefined && known.has(host.poolId) ? host.poolId === pool.id : pool.id === fallback,
		),
	}));
}

const number = (value: number): string => value.toLocaleString("en-GB");

/** "3 hosts, 2 online, 44 of 144 vCPU in use, 158 sandboxes": what a pool's hosts hold, or that it has none. */
export function poolSummaryText(hosts: readonly Host[]): string {
	if (hosts.length === 0) return "No hosts";
	const online = hosts.filter((host) => host.state === "online").length;
	const vcpus = hosts.reduce((sum, host) => sum + host.vcpus, 0);
	const used = hosts.reduce((sum, host) => sum + host.used.vcpus, 0);
	const sandboxes = hosts.reduce((sum, host) => sum + host.sandboxes.isolates + host.sandboxes.microvms, 0);
	return [
		hosts.length === 1 ? "1 host" : `${number(hosts.length)} hosts`,
		`${number(online)} online`,
		`${number(used)} of ${number(vcpus)} vCPU in use`,
		sandboxes === 1 ? "1 sandbox" : `${number(sandboxes)} sandboxes`,
	].join(", ");
}

/** What a pool's ⋯ can do with it. */
export interface PoolActions {
	readonly onAdd: () => void;
	readonly onRename: () => void;
	readonly onMakeDefault: () => void;
	readonly onDelete: () => void;
}

/** A pool's ⋯: Add host here, Rename, Make default (not on the default), then Delete, only for an empty other pool. */
function poolMenu(group: PoolGroup, actions: PoolActions) {
	const { pool } = group;
	const kept = pool.default ? "Default" : group.hosts.length > 0 ? "Has hosts" : undefined;
	const entries: MenuEntry[] = [
		{ kind: "item", id: "add", label: "Add host here", icon: <PlusIcon />, onSelect: actions.onAdd },
		{ kind: "item", id: "rename", label: "Rename", icon: <RenameIcon />, onSelect: actions.onRename },
		...(pool.default
			? []
			: [
					{
						kind: "item" as const,
						id: "default",
						label: "Make default",
						icon: <DefaultIcon />,
						onSelect: actions.onMakeDefault,
					},
				]),
		{ kind: "separator", id: "sep-delete" },
		{
			kind: "item",
			id: "delete",
			label: "Delete",
			icon: <TrashIcon />,
			danger: true,
			// Kantel deletes only an empty pool that isn't the default: why not, at the row's end.
			disabled: kept !== undefined,
			...(kept === undefined ? {} : { detail: kept }),
			onSelect: actions.onDelete,
		},
	];
	return <Menu label={`Actions for pool ${pool.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />;
}

/**
 * A pool's heading over its hosts: its name, Default on the default, what its hosts hold, and its ⋯. The name wraps
 * rather than being cut short, so a long one reads whole on a phone.
 */
export function PoolHeading({ group, actions }: { group: PoolGroup; actions: PoolActions }) {
	return (
		<div className="kt-pool-heading flex min-w-0 items-center gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="min-w-0 font-medium wrap-anywhere text-fg">{group.pool.name}</span>
					{group.pool.default ? <Badge tone="accent">Default</Badge> : null}
				</span>
				<span className="text-sm font-regular text-muted">{poolSummaryText(group.hosts)}</span>
			</div>
			{poolMenu(group, actions)}
		</div>
	);
}

/**
 * The heading over accounts' own hosts on a super-admin's page: they are in their accounts' pools, not the deployment's,
 * so they have no pool menu here.
 */
export function AccountHostsHeading({ hosts }: { hosts: readonly Host[] }) {
	return (
		<div className="kt-pool-heading flex min-w-0 flex-col gap-0.5">
			<span className="font-medium text-fg">Accounts' own hosts</span>
			<span className="text-sm font-regular text-muted">
				{poolSummaryText(hosts)}. They're in their accounts' pools, which each account manages.
			</span>
		</div>
	);
}

/** What a pool with no hosts says under its heading, with Add host here. */
export function EmptyPool({ onAdd }: { onAdd: () => void }) {
	return (
		<div className="kt-pool-empty flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
			<span>Add a host to this pool, or move a drained one here.</span>
			<Button size="sm" icon={<PlusIcon size="sm" />} onClick={onAdd}>
				Add host here
			</Button>
		</div>
	);
}

/** Why a pool's name won't do, or undefined when it will. */
export function poolNameError(name: string): string | undefined {
	if (name === "") return undefined;
	return POOL_NAME_PATTERN.test(name)
		? undefined
		: "Use lower-case letters, digits and dashes, starting and ending with a letter or digit.";
}

/** New pool, or Rename: one field, its name. */
export function PoolNameDialog({
	open,
	pool,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The pool being renamed; absent, a new one. */
	pool?: Pool;
	onClose: () => void;
	onSave: (name: string) => Promise<void>;
}) {
	const [text, setText] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const name = (text ?? pool?.name ?? "").trim();
	const invalid = poolNameError(name);
	const close = () => {
		setText(undefined);
		setFailure(undefined);
		onClose();
	};
	const save = () => {
		if (busy || name === "" || invalid !== undefined) return;
		if (pool !== undefined && name === pool.name) {
			close();
			return;
		}
		setBusy(true);
		setFailure(undefined);
		onSave(name).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, `Kantel couldn't ${pool === undefined ? "make" : "rename"} the pool. Try again.`));
			},
		);
	};
	return (
		<Dialog
			open={open}
			title={pool === undefined ? "New pool" : "Rename pool"}
			onClose={close}
			onSubmit={save}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={name === "" || invalid !== undefined}>
						{pool === undefined ? "Make pool" : "Rename"}
					</Button>
				</>
			}
		>
			<p>
				{pool === undefined
					? "A set of hosts, each in one pool. It starts empty: add hosts to it, or move drained ones in."
					: "Join commands and scripts that name the pool by its old name stop finding it."}
			</p>
			<div className="pt-2">
				<TextField
					label="Name"
					hint="Lower-case letters, digits and dashes, such as ci or agents."
					value={text ?? pool?.name ?? ""}
					onChange={(event) => setText(event.currentTarget.value)}
					placeholder="ci"
					mono
					spellCheck={false}
					autoCapitalize="off"
					maxLength={63}
					{...(invalid === undefined ? {} : { error: invalid })}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** Delete pool: only an empty pool that isn't the default, which Kantel checks again. */
export function DeletePoolDialog({
	pool,
	onClose,
	onDelete,
}: {
	pool: Pool | undefined;
	onClose: () => void;
	onDelete: (pool: Pool) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={pool !== undefined}
			title="Delete this pool?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (pool === undefined) return;
							setBusy(true);
							setFailure(undefined);
							onDelete(pool).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete the pool. Try again."));
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
				<strong className="wrap-anywhere">{pool?.name}</strong> has no hosts. Join commands made for it stop working.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** A pool as a choice: its name, and that it's the default when its name doesn't say so. */
const poolLabel = (pool: Pool): string =>
	pool.default && pool.name !== "default" ? `${pool.name} (default)` : pool.name;

const sandboxCount = (host: Host): number => host.sandboxes.isolates + host.sandboxes.microvms;

/**
 * Move to pool: the rule first (only a drained host with no sandboxes moves), what stands in the way as the page last
 * read it, with Drain where it isn't drained, then the pool to move it to. Kantel checks again as it moves it, and its
 * reason shows here when it refuses.
 */
export function MoveHostDialog({
	host,
	pools,
	onClose,
	onDrain,
	onMove,
}: {
	host: Host | undefined;
	pools: readonly Pool[];
	onClose: () => void;
	/** Drains it from here, so it can move once its sandboxes have gone. */
	onDrain: (host: Host) => Promise<void>;
	onMove: (host: Host, pool: Pool) => Promise<void>;
}) {
	const others = [...pools].filter((pool) => pool.id !== host?.poolId).sort((a, b) => a.name.localeCompare(b.name));
	const [chosen, setChosen] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [draining, setDraining] = useState(false);
	const [failure, setFailure] = useState<string>();
	const target = others.find((pool) => pool.id === chosen) ?? others[0];
	const from = pools.find((pool) => pool.id === host?.poolId) ?? pools.find((pool) => pool.default);
	const close = () => {
		setChosen(undefined);
		setFailure(undefined);
		onClose();
	};
	const move = () => {
		if (host === undefined || target === undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		onMove(host, target).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't move the host. Try again."));
			},
		);
	};
	const drain = () => {
		if (host === undefined) return;
		setDraining(true);
		setFailure(undefined);
		onDrain(host).then(
			() => setDraining(false),
			(caught: unknown) => {
				setDraining(false);
				setFailure(messageOf(caught, `Kantel couldn't drain ${host.name}. Try again.`));
			},
		);
	};
	const left = host === undefined ? 0 : sandboxCount(host);
	return (
		<Dialog
			open={host !== undefined}
			title="Move to another pool"
			onClose={close}
			onSubmit={move}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={target === undefined}>
						Move
					</Button>
				</>
			}
		>
			<p>
				Only a drained host with no sandboxes moves. Drain <strong className="wrap-anywhere">{host?.name}</strong>, let
				its sandboxes finish, move it, then undrain it in its new pool.
			</p>
			<div className="flex min-w-0 flex-col gap-3 pt-3">
				{host === undefined ? null : host.state !== "draining" ? (
					<Notice
						level="warning"
						action={
							<Button size="sm" busy={draining} onClick={drain}>
								Drain
							</Button>
						}
					>
						It's {HOST_STATE_LABELS[host.state].toLowerCase()}, not drained.
					</Notice>
				) : left > 0 ? (
					<Notice level="warning">
						It's drained but still has {left === 1 ? "a sandbox" : `${number(left)} sandboxes`}. Move it once{" "}
						{left === 1 ? "it has" : "they have"} gone.
					</Notice>
				) : null}
				{target === undefined ? (
					<Notice level="info">There's no other pool to move it to. Make one first.</Notice>
				) : (
					<SelectField
						label="Pool"
						{...(from === undefined ? {} : { hint: `It's in ${from.name} now.` })}
						value={target.id}
						onChange={(event) => setChosen(event.currentTarget.value)}
						options={others.map((pool) => ({
							value: pool.id,
							label: poolLabel(pool),
						}))}
					/>
				)}
				{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			</div>
		</Dialog>
	);
}

/** Add host's choice of pool, for an account with more than one: the default is chosen at first. */
export function PoolPicker({
	pools,
	value,
	onChange,
}: {
	pools: readonly Pool[];
	value: string;
	onChange: (poolId: string) => void;
}) {
	const ordered = [...pools].sort((a, b) =>
		a.default === b.default ? a.name.localeCompare(b.name) : a.default ? -1 : 1,
	);
	return (
		<SelectField
			label="Pool"
			hint="The pool the new host joins. Changing it makes the command again."
			value={value}
			onChange={(event) => onChange(event.currentTarget.value)}
			options={ordered.map((pool) => ({ value: pool.id, label: poolLabel(pool) }))}
		/>
	);
}
