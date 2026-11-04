import {
	type ComponentProps,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button, type ButtonProps } from "./button.tsx";
import { describedBy, FormField, type FormFieldLayout } from "./form-layout.tsx";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "./icons.tsx";
import "./controls.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * What `font: inherit` did on a control, as longhands: the shorthand would also reset the font size and line height
 * that the control sets in a utility of its own, and Tailwind's sort, not the class order, decides which wins.
 */
const inheritFont = "[font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit]";

/** A Disclosure's frame. Exported, with the rest, for a row that draws a disclosure's summary itself (a turn fold). */
export const disclosureClass = "kt-disclosure min-w-0";

/** The summary button: a muted row, lit on hover, pulled left so the chevron hangs in the gutter. */
export const disclosureSummaryClass = `kt-disclosure-summary kt-focusable -ml-1.5 flex min-h-control-xs w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-left text-sm text-muted ${inheritFont} [line-height:inherit] hover:bg-hover hover:text-fg`;

/** The chevron, turned down while the disclosure is open. */
export function disclosureChevronClass(open: boolean) {
	return `kt-disclosure-chevron flex-none text-faint transition-transform${open ? " rotate-90" : ""}`;
}

/** Trimmed to its capitals, as a Button's label is, so the chevron and the words share one centre. */
export const disclosureTextClass = "kt-disclosure-text min-w-0 py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";

/**
 * A summary row that shows and hides detail below it: tool output, a thought, an older group of steps. The summary is
 * a real button with aria-expanded, so Enter and Space work, and the detail is only rendered while open.
 */
export function Disclosure({
	summary,
	trailing,
	children,
	defaultOpen = false,
	open: controlled,
	onOpenChange,
	className,
}: {
	summary: ReactNode;
	/** After the summary's words, in the button, outside their clip: a count or a mark that must stay whole. */
	trailing?: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
}) {
	const [uncontrolled, setUncontrolled] = useState(defaultOpen);
	const open = controlled ?? uncontrolled;
	const id = useId();
	return (
		<div className={`${disclosureClass}${open ? " kt-disclosure-open" : ""}${className ? ` ${className}` : ""}`}>
			<button
				type="button"
				className={disclosureSummaryClass}
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					setUncontrolled(!open);
					onOpenChange?.(!open);
				}}
			>
				<ChevronRightIcon size="sm" className={disclosureChevronClass(open)} />
				<span className={disclosureTextClass}>{summary}</span>
				{trailing}
			</button>
			{open ? (
				<div id={id} className="kt-disclosure-detail min-w-0 pt-1 pr-0 pb-2 pl-4">
					{children}
				</div>
			) : null}
		</div>
	);
}

/**
 * Copies text and says so for a moment. The label stays in words ("Copy link"); the icon changes to a tick and the
 * label to "Copied" for 1.5s, announced politely. `text` may be read on the click, for text that goes stale (a link
 * with a token that expires).
 */
export function CopyButton({
	text,
	label = "Copy",
	iconOnly = false,
	className,
	...rest
}: Omit<ButtonProps, "onClick" | "children" | "icon"> & {
	text: string | (() => Promise<string>);
	label?: string;
	iconOnly?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(() => {
		const clipboard = navigator.clipboard;
		if (clipboard === undefined) return;
		let written: Promise<void>;
		if (typeof text === "string") written = clipboard.writeText(text);
		else if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
			// The item is handed over during the click, with its text to come, which Safari needs for a later write.
			const blob = text().then((value) => new Blob([value], { type: "text/plain" }));
			written = clipboard.write([new ClipboardItem({ "text/plain": blob })]);
		} else written = text().then((value) => clipboard.writeText(value));
		void written.then(
			() => {
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1500);
			},
			() => setCopied(false),
		);
	}, [text]);
	const words = copied ? "Copied" : label;
	return (
		<Button
			{...rest}
			onClick={copy}
			icon={copied ? <CheckIcon size="sm" /> : <CopyIcon size="sm" />}
			aria-label={iconOnly ? words : undefined}
			title={iconOnly ? words : undefined}
			className={[iconOnly ? "kt-icon-button" : "", className ?? ""].join(" ").trim() || undefined}
		>
			{iconOnly ? undefined : <span aria-live="polite">{words}</span>}
		</Button>
	);
}

/** What every labelled field takes on top of its element's own props. See FormField. */
type FieldProps = {
	label: string;
	hint?: string;
	error?: string;
	layout?: FormFieldLayout;
	hideLabel?: boolean;
	/** Beside the label: a Proposed or Narrowed badge. */
	extra?: ReactNode;
	/** The input's width: the column's (default), or one sized for a short value such as a number or a time. */
	width?: "full" | "short";
	mono?: boolean;
};

/**
 * The frame every text control shares (labels, help and errors are FormField's): sunken, a hairline round it, red
 * when invalid.
 */
