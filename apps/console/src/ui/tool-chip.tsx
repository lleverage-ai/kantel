import type { ToolItem } from "@harbour/protocol";
import { memo, useState } from "react";

// A tool call as one quiet line in plain words, "Ran ls -la docs", "Read docs/release-notes.md", with its status.
// The host writes the words (the item's `label`); the arguments and output are there on demand, one tap away, and
// nothing about the call shouts while it runs.

function StatusIcon({ status }: { status: ToolItem["status"] }) {
	if (status === "running") return <span className="spin" aria-label="Running" role="img" />;
	if (status === "error" || status === "interrupted")
		return (
			<svg
				className={`icon icon-${status}`}
				viewBox="0 0 16 16"
				aria-label={status === "error" ? "Failed" : "Interrupted"}
				role="img"
			>
				<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
				{status === "error" ? (
					<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				) : (
					<path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				)}
			</svg>
		);
	return (
		<svg className="icon icon-done" viewBox="0 0 16 16" aria-label="Done" role="img">
			<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<path
				d="M5.2 8.3l1.9 1.9 3.8-4"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

const seconds = (ms: number): string => `${ms < 1000 ? (ms / 1000).toFixed(1) : Math.round(ms / 100) / 10} s`;

export const ToolChip = memo(function ToolChip({ item }: { item: ToolItem }) {
	const [open, setOpen] = useState(false);
	const active = item.status === "running";
	const time = item.endedAt === undefined ? undefined : seconds(Math.max(0, item.endedAt - item.at));
	return (
		<div className={`tool tool-${item.status}${open ? " tool-open" : ""}`}>
			<button type="button" className="tool-chip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<StatusIcon status={item.status} />
				<span className="tool-words">{item.label}</span>
				{time === undefined ? null : <span className="tool-time">{time}</span>}
				<svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M6 4l4 4-4 4"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open ? (
				<div className="tool-detail">
					<div className="tool-label">Arguments</div>
					<pre>{JSON.stringify(item.args ?? {}, null, 2)}</pre>
					<div className="tool-label">{active ? "Output so far" : item.status === "error" ? "Error" : "Output"}</div>
					<pre className="tool-output">
						{item.output ? item.output : active ? "Waiting for output…" : "(no output)"}
					</pre>
				</div>
			) : null}
		</div>
	);
});
