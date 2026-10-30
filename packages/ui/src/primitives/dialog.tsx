import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";
import "./dialog.css";

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
			<h2 id={titleId} className="hb-dialog-title">
				{title}
			</h2>
			{children === undefined ? null : <div className="hb-dialog-body">{children}</div>}
			<div className="hb-dialog-actions">{actions}</div>
		</>
	);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it already; the click is only for the scrim.
		<dialog
			ref={ref}
			className="hb-dialog"
			aria-labelledby={titleId}
			onClick={(event) => {
				// A click on the dialog element itself, not its content, is on the scrim.
				if (event.target === event.currentTarget) onClose();
			}}
		>
			{open ? (
				onSubmit === undefined ? (
					<div className="hb-dialog-content">{body}</div>
				) : (
					<form className="hb-dialog-content" onSubmit={submit}>
						{body}
					</form>
				)
			) : null}
		</dialog>
	);
}
