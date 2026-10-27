import { memo } from "react";
import type { AssistantItem, NoticeItem, TranscriptItem, UserItem } from "../protocol-local/index.ts";
import { Markdown } from "./markdown.tsx";
import { Profiled } from "./profile.tsx";
import { ToolChip } from "./tool-chip.tsx";

// One row per transcript item. Rows are memoised on the item object: the reducer replaces only the item a delta
// names, so while an answer streams, every earlier row gets the same props and React skips it.

function UserRow({ item }: { item: UserItem }) {
	return (
		<div className="user">
			<div className="user-text">{item.text}</div>
		</div>
	);
}

function AssistantRow({ item }: { item: AssistantItem }) {
	const streaming = item.status === "streaming";
	const lastText = item.parts.findLastIndex((part) => part.kind === "text");
	return (
		<div className={`assistant${streaming ? " streaming" : ""}`}>
			{item.parts.map((part, index) => {
				if (part.kind === "tool") return null;
				if (part.kind === "thinking") {
					if (part.text === "") return null;
					return (
						<details key={index} className="thinking">
							<summary>{streaming && index === item.parts.length - 1 ? "Thinking…" : "Thought it through"}</summary>
							<p>{part.text}</p>
						</details>
					);
				}
				return (
					<div key={index} className={streaming && index === lastText ? "text text-live" : "text"}>
						<Markdown text={part.text} />
					</div>
				);
			})}
			{streaming && item.parts.every((part) => part.kind !== "text") ? <div className="pending-dots" aria-label="Working" /> : null}
			{item.status === "error" ? <div className="assistant-error">This reply stopped with an error{item.error ? `: ${item.error}` : "."}</div> : null}
			{item.status === "aborted" ? <div className="assistant-error">Stopped.</div> : null}
		</div>
	);
}

function NoticeRow({ item }: { item: NoticeItem }) {
	return <div className={`notice notice-${item.tone}`}>{item.text}</div>;
}

export const Row = memo(function Row({ item, turnStart, first }: { item: TranscriptItem; turnStart: boolean; first: boolean }) {
	let body;
	switch (item.kind) {
		case "user":
			body = <UserRow item={item} />;
			break;
		case "assistant":
			body = <AssistantRow item={item} />;
			break;
		case "tool":
			body = <ToolChip item={item} />;
			break;
		case "notice":
			body = <NoticeRow item={item} />;
			break;
	}
	return (
		<Profiled id={item.id}>
			<div className={`row row-${item.kind}${turnStart ? " turn-start" : ""}${first ? " row-first" : ""}`} data-item={item.id}>
				<div className="column">{body}</div>
			</div>
		</Profiled>
	);
});
