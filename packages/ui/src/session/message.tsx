import type { AssistantItem, NoticeItem, UserItem } from "@kantel/protocol";
import { memo, useContext, useState } from "react";
import { DraftDocumentCard, presentedFilesClass, presentedFilesItemClass } from "../presented/presented-file-card.tsx";
import { Disclosure } from "../primitives/controls.tsx";
import { ForkIcon, PencilIcon, RetryIcon, RewindIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Notice } from "../primitives/surface.tsx";
import { SentAttachments } from "./attachment-card.tsx";
import { Markdown } from "./markdown.tsx";
import { MessageAction, MessageActions, MessageActionsContext, MessageEditor } from "./message-actions.tsx";
import { useSmoothText } from "./smooth-text.ts";
import { LiveActivity } from "./working-indicator.tsx";
// The answer's spacing between parts and its streaming caret stay in CSS; see the file.
import "./message.css";

// The transcript's messages, after T3 Code (TimelineUserMessageRow.tsx:432-459, TimelineAssistantRows.tsx:26-72):
// the person's words in a right-aligned bubble, the agent's answer unboxed on the canvas. Each is memoised on its
// item, so while one answer streams no other message renders again.

/** The person's message: the bubble, right-aligned, with its caption, attachments and actions under one another. */
const userMessage = "kt-user-message flex min-w-0 flex-col items-end gap-0.5";
/** A thought, streaming or behind its disclosure: muted, a size down, its own line breaks kept. */
const thought = "kt-assistant-message-thought m-0 text-sm leading-normal whitespace-pre-wrap text-muted wrap-anywhere";

const viaCaption = { prompt: undefined, steer: "Steered", followUp: "Follow-up" } as const;

/**
 * A message the host shows before its session has it (an optimistic send). `sending`: on its way, shown as if sent,
 * without Edit from here (the session has no such message yet). `failed`: it didn't go; the line under the bubble says
 * so, with Try again and Edit, which puts the words back in the composer.
 */
export type MessageDelivery =
	| { readonly state: "sending" }
	| {
			readonly state: "failed";
			/** Why, as the host has it. */
			readonly reason?: string;
			readonly onRetry: () => void;
			/** Takes the message back to the composer. Without it, only Try again. */
			readonly onEdit?: () => void;
	  };

/**
 * What the person sent: a right-aligned bubble, at most 80% of the column wide, with the time it was sent, Edit from
 * here (when the host gives `MessageActionsContext` an `edit`) and Copy under it on hover or focus (`MessageActions`).
 * Edit from here turns the bubble into a `MessageEditor`; sending rewinds the session to this message. `actions: false`
 * leaves that line out, for a preview. A message on its way (`delivery`) looks sent; one that failed says so on that
 * line, with Try again and Edit.
 */
export const UserMessage = memo(function UserMessage({
	item,
	actions = true,
	showActions = false,
	delivery,
}: {
	item: UserItem;
	/** The time and Copy under the bubble. Default on. */
	actions?: boolean;
	/** Shows them without a hover, for stories and screenshots. */
	showActions?: boolean;
	/** The message is the host's own copy, not yet the session's: on its way, or failed. */
	delivery?: MessageDelivery;
}) {
	useRenderProbe("UserMessage", item.id);
	const { edit, editBlocked } = useContext(MessageActionsContext);
	const [editing, setEditing] = useState(false);
	const caption = viaCaption[item.via];
	if (editing && edit !== undefined) {
		return (
			<div className={userMessage}>
				<MessageEditor
					text={item.text}
					onCancel={() => setEditing(false)}
					onSend={async (text) => {
						await edit(item.id, text);
						setEditing(false);
					}}
				/>
			</div>
		);
	}
	return (
		<div className={userMessage}>
			{caption === undefined ? null : <span className="kt-user-message-via px-1 text-xs text-faint">{caption}</span>}
			{item.attachments === undefined || item.attachments.length === 0 ? null : (
				<SentAttachments attachments={item.attachments} />
			)}
			{item.text === "" && (item.attachments?.length ?? 0) > 0 ? null : (
				<div className="kt-user-message-bubble max-w-[80%] rounded-bubble bg-user-message px-3 py-2.5 text-md leading-normal whitespace-pre-wrap text-fg wrap-anywhere">
					{item.text}
				</div>
			)}
			{actions && delivery?.state === "failed" ? (
				<MessageActions
					at={item.at}
					text={item.text}
					align="end"
					visible
					after={
						<span className="kt-message-actions-error" role="status">
							{delivery.reason === undefined || delivery.reason === ""
								? "Couldn't send"
								: `Couldn't send: ${delivery.reason}`}
						</span>
					}
				>
					<MessageAction label="Try again" icon={<RetryIcon size="sm" />} onClick={delivery.onRetry} />
					{delivery.onEdit === undefined ? null : (
						<MessageAction label="Edit in the composer" icon={<PencilIcon size="sm" />} onClick={delivery.onEdit} />
					)}
				</MessageActions>
			) : actions ? (
				<MessageActions at={item.at} text={item.text} align="end" visible={showActions}>
					{edit === undefined || delivery !== undefined ? null : (
						<MessageAction
							label={editBlocked ?? "Edit from here"}
							icon={<RewindIcon size="sm" />}
							disabled={editBlocked !== undefined}
							onClick={() => setEditing(true)}
						/>
					)}
				</MessageActions>
			) : null}
		</div>
	);
});

