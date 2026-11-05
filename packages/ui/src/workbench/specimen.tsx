import type { ReactNode } from "react";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

// Layout helpers for stories only; not exported from the library.

/** A story's page: the title, an intro, then its sections, at the content width plus room either side. */
const sheet = "flex max-w-[calc(var(--kt-content-width)+var(--kt-step-12)*4)] flex-col gap-6";
/** The intro sits close under the title: the negative top margin takes back most of the sheet's gap. */
const introClass = "-mt-4 mb-0 max-w-[70ch] text-sm text-muted";
/** A row of items with an optional label at the left; the items wrap. */
const row = "flex flex-wrap items-center gap-x-4 gap-y-2";
const rowItems = "flex min-w-0 flex-1 flex-wrap items-center gap-2";
const swatchChip =
	"flex h-12 items-center justify-center rounded-control border border-border-strong text-lg font-medium";

export function Sheet({ title, children, intro }: { title: string; intro?: ReactNode; children: ReactNode }) {
	return (
		<div className={sheet}>
			<h1 className="m-0 text-lg font-strong">{title}</h1>
			{intro === undefined ? null : <p className={introClass}>{intro}</p>}
			{children}
		</div>
	);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="m-0 text-sm font-medium text-muted">{title}</h2>
			{children}
		</section>
	);
}

export function Row({ children, label }: { children: ReactNode; label?: string }) {
	return (
		<div className={row}>
			{label === undefined ? null : <span className="w-[9em] text-sm text-faint">{label}</span>}
			<div className={rowItems}>{children}</div>
		</div>
	);
}

/** A column as wide as the transcript, for components that live in it. */
export function Column({ children }: { children: ReactNode }) {
	return <div className="flex w-full max-w-content flex-col gap-3">{children}</div>;
}

export function Swatch({ name, value, text }: { name: string; value: string; text?: boolean }) {
	return (
		<div className="flex w-[9em] flex-col gap-1">
			<span className={swatchChip} style={text ? { color: value } : { background: value }}>
				{text ? "Aa" : null}
			</span>
			<code className="font-mono text-xs wrap-anywhere text-muted">{name}</code>
		</div>
	);
}
