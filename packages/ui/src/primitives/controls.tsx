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
import { CheckIcon, ChevronRightIcon, CopyIcon } from "./icons.tsx";
import "./controls.css";

/**
 * A summary row that shows and hides detail below it: tool output, a thought, an older group of steps. The summary is
 * a real button with aria-expanded, so Enter and Space work, and the detail is only rendered while open.
 */
export function Disclosure({
	summary,
	children,
	defaultOpen = false,
	open: controlled,
	onOpenChange,
	className,
}: {
	summary: ReactNode;
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
		<div className={`hb-disclosure${open ? " hb-disclosure-open" : ""}${className ? ` ${className}` : ""}`}>
			<button
				type="button"
				className="hb-disclosure-summary hb-focusable"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					setUncontrolled(!open);
					onOpenChange?.(!open);
				}}
			>
				<ChevronRightIcon size="sm" className="hb-disclosure-chevron" />
				<span className="hb-disclosure-text">{summary}</span>
			</button>
			{open ? (
				<div id={id} className="hb-disclosure-detail">
					{children}
				</div>
			) : null}
		</div>
	);
}

/**
 * Copies text and says so for a moment. The label stays in words ("Copy link"); the icon changes to a tick and the
 * label to "Copied" for 1.5s, announced politely.
 */
export function CopyButton({
	text,
	label = "Copy",
	iconOnly = false,
	className,
	...rest
}: Omit<ButtonProps, "onClick" | "children" | "icon"> & { text: string; label?: string; iconOnly?: boolean }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(() => {
		void navigator.clipboard?.writeText(text).then(
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
			className={[iconOnly ? "hb-icon-button" : "", className ?? ""].join(" ").trim() || undefined}
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

function inputClass(base: string, width: FieldProps["width"], mono: boolean | undefined) {
	return `${base}${width === "short" ? " hb-input-short" : ""}${mono ? " hb-input-mono" : ""} hb-focusable`;
}

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
				className={inputClass("hb-input", width, mono)}
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
				className={inputClass("hb-input hb-textarea", "full", mono)}
				aria-invalid={error !== undefined || undefined}
				aria-describedby={describedBy(id, hint, error)}
				{...rest}
			/>
		</FormField>
	);
}

export type SelectOption = { readonly value: string; readonly label: string };

/**
 * A labelled choice of one from a list too long for a SegmentedControl: a project, a model. The browser's own select,
 * so the keyboard, a screen reader and a phone's picker all work as people expect.
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
			<select
				id={id}
				className={inputClass("hb-input hb-select", width, false)}
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
		</FormField>
	);
}

export type SegmentOption<T extends string> = { value: T; label: string; count?: number };

/**
 * A small set of mutually exclusive views or filters: "Unified" or "Split", "All", "Working" and "Done". A radio
 * group: Tab reaches the selected option, arrow keys move between options.
 */
export function SegmentedControl<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly SegmentOption<T>[];
	value: T;
	onChange: (value: T) => void;
}) {
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
		const index = options.findIndex((option) => option.value === value);
		const next = (index + step + options.length) % options.length;
		const option = options[next];
		if (option === undefined) return;
		onChange(option.value);
		refs.current[next]?.focus();
	};
	return (
		<div className="hb-segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
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
						tabIndex={checked ? 0 : -1}
						className="hb-segment hb-focusable"
						onClick={() => onChange(option.value)}
					>
						{option.label}
						{option.count === undefined ? null : <span className="hb-segment-count">{option.count}</span>}
					</button>
				);
			})}
		</div>
	);
}
