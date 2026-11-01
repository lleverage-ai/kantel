import { memo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { ChevronRightIcon } from "../primitives/icons.tsx";

// A JSON value as a tree a person reads and opens: an API's answer in a connection call's opened view
// (session/connection-tools.tsx). Open to `openDepth` levels (one by default: the top level's keys, each object or
// array under them folded to a line that says how much it holds), every fold a button (Tab reaches it, Enter or Space
// opens it, `aria-expanded` says which it is). A folded value renders nothing of what it holds, so a 60 KB answer
// costs its first level. A long array shows its first `PAGE` items and a button for the rest.
//
// Styled with Tailwind utilities in the code font and the theme's syntax colours (`--kt-syntax-*`), so it follows a
// theme switch as highlighted code does (code/syntax.css).

/** How many of an array's items, or an object's keys, show before "Show N more". */
export const JSON_PAGE = 100;

export type JsonViewerProps = {
	value: unknown;
	/** How many levels start open: 1 opens the top level and folds what is under it. */
	openDepth?: number;
	/** What the value is, for a screen reader: "The response". */
	label?: string;
	className?: string;
};

const keyClass = "text-(--kt-syntax-property)";
const punctuation = "text-faint";
/** A fold's button: the whole line, chevron, key and summary, as one target. */
const foldClass =
	"kt-json-fold kt-focusable -mx-1 inline-flex max-w-full cursor-pointer items-baseline gap-1 rounded-xs border-0 bg-transparent px-1 py-0 text-left text-fg hover:bg-hover";

/** The kind of a JSON value, for its colour and how it opens. */
type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

const kindOf = (value: unknown): Kind =>
	value === null
		? "null"
		: Array.isArray(value)
			? "array"
			: typeof value === "object"
				? "object"
				: typeof value === "string"
					? "string"
					: typeof value === "number"
						? "number"
						: typeof value === "boolean"
							? "boolean"
							: "null";

/** "3 items", "1 key": what a folded value holds. */
export function jsonSummary(value: unknown): string {
	if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length.toLocaleString("en-GB")} items`;
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value).length;
		return keys === 1 ? "1 key" : `${keys.toLocaleString("en-GB")} keys`;
	}
	return "";
}

/** A value that isn't an object or array, in its syntax colour. */
function Scalar({ value }: { value: unknown }) {
	const kind = kindOf(value);
	if (kind === "string")
		return <span className="text-(--kt-syntax-string) wrap-anywhere">{JSON.stringify(value)}</span>;
	return <span className="text-(--kt-syntax-number)">{kind === "null" ? "null" : String(value)}</span>;
}

/** An object's or array's entries, as [key, value] (an array's keys are its indexes). */
const entriesOf = (value: object): [string, unknown][] =>
	Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);

/** One entry: its key (none at the root, and an array's index quiet), then its value, open or folded. */
const Entry = memo(function Entry({
	name,
	index,
	value,
	depth,
	openDepth,
	last,
}: {
	name: string | undefined;
	/** An array's item: its index is quiet, not a key. */
	index: boolean;
	value: unknown;
	depth: number;
	openDepth: number;
	last: boolean;
}) {
	const kind = kindOf(value);
	const nested = kind === "object" || kind === "array";
	const [open, setOpen] = useState(depth < openDepth);
	const comma = last ? null : <span className={punctuation}>,</span>;
	const key =
		name === undefined ? null : (
			<span className={index ? "text-faint" : keyClass}>
				{index ? name : JSON.stringify(name)}
				<span className={punctuation}>:</span>
			</span>
		);
	if (!nested) {
		return (
			<li className="kt-json-entry pl-4">
				{key === null ? null : <>{key} </>}
				<Scalar value={value} />
				{comma}
			</li>
		);
	}
	const entries = entriesOf(value as object);
	const [opening, closing] = kind === "array" ? ["[", "]"] : ["{", "}"];
	if (entries.length === 0) {
		return (
			<li className="kt-json-entry pl-4">
				{key === null ? null : <>{key} </>}
				<span className={punctuation}>
					{opening}
					{closing}
				</span>
				{comma}
			</li>
		);
	}
	return (
		<li className="kt-json-entry">
			<button type="button" className={foldClass} aria-expanded={open} onClick={() => setOpen((was) => !was)}>
				<ChevronRightIcon
					size="sm"
					className={`kt-json-chevron flex-none self-center text-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
				{key}
				<span className={punctuation}>{opening}</span>
				{open ? null : (
					<>
						<span className="text-faint">{jsonSummary(value)}</span>
						<span className={punctuation}>{closing}</span>
					</>
				)}
			</button>
			{open ? null : comma}
			{open ? (
				<>
					<Entries entries={entries} array={kind === "array"} depth={depth + 1} openDepth={openDepth} />
					<span className={`${punctuation} pl-4`}>
						{closing}
						{comma}
					</span>
				</>
			) : null}
		</li>
	);
});

/** An open value's entries, one level in, the first `JSON_PAGE` until the person asks for the rest. */
function Entries({
	entries,
	array,
	depth,
	openDepth,
}: {
	entries: readonly [string, unknown][];
	array: boolean;
	depth: number;
	openDepth: number;
}) {
	const [shown, setShown] = useState(JSON_PAGE);
	const more = entries.length - shown;
	return (
		<ul className="kt-json-entries m-0 list-none pl-4">
			{entries.slice(0, shown).map(([name, value], index) => (
				<Entry
					key={name}
					name={name}
					index={array}
					value={value}
					depth={depth}
					openDepth={openDepth}
					last={index === entries.length - 1}
				/>
			))}
			{more > 0 ? (
				<li className="pt-1 pl-3">
					<Button
						variant="ghost"
						size="xs"
						className="kt-json-more font-sans text-muted! hover:enabled:text-fg!"
						onClick={() => setShown(entries.length)}
					>
						{`Show ${more.toLocaleString("en-GB")} more`}
					</Button>
				</li>
			) : null}
		</ul>
	);
}

/** A JSON value as a tree, open to `openDepth` levels, every fold a button. */
export function JsonViewer({ value, openDepth = 1, label, className = "" }: JsonViewerProps) {
	return (
		<ul
			className={`kt-json-viewer kt-selectable m-0 min-w-0 list-none p-0 font-mono text-code leading-normal text-fg select-text ${className}`}
			aria-label={label}
		>
			<Entry name={undefined} index={false} value={value} depth={0} openDepth={openDepth} last />
		</ul>
	);
}
