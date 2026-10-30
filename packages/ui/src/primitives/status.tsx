import type { ReactNode } from "react";
import { type Status, statusLabel } from "../tokens/tokens.ts";
import "./status.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). The `hb-status-<status>` classes stay
// in status.css: they set --hb-status-current and --hb-status-current-soft, which these utilities read.

/** The dot: the status colour in a 6px circle. */
const statusDot = "inline-block flex-none size-dot rounded-full bg-(--hb-status-current)";

/** Working breathes (hb-pulse is in base.css), opacity only. */
const statusDotWorking = "animate-[hb-pulse_var(--hb-duration-pulse)_var(--hb-ease-breathe)_infinite]";

/**
 * The status colour as a 6px dot. Pulses only while working, the one status where something is happening. Give it a
 * label when nothing beside it says the status in words.
 */
export function StatusDot({ status, label }: { status: Status; label?: string }) {
	return (
		<span
			className={`hb-status-dot hb-status-${status} ${statusDot}${status === "working" ? ` ${statusDotWorking}` : ""}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
		/>
	);
}

/** The words with their dot. The dot sits on the words' baseline, then moves up onto the middle of their capitals. */
const statusLabelClass =
	"inline-flex min-w-0 items-baseline gap-1.5 text-xs leading-tight whitespace-nowrap text-(--hb-status-current) [&>.hb-status-dot]:translate-y-(--hb-on-cap)";

/**
 * A status in words with its dot: "Working", "Needs approval". The words default to the status's own label; pass
 * children to say something more specific ("Working for 3m").
 */
export function StatusLabel({ status, children }: { status: Status; children?: ReactNode }) {
	return (
		<span className={`hb-status-label hb-status-${status} ${statusLabelClass}`}>
			<StatusDot status={status} />
			<span>{children ?? statusLabel[status]}</span>
		</span>
	);
}

export type BadgeTone = "neutral" | "accent" | Status;

/** The pill. Its words are trimmed to their capitals and centred in it, so they look centred in any font. */
const badgeBase =
	"inline-flex h-[calc(var(--hb-control-xs)_-_var(--hb-step-1_5))] flex-none items-center rounded-xs px-1.5 text-2xs font-medium leading-none whitespace-nowrap";

/** Each tone's tint and text colour; a status tone reads its status's colours from the hb-status class. */
const badgeTones = {
	neutral: "hb-badge-neutral bg-active text-muted",
	accent: "hb-badge-accent bg-accent-soft text-accent-text",
	status: "bg-(--hb-status-current-soft) text-(--hb-status-current)",
} as const;

/**
 * A short tag on a value or a row: "Proposed", "Approved", "Read only". Sentence case, one or two words. Not a
 * status indicator for a whole session (use StatusLabel) and never a button.
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
	const toneClass =
		tone === "neutral" || tone === "accent" ? badgeTones[tone] : `hb-status-${tone} ${badgeTones.status}`;
	return (
		<span className={`hb-badge ${badgeBase} ${toneClass}`}>
			<span className="hb-badge-text [text-box:trim-both_cap_alphabetic]">{children}</span>
		</span>
	);
}