const fieldFrame =
	"kt-focusable min-w-0 rounded-control border border-border-input bg-sunken text-fg [font-feature-settings:inherit] [font-weight:inherit] placeholder:text-faint aria-[invalid=true]:border-status-error-line";

/**
 * Each control's height and padding. A single line is a control tall, and taller on touch; a text area's height
 * follows its rows and the person can drag it taller; a select draws its own chevron (see SelectField), so it keeps
 * room at its end for that, and fades when disabled, as the browser's own select did before preflight set every
 * control's opacity to 1.
 */
const fieldKind = {
	input: "h-control-md px-2.5 py-0 [line-height:inherit] pointer-coarse:h-control-lg",
	textarea: "h-auto min-h-control-md resize-y px-2.5 py-2 leading-normal",
	select:
		"peer h-control-md cursor-pointer appearance-none py-0 pr-8 pl-2.5 [line-height:inherit] pointer-coarse:h-control-lg disabled:opacity-70",
} as const;

/** A short value (a number, a time, a date): one width everywhere, so short fields line up from form to form. */
const fieldWidth = {
	full: "w-full",
	short: "w-[calc(var(--kt-control-lg)_*_5)] max-w-full",
} as const;

/** The words: the page's font, or code's. 16px on touch stops iOS zooming into the field. */
const fieldFont = {
	sans: "[font-family:inherit] text-md pointer-coarse:text-lg",
	mono: "font-mono text-code pointer-coarse:text-lg",
} as const;

function fieldClass(kind: keyof typeof fieldKind, width: FieldProps["width"], mono: boolean | undefined) {
	const hooks = `kt-input${kind === "input" ? "" : ` kt-${kind}`}${width === "short" ? " kt-input-short" : ""}${mono ? " kt-input-mono" : ""}`;
	return `${hooks} ${fieldFrame} ${fieldKind[kind]} ${fieldWidth[width ?? "full"]} ${fieldFont[mono ? "mono" : "sans"]}`;
}

/** A plain single-line text input, full width, for one drawn outside TextField (a share popover's invite field). */
export const inputClass = fieldClass("input", "full", false);

/** A single-line text input with its label, an optional hint and an error, laid out by FormField. */
export function TextField({
	label,
	hint,
	error,
	layout,
	hideLabel,
	extra,
	width,
	mono,
	className,
	id: suppliedId,
	...rest
}: ComponentProps<"input"> & FieldProps) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	return (
		<FormField id={id} label={label} htmlFor={id} {...{ hint, error, layout, hideLabel, extra, className }}>
			<input
				id={id}
				className={fieldClass("input", width, mono)}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={describedBy(id, hint, error)}
				{...rest}
			/>
		</FormField>
	);
}

/**
 * A labelled multi-line input for text a person writes out: a scheduled task's prompt, a note. It grows with its rows
 * and the person can drag it taller. Not the composer, which sends on Enter.
 */
export function TextAreaField({
	label,
	hint,
	error,
	layout,
	hideLabel,
	extra,
	mono,
	className,
	id: suppliedId,
	rows = 4,
	...rest
}: ComponentProps<"textarea"> & Omit<FieldProps, "width">) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	return (
		<FormField id={id} label={label} htmlFor={id} {...{ hint, error, layout, hideLabel, extra, className }}>
			<textarea
				id={id}
				rows={rows}
				className={fieldClass("textarea", "full", mono)}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={describedBy(id, hint, error)}
				{...rest}
			/>
		</FormField>
	);
}

export type SelectOption = { readonly value: string; readonly label: string };

/**
 * The select's chevron, in place of the browser's arrow: inset from the end as far as the words are from the start
 * (2.5, as a text input's), in the muted colour, and faded with a disabled select. The select's `pr-8` is that inset,
 * the icon and a gap, so long words stop short of it. The browser's own arrow sat wherever the engine put it, and
 * Safari drew it against the border whatever the padding.
 */
const selectChevron = "pointer-events-none absolute right-2.5 text-muted peer-disabled:opacity-70";

/**
 * A labelled choice of one from a list too long for a SegmentedControl: a project, a model. The browser's own select,
 * so the keyboard, a screen reader and a phone's picker all work as people expect; only its arrow is drawn here.
 */
export function SelectField({
	label,
	hint,
	error,
	layout,
	hideLabel,
	extra,
	width,
	options,
	className,
	id: suppliedId,
	...rest
}: Omit<ComponentProps<"select">, "children" | "multiple"> &
	Omit<FieldProps, "mono"> & {
		options: readonly SelectOption[];
	}) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	return (
		<FormField id={id} label={label} htmlFor={id} {...{ hint, error, layout, hideLabel, extra, className }}>
			<span className={`kt-select-frame relative flex min-w-0 items-center ${fieldWidth[width ?? "full"]}`}>
				<select
					id={id}
					className={`${fieldClass("select", "full", false)}${width === "short" ? " kt-input-short" : ""}`}
					aria-invalid={error !== undefined || undefined}
					aria-describedby={describedBy(id, hint, error)}
					{...rest}
				>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				<ChevronDownIcon size="sm" className={selectChevron} />
			</span>
		</FormField>
	);
}

