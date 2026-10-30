import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * A modal dialog: the browser's top layer, a dimmed page behind (its ::backdrop), a raised card no wider than a short
 * sentence needs.
 */
const dialogFrame =
	"hb-dialog m-auto w-[min(var(--hb-card-width),calc(100vw_-_var(--hb-step-6)))] max-w-none border-0 p-0 rounded-panel bg-raised shadow-float font-sans text-md text-fg backdrop:bg-scrim";

/** The heading, the words and the buttons, down the card. */
const dialogContent = "hb-dialog-content flex flex-col gap-3 p-5";

/**
 * The words under the heading, muted with any name in them in the text colour. A `hb-dialog-error` paragraph in them
 * (session/session-menu.tsx's) is in the error colour.
 */
const dialogBody =
	"hb-dialog-body text-muted leading-normal [&>p]:m-0 [&>p+p]:mt-2 [&_strong]:font-medium [&_strong]:text-fg [&>.hb-dialog-error]:text-status-error";

export type DialogProps = {
	open: boolean;
	/** The dialog's heading, and its accessible name. */
	title: string;
	/** What it's about, under the heading. */
	children?: ReactNode;
	/** The buttons at its foot, the main one last. A submit button submits `onSubmit`. */
	actions: ReactNode;
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
export function Dialog({ open, title, children, actions, onClose, onSubmit }: DialogProps) {
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

	const body = (
		<>
			<h2 id={titleId} className="hb-dialog-title m-0 text-lg font-strong leading-tight">
				{title}
			</h2>
			{children === undefined ? null : <div className={dialogBody}>{children}</div>}
			<div className="hb-dialog-actions mt-1 flex justify-end gap-2">{actions}</div>
		</>
	);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it already; the click is only for the scrim.
		<dialog
			ref={ref}
			className={dialogFrame}
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
