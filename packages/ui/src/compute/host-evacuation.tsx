// Move sandboxes off a host, from its ⋯ menu on the Hosts page, and its progress when its row is opened: the host is
// drained, then each sandbox on it moves to another host in its pool, two at a time, keeping its memory where the two
// hosts match and restarting otherwise. Each sandbox's line says whether it waits, is moving (and where its move has
// got), moved and where to, or was skipped or failed, and why. Kantel carries it on with the page closed, and through a
// control plane restart; undraining the host stops it.

import { useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { useLoad, useReloadOn } from "../primitives/load.ts";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { Host, HostEvacuation, HostEvacuationSandbox, HostsSource } from "./compute-model.ts";
import { cellMono, messageOf, table, tableFrame, td, th } from "./parts.tsx";
import { moveProgressText } from "./sandbox-move.tsx";

/** How long after a read the row reads the evacuation again while it runs. */
const EVACUATION_POLL_MS = 2000;

export interface HostEvacuationPanelProps {
	readonly host: Pick<Host, "name" | "state">;
	/** Its last evacuation; absent, it has had none. */
	readonly evacuation?: HostEvacuation;
	/** Each host's name by its ID, to say where a sandbox went; one not in it shows its ID. */
	readonly names: ReadonlyMap<string, string>;
	/** A phone: a short row per sandbox instead of the table. */
	readonly narrow?: boolean;
	/** The evacuation is being read for the first time. */
	readonly loading?: boolean;
	/** It couldn't be read: why, with `onRetry` to read it again. */
	readonly error?: string;
	readonly onRetry?: () => void;
	/** Begins one, or again once one has ended. Absent: no button. */
	readonly onStart?: () => void;
}

const count = (value: number, one: string, many: string): string =>
	`${value.toLocaleString("en-GB")} ${value === 1 ? one : many}`;

/** "8 moved, 1 skipped, 1 failed": the counts that aren't nought, "Nothing to move" when all are. */
export function evacuationCountsText(evacuation: Pick<HostEvacuation, "moved" | "skipped" | "failed">): string {
	const parts = [
		...(evacuation.moved > 0 ? [`${evacuation.moved.toLocaleString("en-GB")} moved`] : []),
		...(evacuation.skipped > 0 ? [`${evacuation.skipped.toLocaleString("en-GB")} skipped`] : []),
		...(evacuation.failed > 0 ? [`${evacuation.failed.toLocaleString("en-GB")} failed`] : []),
	];
	return parts.length === 0 ? "Nothing to move" : parts.join(", ");
}

/** "Moving sandboxes off, 3 moved, 5 to go": a running evacuation in a line, for the host's row. */
export function evacuationRowText(evacuation: Pick<HostEvacuation, "moved" | "remaining">): string {
	return `Moving sandboxes off, ${evacuation.moved.toLocaleString("en-GB")} moved, ${evacuation.remaining.toLocaleString("en-GB")} to go`;
}

/** What a moved sandbox's memory did: kept, or why it restarted. */
function movedDetail(item: HostEvacuationSandbox): string {
	if (item.keptMemory === true) return "Memory kept";
	return item.reason === undefined ? "Restarted" : `Restarted: ${item.reason}`;
}

/** One sandbox's state in words with its dot. */
function SandboxState({ item, names }: { item: HostEvacuationSandbox; names: ReadonlyMap<string, string> }) {
	const to = item.hostId === undefined ? undefined : (names.get(item.hostId) ?? item.hostId);
	switch (item.state) {
		case "waiting":
			return (
				<StatusLabel status="idle" quiet>
					Waiting
				</StatusLabel>
			);
		case "moving":
			return (
				<StatusLabel status="working">
					{item.phase === undefined ? "Moving" : moveProgressText(item.phase, to)}
				</StatusLabel>
			);
		case "moved":
			return <StatusLabel status="done">{to === undefined ? "Moved" : `Moved to ${to}`}</StatusLabel>;
		case "skipped":
			return <StatusLabel status="approval">Skipped</StatusLabel>;
		case "failed":
			return <StatusLabel status="error">Failed</StatusLabel>;
	}
}

/** Why it was skipped or failed, or what its memory did where it moved; nothing while it waits or moves. */
function detailOf(item: HostEvacuationSandbox): string | undefined {
	if (item.state === "moved") return movedDetail(item);
	if (item.state === "skipped" || item.state === "failed") return item.reason;
	return undefined;
}

/** Its name, cut short with the whole in its tooltip, and its ID; one the viewer may not see says so. */
function SandboxName({ item }: { item: HostEvacuationSandbox }) {
	return (
		<span className="flex min-w-0 flex-col">
			<span
				className={`block max-w-(--kt-popover-width) truncate ${item.name === undefined ? "text-muted" : "font-medium text-fg"}`}
				title={item.name}
			>
				{item.name ?? "A private sandbox"}
			</span>
			<span className={`${cellMono} block max-w-(--kt-popover-width) truncate`}>{item.id}</span>
		</span>
	);
}

/** The heading's line: what it is doing or did, in words. */
function Summary({ evacuation }: { evacuation: HostEvacuation }) {
	const total = evacuation.moved + evacuation.remaining + evacuation.skipped + evacuation.failed;
	switch (evacuation.state) {
		case "running":
			return (
				<StatusLabel status="working">
					{`${evacuation.moved.toLocaleString("en-GB")} of ${count(total, "sandbox", "sandboxes")} moved`}
				</StatusLabel>
			);
		case "done":
			return <StatusLabel status="done">{`Done: ${evacuationCountsText(evacuation)}`}</StatusLabel>;
		case "failed":
			return <StatusLabel status="error">{`Ended: ${evacuationCountsText(evacuation)}`}</StatusLabel>;
		case "stopped":
			return (
				<StatusLabel status="idle">
					{evacuation.reason === undefined ? "Stopped" : `Stopped: ${evacuation.reason.toLowerCase()}`}
				</StatusLabel>
			);
	}
}

/** How much of it has ended (moved, skipped or failed), as a bar. Static width: no animation on a live row. */
function Progress({ evacuation }: { evacuation: HostEvacuation }) {
	const ended = evacuation.moved + evacuation.skipped + evacuation.failed;
	const total = ended + evacuation.remaining;
	const share = total === 0 ? 1 : ended / total;
	return (
		<span
			className="block h-1 w-full overflow-hidden rounded-full bg-active"
			role="progressbar"
			aria-label="Sandboxes moved off"
			aria-valuemin={0}
			aria-valuemax={total}
			aria-valuenow={ended}
		>
			<span
				className={`block h-full rounded-full ${evacuation.failed > 0 ? "bg-status-error" : "bg-status-working"}`}
				style={{ width: `${Math.round(share * 100)}%` }}
			/>
		</span>
	);
}

/** A host's evacuation: what it does before one begins, then each sandbox as it goes. */
export function HostEvacuationPanel({
	host,
	evacuation,
	names,
	narrow = false,
	loading = false,
	error,
	onRetry,
	onStart,
}: HostEvacuationPanelProps) {
	const heading = <h3 className="m-0 text-sm font-medium text-fg">Move sandboxes off</h3>;
	const connected = host.state !== "offline" && host.state !== "joining";
	const startButton = (label: string) =>
		onStart === undefined ? null : (
			<Button size="sm" disabled={!connected} onClick={onStart}>
				{label}
			</Button>
		);
	if (loading) {
		return (
			<section
				className="flex min-w-0 flex-col gap-2"
				aria-label={`Moving sandboxes off ${host.name}`}
				aria-busy="true"
			>
				{heading}
				<Skeleton lines={2} />
			</section>
		);
	}
	if (error !== undefined) {
		return (
			<section className="flex min-w-0 flex-col gap-2" aria-label={`Moving sandboxes off ${host.name}`}>
				{heading}
				<Notice
					level="error"
					action={
						onRetry === undefined ? undefined : (
							<Button size="sm" onClick={onRetry}>
								Try again
							</Button>
						)
					}
				>
					{error}
				</Notice>
			</section>
		);
	}
	if (evacuation === undefined) {
		return (
			<section
				className="flex min-w-0 flex-col gap-2"
				aria-label={`Moving sandboxes off ${host.name}`}
				data-host-evacuation="none"
			>
				{heading}
				<p className="m-0 max-w-[60ch] text-sm text-muted">
					Moves each sandbox to another host in its pool, two at a time, so this host can be updated, resized or
					retired. Each keeps its memory where the two hosts match, and restarts otherwise. Any that can't move stay,
					with the reason.
				</p>
				{connected ? null : (
					<p className="m-0 text-sm text-muted">It isn't connected: its sandboxes move once it's back.</p>
				)}
				<div className="flex">{startButton("Move sandboxes off")}</div>
			</section>
		);
	}
	const again =
		evacuation.state === "failed"
			? startButton("Try again")
			: evacuation.state === "stopped"
				? startButton("Move sandboxes off")
				: null;
	return (
		<section
			className="flex min-w-0 flex-col gap-2"
			aria-label={`Moving sandboxes off ${host.name}`}
			data-host-evacuation={evacuation.state}
		>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
				{heading}
				<Summary evacuation={evacuation} />
			</div>
			{evacuation.state === "running" ? <Progress evacuation={evacuation} /> : null}
			{evacuation.state === "failed" && evacuation.reason !== undefined ? (
				<p className="m-0 text-sm text-status-error">{evacuation.reason}</p>
			) : null}
			{evacuation.sandboxes.length === 0 ? (
				<p className="m-0 text-sm text-muted">No sandboxes were on it.</p>
			) : narrow ? (
				<ul className="m-0 flex list-none flex-col p-0">
					{evacuation.sandboxes.map((item) => {
						const detail = detailOf(item);
						return (
							<li
								key={item.id}
								className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
								data-evacuation-sandbox={item.state}
							>
								<span className="flex min-w-0 items-start justify-between gap-3">
									<SandboxName item={item} />
									<SandboxState item={item} names={names} />
								</span>
								{detail === undefined ? null : <span className="min-w-0 text-sm text-muted">{detail}</span>}
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
									Sandbox
								</th>
								<th className={th} scope="col">
									State
								</th>
								<th className={th} scope="col">
									Detail
								</th>
							</tr>
						</thead>
						<tbody>
							{evacuation.sandboxes.map((item) => (
								<tr key={item.id} data-evacuation-sandbox={item.state}>
									<td className={td}>
										<SandboxName item={item} />
									</td>
									<td className={td}>
										<SandboxState item={item} names={names} />
									</td>
									<td className={`${td} whitespace-normal text-muted`}>{detailOf(item) ?? null}</td>
								</tr>
							))}
						</tbody>
					</table>
				</SideScroll>
			)}
			{again === null ? null : <div className="flex">{again}</div>}
		</section>
	);
}

/**
 * The host's last evacuation, read from `source` where it can say: once the host is draining or has had one, again
 * whenever the host's summary of it changes, and every `EVACUATION_POLL_MS` while it runs (`poll`).
 */
export function useHostEvacuation(source: HostsSource, host: Host, poll = true) {
	const shown = source.evacuation !== undefined && (host.state === "draining" || host.evacuation !== undefined);
	const { state, reload, pending } = useLoad(
		() => (shown ? (source.evacuation?.(host.id) ?? Promise.resolve(undefined)) : Promise.resolve(undefined)),
		[source, host.id, shown],
	);
	const running = state.status === "ready" && state.value?.state === "running";
	useEffect(() => {
		if (!poll || !running || pending) return;
		const timer = setTimeout(reload, EVACUATION_POLL_MS);
		return () => clearTimeout(timer);
	}, [poll, running, pending, reload]);
	useReloadOn(`${host.evacuation?.startedAt}:${host.evacuation?.state}`, reload);
	return { shown, state, reload };
}

/** The panel for an opened host's row, read from the page's source, with Move sandboxes off where it offers it. */
export function HostEvacuationSection({
	host,
	source,
	names,
	narrow = false,
	poll = true,
	onStart,
}: {
	host: Host;
	source: HostsSource;
	names: ReadonlyMap<string, string>;
	narrow?: boolean;
	poll?: boolean;
	onStart?: () => void;
}) {
	const { shown, state, reload } = useHostEvacuation(source, host, poll);
	if (!shown) return null;
	return (
		<HostEvacuationPanel
			host={host}
			{...(state.status === "ready" && state.value !== undefined ? { evacuation: state.value } : {})}
			names={names}
			narrow={narrow}
			loading={state.status === "loading"}
			{...(state.status === "error"
				? { error: messageOf(state.error, "Kantel couldn't read how far it has got."), onRetry: reload }
				: {})}
			{...(onStart === undefined ? {} : { onStart })}
		/>
	);
}

/** Move sandboxes off: what it does, then the start. */
export function EvacuateDialog({
	host,
	onClose,
	onStart,
}: {
	/** The host: the dialog is open while there is one. */
	host: Host | undefined;
	onClose: () => void;
	/** Begins it; rejects with why it didn't. */
	onStart: (host: Host) => Promise<void>;
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
			title="Move sandboxes off this host?"
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
							onStart(host).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't start moving them. Try again."));
								},
							);
						}}
					>
						Move sandboxes off
					</Button>
				</>
			}
		>
			<p>
				<strong>{host?.name}</strong> is drained, so nothing new lands on it, and each of its sandboxes moves to another
				host in its pool, two at a time. A running one keeps its memory where the two hosts match and restarts
				otherwise; a stopped one starts on its new host. Any that can't move stay, with the reason.
			</p>
			<p>It carries on if you close this page. Undrain the host to stop it.</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
