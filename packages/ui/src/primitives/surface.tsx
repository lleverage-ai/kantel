import type { ComponentProps, ReactNode } from "react";
import { AlertIcon, InfoIcon, XCircleIcon } from "./icons.tsx";
import "./surface.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

export type PanelTone = "default" | "approval" | "error";

const panelTone = {
	default: "border-border",
	approval: "border-status-approval-line",
	error: "border-status-error-line",
} as const;

/** A panel's header and footer: one short row of small text, a hairline from the body. */
const panelHeader =
	"flex min-h-control-md min-w-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted";
const panelFooter = "flex min-w-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-faint";

/**
 * A bordered panel on the canvas: the frame for cards, settings groups and detail views. A header row, a body and
 * an optional footer, separated by hairlines. Panels sit in the flow and use a border, never a shadow.
 */
export function Panel({
	header,
	footer,
	tone = "default",
	className,
	children,
	...rest
}: ComponentProps<"section"> & { header?: ReactNode; footer?: ReactNode; tone?: PanelTone }) {
	return (
		<section
			className={`hb-panel hb-panel-${tone} flex min-w-0 flex-col overflow-hidden rounded-panel border bg-panel ${panelTone[tone]}${className ? ` ${className}` : ""}`}
			{...rest}
		>
			{header === undefined ? null : <header className={`hb-panel-header ${panelHeader}`}>{header}</header>}
			<div className="hb-panel-body flex min-w-0 flex-col gap-3 p-3">{children}</div>
			{footer === undefined ? null : <footer className={`hb-panel-footer ${panelFooter}`}>{footer}</footer>}
		</section>
	);
}

export type NoticeLevel = "info" | "warning" | "error";

const noticeIcon = {
	info: <InfoIcon size="sm" />,
	warning: <AlertIcon size="sm" />,
	error: <XCircleIcon size="sm" />,
} as const;

/**
 * A notice's frame. Its icon sits on the first line's baseline, then moves up onto the middle of its capitals (see
 * --hb-on-cap).
 */
const noticeClass =
	"flex min-w-0 items-start gap-2 rounded-control border bg-panel px-2.5 py-2 text-sm leading-normal [&>.hb-icon]:translate-y-(--hb-on-cap) [&>.hb-icon]:self-baseline";

/** Each level's border, words and icon colour. */
const noticeLevel = {
	info: "border-border text-muted [&>.hb-icon]:text-faint",
	warning: "border-status-approval-line text-muted [&>.hb-icon]:text-status-approval",
	error: "border-status-error-line text-fg [&>.hb-icon]:text-status-error",
} as const;

/**
 * A one or two line message in the flow: "This tool may have partly run", "Reconnecting". For something the person
 * must decide, use a card; for a whole empty screen, EmptyState.
 *
 * A notice is announced when it appears (an error as an alert). Pass `announce={false}` for one that is part of a
 * record rather than news, such as a notice in a transcript, which would otherwise be read again whenever the
 * virtual list mounts it.
 */
export function Notice({
	level = "info",
	children,
	action,
	announce = true,
}: {
	level?: NoticeLevel;
	children: ReactNode;
	action?: ReactNode;
	announce?: boolean;
}) {
	return (
		<div
			className={`hb-notice hb-notice-${level} ${noticeClass} ${noticeLevel[level]}`}
			role={announce ? (level === "error" ? "alert" : "status") : undefined}
		>
			{noticeIcon[level]}
			<div className="hb-notice-text min-w-0 flex-1 self-baseline wrap-anywhere">{children}</div>
			{action === undefined ? null : <div className="hb-notice-action -my-0.5 flex-none">{action}</div>}
		</div>
	);
}

/**
 * What a screen or a list says when it has nothing to show, and what to do about it. One sentence of title, at most
 * one more of detail, at most one action. `greeting`: the larger title a new session opens with, over the composer in
 * the middle of the page, as claude.ai greets a new chat.
 */
export function EmptyState({
	title,
	children,
	action,
	greeting = false,
}: {
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	greeting?: boolean;
}) {
	return (
		<div
			className={`hb-empty flex flex-col items-center text-center ${greeting ? "gap-2 px-4 py-0" : "gap-1 px-4 py-8"}`}
		>
			<p
				className={`hb-empty-title m-0 text-fg ${greeting ? "text-doc-h2 leading-tight font-medium" : "text-md font-medium"}`}
			>
				{title}
			</p>
			{children === undefined ? null : (
				<p className={`hb-empty-detail m-0 text-muted ${greeting ? "max-w-[48ch] text-md" : "max-w-[36ch] text-sm"}`}>
					{children}
				</p>
			)}
			{action === undefined ? null : <div className="hb-empty-action mt-2.5">{action}</div>}
		</div>
	);
}

/*
 * A badge shares the row's baseline, and its words are centred in the pill, but its type is smaller than the value's,
 * so the middle of its capitals sits below the middle of the value's. It moves up by half the difference in cap
 * height: --hb-row-cap is the row's cap height, resolved in the row's type (a registered length, surface.css, computes
 * where it is set), against 1cap in the badge's own. Nothing about the row's layout changes.
 */
const fieldRow = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 [--hb-row-cap:1cap]";
/** A pill is nearly a line tall; it may overhang the line by a pixel rather than push the rows apart. */
const fieldExtra = "mx-0 -my-0.5 flex-none *:translate-y-[calc(0.5cap_-_0.5_*_var(--hb-row-cap))]";

/** A label and its value, in a definition list. Use inside a Panel or a card for terms, settings and facts. */
export function Field({ label, children, extra }: { label: string; children: ReactNode; extra?: ReactNode }) {
	return (
		<div className={`hb-field-row ${fieldRow}`}>
			<dt className="hb-field-label min-w-[7.5em] flex-none text-faint">{label}</dt>
			<dd className="hb-field-value m-0 min-w-0 flex-1 text-fg wrap-anywhere">{children}</dd>
			{extra === undefined ? null : <dd className={`hb-field-extra ${fieldExtra}`}>{extra}</dd>}
		</div>
	);
}

export function FieldList({ children }: { children: ReactNode }) {
	return <dl className="hb-field-list m-0 flex min-w-0 flex-col gap-1.5 text-sm">{children}</dl>;
}
