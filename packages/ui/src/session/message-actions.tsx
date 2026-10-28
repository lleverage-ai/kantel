import type { ReactNode } from "react";
import { IconButton } from "../primitives/button.tsx";
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
	/** More actions, before Copy: `MessageAction`s such as Edit from here or Fork from this response. */
	children?: ReactNode;
	/** Shows the line without a hover, for stories and screenshots. */
	visible?: boolean;
	/** Fixes the day the time is compared with, for stories. */
	now?: number;
};

/** The time and actions under a message: Copy and the host's actions, revealed on hover or focus. */
export function MessageActions({ at, text, align, children, visible = false, now }: MessageActionsProps) {
	const time = <ClockTime at={at} {...(now === undefined ? {} : { now })} className="hb-message-actions-time" />;
	return (
		<div className={`hb-message-actions hb-message-actions-${align}${visible ? " hb-message-actions-visible" : ""}`}>
			{align === "end" ? time : null}
			<div className="hb-message-actions-buttons">
				{children}
				<CopyButton text={text} label="Copy message" iconOnly size="xs" variant="ghost" />
			</div>
			{align === "start" ? time : null}
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
