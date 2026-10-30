import { type ComponentProps, type ReactNode, type Ref, useId } from "react";
import "./form-layout.css";

/**
 * The header every config page opens with: its title, a line on what the page is for and the page's own actions
 * (New key, Export) on the right. The actions drop under the title when the page is narrow.
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
		<header className={`hb-page-header${className ? ` ${className}` : ""}`}>
			<div className="hb-page-header-text">
				<Title id={titleId} className="hb-page-header-title">
					{title}
				</Title>
				{lede === undefined ? null : <p className="hb-page-header-lede">{lede}</p>}
			</div>
			{actions === undefined ? null : <div className="hb-page-header-actions">{actions}</div>}
		</header>
	);
}

/**
 * The column a config form sits in: its sections one under another, at a reading width. Inside a Panel, a page or a
 * side column alike; the fields inside lay themselves out by the width this column gets, not the window's.
 */
export function FormLayout({ className, ...rest }: ComponentProps<"div">) {
	return <div className={`hb-form-layout${className ? ` ${className}` : ""}`} {...rest} />;
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
		<section className={`hb-form-section${className ? ` ${className}` : ""}`} aria-labelledby={headingId} {...rest}>
			<div className="hb-form-section-head">
				<div className="hb-form-section-text">
					<Heading
						id={headingId}
						className="hb-form-section-title"
						ref={headingRef}
						tabIndex={headingRef ? -1 : undefined}
					>
						{title}
					</Heading>
					{description === undefined ? null : <p className="hb-form-section-description">{description}</p>}
				</div>
				{action === undefined ? null : <div className="hb-form-section-action">{action}</div>}
			</div>
			<div className="hb-form-section-body">{children}</div>
		</section>
	);
}

export type FormFieldLayout = "stacked" | "inline";

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
	const labelClass = `hb-form-field-label${hideLabel ? " hb-sr-only" : ""}`;
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
			<p id={`${id}-error`} className="hb-form-field-error">
				{error}
			</p>
		) : hint !== undefined ? (
			<p id={`${id}-hint`} className="hb-form-field-hint">
				{hint}
			</p>
		) : null;
	const control =
		htmlFor === undefined ? (
			// biome-ignore lint/a11y/useSemanticElements: a group of controls inside a form that may have its own fieldset.
			<div className="hb-form-field-control" role="group" aria-labelledby={labelId}>
				{children}
			</div>
		) : (
			<div className="hb-form-field-control">{children}</div>
		);
	return (
		<div className={`hb-form-field hb-form-field-${layout}${className ? ` ${className}` : ""}`}>
			{extra === undefined ? (
				labelElement
			) : (
				<div className="hb-form-field-label-row">
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

/**
 * Short fields side by side on equal tracks, so their labels and inputs line up from row to row: Every, Minutes apart
 * and At; Projects and Jobs. Two or three columns while the form has room, one under another when it hasn't. A
 * field's help wraps under its own input without pushing its neighbours'.
 */
export function FormGrid({ columns = 3, className, children, ...rest }: ComponentProps<"div"> & { columns?: 2 | 3 }) {
	return (
		<div className={`hb-form-grid-frame${className ? ` ${className}` : ""}`} {...rest}>
			<div className="hb-form-grid" data-columns={columns}>
				{children}
			</div>
		</div>
	);
}

/**
 * A form's buttons: the primary action first, then the others, left aligned under the fields; `end` holds an action
 * that undoes or removes (End schedule, Revoke), pushed to the far side. On a narrow form each button takes the whole
 * width, at the touch size.
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
		<div className={`hb-form-actions-frame${className ? ` ${className}` : ""}`}>
			<div className="hb-form-actions">
				<div className="hb-form-actions-main">{children}</div>
				{end === undefined ? null : <div className="hb-form-actions-end">{end}</div>}
			</div>
		</div>
	);
}
