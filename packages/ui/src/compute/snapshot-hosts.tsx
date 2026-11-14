// A saved snapshot's hosts (compute console, Snapshots): the one it was saved on first, then each with a copy or
// fetching one, as they last reported, and whether a sandbox made from it there restores its memory. Kantel keeps a
// saved snapshot on two hosts of its pool where the account's setting is on, so losing one host loses none of it.
// A shared host, for anyone but a super-admin, comes without its name, as the API answers.

import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import type { SavedSnapshot, SnapshotHost, SnapshotsSource } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

export interface SnapshotHostsProps {
	readonly hosts: readonly SnapshotHost[];
	/** Whether the snapshot holds its sandbox's memory: only then does each host say whether it restores it. */
	readonly memory?: boolean;
}

const row =
	"flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0";

/** The hosts a saved snapshot is on, one row each: its name, held or fetching, and with a memory snapshot, whether it restores it. */
export function SnapshotHosts({ hosts, memory = false }: SnapshotHostsProps) {
	if (hosts.length === 0) {
		return (
			<p className="m-0 text-sm text-muted" data-snapshot-hosts="none">
				Not on a host yet. Its host lists it within a minute of the save.
			</p>
		);
	}
	return (
		<ul className="m-0 flex min-w-0 list-none flex-col p-0" data-snapshot-hosts>
			{hosts.map((host, at) => (
				<li
					// A shared host has no ID to key on; the list's order is the API's and doesn't change while it's shown.
					key={host.hostId ?? `shared-${at}`}
					className={row}
					data-snapshot-host={host.hostId ?? "shared"}
				>
					{host.hostName === undefined ? (
						<span className="text-sm text-muted">Shared host</span>
					) : (
						<span className="min-w-0 max-w-full truncate text-sm font-medium text-fg" title={host.hostId}>
							{host.hostName}
						</span>
					)}
					<span className="flex flex-none items-center gap-3 text-sm">
						{memory && host.state === "held" ? (
							<span className="text-muted">{host.memory ? "With memory" : "Disk only"}</span>
						) : null}
						{host.state === "held" ? (
							<StatusLabel status="done" quiet>
								Held
							</StatusLabel>
						) : (
							<StatusLabel status="working" quiet>
								Fetching
							</StatusLabel>
						)}
					</span>
				</li>
			))}
		</ul>
	);
}

/** A saved snapshot's hosts as the source reads them: a skeleton while it does, the reason with Try again where it can't. */
export function SavedSnapshotHosts({
	source,
	snapshot,
}: {
	source: Pick<SnapshotsSource, "hosts">;
	snapshot: Pick<SavedSnapshot, "id" | "memory">;
}) {
	const { state, reload } = useLoad(
		() => source.hosts?.(snapshot.id) ?? Promise.resolve(undefined),
		[source, snapshot.id],
	);
	if (state.status === "loading") {
		return (
			<div className="flex flex-col gap-3 py-2" aria-busy="true">
				<Skeleton width="70%" />
				<Skeleton width="50%" />
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<Notice
				level="error"
				action={
					<Button size="sm" onClick={reload}>
						Try again
					</Button>
				}
			>
				{messageOf(state.error, "Kantel couldn't read its hosts.")}
			</Notice>
		);
	}
	if (state.value === undefined) {
		return <p className="m-0 text-sm text-muted">This Kantel doesn't list a snapshot's hosts yet.</p>;
	}
	return <SnapshotHosts hosts={state.value} memory={snapshot.memory === true} />;
}

/**
 * The account's setting (`snapshotCopies`): keep each saved snapshot on two hosts of its pool, on by default. Off, no
 * new copies are made and those there stay. Applies at once; only an admin or owner may change it.
 */
export function SnapshotCopiesSwitch({
	on: saved,
	manager,
	onChange,
}: {
	on: boolean;
	manager: boolean;
	/** Saves the setting and answers what Kantel saved; rejects with why it couldn't. */
	onChange: (on: boolean) => Promise<boolean>;
}) {
	const [on, setOn] = useState(saved);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	return (
		<div className="flex min-w-0 flex-col gap-1 pt-2" data-snapshot-copies>
			<Switch
				label="Keep saved snapshots on two hosts"
				checked={on}
				busy={busy}
				disabled={!manager}
				hint={
					manager
						? "Where its pool has a second host for them, so losing one loses none. Off, no new copies are made."
						: "Only an admin or owner changes this."
				}
				onChange={(next) => {
					setBusy(true);
					setFailure(undefined);
					onChange(next).then(
						(answer) => {
							setOn(answer);
							setBusy(false);
						},
						(caught: unknown) => {
							setBusy(false);
							setFailure(messageOf(caught, "Kantel couldn't change it. Try again."));
						},
					);
				}}
			/>
			{failure === undefined ? null : <p className="m-0 text-sm text-status-error">{failure}</p>}
		</div>
	);
}
