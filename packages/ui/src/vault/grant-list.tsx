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

// Styled with Tailwind utilities (src/tokens/tailwind.css): one row per grant, Stop always visible (not on hover), so
// it works the same with touch.

/** A line of facts about a grant, wrapping between them. */
const meta = "flex flex-wrap gap-x-2.5 text-xs text-muted wrap-anywhere";

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
		<li
			className={`flex min-w-0 items-start gap-2.5 border-border px-3 py-2.5 not-first:border-t ${current ? "bg-selected" : ""}`}
		>
			<KeyIcon size="sm" className="mt-0.5 flex-none text-faint" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="font-medium wrap-anywhere">
					{name} <span className="font-regular text-muted">on</span> <span className="hb-mono">{grant.route.host}</span>
				</p>
				<p className={meta}>
					<span className="hb-mono">{methodText(grant.route.methods)}</span>{" "}
					<span className="hb-mono">{grant.route.pathPrefix}</span>
				</p>
				<p className={meta}>
					<span>{usesText(grant)}</span>
					<span>{grant.expiresAt === undefined ? "No expiry" : timeLeft(grant.expiresAt, now)}</span>
				</p>
				{who === "" ? null : <p className={meta}>{who}</p>}
				{failed ? <p className="text-xs text-status-error">Harbour didn't stop it. Try again.</p> : null}
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
		<section className="flex min-w-0 flex-col gap-2.5 text-sm text-fg [&_p]:m-0" aria-label={title}>
			<div className="flex items-baseline gap-2">
				<h2 className="m-0 text-sm font-medium">{title}</h2>
				{grants.length === 0 ? null : <span className="text-xs text-faint tabular-nums">{grants.length}</span>}
			</div>
			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{grants.length === 0 && loading ? (
				<div className="hb-grant-list-loading flex flex-col gap-4">
					<span className="hb-sr-only">Loading active grants</span>
					<Skeleton lines={3} />
					<Skeleton lines={3} />
				</div>
			) : grants.length === 0 && error === undefined ? (
				<EmptyState title="No active grants">
					When you approve a request, its grant is listed here until it ends.
				</EmptyState>
			) : (
				<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-panel p-0">
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
