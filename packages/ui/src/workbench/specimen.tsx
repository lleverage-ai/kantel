import type { ReactNode } from "react";
import "./specimen.css";

// Layout helpers for stories only; not exported from the library.

export function Sheet({ title, children, intro }: { title: string; intro?: ReactNode; children: ReactNode }) {
	return (
		<div className="wb-sheet">
			<h1 className="wb-title">{title}</h1>
			{intro === undefined ? null : <p className="wb-intro">{intro}</p>}
			{children}
		</div>
	);
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="wb-section">
			<h2 className="wb-section-title">{title}</h2>
			{children}
		</section>
	);
}

export function Row({ children, label }: { children: ReactNode; label?: string }) {
	return (
		<div className="wb-row">
			{label === undefined ? null : <span className="wb-row-label">{label}</span>}
			<div className="wb-row-items">{children}</div>
		</div>
	);
}

/** A column as wide as the transcript, for components that live in it. */
export function Column({ children }: { children: ReactNode }) {
	return <div className="wb-column">{children}</div>;
}

export function Swatch({ name, value, text }: { name: string; value: string; text?: boolean }) {
	return (
		<div className="wb-swatch">
			<span className="wb-swatch-chip" style={text ? { color: value } : { background: value }}>
				{text ? "Aa" : null}
			</span>
			<code className="wb-swatch-name">{name}</code>
		</div>
	);
}