/**
 * A thought as it streams, before the answer's first word, after T3 Code's live reasoning preview
 * (TimelineWorkGroupRows.tsx:503-581): the live activity row, a brain and "Thinking", then the newest lines of the
 * thought, muted and clamped to four, so the reader sees the agent think without the transcript jumping as the thought
 * grows. The whole thought is behind the "Thought it through" disclosure once the answer starts.
 */
function ThinkingPreview({ thinking }: { thinking: string }) {
	return (
		<div className="kt-assistant-message-thinking-live flex min-w-0 flex-col gap-1">
			<LiveActivity />
			<div className="kt-assistant-message-thought-window ml-[calc(var(--kt-icon-md)+var(--kt-step-2))] flex max-h-[calc(4*var(--kt-text-sm)*var(--kt-leading))] flex-col justify-end overflow-hidden">
				<p className={thought}>{thinking}</p>
			</div>
		</div>
	);
}

/**
 * The agent's answer, on the canvas: an optional thought behind a disclosure, then Markdown. While it streams, a quiet
 * caret sits at the end of the text; while it thinks before its first word, the thought streams in a clamped preview
 * under the live activity row (a brain and "Thinking"); before any text or thought arrives, that row alone says the
 * agent is thinking. With `actions`, a finished answer with text has Copy, Fork from this response
 * (when the host gives `MessageActionsContext` a `fork`) and the time it was
 * generated under it, on hover or focus (`MessageActions`).
 */
export const AssistantMessage = memo(function AssistantMessage({
	item,
	actions = false,
	showActions = false,
}: {
	item: AssistantItem;
	/**
	 * When the turn this answer belongs to started. Kept for hosts that pass it; the turn's timer is the transcript's
	 * working header now, so the answer doesn't show it.
	 */
	turnStartedAt?: number | undefined;
	/**
	 * Copy and the time under the answer, once it has finished. The transcript turns it on for a turn's final answer
	 * only, as T3 Code does, not for the words an agent says between tool calls.
	 */
	actions?: boolean;
	/** Shows them without a hover, for stories and screenshots. */
	showActions?: boolean;
}) {
	useRenderProbe("AssistantMessage", item.id);
	const { fork } = useContext(MessageActionsContext);
	const [forking, setForking] = useState(false);
	const [forkError, setForkError] = useState<string | undefined>(undefined);
	const { streaming, text, thinking } = item;
	// The words flow in at a steady pace rather than in the bursts they arrive in (smooth-text.ts).
	const shown = useSmoothText(text, streaming);
	const flowing = streaming || shown.length < text.length;
	const onFork = async () => {
		if (fork === undefined || forking) return;
		setForking(true);
		setForkError(undefined);
		try {
			await fork(item.id);
		} catch (reason) {
			setForkError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setForking(false);
		}
	};
	return (
		<div className={`kt-assistant-message flex min-w-0 flex-col ${flowing ? "kt-assistant-message-streaming" : ""}`}>
			{thinking ? (
				streaming && text === "" ? (
					<ThinkingPreview thinking={thinking} />
				) : (
					<Disclosure className="kt-assistant-message-thinking" summary="Thought it through">
						<p className={thought}>{thinking}</p>
					</Disclosure>
				)
			) : null}
			{text !== "" ? (
				<Markdown text={shown} />
			) : streaming && !thinking && item.document === undefined ? (
				<LiveActivity />
			) : null}
			{streaming && item.document !== undefined ? (
				<div className={presentedFilesClass}>
					<div className={presentedFilesItemClass}>
						<DraftDocumentCard title={item.document.title} />
					</div>
				</div>
			) : null}
			{actions && !streaming && text !== "" ? (
				<MessageActions
					at={item.at}
					text={text}
					align="start"
					visible={showActions}
					after={
						forkError === undefined ? null : (
							<span className="kt-message-actions-error" role="alert">
								{forkError}
							</span>
						)
					}
				>
					{fork === undefined ? null : (
						<MessageAction
							label="Fork from this response"
							icon={<ForkIcon size="sm" />}
							busy={forking}
							onClick={() => void onFork()}
						/>
					)}
				</MessageActions>
			) : null}
		</div>
	);
});

/** A notice from the host in the flow of the transcript: a reconnect, a call that may have partly run. */
export const NoticeRow = memo(function NoticeRow({ item }: { item: NoticeItem }) {
	return (
		<div className="kt-notice-row min-w-0">
			<Notice level={item.level} announce={false}>
				{item.text}
			</Notice>
		</div>
	);
});
