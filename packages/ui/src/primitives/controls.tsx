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

/** A single-line text input with its label, an optional hint and an error. */
export function TextField({
	label,
	hint,
	error,
	className,
	id: suppliedId,
	...rest
}: ComponentProps<"input"> & { label: string; hint?: string; error?: string }) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	const described = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
	return (
		<div className={`hb-text-field${className ? ` ${className}` : ""}`}>
			<label className="hb-text-field-label" htmlFor={id}>
				{label}
			</label>
			<input
				id={id}
				className="hb-input hb-focusable"
				aria-invalid={error !== undefined || undefined}
				aria-describedby={described}
				{...rest}
			/>
			{error !== undefined ? (
				<p id={`${id}-error`} className="hb-text-field-error">
					{error}
				</p>
			) : hint !== undefined ? (
				<p id={`${id}-hint`} className="hb-text-field-hint">
					{hint}
				</p>
			) : null}
		</div>
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
	options,
	className,
	id: suppliedId,
	...rest
}: Omit<ComponentProps<"select">, "children" | "multiple"> & {
	label: string;
	options: readonly SelectOption[];
	hint?: string;
	error?: string;
}) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	const described = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
	return (
		<div className={`hb-text-field${className ? ` ${className}` : ""}`}>
			<label className="hb-text-field-label" htmlFor={id}>
				{label}
			</label>
			<select
				id={id}
				className="hb-input hb-select hb-focusable"
				aria-invalid={error !== undefined || undefined}
				aria-describedby={described}
				{...rest}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			{error !== undefined ? (
				<p id={`${id}-error`} className="hb-text-field-error">
					{error}
				</p>
			) : hint !== undefined ? (
				<p id={`${id}-hint`} className="hb-text-field-hint">
					{hint}
				</p>
			) : null}
		</div>
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
