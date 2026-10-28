import { memo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useNow } from "../primitives/clock.ts";
import { timeLeft } from "../primitives/format.ts";
import { KeyIcon } from "../primitives/icons.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { methodText } from "../session/vault-model.ts";
import type { GrantSummary } from "./load.ts";
import { usesText } from "./vault-page-model.ts";
import "./grant-list.css";

export type ActiveGrantListProps = {
	grants: readonly GrantSummary[];
	/** Stops a grant. The row shows Stopping until it resolves; the host then drops it from `grants`. */
	onStop: (grantId: string) => Promise<void>;
	loading?: boolean;
	error?: string;
	/** A fixed time, for stories. Without it the expiry countdowns read the shared one-second clock. */
	now?: number;
	/** The grant whose request is open on the page, highlighted in the list. */
	currentProposalId?: string;
	title?: string;
};

const GrantRow = memo(function GrantRow({
	summary,
	now,
	current,
	onStop,
}: {
	summary: GrantSummary;
	now: number;
	current: boolean;
	onStop: (grantId: string) => Promise<void>;
}) {
	const { grant } = summary;
	const [stopping, setStopping] = useState(false);
	const [failed, setFailed] = useState(false);
	const name = summary.itemName ?? "A credential";
	const who = [summary.requester?.agent, summary.requester?.session].filter(Boolean).join(" in ");
	return (
		<li className={`hb-grant-row${current ? " hb-grant-row-current" : ""}`}>
			<KeyIcon size="sm" className="hb-grant-row-icon" />
			<div className="hb-grant-row-text">
				<p className="hb-grant-row-title">
					{name} <span className="hb-grant-row-on">on</span> <span className="hb-mono">{grant.route.host}</span>
				</p>
				<p className="hb-grant-row-meta">
					<span className="hb-mono">{methodText(grant.route.methods)}</span>{" "}
					<span className="hb-mono">{grant.route.pathPrefix}</span>
				</p>
				<p className="hb-grant-row-meta">
					<span>{usesText(grant)}</span>
					<span>{grant.expiresAt === undefined ? "No expiry" : timeLeft(grant.expiresAt, now)}</span>
				</p>
				{who === "" ? null : <p className="hb-grant-row-meta">{who}</p>}
				{failed ? <p className="hb-grant-row-error">The vault didn't stop it. Try again.</p> : null}
			</div>
			<Button
				size="xs"
				variant="danger"
				busy={stopping}
				aria-label={`Stop ${name} on ${grant.route.host}`}
				onClick={() => {
					setStopping(true);
					setFailed(false);
					onStop(grant.id).then(
						() => setStopping(false),
						() => {
							setStopping(false);
							setFailed(true);
						},
					);
				}}
			>
				Stop
			</Button>
		</li>
	);
});

/**
 * The viewer's active grants, each with Stop: what agents can reach right now and until when. Stopping a grant makes
 * the vault refuse the next request that would use it.
 */
export function ActiveGrantList({
	grants,
	onStop,
	loading = false,
	error,
	now: fixedNow,
	currentProposalId,
	title = "Active grants",
}: ActiveGrantListProps) {
	const ticking = useNow(1000, fixedNow === undefined && grants.length > 0);
	const now = fixedNow ?? ticking;
	return (
		<section className="hb-grant-list" aria-label={title}>
			<div className="hb-grant-list-head">
				<h2 className="hb-grant-list-title">{title}</h2>
				{grants.length === 0 ? null : <span className="hb-grant-list-count">{grants.length}</span>}
			</div>
			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{grants.length === 0 && loading ? (
				<div className="hb-grant-list-loading">
					<span className="hb-sr-only">Loading active grants</span>
					<Skeleton lines={3} />
					<Skeleton lines={3} />
				</div>
			) : grants.length === 0 && error === undefined ? (
				<EmptyState title="No active grants">
					When you approve a request, its grant is listed here until it ends.
				</EmptyState>
			) : (
				<ul className="hb-grant-list-items">
					{grants.map((summary) => (
						<GrantRow
							key={summary.grant.id}
							summary={summary}
							now={now}
							current={summary.grant.proposalId === currentProposalId}
							onStop={onStop}
						/>
					))}
				</ul>
			)}
		</section>
	);
}
