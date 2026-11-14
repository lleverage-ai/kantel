// Move to host, from a microVM's ⋯ menu: the other hosts of its pool it may move to, each with what a move there does
// to its memory (kept, or it restarts on its disk) and the pause Kantel expects where it estimates one, then the move's
// progress as its phases go by. A move keeps going when the dialog closes; a failure says why, here or in the page's
// notice once it has closed.

import { useId, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { duration } from "../primitives/format.ts";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Elapsed } from "../primitives/time.tsx";
import { type MoveChoice, type MoveTarget, movePhaseText, type Sandbox } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

export interface MoveDialogProps {
	/** The sandbox to move: the dialog is open while there is one. Its later reads show the move's progress. */
	readonly sandbox: Sandbox | undefined;
	/** The hosts it may move to, read each time the dialog opens. */
	readonly targets: (sandbox: Sandbox) => Promise<readonly MoveTarget[]>;
	readonly onClose: () => void;
	/** Moves it; settles once it runs on its new host, or rejects with why it didn't move. */
	readonly onMove: (sandbox: Sandbox, choice: MoveChoice) => Promise<void>;
	/** A move still under way when the dialog closed failed: why, for the page to say. */
	readonly onFailed?: (sandbox: Sandbox, reason: string) => void;
}

/** What a move to `target` does to its memory, in a word or two. */
const memoryText = (target: MoveTarget): string => (target.memory === "kept" ? "Keeps memory" : "Restarts");

/** "Copying its disk to edge-2", "Starting it on edge-2": the move's phase, and where to when known. */
export function moveProgressText(phase: string, hostName: string | undefined): string {
	const words = movePhaseText(phase);
	if (hostName === undefined) return words;
	if (phase === "copying" || phase === "final-copy") return `${words} to ${hostName}`;
	if (phase === "starting") return `${words} on ${hostName}`;
	return words;
}

const row =
	"flex min-w-0 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-b-0";
const radio = "kt-focusable m-0 size-3.5 flex-none cursor-pointer accent-accent";

/** One host to choose: its name, cut short with the whole in its tooltip, and what moving there does. */
function TargetRow({
	target,
	name,
	checked,
	onChoose,
}: {
	target: MoveTarget;
	name: string;
	checked: boolean;
	onChoose: () => void;
}) {
	return (
		<li className="min-w-0">
			<label className={row} data-move-target={target.hostId}>
				<input type="radio" name={name} className={radio} checked={checked} onChange={onChoose} />
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={target.hostName}>
					{target.hostName}
				</span>
				<span className="flex flex-none items-center gap-3 text-sm text-muted">
					<span>{memoryText(target)}</span>
					{target.pauseMs === undefined ? null : (
						<span title="The pause Kantel expects while it moves">{duration(target.pauseMs)} pause</span>
					)}
				</span>
			</label>
		</li>
	);
}

/**
 * Move to host. It lists the hosts the source says it may move to (`targets`), the first chosen, and moves it to the one
 * chosen: with its memory where that host keeps it, unless Restart it instead is ticked. While it moves, the dialog
 * shows its phase from the sandbox's reads (`moving` and its `move`), and Close leaves it moving. A failure keeps the
 * dialog open with why; one after the dialog closed goes to `onFailed`.
 */