/** One on/off choice: the browser's checkbox in the accent colour, its label beside it, a hint under the label. */
const checkboxField =
	"kt-checkbox-field inline-grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 text-sm leading-normal text-fg";
const checkboxClass = "kt-checkbox kt-focusable peer m-0 size-3.5 cursor-pointer accent-accent disabled:cursor-default";

/**
 * One on/off choice that is part of a form or a decision and takes effect with it: "Let agents write" beside a Grant
 * button. The browser's own checkbox, so Space toggles it and a screen reader announces its state, with its label
 * beside it (clicking the label toggles it too) and an optional hint read as its description.
 */
export function CheckboxField({
	label,
	hint,
	className,
	id: suppliedId,
	...rest
}: Omit<ComponentProps<"input">, "type" | "children"> & { label: string; hint?: string }) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	return (
		<div className={`${checkboxField}${className === undefined ? "" : ` ${className}`}`}>
			<input
				id={id}
				type="checkbox"
				className={checkboxClass}
				aria-describedby={describedBy(id, hint, undefined)}
				{...rest}
			/>
			{/* A disabled box's label greys out with it: the box is the label's peer. */}
			<label
				htmlFor={id}
				className="kt-checkbox-label cursor-pointer peer-disabled:cursor-default peer-disabled:text-disabled"
			>
				{label}
			</label>
			{hint === undefined ? null : (
				<span id={`${id}-hint`} className="kt-checkbox-hint col-start-2 text-sm text-faint">
					{hint}
				</span>
			)}
		</div>
	);
}

/**
 * `disabled`: shown but not chosen, such as an option that is coming; arrow keys pass over it. `tone`: chosen, the
 * option takes its status's tint, where the choice is an answer such as Allow, Ask or Block.
 */
export type SegmentOption<T extends string> = {
	value: T;
	label: string;
	count?: number;
	disabled?: boolean;
	tone?: SegmentTone;
};

export type SegmentTone = "done" | "approval" | "error";

/** A toned option, chosen: its status's tint and colour in place of the plain lit segment's. */
const segmentTone: Record<SegmentTone, string> = {
	done: "aria-checked:bg-status-done-soft aria-checked:text-status-done",
	approval: "aria-checked:bg-status-approval-soft aria-checked:text-status-approval",
	error: "aria-checked:bg-status-error-soft aria-checked:text-status-error",
};

/** The segments' sunken tray. */
const segmentedClass = "kt-segmented inline-flex gap-0.5 rounded-full border border-border bg-sunken p-0.5";

/** A segment: muted words, lit when it is the chosen one (`segmentLit`, or its tone's tint). */
const segmentClass = `kt-segment kt-focusable inline-flex h-[calc(var(--kt-control-sm)_-_var(--kt-step-1))] cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 py-0 text-sm text-muted ${inheritFont} [line-height:inherit] hover:not-disabled:text-fg disabled:cursor-default disabled:text-disabled`;
const segmentLit = "aria-checked:bg-active aria-checked:text-fg";

/**
 * A small set of mutually exclusive views or filters: "Unified" or "Split", "All", "Working" and "Done". A radio
 * group: Tab reaches the selected option, arrow keys move between options. With no value yet (a page still working out
 * which view to open on) no option is lit and Tab reaches the first; choosing one is the person's choice.
 */
export function SegmentedControl<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly SegmentOption<T>[];
	value: T | undefined;
	onChange: (value: T) => void;
}) {
	// The option Tab reaches: the chosen one, else the first that can be chosen.
	const focusable = value === undefined ? options.find((option) => option.disabled !== true)?.value : value;
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		const chosen = options.findIndex((option) => option.value === value);
		// With nothing chosen yet, the first step lands on the first option (or the last, going back).
		const index = chosen === -1 ? (step > 0 ? -1 : options.length) : chosen;
		for (let move = 1; move <= options.length; move++) {
			const next = (index + step * move + options.length * move) % options.length;
			if (next === chosen) break;
			const option = options[next];
			if (option === undefined || option.disabled === true) continue;
			onChange(option.value);
			refs.current[next]?.focus();
			return;
		}
	};
	return (
		<div className={segmentedClass} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
			{options.map((option, index) => {
				const checked = option.value === value;
				return (
					// biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio group pattern with roving focus; native radios cannot be styled as segments as simply.
					<button
						key={option.value}
						ref={(element) => {
							refs.current[index] = element;
						}}
						type="button"
						role="radio"
						aria-checked={checked}
						tabIndex={option.value === focusable ? 0 : -1}
						disabled={option.disabled}
						className={`${segmentClass} ${option.tone === undefined ? segmentLit : segmentTone[option.tone]}`}
						onClick={() => onChange(option.value)}
					>
						{option.label}
						{option.count === undefined ? null : (
							<span className="kt-segment-count text-faint tabular-nums">{option.count}</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
