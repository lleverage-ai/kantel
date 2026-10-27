import type { BrowserGrantCard as BrowserGrantCardData } from "@harbour/protocol";
import { memo, useEffect, useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckCircleIcon, GlobeIcon, MinusCircleIcon } from "../primitives/icons.tsx";
import { Panel } from "../primitives/surface.tsx";
import "./cards.css";

export type BrowserGrantCardProps = {
	card: BrowserGrantCardData;
	/** Allow. Without both handlers a pending request is shown read-only, waiting for a decision (a replay, an audit). */
	onGrant?: () => void;
	onDeny?: () => void;
	/** The decision is on its way: the button pressed shows a spinner and both are blocked. */
	busy?: boolean;
};

/**
 * The agent asking to use a browser, with its reason, Decline and Allow. Once decided it folds to one quiet line, so
 * a settled request takes no more room than a tool row.
 */
export const BrowserGrantCard = memo(function BrowserGrantCard({
	card,
	onGrant,
	onDeny,
	busy = false,
}: BrowserGrantCardProps) {
	if (card.status === "granted") {
		return (
			<p className="hb-card-quiet" title={card.reason}>
				<CheckCircleIcon size="sm" className="hb-card-icon-done" />
				<span className="hb-card-quiet-text">Browser access allowed</span>
			</p>
		);
	}
	if (card.status === "denied") {
		return (
			<p className="hb-card-quiet" title={card.reason}>
				<MinusCircleIcon size="sm" className="hb-card-icon-quiet" />
				<span className="hb-card-quiet-text">Browser access declined</span>
			</p>
		);
	}
	return <PendingGrant card={card} onGrant={onGrant} onDeny={onDeny} busy={busy} />;
});

function PendingGrant({
	card,
	onGrant,
	onDeny,
	busy,
}: {
	card: BrowserGrantCardData;
	onGrant: (() => void) | undefined;
	onDeny: (() => void) | undefined;
	busy: boolean;
}) {
	const titleId = useId();
	// Which button was pressed, so the spinner shows on that one. Forgotten once the card is no longer busy.
	const [pressed, setPressed] = useState<"grant" | "deny" | undefined>(undefined);
	useEffect(() => {
		if (!busy) setPressed(undefined);
	}, [busy]);
	const spinning = busy ? (pressed ?? "grant") : undefined;
	const decidable = onGrant !== undefined && onDeny !== undefined;

	return (
		<Panel className="hb-card hb-browser-card" tone="approval" aria-labelledby={titleId}>
			<div className="hb-card-head">
				<GlobeIcon className="hb-card-icon-approval" />
				<div className="hb-card-text">
					<p id={titleId} className="hb-card-question">
						Wants to use a browser
					</p>
					<p className="hb-card-detail">{card.reason}</p>
					{decidable ? null : <p className="hb-card-detail">Waiting for a decision</p>}
				</div>
			</div>
			{decidable ? (
				<div className="hb-card-actions">
					<Button
						disabled={busy && spinning !== "deny"}
						busy={spinning === "deny"}
						onClick={() => {
							setPressed("deny");
							onDeny?.();
						}}
					>
						Decline
					</Button>
					<Button
						variant="primary"
						disabled={busy && spinning !== "grant"}
						busy={spinning === "grant"}
						onClick={() => {
							setPressed("grant");
							onGrant?.();
						}}
					>
						Allow
					</Button>
				</div>
			) : null}
		</Panel>
	);
}