export function MoveDialog({ sandbox, targets, onClose, onMove, onFailed }: MoveDialogProps) {
	const open = sandbox !== undefined;
	const name = useId();
	const { state, reload } = useLoad(
		() => (sandbox === undefined ? Promise.resolve([]) : targets(sandbox)),
		[sandbox?.id, open],
	);
	const [chosen, setChosen] = useState<string>();
	const [restart, setRestart] = useState(false);
	const [busy, setBusy] = useState<{ readonly target: MoveTarget; readonly since: number }>();
	const [failure, setFailure] = useState<string>();
	// Which attempt the dialog is showing: one that settles after the dialog closed (or opened again) isn't shown here.
	const attempt = useRef(0);
	const list = state.status === "ready" ? state.value : [];
	const target = list.find((host) => host.hostId === chosen) ?? list[0];
	// A failure says so even while the page's last read still has it moving.
	const moving = busy !== undefined || (failure === undefined && sandbox?.state === "moving");

	const close = () => {
		attempt.current += 1;
		setChosen(undefined);
		setRestart(false);
		setBusy(undefined);
		setFailure(undefined);
		onClose();
	};
	const move = () => {
		if (sandbox === undefined || target === undefined || moving) return;
		const mine = ++attempt.current;
		const box = sandbox;
		setBusy({ target, since: Date.now() });
		setFailure(undefined);
		onMove(box, { hostId: target.hostId, keepMemory: target.memory === "kept" && !restart }).then(
			() => {
				if (attempt.current === mine) close();
			},
			(caught: unknown) => {
				const reason = messageOf(caught, `Kantel couldn't move ${box.name}. It's where it was.`);
				if (attempt.current !== mine) {
					onFailed?.(box, reason);
					return;
				}
				setBusy(undefined);
				setFailure(reason);
			},
		);
	};

	if (moving) {
		const phase = sandbox?.state === "moving" ? (sandbox.move?.phase ?? "copying") : "copying";
		const to = sandbox?.move?.hostName ?? busy?.target.hostName;
		const since = sandbox?.move?.startedAt ?? busy?.since ?? Date.now();
		return (
			<Dialog
				open={open}
				title="Move to host"
				onClose={close}
				actions={
					// Move's button has gone: focus goes to Close, so the keyboard stays in the dialog.
					<Button onClick={close} autoFocus>
						Close
					</Button>
				}
			>
				<p>
					Moving <strong className="wrap-anywhere">{sandbox?.name}</strong>
					{to === undefined ? null : (
						<>
							{" "}
							to <strong className="wrap-anywhere">{to}</strong>
						</>
					)}
					. It keeps going if you close this.
				</p>
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-2" data-move-phase={phase}>
					{/* The host is named above: the phase alone stays on one line beside the time. */}
					<StatusLabel status="working">{movePhaseText(phase)}</StatusLabel>
					<span className="text-sm text-muted">
						<Elapsed since={since} />
					</span>
				</div>
			</Dialog>
		);
	}

	const restarts = target !== undefined && (target.memory !== "kept" || restart);
	return (
		<Dialog
			open={open}
			title="Move to host"
			onClose={close}
			onSubmit={move}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" disabled={target === undefined}>
						Move
					</Button>
				</>
			}
		>
			<p>
				Moves <strong className="wrap-anywhere">{sandbox?.name}</strong> to another host in its pool. It keeps its ID,
				settings and URLs, and runs there once moved.
			</p>
			<div className="flex min-w-0 flex-col gap-4 pt-2">
				{state.status === "loading" ? (
					<div className="flex flex-col gap-3 py-2" aria-busy="true" data-move-targets="loading">
						<Skeleton width="70%" />
						<Skeleton width="50%" />
					</div>
				) : state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the hosts it may move to.")}
					</Notice>
				) : list.length === 0 ? (
					<Notice level="info">No other host in its pool can take it now.</Notice>
				) : (
					<fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" data-move-targets>
						<legend className="mb-1 p-0 text-sm font-medium text-fg">Host</legend>
						<ul className="m-0 flex min-w-0 list-none flex-col p-0">
							{list.map((host) => (
								<TargetRow
									key={host.hostId}
									target={host}
									name={name}
									checked={host.hostId === target?.hostId}
									onChoose={() => setChosen(host.hostId)}
								/>
							))}
						</ul>
					</fieldset>
				)}
				{target?.memory === "kept" ? (
					<CheckboxField
						label="Restart it instead"
						hint="It boots on its disk there: running programs and memory are lost."
						checked={restart}
						onChange={(event) => setRestart(event.currentTarget.checked)}
					/>
				) : null}
				{restarts && sandbox?.state === "paused" ? (
					<p className="m-0 text-sm text-muted">It's paused, so its memory is lost: it boots on its disk there.</p>
				) : null}
				{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			</div>
		</Dialog>
	);
}
