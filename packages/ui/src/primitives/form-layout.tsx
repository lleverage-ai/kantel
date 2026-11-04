import { type ComponentProps, type ReactNode, type Ref, useId } from "react";
import "./form-layout.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). form-layout.css keeps the container
// queries (the closed theme has no container sizes) and the form's rule on every paragraph inside it, on the kt- hooks
// below.

/** The component's own classes, then the caller's. */
function withClass(base: string, className: string | undefined): string {
	return className ? `${base} ${className}` : base;
}

/**
 * The page's header, over a hairline: the title on the left and the actions on the right of one row, at every width,
 * and the lede under both across the page.
 */
const pageHeader =
	"kt-page-header grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b border-border pb-4";

/** A control that sizes itself (a segmented control) keeps its own width straight in a form or a section. */
const ownWidth = "[&>.kt-segmented]:max-w-full [&>.kt-segmented]:self-start";

/**
 * The form's column. The same gap between fields whether they sit in a section or straight in the form; the actions a
 * step lower.
 */
const formLayout = `kt-form-layout flex w-full min-w-0 flex-col gap-4 text-sm leading-normal text-fg [&>.kt-form-actions-frame]:mt-1 ${ownWidth}`;

/** A section; one after another gets a hairline above it, with room either side of the line. */
const formSection =
	"kt-form-section flex min-w-0 flex-col gap-4 [.kt-form-section+&]:mt-2 [.kt-form-section+&]:border-t [.kt-form-section+&]:border-border [.kt-form-section+&]:pt-6";

/**
 * A field: label, control, then the help or the error, on one rhythm in every form. The inline layout's two tracks
 * are a container query in form-layout.css.
 */
const formField = "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-1";

/** A control that sizes itself (a segmented control, a row of toggles) keeps its own width in the field. */
const fieldControl =
	"kt-form-field-control flex min-w-0 flex-col items-stretch gap-1 [&>:is(.kt-segmented,.kt-form-inline)]:max-w-full [&>:is(.kt-segmented,.kt-form-inline)]:self-start";

/** Help or an error under a field. */
const fieldNote = "m-0 text-sm leading-normal";

/** A row of controls inside one field: checkboxes, toggles. Keeps its own width in a field, like a segmented control. */
export const formInline = "kt-form-inline flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5";

/** The actions' row and each of its two groups: wrapping, on one line while there's room. */
const actionsRow = "flex min-w-0 flex-wrap items-center gap-2";

/**
 * The header every config page opens with: its title, a line on what the page is for and the page's own actions
 * (New key, Export) on the right. The title and the actions keep one row on a phone too; the lede goes under them.
 */
export function PageHeader({
	title,
	lede,
	actions,
	titleId,
	titleAs: Title = "h1",
	className,
}: {
	title: ReactNode;
	lede?: ReactNode;
	actions?: ReactNode;
	/** For a page that labels its landmark by the title. */
	titleId?: string;
	/** `p` where the page's h1 is further down, such as the vault's request. */
	titleAs?: "h1" | "p";
	className?: string;
}) {
	return (
		<header className={withClass(pageHeader, className)}>
			<Title
				id={titleId}
				className="kt-page-header-title col-start-1 row-start-1 m-0 min-w-0 text-heading font-strong leading-tight text-fg [overflow-wrap:anywhere]"
			>
				{title}
			</Title>
			{/* The actions keep the title's row, on the column's right edge: a button, a select or a status, never
			    stretched. Several wrap among themselves, right-aligned. */}
			{actions === undefined ? null : (
				<div className="kt-page-header-actions col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-2">
					{actions}
				</div>
			)}
			{lede === undefined ? null : (
				<p className="kt-page-header-lede col-span-2 row-start-2 m-0 max-w-content text-sm leading-normal text-muted">
					{lede}
				</p>
			)}
		</header>
	);
}

/**
 * The column a config form sits in: its sections one under another, at a reading width. Inside a Panel, a page or a
 * side column alike; the fields inside lay themselves out by the width this column gets, not the window's.
 */
export function FormLayout({ className, ...rest }: ComponentProps<"div">) {
	return <div className={withClass(formLayout, className)} {...rest} />;
}

/**
 * A titled group of fields in a form: Owner and name, When, Terms. The title is a heading at `level` (3 by default,
 * under the page's or panel's own); a line under it says what the group decides, and `action` sits on its right.
 * Sections after the first are divided by a hairline.
 */
export function FormSection({
	title,
	description,
	action,
	level = 3,
	headingRef,
	className,
	children,
	...rest
}: Omit<ComponentProps<"section">, "title"> & {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	level?: 2 | 3 | 4;
	headingRef?: Ref<HTMLHeadingElement>;
}) {
	const generatedId = useId();
	const headingId = `${generatedId}-title`;
	const Heading = `h${level}` as const;
	return (
		<section className={withClass(formSection, className)} aria-labelledby={headingId} {...rest}>
			<div className="kt-form-section-head flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
				<div className="kt-form-section-text flex min-w-0 flex-auto flex-col gap-1">
					<Heading
						id={headingId}
						className="kt-form-section-title m-0 text-lg font-strong leading-tight text-fg wrap-anywhere focus:outline-none"
						ref={headingRef}
						tabIndex={headingRef ? -1 : undefined}
					>
						{title}
					</Heading>
					{description === undefined ? null : (
						<p className="kt-form-section-description m-0 text-sm leading-normal text-muted">{description}</p>
					)}
				</div>
				{action === undefined ? null : (
					<div className="kt-form-section-action flex flex-none items-center gap-1.5">{action}</div>
				)}
			</div>
			<div className={`kt-form-section-body flex min-w-0 flex-col gap-4 ${ownWidth}`}>{children}</div>
		</section>
	);
}

