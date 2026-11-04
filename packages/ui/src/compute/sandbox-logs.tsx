// A sandbox's Logs tab: one timeline, newest first, of the commands that ran in it and what happened to it (made,
// snapshots taken, stopped). A failed command opens in place with the end of its output. A table on a wide screen,
// rows on a phone. Follow reads the commands again every few seconds while it runs.

import { Fragment, useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, SegmentedControl } from "../primitives/controls.tsx";
import { duration } from "../primitives/format.ts";
import { useLoad, useReloadOn } from "../primitives/load.ts";
import { EventIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import type { Sandbox, SandboxCommand, SandboxesSource, SandboxSnapshot } from "./compute-model.ts";
import { messageOf, table } from "./parts.tsx";

export type LogFilter = "all" | "commands" | "events";

/** One line of the timeline: a command, or something that happened to the sandbox. */
export type LogEntry =
	| { readonly kind: "command"; readonly id: string; readonly at: number; readonly command: SandboxCommand }
	| { readonly kind: "event"; readonly id: string; readonly at: number; readonly text: string; readonly by: string };

const FILTERS: readonly { value: LogFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "commands", label: "Commands" },
	{ value: "events", label: "Events" },
];

/** How often Follow reads the commands again, in milliseconds. */
const FOLLOW_MS = 5000;

/**
 * The timeline, newest first: the commands, the sandbox being made (from its environment, or forked), and each
 * snapshot in its history, a stop's as Stopped.
 */
export function sandboxTimeline(
	sandbox: Pick<Sandbox, "id" | "createdAt" | "createdBy" | "environment" | "forkedFrom">,
	commands: readonly SandboxCommand[],
	snapshots: readonly SandboxSnapshot[],
): readonly LogEntry[] {
	const made =
		sandbox.environment !== undefined
			? `Started from ${sandbox.environment.name}`
			: sandbox.forkedFrom !== undefined
				? `Forked from ${sandbox.forkedFrom}`
				: "Created";
	const entries: LogEntry[] = [
		...commands.map((command) => ({ kind: "command" as const, id: command.id, at: command.startedAt, command })),
		{ kind: "event", id: `made-${sandbox.id}`, at: sandbox.createdAt, text: made, by: sandbox.createdBy },
		...snapshots.map((snap) => ({
			kind: "event" as const,
			id: snap.id,
			at: snap.takenAt,
			text: snap.reason === "stop" ? "Stopped, snapshot taken" : "Snapshot taken",
			by: "Kantel",
		})),
	];
	return entries.sort((a, b) => b.at - a.at);
}

const shownIn = (entry: LogEntry, filter: LogFilter): boolean =>
	filter === "all" || (filter === "commands" ? entry.kind === "command" : entry.kind === "event");

