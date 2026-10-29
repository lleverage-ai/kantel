import { createContext, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { ClockTime } from "../primitives/time.tsx";
import "./message-actions.css";

// A message's actions, after T3 Code's message meta rows (TimelineUserMessageRow.tsx:196-229,
// TimelineAssistantRows.tsx:144-196, pingdotgg/t3code at 9826dbb9): a quiet line under the message with its time and small ghost buttons, shown
// while the message is hovered or holds focus, and always under a coarse pointer, where there is no hover. It is
// transparent rather than absent while hidden, so the transcript never moves when it appears.

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
	const time = <ClockTime at={at} {...(now === undefined ? {} : { now })} className="hb-message-actions-time" />;
	const copy = <CopyButton text={text} label="Copy message" iconOnly size="xs" variant="ghost" />;
	return (
		<div className={`hb-message-actions hb-message-actions-${align}${visible ? " hb-message-actions-visible" : ""}`}>
			{align === "end" ? after : null}
			{align === "end" ? time : null}
			<div className="hb-message-actions-buttons">
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
		<div className="hb-message-editor" data-focus-surface>
			<textarea
				ref={field}
				className="hb-message-editor-input"
				aria-label="Edit message"
				value={draft}
				rows={1}
				readOnly={sending}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			<div className="hb-message-editor-footer">
				<span className="hb-message-editor-hint">
					{error === undefined ? "Sending reruns from here. What came after this message leaves the session." : null}
					{error === undefined ? null : (
						<span className="hb-message-editor-error" role="alert">
							{error}
						</span>
					)}
				</span>
				<div className="hb-message-editor-buttons">
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