export type FormFieldLayout = "stacked" | "inline";

/** The field's layout hook: form-layout.css lays out `kt-form-field-inline` as a settings row on a wide form. */
const fieldLayout: Record<FormFieldLayout, string> = {
	stacked: "kt-form-field kt-form-field-stacked",
	inline: "kt-form-field kt-form-field-inline",
};

/**
 * One labelled field: its label, the control, and the help or the error under it. TextField, TextAreaField and
 * SelectField are built on it; use it directly for any other control (a SegmentedControl, a row of toggles, a code
 * editor) so every field in a form has the same label, spacing and help.
 *
 * `htmlFor` names the control the label is for. Without it the field is a group of controls labelled by the label.
 * The help and error get the ids `${id}-hint` and `${id}-error`: pass `describedBy(id, hint, error)` to the control's
 * `aria-describedby`.
 *
 * `inline` puts the label and its help beside the control once the form is wide enough, as a settings row; it stacks
 * on a narrow form. `extra` sits beside the label: a Proposed or Narrowed badge.
 */
export function FormField({
	id,
	label,
	hint,
	error,
	htmlFor,
	extra,
	layout = "stacked",
	hideLabel = false,
	className,
	children,
}: {
	id: string;
	label: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	htmlFor?: string | undefined;
	extra?: ReactNode;
	layout?: FormFieldLayout | undefined;
	/** The label is read by screen readers but not shown: where a row's own label already says it. */
	hideLabel?: boolean | undefined;
	className?: string | undefined;
	children: ReactNode;
}) {
	const labelId = `${id}-label`;
	const labelClass = `kt-form-field-label${hideLabel ? " kt-sr-only" : ""} text-sm leading-normal text-muted`;
	const labelElement =
		htmlFor === undefined ? (
			<span id={labelId} className={labelClass}>
				{label}
			</span>
		) : (
			<label id={labelId} className={labelClass} htmlFor={htmlFor}>
				{label}
			</label>
		);
	const note =
		error !== undefined ? (
			<p id={`${id}-error`} className={`kt-form-field-error ${fieldNote} text-status-error`}>
				{error}
			</p>
		) : hint !== undefined ? (
			<p id={`${id}-hint`} className={`kt-form-field-hint ${fieldNote} text-faint`}>
				{hint}
			</p>
		) : null;
	const control =
		htmlFor === undefined ? (
			// biome-ignore lint/a11y/useSemanticElements: a group of controls inside a form that may have its own fieldset.
			<div className={fieldControl} role="group" aria-labelledby={labelId}>
				{children}
			</div>
		) : (
			<div className={fieldControl}>{children}</div>
		);
	return (
		<div className={withClass(`${fieldLayout[layout]} ${formField}`, className)}>
			{extra === undefined ? (
				labelElement
			) : (
				<div className="kt-form-field-label-row flex min-h-control-xs min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{labelElement}
					{extra}
				</div>
			)}
			{control}
			{note}
		</div>
	);
}

/** The `aria-describedby` for a FormField's control: its error, or else its help. */
export function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
	return error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
}

/** Two or three equal tracks. One column on a narrow frame is a container query in form-layout.css. */
const gridTracks: Record<2 | 3, string> = {
	2: "grid-cols-[repeat(2,minmax(0,1fr))]",
	3: "grid-cols-[repeat(3,minmax(0,1fr))]",
};

/**
 * Short fields side by side on equal tracks, so their labels and inputs line up from row to row: Every, Minutes apart
 * and At; Projects and Jobs. Two or three columns while the form has room, one under another when it hasn't. A
 * field's help wraps under its own input without pushing its neighbours'.
 */
export function FormGrid({ columns = 3, className, children, ...rest }: ComponentProps<"div"> & { columns?: 2 | 3 }) {
	return (
		<div className={withClass("kt-form-grid-frame min-w-0", className)} {...rest}>
			<div
				className={`kt-form-grid m-0 grid min-w-0 items-start gap-4 border-0 p-0 ${gridTracks[columns]}`}
				data-columns={columns}
			>
				{children}
			</div>
		</div>
	);
}

/**
 * A form's buttons: the primary action first, then the others, left aligned under the fields; `end` holds an action
 * that undoes or removes (End schedule, Revoke), pushed to the far side. On a narrow form each button takes the whole
 * width, at the touch size (a container query in form-layout.css).
 */
export function FormActions({
	end,
	className,
	children,
}: {
	end?: ReactNode;
	className?: string;
	children?: ReactNode;
}) {
	return (
		<div className={withClass("kt-form-actions-frame min-w-0", className)}>
			<div className={`kt-form-actions justify-between ${actionsRow}`}>
				<div className={`kt-form-actions-main ${actionsRow}`}>{children}</div>
				{end === undefined ? null : <div className={`kt-form-actions-end ${actionsRow}`}>{end}</div>}
			</div>
		</div>
	);
}
