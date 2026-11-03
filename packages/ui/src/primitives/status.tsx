import type { ReactNode } from "react";
import { type Status, statusLabel } from "../tokens/tokens.ts";
import "./status.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). The `kt-status-<status>` classes stay
// in status.css: they set --kt-status-current and --kt-status-current-soft, which these utilities read.

/** The dot: the status colour in a 6px circle. */
const statusDot = "inline-block flex-none size-dot rounded-full bg-(--kt-status-current)";

/** Working breathes (kt-pulse is in base.css), opacity only. */
const statusDotWorking = "animate-[kt-pulse_var(--kt-duration-pulse)_var(--kt-ease-breathe)_infinite]";

/**
 * The status colour as a 6px dot. Pulses only while working, the one status where something is happening. Give it a
 * label when nothing beside it says the status in words.
 */
export function StatusDot({ status, label }: { status: Status; label?: string }) {
	return (
		<span
			className={`kt-status-dot kt-status-${status} ${statusDot}${status === "working" ? ` ${statusDotWorking}` : ""}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
		/>
	);
}

/** The words with their dot. The dot sits on the words' baseline, then moves up onto the middle of their capitals. */
const statusLabelClass =
	"inline-flex min-w-0 items-baseline gap-1.5 text-xs leading-tight whitespace-nowrap text-(--kt-status-current) [&>.kt-status-dot]:translate-y-(--kt-on-cap)";

/**
 * A status in words with its dot: "Working", "Needs approval". The words default to the status's own label; pass
 * children to say something more specific ("Working for 3m").
 */
export function StatusLabel({ status, children }: { status: Status; children?: ReactNode }) {
	return (
		<span className={`kt-status-label kt-status-${status} ${statusLabelClass}`}>
			<StatusDot status={status} />
			<span>{children ?? statusLabel[status]}</span>
		</span>
	);
}

export type BadgeTone = "neutral" | "accent" | Status;

/** The pill. Its words are trimmed to their capitals and centred in it, so they look centred in any font. */
const badgeBase =
	"inline-flex h-[calc(var(--kt-control-xs)_-_var(--kt-step-1_5))] flex-none items-center rounded-full px-2 text-2xs font-medium leading-none whitespace-nowrap";

/** Each tone's tint and text colour; a status tone reads its status's colours from the kt-status class. */
const badgeTones = {
	neutral: "kt-badge-neutral bg-active text-muted",
	accent: "kt-badge-accent bg-accent-soft text-accent-text",
	status: "bg-(--kt-status-current-soft) text-(--kt-status-current)",
} as const;

/**
 * A short tag on a value or a row: "Proposed", "Approved", "Read only". Sentence case, one or two words. Not a
 * status indicator for a whole session (use StatusLabel) and never a button.
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
	const toneClass =
		tone === "neutral" || tone === "accent" ? badgeTones[tone] : `kt-status-${tone} ${badgeTones.status}`;
	return (
		<span className={`kt-badge ${badgeBase} ${toneClass}`}>
			<span className="kt-badge-text [text-box:trim-both_cap_alphabetic]">{children}</span>
		</span>
	);
}
