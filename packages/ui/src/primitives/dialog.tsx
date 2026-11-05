import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./button.tsx";
import { CloseIcon } from "./lucide.tsx";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * A modal dialog: the browser's top layer, a dimmed page behind (its ::backdrop), a raised card no wider than a short
 * sentence needs.
 *
 * The top layer draws it above the page, but it still inherits text styles from wherever it sits in the DOM, often a
 * table's actions cell (right-aligned, no wrapping). So it resets what it can inherit: alignment, wrapping, weight,
 * line height, case and spacing.
 */
const dialogFrame =
	"kt-dialog m-auto max-w-none border-0 p-0 rounded-panel bg-raised shadow-float font-sans text-md font-normal leading-normal text-fg text-start whitespace-normal wrap-break-word normal-case tracking-normal backdrop:bg-scrim";

/** Its width: a short sentence's, or a chart's and a table's (`wide`), never wider than the window. */
const dialogWidth = {
	card: "w-[min(var(--kt-card-width),calc(100vw_-_var(--kt-step-6)))]",
	wide: "w-[min(var(--kt-dialog-wide-width),calc(100vw_-_var(--kt-step-6)))]",
} as const;

/** The heading, the words and the buttons, down the card. */
const dialogContent = "kt-dialog-content flex flex-col gap-3 p-5";

/**
 * The words under the heading, muted with any name in them in the text colour. A `kt-dialog-error` paragraph in them
 * (session/session-menu.tsx's) is in the error colour.
 */
const dialogBody =
	"kt-dialog-body text-muted leading-normal [&>p]:m-0 [&>p+p]:mt-2 [&_strong]:font-medium [&_strong]:text-fg [&>.kt-dialog-error]:text-status-error";

export type DialogProps = {
	open: boolean;
	/** The dialog's heading, and its accessible name. */
	title: string;
	/** What it's about, under the heading. */
	children?: ReactNode;
	/** The buttons at its foot, the main one last. A submit button submits `onSubmit`. Absent: a close button in the
	 * heading's corner instead, for a dialog that only shows something. */
	actions?: ReactNode;
	/** A card's width (default), or `wide` for a dialog that shows a chart or a table. */
	width?: "card" | "wide";
	/** A 16px icon before the heading. */
	icon?: ReactNode;
	/** Controls at the heading's end, before its close button: a range to show. */
	toolbar?: ReactNode;
	/** Escape, the scrim or a Cancel button closed it. */
	onClose: () => void;
	/** Makes the dialog a form: Enter in a field, or a submit button, calls it. */
	onSubmit?: () => void;
};

/**
 * A modal dialog for a decision that can't wait in the page: confirming a delete, naming something. The browser's own
 * modal `<dialog>`, so it sits above everything, keeps focus inside, and Escape closes it. A click on the scrim
 * closes it too. Keep it short: a heading, a sentence or a field, and two buttons.
 */
export function Dialog({
	open,
	title,
	children,
	actions,
	width = "card",
	icon,
	toolbar,
	onClose,
	onSubmit,
}: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);

	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		// Escape closes the browser's dialog itself; the owner's state follows.
		const onCancel = (event: Event) => {
			event.preventDefault();
			onCloseRef.current();
		};
		dialog.addEventListener("cancel", onCancel);
		return () => dialog.removeEventListener("cancel", onCancel);
	}, []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit?.();
	};

	const heading = (
		<h2 id={titleId} className="kt-dialog-title m-0 min-w-0 truncate text-lg font-strong leading-tight">
			{title}
		</h2>
	);
	const body = (
		<>
			{icon === undefined && toolbar === undefined && actions !== undefined ? (
				heading
			) : (
				// On a narrow screen the controls go under the heading rather than cutting it short.
				<div className="kt-dialog-head flex min-w-0 flex-wrap items-center gap-2">
					<span className="flex min-w-48 flex-1 items-center gap-2">
						{icon === undefined ? null : <span className="flex flex-none text-muted">{icon}</span>}
						{heading}
					</span>
					<span className="ml-auto flex flex-none items-center gap-2">
						{toolbar}
						{actions === undefined ? (
							<IconButton size="sm" variant="ghost" label="Close" icon={<CloseIcon />} onClick={onClose} />
						) : null}
					</span>
				</div>
			)}
			{children === undefined ? null : <div className={dialogBody}>{children}</div>}
			{actions === undefined ? null : <div className="kt-dialog-actions mt-1 flex justify-end gap-2">{actions}</div>}
		</>
	);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it already; the click is only for the scrim.
		<dialog
			ref={ref}
			className={`${dialogFrame} ${dialogWidth[width]}`}
			aria-labelledby={titleId}
			onClick={(event) => {
				// A click on the dialog element itself, not its content, is on the scrim.
				if (event.target === event.currentTarget) onClose();
			}}
		>
			{open ? (
				onSubmit === undefined ? (
					<div className={dialogContent}>{body}</div>
				) : (
					<form className={dialogContent} onSubmit={submit}>
						{body}
					</form>
				)
			) : null}
		</dialog>
	);
}
