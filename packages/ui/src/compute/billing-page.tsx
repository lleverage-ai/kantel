// The Billing page (compute console, experimental; hosted Kantel only): the account's plan and this period's use of
// it (sandbox time against what the price includes, sandboxes running at once, saved snapshots and the daily spend),
// every plan side by side to switch between, and what each sandbox size costs an hour. It is a demo of the hosted
// service: switching plans takes no payment and no card is stored. Every call goes through the `BillingSource` the
// host binds; stories bind it to fixtures.

import { type ReactNode, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { DAY } from "../primitives/format.ts";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice, Panel } from "../primitives/surface.tsx";
import {
	type BillingSource,
	type BillingSummary,
	type ComputeAccount,
	costText,
	type Plan,
	priceText,
	SANDBOX_SIZES,
	sizeSpec,
	usedShare,
} from "./compute-model.ts";
import { CapacityBar, computePage, messageOf, SectionHeading, TableFrame, table, td, th } from "./parts.tsx";

export interface BillingPageProps {
	readonly source: BillingSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
}

/** "1 Nov": a day of a billing period, which runs on UTC days. */
const dayText = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "small, medium and large": a few words in a sentence. */
function listText(words: readonly string[]): string {
	if (words.length <= 1) return words[0] ?? "";
	return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "Small, medium and large sizes". */
function sizesText(plan: Plan): string {
	const words = listText(plan.sizes.map((size) => sizeSpec(size).label.toLowerCase()));
	return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${plan.sizes.length === 1 ? "size" : "sizes"}`;
}

type NoticeState = { level: "info" | "error"; text: string };

export function BillingPage({ source, account, now: fixedNow }: BillingPageProps) {
	const { state, reload } = useLoad(
		() => Promise.all([source.summary(account.id), source.plans()] as const),
		[source, account.id],
	);
	// The summary after a plan change, ahead of the next read.
	const [changed, setChanged] = useState<BillingSummary>();
	const [switching, setSwitching] = useState<string>();
	const [notice, setNotice] = useState<NoticeState>();
	const now = fixedNow ?? Date.now();

	const loaded = state.status === "ready" ? state.value : undefined;
	const summary = changed?.accountId === account.id ? changed : loaded?.[0];
	const plans = loaded?.[1];

	const switchTo = async (plan: Plan) => {
		setSwitching(plan.id);
		try {
			const next = await source.changePlan(account.id, plan.id);
			setChanged(next);
			setNotice({ level: "info", text: `Switched to ${plan.name}. No payment was taken: this is a demo.` });
			reload();
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't switch to ${plan.name}. Try again.`) });
		} finally {
			setSwitching(undefined);
		}
	};

	return (
		<div className={computePage}>
			<PageHeader
				title="Billing"
				lede={
					account.kind === "organisation"
						? `${account.name}'s plan, what it has used this period and what sandboxes cost.`
						: "Your plan, what you've used this period and what sandboxes cost."
				}
			/>
			<Notice level="info" announce={false}>
				This is a demo of hosted Kantel. No payment is taken and no card is stored.
			</Notice>
			{notice === undefined ? null : (
				<Notice
					level={notice.level}
					action={
						<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
							Dismiss
						</Button>
					}
				>
					{notice.text}
				</Notice>
			)}
			{state.status === "error" && summary === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the plan and usage.")}
				</Notice>
			) : summary === undefined || plans === undefined ? (
				<BillingSkeleton />
			) : (
				<>
					<ThisPeriod summary={summary} now={now} />
					<section className="flex min-w-0 flex-col gap-2" aria-label="Plans">
						<SectionHeading title="Plans" />
						<div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
							{plans.map((plan) => (
								<PlanCard
									key={plan.id}
									plan={plan}
									current={plan.id === summary.plan.id}
									busy={switching === plan.id}
									disabled={switching !== undefined}
									onSwitch={() => void switchTo(plan)}
								/>
							))}
						</div>
					</section>
				</>
			)}
			<SandboxRates />
		</div>
	);
}

function BillingSkeleton() {
	return (
		<Panel aria-busy="true">
			<div className="flex flex-col gap-3 p-1">
				<Skeleton width="40%" />
				<Skeleton lines={3} />
			</div>
		</Panel>
	);
}

/** One measure of the period: what it is, the figure, and a bar of it against the plan's limit. */
function Meter({
	label,
	value,
	share,
	children,
}: {
	label: string;
	value: string;
	share: number;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="text-xs text-muted">{label}</span>
			<span className="text-lg font-medium leading-tight tabular-nums text-fg">{value}</span>
			<CapacityBar share={share}>{children}</CapacityBar>
		</div>
	);
}

