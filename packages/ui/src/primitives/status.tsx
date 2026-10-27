import type { ReactNode } from "react";
import { type Status, statusLabel } from "../tokens/tokens.ts";
import "./status.css";

/**
 * The status colour as a 6px dot. Pulses only while working, the one status where something is happening. Give it a
 * label when nothing beside it says the status in words.
 */
export function StatusDot({ status, label }: { status: Status; label?: string }) {
	return (
		<span
			className={`hb-status-dot hb-status-${status}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
		/>
	);
}

/**
 * A status in words with its dot: "Working", "Needs approval". The words default to the status's own label; pass
 * children to say something more specific ("Working for 3m").
 */
export function StatusLabel({ status, children }: { status: Status; children?: ReactNode }) {
	return (
		<span className={`hb-status-label hb-status-${status}`}>
			<StatusDot status={status} />
			<span>{children ?? statusLabel[status]}</span>
		</span>
	);
}

export type BadgeTone = "neutral" | "accent" | Status;

/**
 * A short tag on a value or a row: "Proposed", "Approved", "Read only". Sentence case, one or two words. Not a
 * status indicator for a whole session (use StatusLabel) and never a button.
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
	const toneClass = tone === "neutral" || tone === "accent" ? `hb-badge-${tone}` : `hb-status-${tone}`;
	return (
		<span className={`hb-badge ${toneClass}`}>
			<span className="hb-badge-text">{children}</span>
		</span>
	);
}
