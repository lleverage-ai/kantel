import type { AssistantItem, NoticeItem, UserAttachment, UserItem } from "@harbour/protocol";
import { memo, useContext, useState } from "react";
import { DraftDocumentCard } from "../presented/presented-file-card.tsx";
import { Disclosure } from "../primitives/controls.tsx";
import { fileTypeIcon, fileTypeKind, fileTypeLabel } from "../primitives/file-icons.ts";
import { ForkIcon, RewindIcon } from "../primitives/icons.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Notice } from "../primitives/surface.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import { Markdown } from "./markdown.tsx";
import { MessageAction, MessageActions, MessageActionsContext, MessageEditor } from "./message-actions.tsx";
import { LiveActivity } from "./working-indicator.tsx";
import "./message.css";

// The transcript's messages, after T3 Code (TimelineUserMessageRow.tsx:432-459, TimelineAssistantRows.tsx:26-72):
// the person's words in a right-aligned bubble, the agent's answer unboxed on the canvas. Each is memoised on its
// item, so while one answer streams no other message renders again.

const viaCaption = { prompt: undefined, steer: "Steered", followUp: "Follow-up" } as const;

/**
 * What the person sent: a right-aligned bubble, at most 80% of the column wide, with the time it was sent, Edit from
 * here (when the host gives `MessageActionsContext` an `edit`) and Copy under it on hover or focus (`MessageActions`).
 * Edit from here turns the bubble into a `MessageEditor`; sending rewinds the session to this message. `actions: false`
 * leaves that line out, for a preview.
 */
export const UserMessage = memo(function UserMessage({
	item,
	actions = true,
	showActions = false,
}: {
	item: UserItem;
	/** The time and Copy under the bubble. Default on. */
	actions?: boolean;
	/** Shows them without a hover, for stories and screenshots. */
	showActions?: boolean;
}) {
	useRenderProbe("UserMessage", item.id);
	const { edit, editBlocked } = useContext(MessageActionsContext);
	const [editing, setEditing] = useState(false);
	const caption = viaCaption[item.via];
	if (editing && edit !== undefined) {
		return (
			<div className="hb-user-message">
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
		<div className="hb-user-message">
			{caption === undefined ? null : <span className="hb-user-message-via">{caption}</span>}
			{item.attachments === undefined || item.attachments.length === 0 ? null : (
				<SentAttachments attachments={item.attachments} />
			)}
			{item.text === "" && (item.attachments?.length ?? 0) > 0 ? null : (
				<div className="hb-user-message-bubble">{item.text}</div>
			)}
			{actions ? (
				<MessageActions at={item.at} text={item.text} align="end" visible={showActions}>
					{edit === undefined ? null : (
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

/** The files sent with a message, above its bubble: each a small card with its file type's icon, name, type and size. */
function SentAttachments({ attachments }: { attachments: readonly UserAttachment[] }) {
	return (
		<ul className="hb-user-attachments" aria-label="Attached files">
			{attachments.map((attachment) => {
				const Icon = fileTypeIcon(attachment);
				return (
					<li key={attachment.id} className="hb-user-attachment" title={attachment.name}>
						<span className="hb-user-attachment-tile hb-file-tile" data-kind={fileTypeKind(attachment)}>
							<Icon />
						</span>
						<span className="hb-user-attachment-text">
							<span className="hb-user-attachment-name">{attachment.name}</span>
							<span className="hb-user-attachment-facts">
								<span>{attachment.kind === "text" ? "Pasted" : fileTypeLabel(attachment)}</span>
								<span>{formatBytes(attachment.size)}</span>
							</span>
						</span>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * A thought as it streams, before the answer's first word, after T3 Code's live reasoning preview
 * (TimelineWorkGroupRows.tsx:503-581): the live activity row, a brain and "Thinking", then the newest lines of the
 * thought, muted and clamped to four, so the reader sees the agent think without the transcript jumping as the thought
 * grows. The whole thought is behind the "Thought it through" disclosure once the answer starts.
 */
function ThinkingPreview({ thinking }: { thinking: string }) {
	return (
		<div className="hb-assistant-message-thinking-live">
			<LiveActivity />
			<div className="hb-assistant-message-thought-window">
				<p className="hb-assistant-message-thought">{thinking}</p>
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
		<div className={`hb-assistant-message${streaming ? " hb-assistant-message-streaming" : ""}`}>
			{thinking ? (
				streaming && text === "" ? (
					<ThinkingPreview thinking={thinking} />
				) : (
					<Disclosure className="hb-assistant-message-thinking" summary="Thought it through">
						<p className="hb-assistant-message-thought">{thinking}</p>
					</Disclosure>
				)
			) : null}
			{text !== "" ? (
				<Markdown text={text} />
			) : streaming && !thinking && item.document === undefined ? (
				<LiveActivity />
			) : null}
			{streaming && item.document !== undefined ? (
				<div className="hb-presented-files">
					<div className="hb-presented-files-item">
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
							<span className="hb-message-actions-error" role="alert">
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
		<div className="hb-notice-row">
			<Notice level={item.level} announce={false}>
				{item.text}
			</Notice>
		</div>
	);
});