/** "14:02:11" today, "2 Nov 14:02" before. */
function timeText(at: number, now: number): string {
	const when = new Date(at);
	const today = new Date(now).toDateString() === when.toDateString();
	return today
		? when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
		: `${when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

const failed = (entry: LogEntry): boolean =>
	entry.kind === "command" && entry.command.exitCode !== undefined && entry.command.exitCode !== 0;

const head = "h-control-md border-b border-border px-2 py-0 text-xs font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-2 align-middle";

export function SandboxLogs({
	source,
	snapshots,
	sandbox,
	now,
	narrow = false,
}: {
	source: Pick<SandboxesSource, "history">;
	snapshots: { history(sandboxId: string): Promise<readonly SandboxSnapshot[]> };
	sandbox: Sandbox;
	now: number;
	narrow?: boolean;
}) {
	const { state, reload } = useLoad(
		() => Promise.all([source.history(sandbox.id), snapshots.history(sandbox.id)]),
		[source, snapshots, sandbox.id],
	);
	const [filter, setFilter] = useState<LogFilter>("all");
	const [follow, setFollow] = useState(false);
	// Failed commands opened by the person; the newest failure starts open.
	const [opened, setOpened] = useState<ReadonlySet<string>>();
	const following = follow && sandbox.state === "running";
	// The next read is asked for only once the last has answered, so a slow one isn't overtaken and only one runs.
	useEffect(() => {
		if (!following || state.status !== "ready") return;
		const timer = setTimeout(reload, FOLLOW_MS);
		return () => clearTimeout(timer);
	}, [following, state, reload]);
	// A stop (or a save) adds a snapshot, and its event, after Follow has ended: read again when it does.
	useReloadOn(sandbox.snapshot?.id, reload);

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
				{messageOf(state.error, `Kantel couldn't read ${sandbox.name}'s logs.`)}
			</Notice>
		);
	}
	if (state.status === "loading") return <Skeleton lines={5} />;
	const [commands, history] = state.value;
	const timeline = sandboxTimeline(sandbox, commands, history);
	const entries = timeline.filter((entry) => shownIn(entry, filter));
	const open =
		opened ??
		new Set(
			timeline
				.filter(failed)
				.slice(0, 1)
				.map((entry) => entry.id),
		);
	const toggle = (id: string) => {
		const next = new Set(open);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setOpened(next);
	};

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SegmentedControl label="Show" options={FILTERS} value={filter} onChange={setFilter} />
				{narrow ? null : (
					<Switch label="Follow" checked={follow} onChange={setFollow} disabled={sandbox.state !== "running"} />
				)}
			</div>
			{entries.length === 0 ? (
				<p className="m-0 text-sm text-muted">
					{filter === "commands" ? "No commands have run in it yet." : "Nothing yet."}
				</p>
			) : narrow ? (
				<ul className="m-0 flex list-none flex-col p-0">
					{entries.map((entry) => (
						<li key={entry.id} className="flex min-w-0 flex-col gap-1 border-b border-border py-3" data-log={entry.id}>
							<span className="flex min-w-0 items-center gap-2">
								{entry.kind === "command" && failed(entry) && entry.command.output !== undefined ? (
									<button
										type="button"
										className="kt-focusable min-w-0 flex-1 cursor-pointer truncate rounded-xs text-left font-mono text-code text-fg"
										aria-expanded={open.has(entry.id)}
										onClick={() => toggle(entry.id)}
									>
										{entry.command.command}
									</button>
								) : entry.kind === "command" ? (
									<code className="min-w-0 flex-1 truncate font-mono text-code text-fg">{entry.command.command}</code>
								) : (
									<span className="flex min-w-0 flex-1 items-center gap-2 text-md text-fg">
										<EventIcon size="sm" />
										<span className="truncate">{entry.text}</span>
									</span>
								)}
								{failed(entry) && entry.kind === "command" ? (
									<Badge tone="error">Exit {entry.command.exitCode}</Badge>
								) : null}
							</span>
							<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
								<span className="tabular-nums">{timeText(entry.at, now)}</span>
								{(entry.kind === "command" ? entry.command.by : entry.by) === "" ? null : (
									<span>{entry.kind === "command" ? entry.command.by : entry.by}</span>
								)}
								{entry.kind === "command" && entry.command.durationMs !== undefined ? (
									<span>{duration(entry.command.durationMs)}</span>
								) : null}
							</span>
							{entry.kind === "command" && entry.command.output !== undefined && open.has(entry.id) ? (
								<pre className="kt-selectable m-0 mt-1 overflow-x-auto rounded-panel border border-border bg-code-surface px-3 py-2 font-mono text-code leading-normal text-fg">
									{entry.command.output}
								</pre>
							) : null}
						</li>
					))}
				</ul>
			) : (
				<div className="kt-compute-table min-w-0 overflow-x-auto">
					<table className={table}>
						<thead>
							<tr>
								<th className={`${head} w-24`} scope="col">
									Time
								</th>
								<th className={head} scope="col">
									Command
								</th>
								<th className={head} scope="col">
									By
								</th>
								<th className={`${head} text-right`} scope="col">
									Exit
								</th>
								<th className={`${head} text-right`} scope="col">
									Took
								</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry) => {
								const isOpen = open.has(entry.id);
								const output = entry.kind === "command" ? entry.command.output : undefined;
								return (
									<Fragment key={entry.id}>
										<tr className={isOpen ? "bg-hover" : "hover:bg-hover"} data-log={entry.id}>
											<td className={`${cell} font-mono text-code whitespace-nowrap text-faint tabular-nums`}>
												{timeText(entry.at, now)}
											</td>
											<td className={`${cell} max-w-0 w-full`}>
												{entry.kind === "event" ? (
													<span className="inline-flex items-center gap-2 text-muted">
														<EventIcon size="sm" />
														{entry.text}
													</span>
												) : failed(entry) && output !== undefined ? (
													<button
														type="button"
														className="kt-focusable block max-w-full cursor-pointer truncate rounded-xs text-left font-mono text-code text-fg"
														aria-expanded={isOpen}
														onClick={() => toggle(entry.id)}
													>
														{entry.command.command}
													</button>
												) : (
													<code className="block truncate font-mono text-code text-fg">{entry.command.command}</code>
												)}
											</td>
											<td className={`${cell} whitespace-nowrap text-muted`}>
												{(entry.kind === "command" ? entry.command.by : entry.by) || "–"}
											</td>
											<td className={`${cell} text-right whitespace-nowrap tabular-nums`}>
												{entry.kind === "event" || entry.command.exitCode === undefined ? (
													<span className="text-faint">–</span>
												) : failed(entry) ? (
													<Badge tone="error">{String(entry.command.exitCode)}</Badge>
												) : (
													<span className="text-faint">{entry.command.exitCode}</span>
												)}
											</td>
											<td className={`${cell} text-right whitespace-nowrap text-faint tabular-nums`}>
												{entry.kind === "command" && entry.command.durationMs !== undefined
													? duration(entry.command.durationMs)
													: "–"}
											</td>
										</tr>
										{isOpen && output !== undefined ? (
											<tr>
												<td className="border-b border-border" />
												<td className="border-b border-border px-2 pb-3" colSpan={4}>
													<div className="flex min-w-0 items-start gap-2 rounded-panel border border-border bg-code-surface px-3 py-2">
														<pre className="kt-selectable m-0 min-w-0 flex-1 overflow-x-auto font-mono text-code leading-normal whitespace-pre-wrap text-fg">
															{output}
														</pre>
														<CopyButton text={output} size="xs" variant="ghost" />
													</div>
												</td>
											</tr>
										) : null}
									</Fragment>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
