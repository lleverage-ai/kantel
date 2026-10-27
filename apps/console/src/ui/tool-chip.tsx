import { memo, useState } from "react";
import type { ToolItem } from "../protocol-local/index.ts";

// A tool call as one quiet line in plain words, "Ran ls -la docs", "Read docs/release-notes.md", with its status.
// The arguments and output are there on demand, one tap away; nothing about the call shouts while it runs.

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const short = (value: string, max = 72): string => {
	const line = value.split("\n")[0] ?? "";
	return line.length > max || value.includes("\n") ? `${line.slice(0, max).trimEnd()}…` : line;
};

/** Plain-language description of a call: [verb while running, verb once done, object]. */
export function describe(item: Pick<ToolItem, "name" | "args">): { running: string; done: string; object: string } {
	const { name, args } = item;
	switch (name) {
		case "bash":
			return { running: "Running", done: "Ran", object: short(text(args.command)) };
		case "read":
			return { running: "Reading", done: "Read", object: text(args.path) };
		case "grep": {
			const where = text(args.path);
			return { running: "Searching for", done: "Searched for", object: `“${text(args.pattern)}”${where ? ` in ${where}` : ""}` };
		}
		case "edit":
			return { running: "Editing", done: "Edited", object: text(args.path) };
		case "write":
			return { running: "Writing", done: "Wrote", object: text(args.path) };
		case "web_fetch":
			return { running: "Opening", done: "Opened", object: text(args.url) };
		default:
			return { running: "Using", done: "Used", object: name };
	}
}

function StatusIcon({ status }: { status: ToolItem["status"] }) {
	if (status === "running" || status === "pending") return <span className="spin" aria-label="Running" role="img" />;
	if (status === "error")
		return (
			<svg className="icon icon-error" viewBox="0 0 16 16" aria-label="Failed" role="img">
				<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
				<path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			</svg>
		);
	return (
		<svg className="icon icon-done" viewBox="0 0 16 16" aria-label="Done" role="img">
			<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<path d="M5.2 8.3l1.9 1.9 3.8-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

const seconds = (ms: number | undefined): string | undefined =>
	ms === undefined ? undefined : ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 100) / 10} s`;

export const ToolChip = memo(function ToolChip({ item }: { item: ToolItem }) {
	const [open, setOpen] = useState(false);
	const words = describe(item);
	const active = item.status === "running" || item.status === "pending";
	const verb = active ? words.running : item.status === "error" ? `Tried: ${words.done.toLowerCase()}` : words.done;
	const time = seconds(item.durationMs);
	return (
		<div className={`tool tool-${item.status}${open ? " tool-open" : ""}`}>
			<button type="button" className="tool-chip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<StatusIcon status={item.status} />
				<span className="tool-words">
					<span className="tool-verb">{verb}</span> <span className="tool-object">{words.object}</span>
				</span>
				{time === undefined ? null : <span className="tool-time">{time}</span>}
				<svg className="chev" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			{open ? (
				<div className="tool-detail">
					<div className="tool-label">Arguments</div>
					<pre>{JSON.stringify(item.args, null, 2)}</pre>
					<div className="tool-label">{active ? "Output so far" : item.status === "error" ? "Error" : "Output"}</div>
					<pre className="tool-output">{item.output === "" ? (active ? "Waiting for output…" : "(no output)") : item.output}</pre>
				</div>
			) : null}
		</div>
	);
});
