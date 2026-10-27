import type { ComponentProps, ReactNode } from "react";
import { AlertIcon, InfoIcon, XCircleIcon } from "./icons.tsx";
import "./surface.css";

export type PanelTone = "default" | "approval" | "error";

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
		<section className={`hb-panel hb-panel-${tone}${className ? ` ${className}` : ""}`} {...rest}>
			{header === undefined ? null : <header className="hb-panel-header">{header}</header>}
			<div className="hb-panel-body">{children}</div>
			{footer === undefined ? null : <footer className="hb-panel-footer">{footer}</footer>}
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
 * A one or two line message in the flow: "This tool may have partly run", "Reconnecting". For something the person
 * must decide, use a card; for a whole empty screen, EmptyState.
 */
export function Notice({
	level = "info",
	children,
	action,
}: {
	level?: NoticeLevel;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className={`hb-notice hb-notice-${level}`} role={level === "error" ? "alert" : "status"}>
			{noticeIcon[level]}
			<div className="hb-notice-text">{children}</div>
			{action === undefined ? null : <div className="hb-notice-action">{action}</div>}
		</div>
	);
}

/**
 * What a screen or a list says when it has nothing to show, and what to do about it. One sentence of title, at most
 * one more of detail, at most one action.
 */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
	return (
		<div className="hb-empty">
			<p className="hb-empty-title">{title}</p>
			{children === undefined ? null : <p className="hb-empty-detail">{children}</p>}
			{action === undefined ? null : <div className="hb-empty-action">{action}</div>}
		</div>
	);
}

/** A label and its value, in a definition list. Use inside a Panel or a card for terms, settings and facts. */
export function Field({ label, children, extra }: { label: string; children: ReactNode; extra?: ReactNode }) {
	return (
		<div className="hb-field-row">
			<dt className="hb-field-label">{label}</dt>
			<dd className="hb-field-value">{children}</dd>
			{extra === undefined ? null : <dd className="hb-field-extra">{extra}</dd>}
		</div>
	);
}

export function FieldList({ children }: { children: ReactNode }) {
	return <dl className="hb-field-list">{children}</dl>;
}