function ThisPeriod({ summary, now }: { summary: BillingSummary; now: number }) {
	const { plan } = summary;
	const days = Math.max(1, Math.round((summary.periodEnd - summary.periodStart) / DAY));
	const left = Math.max(0, Math.ceil((summary.periodEnd - now) / DAY));
	const over = summary.usedCents - plan.includedCents;
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label="This period">
			<SectionHeading title="This period" />
			<Panel>
				<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<p className="m-0 text-md font-strong text-fg">
						{plan.name} plan, {priceText(plan.priceCents)} a month
					</p>
					<p className="m-0 text-sm text-muted">
						{dayText.format(summary.periodStart)} to {dayText.format(summary.periodEnd)},{" "}
						{left === 1 ? "1 day" : `${left} days`} left
					</p>
				</div>
				<div className="grid min-w-0 grid-cols-1 gap-4 py-1 sm:grid-cols-3">
					<Meter
						label="Sandbox time"
						value={costText(summary.usedCents)}
						share={usedShare(summary.usedCents, plan.includedCents)}
					>
						{over > 0
							? `${costText(over)} over the ${costText(plan.includedCents)} included`
							: `of ${costText(plan.includedCents)} included`}
					</Meter>
					<Meter
						label="Running now"
						value={String(summary.running)}
						share={usedShare(summary.running, plan.concurrent)}
					>
						of {plan.concurrent} sandboxes at once
					</Meter>
					<Meter
						label="Saved snapshots"
						value={String(summary.savedSnapshots)}
						share={usedShare(summary.savedSnapshots, plan.savedSnapshots)}
					>
						of {plan.savedSnapshots} kept
					</Meter>
				</div>
				<DailySpend summary={summary} days={days} />
			</Panel>
		</section>
	);
}

/**
 * Each day's spend as a bar, a slot for every day of the period, so how far into it you are shows too. Heights are
 * inline percentages of the busiest day, as CapacityBar's widths are.
 */
function DailySpend({ summary, days }: { summary: BillingSummary; days: number }) {
	const max = Math.max(1, ...summary.daily);
	const total = summary.daily.reduce((sum, cents) => sum + cents, 0);
	const label = `Daily spend this period: ${costText(total)} over ${summary.daily.length} ${
		summary.daily.length === 1 ? "day" : "days"
	}, at most ${costText(Math.max(0, ...summary.daily))} in a day.`;
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-3">
			<span className="text-xs text-muted">Daily spend</span>
			<div className="flex h-12 min-w-0 items-end gap-0.5" role="img" aria-label={label}>
				{Array.from({ length: days }, (_, day) => {
					const cents = summary.daily[day];
					const date = dayText.format(summary.periodStart + day * DAY);
					return cents === undefined ? (
						<span key={date} className="block h-0.5 min-w-0 flex-1 rounded-xs bg-active" />
					) : (
						<span
							key={date}
							className="block min-h-0.5 min-w-0 flex-1 rounded-xs bg-accent"
							style={{ height: `${Math.round((cents / max) * 100)}%` }}
							title={`${date}: ${costText(cents)}`}
						/>
					);
				})}
			</div>
			<div className="flex justify-between text-xs text-faint">
				<span>{dayText.format(summary.periodStart)}</span>
				<span>{dayText.format(summary.periodEnd)}</span>
			</div>
		</div>
	);
}

function PlanCard({
	plan,
	current,
	busy,
	disabled,
	onSwitch,
}: {
	plan: Plan;
	current: boolean;
	busy: boolean;
	disabled: boolean;
	onSwitch: () => void;
}) {
	return (
		<Panel aria-label={`${plan.name} plan`}>
			<div className="flex min-w-0 items-center justify-between gap-2">
				<h3 className="m-0 text-md font-strong leading-tight text-fg">{plan.name}</h3>
				{current ? <Badge tone="accent">Current plan</Badge> : null}
			</div>
			<p className="m-0 text-sm text-muted">
				<span className="text-lg font-medium tabular-nums text-fg">{priceText(plan.priceCents)}</span> a month
			</p>
			<ul className="m-0 flex flex-1 list-none flex-col gap-1 p-0 text-sm text-muted">
				<li>{costText(plan.includedCents)} of sandbox time included</li>
				<li>{plan.concurrent.toLocaleString("en-GB")} sandboxes at once</li>
				<li>{plan.startsPerMinute.toLocaleString("en-GB")} starts a minute</li>
				<li>{plan.savedSnapshots.toLocaleString("en-GB")} saved snapshots</li>
				<li>{sizesText(plan)}</li>
			</ul>
			{current ? null : (
				<div className="pt-1">
					<Button busy={busy} disabled={disabled} onClick={onSwitch}>
						Switch to {plan.name}
					</Button>
				</div>
			)}
		</Panel>
	);
}

function SandboxRates() {
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-label="Sandbox rates">
			<SectionHeading title="Sandbox rates" />
			{/* Nothing in it takes focus, so the frame does: on a phone it scrolls sideways, and the keyboard must reach it. */}
			<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-label="Sandbox rates table">
				<table className={table}>
					<thead>
						<tr>
							<th className={th} scope="col">
								Size
							</th>
							<th className={`${th} text-right`} scope="col">
								vCPU
							</th>
							<th className={`${th} text-right`} scope="col">
								Memory
							</th>
							<th className={`${th} text-right`} scope="col">
								Disk
							</th>
							<th className={`${th} text-right`} scope="col">
								An hour
							</th>
						</tr>
					</thead>
					<tbody>
						{SANDBOX_SIZES.map((spec) => (
							<tr key={spec.size}>
								<td className={`${td} font-medium text-fg`}>{spec.label}</td>
								<td className={`${td} text-right tabular-nums`}>{spec.vcpus}</td>
								<td className={`${td} text-right tabular-nums`}>{spec.memoryGb} GB</td>
								<td className={`${td} text-right tabular-nums`}>{spec.diskGb} GB</td>
								<td className={`${td} text-right tabular-nums`}>
									{spec.centsPerHour === undefined ? "–" : costText(spec.centsPerHour)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</TableFrame>
			<p className="m-0 text-xs text-muted">
				MicroVMs are billed at these rates while they run. Isolates are billed per CPU-second instead, at a small
				fraction of them.
			</p>
		</section>
	);
}
