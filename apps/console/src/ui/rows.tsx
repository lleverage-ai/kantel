import type { AssistantItem, CardItem, NoticeItem, TranscriptItem, UserItem } from "@harbour/protocol";
import { memo, type ReactNode } from "react";
import { Markdown } from "./markdown.tsx";
import { Profiled } from "./profile.tsx";
import { ToolChip } from "./tool-chip.tsx";

// One row per transcript item. Rows are memoised on the item object: applying a delta replaces only the items it
// names, so while an answer streams, every earlier row gets the same props and React skips it.

function UserRow({ item }: { item: UserItem }) {
	return (
		<div className="user">
			<div className="user-text">{item.text}</div>
		</div>
	);
}

function AssistantRow({ item }: { item: AssistantItem }) {
	const { streaming, text, thinking } = item;
	return (
		<div className={`assistant${streaming ? " streaming" : ""}`}>
			{thinking ? (
				<details className="thinking">
					<summary>{streaming && text === "" ? "Thinking…" : "Thought it through"}</summary>
					<p>{thinking}</p>
				</details>
			) : null}
			{text !== "" ? (
				<div className={streaming ? "text text-live" : "text"}>
					<Markdown text={text} />
				</div>
			) : streaming && !thinking ? (
				<div className="pending-dots" role="img" aria-label="Working" />
			) : null}
		</div>
	);
}

function NoticeRow({ item }: { item: NoticeItem }) {
	return <div className={`notice notice-${item.level}`}>{item.text}</div>;
}

/** Cards ask for a decision. M0 shows them; acting on them arrives with the live host. */
function CardRow({ item }: { item: CardItem }) {
	const { card } = item;
	switch (card.type) {
		case "question":
			return (
				<div className="card">
					<div className="card-kicker">Question{card.status === "open" ? "" : ` · ${card.status}`}</div>
					<p>{card.text}</p>
					{card.answer ? <p className="card-answer">{card.answer}</p> : null}
				</div>
			);
		case "vault.approval":
			return (
				<div className="card">
					<div className="card-kicker">Wants access · {card.status}</div>
					<p>
						{card.what} on <code>{card.host}</code>
					</p>
					<p className="card-why">{card.why}</p>
					<div className="card-code">Code {card.bindingCode}</div>
				</div>
			);
		case "browser.grant":
			return (
				<div className="card">
					<div className="card-kicker">Wants a browser · {card.status}</div>
					<p>{card.reason}</p>
				</div>
			);
	}
}

export const Row = memo(function Row({
	item,
	turnStart,
	first,
}: {
	item: TranscriptItem;
	turnStart: boolean;
	first: boolean;
}) {
	let body: ReactNode;
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
		case "card":
			body = <CardRow item={item} />;
			break;
		case "notice":
			body = <NoticeRow item={item} />;
			break;
	}
	return (
		<Profiled id={item.id}>
			<div
				className={`row row-${item.kind}${turnStart ? " turn-start" : ""}${first ? " row-first" : ""}`}
				data-item={item.id}
			>
				<div className="column">{body}</div>
			</div>
		</Profiled>
	);
});
