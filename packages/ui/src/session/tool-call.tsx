import type { ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useId, useState } from "react";
import { Disclosure } from "../primitives/controls.tsx";
import { duration } from "../primitives/format.ts";
import {
	ChevronRightIcon,
	EyeIcon,
	FileIcon,
	GlobeIcon,
	type IconProps,
	MinusCircleIcon,
	PencilIcon,
	SearchIcon,
	TerminalIcon,
	VaultIcon,
	XCircleIcon,
} from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { Elapsed } from "../primitives/time.tsx";
import "./tool-call.css";

// A tool call as one quiet work-log line, after T3 Code (WorkLog.tsx:53-90,134-164): an icon that says what kind of
// call it was, the host's plain-words label ("Ran pnpm test", "Read src/billing/charge.ts") and how long it took.
// The arguments and output are one tap away and rendered only while open; nothing about a call shouts while it runs.

type IconComponent = (props: IconProps) => ReactNode;

// Checked in order; vault comes first so "vault_read" is a vault call, not a read.
const iconRules: readonly [RegExp, IconComponent][] = [
	[/vault/, VaultIcon],
	[/read|view/, EyeIcon],
	[/edit|write|patch/, PencilIcon],
	[/bash|shell|exec|command/, TerminalIcon],
	[/grep|glob|search|find/, SearchIcon],
	[/fetch|web|browser/, GlobeIcon],
];

/** The icon for a tool, chosen from its name. */
export function toolIcon(name: string): IconComponent {
	const lower = name.toLowerCase();
	for (const [pattern, icon] of iconRules) if (pattern.test(lower)) return icon;
	return FileIcon;
}

/** What the detail shows for the arguments: a lone `command` as itself, anything else as indented JSON. */
export function formatArgs(args: unknown): { label: string; text: string } | undefined {
	if (args === undefined || args === null) return undefined;
	if (typeof args === "string") return args === "" ? undefined : { label: "Arguments", text: args };
	if (typeof args === "object") {
		const keys = Object.keys(args);
		if (keys.length === 0) return undefined;
		const command = (args as { command?: unknown }).command;
		if (keys.length === 1 && typeof command === "string") return { label: "Command", text: command };
	}
	return { label: "Arguments", text: JSON.stringify(args, null, 2) };
}

const isFailed = (item: ToolItem): boolean => item.status === "error" || item.status === "interrupted";

function Leading({ item }: { item: ToolItem }) {
	switch (item.status) {
		case "running":
			return (
				<>
					<Spinner />
					<span className="hb-sr-only">Running</span>
				</>
			);
		case "error":
			return <XCircleIcon label="Failed" className="hb-tool-status" />;
		case "interrupted":
			return <MinusCircleIcon label="Interrupted" className="hb-tool-status" />;
		default: {
			const Icon = toolIcon(item.name);
			return <Icon />;
		}
	}
}

function Time({ item }: { item: ToolItem }) {
	if (item.status === "running") return <Elapsed since={item.at} />;
	if (item.endedAt === undefined) return null;
	const ms = item.endedAt - item.at;
	// Under a second, "0s" says nothing; the row stays quiet instead.
	return ms < 1000 ? null : <span className="hb-time">{duration(ms)}</span>;
}

function Detail({ item, id }: { item: ToolItem; id: string }) {
	const args = formatArgs(item.args);
	const running = item.status === "running";
	const output = item.output ?? "";
	return (
		<div id={id} className="hb-tool-detail">
			{args === undefined ? null : (
				<div className="hb-tool-section">
					<div className="hb-tool-section-label">{args.label}</div>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
					<pre className="hb-tool-pre hb-selectable hb-focusable" tabIndex={0}>
						{args.text}
					</pre>
				</div>
			)}
			<div className="hb-tool-section">
				<div className="hb-tool-section-label">
					{running ? "Output so far" : item.status === "error" ? "Error" : "Output"}
				</div>
				{output === "" ? (
					<p className="hb-tool-empty">{running ? "Waiting for output" : "No output"}</p>
				) : (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					<pre className="hb-tool-pre hb-tool-output hb-selectable hb-focusable" tabIndex={0}>
						{output}
					</pre>
				)}
			</div>
		</div>
	);
}

export type ToolCallChipProps = { item: ToolItem; defaultOpen?: boolean };

/**
 * One tool call as a quiet row: icon, label, duration. A button with aria-expanded; the arguments and output render
 * only while it is open. Memoised on `item`, so a transcript re-renders only the call that changed.
 */
export const ToolCallChip = memo(function ToolCallChip({ item, defaultOpen = false }: ToolCallChipProps) {
	useRenderProbe("ToolCallChip", item.id);
	const [open, setOpen] = useState(defaultOpen);
	const id = useId();
	return (
		<div className={`hb-tool hb-tool-${item.status}${open ? " hb-tool-open" : ""}`}>
			<button
				type="button"
				className="hb-tool-row hb-focusable"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="hb-tool-icon">
					<Leading item={item} />
				</span>
				<span className="hb-tool-label">{item.label}</span>
				<span className="hb-tool-time">
					<Time item={item} />
				</span>
				<ChevronRightIcon size="sm" className="hb-tool-chevron" />
			</button>
			{open ? <Detail item={item} id={id} /> : null}
		</div>
	);
});

/** "Worked for 8s, 4 steps": from the first call's start to the last call's end. */
export function workSummary(items: readonly ToolItem[]): string {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		start = Math.min(start, item.at);
		end = Math.max(end, item.endedAt ?? item.at);
	}
	const steps = items.length === 1 ? "1 step" : `${items.length} steps`;
	return items.length === 0 ? "No steps" : `Worked for ${duration(end - start)}, ${steps}`;
}

/** How many finished calls a group needs before it collapses to a summary. */
const COLLAPSE_AT = 3;

export type ToolCallGroupProps = { items: readonly ToolItem[]; live?: boolean };

/**
 * Consecutive tool calls. While any call runs, or the group is live (the turn may add to it), every call shows.
 * Once all are finished and there are three or more, they collapse to one "Worked for 8s, 4 steps" disclosure.
 * Failed and interrupted calls stay visible under the summary while it is collapsed, so a failure is never hidden.
 */
export const ToolCallGroup = memo(function ToolCallGroup({ items, live = false }: ToolCallGroupProps) {
	const [open, setOpen] = useState(false);
	const running = items.some((item) => item.status === "running");
	if (live || running || items.length < COLLAPSE_AT) {
		return (
			<div className="hb-tool-group">
				{items.map((item) => (
					<ToolCallChip key={item.id} item={item} />
				))}
			</div>
		);
	}
	const failed = items.filter(isFailed);
	return (
		<div className="hb-tool-group hb-tool-group-collapsible">
			<Disclosure
				className="hb-tool-group-summary"
				summary={<span className="hb-tool-group-words">{workSummary(items)}</span>}
				open={open}
				onOpenChange={setOpen}
			>
				{items.map((item) => (
					<ToolCallChip key={item.id} item={item} />
				))}
			</Disclosure>
			{!open && failed.length > 0 ? (
				<div className="hb-tool-group-failed">
					{failed.map((item) => (
						<ToolCallChip key={item.id} item={item} />
					))}
				</div>
			) : null}
		</div>
	);
});
