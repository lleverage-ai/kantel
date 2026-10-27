import type { AssistantItem, NoticeItem, UserItem } from "@harbour/protocol";
import { memo } from "react";
import { Disclosure } from "../primitives/controls.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Notice } from "../primitives/surface.tsx";
import { Markdown } from "./markdown.tsx";
import "./message.css";

// The transcript's messages, after T3 Code (TimelineUserMessageRow.tsx:432-459, TimelineAssistantRows.tsx:26-72):
// the person's words in a right-aligned bubble, the agent's answer unboxed on the canvas. Each is memoised on its
// item, so while one answer streams no other message renders again.

const viaCaption = { prompt: undefined, steer: "Steered", followUp: "Follow-up" } as const;

/** What the person sent: a right-aligned bubble, at most 80% of the column wide. */
export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
	useRenderProbe("UserMessage", item.id);
	const caption = viaCaption[item.via];
	return (
		<div className="hb-user-message">
			{caption === undefined ? null : <span className="hb-user-message-via">{caption}</span>}
			<div className="hb-user-message-bubble">{item.text}</div>
		</div>
	);
});

/**
 * The agent's answer, on the canvas: an optional thought behind a disclosure, then Markdown. While it streams, a quiet
 * caret sits at the end of the text; before any text or thought arrives, three dots say it is working.
 */
export const AssistantMessage = memo(function AssistantMessage({ item }: { item: AssistantItem }) {
	useRenderProbe("AssistantMessage", item.id);
	const { streaming, text, thinking } = item;
	return (
		<div className={`hb-assistant-message${streaming ? " hb-assistant-message-streaming" : ""}`}>
			{thinking ? (
				<Disclosure
					className="hb-assistant-message-thinking"
					summary={streaming && text === "" ? "Thinking" : "Thought it through"}
				>
					<p className="hb-assistant-message-thought">{thinking}</p>
				</Disclosure>
			) : null}
			{text !== "" ? (
				<Markdown text={text} />
			) : streaming && !thinking ? (
				<span className="hb-working" role="img" aria-label="Working">
					<span className="hb-working-dot" />
					<span className="hb-working-dot" />
					<span className="hb-working-dot" />
				</span>
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
