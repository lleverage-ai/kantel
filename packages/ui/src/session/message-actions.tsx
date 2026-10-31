import { createContext, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { ClockTime } from "../primitives/time.tsx";

// A message's actions, after T3 Code's message meta rows (TimelineUserMessageRow.tsx:196-229,
// TimelineAssistantRows.tsx:144-196, pingdotgg/t3code at 9826dbb9): a quiet line under the message with its time and small ghost buttons, shown
// while the message is hovered or holds focus, and always under a coarse pointer, where there is no hover. It is
// transparent rather than absent while hidden, so the transcript never moves when it appears.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). kt-message-actions stays as a hook for message.css (its
// spacing under an answer), and kt-message-actions-error is the class message.tsx puts on the reason an action failed,
// which this line styles and which keeps it shown. The other kt- classes stay as names for the parts.

/**
 * The line: its buttons ghost and 24px, transparent until the message (message.tsx's .kt-user-message or
 * .kt-assistant-message) is hovered or the line holds focus or an error, and always shown under a coarse pointer, where
 * there is no hover. Only its opacity animates, and not under reduced motion. The hover is plain `:hover` on the
 * message, as before, rather than `hover:` (which Tailwind wraps in a hover-capable media query).
 */
const line =
	"kt-message-actions flex min-h-control-xs min-w-0 items-center gap-1.5 transition-opacity focus-within:opacity-100 has-[.kt-message-actions-error]:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none [.kt-assistant-message:hover_&]:opacity-100 [.kt-user-message:hover_&]:opacity-100";
/**
 * Under an answer the actions come first. Optical alignment: the first button's icon, not its invisible box, lines up
 * with the answer's text; buttons take the touch size under a coarse pointer, so the inset is larger there.
 */
const lineStart =
	"kt-message-actions-start justify-start ml-[calc((var(--kt-icon-sm)_-_var(--kt-control-xs))/2)] pointer-coarse:ml-[calc((var(--kt-icon-sm)_-_var(--kt-control-lg))/2)]";
/** Why an action failed, such as a fork the server refused (message.tsx's span): on the line, in the error colour. */
const lineError =
	"[&_.kt-message-actions-error]:min-w-0 [&_.kt-message-actions-error]:text-xs [&_.kt-message-actions-error]:wrap-anywhere [&_.kt-message-actions-error]:text-status-error";
/** The time: faint, tabular figures, trimmed to its capitals as a button's label is, so it sits on the icons' centre. */
const lineTime =
	"kt-message-actions-time flex-none text-xs whitespace-nowrap text-faint tabular-nums [text-box:trim-both_cap_alphabetic]";

/** Edit from here: the bubble becomes a field the column's width, on the same surface and radius, ringed in focus. */
const editor =
	"kt-message-editor box-border flex w-full flex-col gap-2 rounded-bubble border border-border-input bg-user-message px-3 pt-2.5 pb-2 has-[.kt-message-editor-input:focus-visible]:outline has-[.kt-message-editor-input:focus-visible]:-outline-offset-1 has-[.kt-message-editor-input:focus-visible]:outline-focus";
/** The words, in the bubble's type, two lines tall at least and growing with them up to half the window. */
const editorInput =
	"kt-message-editor-input m-0 box-border block max-h-[50vh] min-h-[calc(var(--kt-text-md)*var(--kt-leading)*2)] w-full resize-none border-0 bg-transparent p-0 text-md leading-normal text-fg [field-sizing:content] [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit] wrap-anywhere focus:outline-none";

export type MessageActionsProps = {
	/** When the person sent the message, or when the agent finished the answer (epoch ms). */
	at: number;
	/** The message's text, for Copy. */
	text: string;
	/**
	 * Which side the line sits on: `end` under a person's bubble (time, then the actions), `start` under an answer
	 * (the actions, then the time).
	 */
	align: "start" | "end";
	/**
	 * More actions: `MessageAction`s such as Edit from here or Fork from this response. Copy stays on the aligned edge,
	 * so they come before it under a bubble and after it under an answer.
	 */
	children?: ReactNode;
	/** After the time, such as why an action failed. */
	after?: ReactNode;
	/** Shows the line without a hover, for stories and screenshots. */
	visible?: boolean;
	/** Fixes the day the time is compared with, for stories. */
	now?: number;
};

/** The time and actions under a message: Copy and the host's actions, revealed on hover or focus. */
export function MessageActions({ at, text, align, children, after, visible = false, now }: MessageActionsProps) {
	const time = <ClockTime at={at} {...(now === undefined ? {} : { now })} className={lineTime} />;
	const copy = <CopyButton text={text} label="Copy message" iconOnly size="xs" variant="ghost" />;
	return (
		<div
			className={`${line} ${lineError} ${align === "start" ? lineStart : "kt-message-actions-end justify-end"} ${visible ? "kt-message-actions-visible opacity-100" : "opacity-0"}`}
		>
			{align === "end" ? after : null}
			{align === "end" ? time : null}
			<div className="kt-message-actions-buttons flex items-center gap-0.5">
				{align === "start" ? copy : null}
				{children}
				{align === "end" ? copy : null}
			</div>
			{align === "start" ? time : null}
			{align === "start" ? after : null}
		</div>
	);
}

export type MessageActionProps = {
	/** What it does, as its accessible name and tooltip: "Edit from here", "Fork from this response". */
	label: string;
	icon: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** Working on it: a spinner in place of the icon, and no clicks. */
	busy?: boolean;
};

/** One action in a message's actions: a small ghost icon button with a tooltip. */
export function MessageAction({ label, icon, onClick, disabled = false, busy = false }: MessageActionProps) {
	return (
		<IconButton label={label} icon={icon} onClick={onClick} disabled={disabled} busy={busy} size="xs" variant="ghost" />
	);
}

/**
 * What the host does for a message's Fork and Edit from here; the transcript gives it to every message through
 * `MessageActionsContext`. An action the host leaves out is not shown.
 */
export type MessageActionHandlers = {
	/** Forks a new session from the answer `itemId`. Resolves once it has; a rejection's message is shown. */
	readonly fork?: (itemId: string) => Promise<void>;
	/** Rewinds the session to the message `itemId` and sends `text` in its place. A rejection's message is shown. */
	readonly edit?: (itemId: string, text: string) => Promise<void>;
	/** Why a message can't be edited now, such as "Stop the run to edit a message": Edit from here is off, saying why. */
	readonly editBlocked?: string;
};

export const MessageActionsContext = createContext<MessageActionHandlers>({});

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export type MessageEditorProps = {
	/** The words to start from: the message as it was sent. */
	text: string;
	/** Sends the edited words; while it runs the editor is busy, and a rejection's message is shown under it. */
	onSend: (text: string) => Promise<void>;
	onCancel: () => void;
	/** Takes focus when it opens. Default on; off for a second editor in a story. */
	autoFocus?: boolean;
};

/**
 * A person's message being edited in place, for Edit from here: the words in a field the width of the column, what
 * sending does, then Cancel and Send. Enter sends and Shift+Enter starts a new line, as in the composer; Escape
 * cancels. The field takes focus with the cursor at the end.
 */
export function MessageEditor({ text, onSend, onCancel, autoFocus = true }: MessageEditorProps) {
	const [draft, setDraft] = useState(text);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const element = field.current;
		if (element === null || !autoFocus) return;
		element.focus();
		element.setSelectionRange(element.value.length, element.value.length);
	}, [autoFocus]);
	const empty = draft.trim() === "";
	const send = async () => {
		if (empty || sending) return;
		setSending(true);
		setError(undefined);
		try {
			await onSend(draft);
		} catch (reason) {
			setError(messageOf(reason));
			setSending(false);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			if (!sending) onCancel();
		} else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send();
		}
	};
	return (
		<div className={editor} data-focus-surface>
			<textarea
				ref={field}
				className={editorInput}
				aria-label="Edit message"
				value={draft}
				rows={1}
				readOnly={sending}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			<div className="kt-message-editor-footer flex flex-wrap items-center justify-between gap-1.5">
				<span className="kt-message-editor-hint min-w-0 flex-auto text-xs text-faint">
					{error === undefined ? "Sending reruns from here. What came after this message leaves the session." : null}
					{error === undefined ? null : (
						<span className="kt-message-editor-error text-status-error" role="alert">
							{error}
						</span>
					)}
				</span>
				<div className="kt-message-editor-buttons ml-auto flex gap-1">
					<Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
						Cancel
					</Button>
					<Button variant="primary" size="sm" onClick={() => void send()} disabled={empty} busy={sending}>
						Send
					</Button>
				</div>
			</div>
		</div>
	);
}
