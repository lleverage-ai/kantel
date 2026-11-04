// A sandbox's egress page (compute console): what left it through its host's egress proxy, newest first, with what
// was allowed, denied and swapped; the protected variables it has, as the placeholders it sees; and its own egress
// grants on top of its environment's. A placeholder sent to a host it isn't bound to shows as a denied request with
// the reason. Values never appear here: the log names a protected variable, never what it holds.

import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { useLoad } from "../primitives/load.ts";
import { BackIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { bytesText, type EgressEntry, type EgressSource, type SandboxEgress } from "./compute-model.ts";
import { bindingText } from "./egress-rules.ts";
import { GrantsSection } from "./grants-section.tsx";
import {
	cellMono,
	cellSub,
	computePage,
	messageOf,
	None,
	SectionHeading,
	TableFrame,
	table,
	td,
	th,
} from "./parts.tsx";

type LogFilter = "all" | "denied" | "swapped";

const FILTERS: readonly { value: LogFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "denied", label: "Denied" },
	{ value: "swapped", label: "Swapped" },
];

const shown = (entry: EgressEntry, filter: LogFilter): boolean =>
	filter === "all" || (filter === "denied" ? entry.decision === "denied" : entry.swapped.length > 0);

const timeText = (at: number): string =>
	new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export interface EgressPageProps {
	readonly source: EgressSource;
	readonly sandboxId: string;
	/**
	 * The account the console has selected. A sandbox of another account (a link, or Back after switching) is shown as
	 * not this account's, with nothing to change.
	 */
	readonly accountId?: string;
	/** The Sandboxes page, for the way back. */
	readonly sandboxesHref: string;
	/** An environment's page, from the sandbox's environment. */
	readonly environmentHref?: (environmentId: string) => string;
	readonly navigate?: (path: string) => void;
	/** Show this filter first, for a story. */
	readonly initialFilter?: LogFilter;
	/** Under the sandbox page's Egress tab: no way back and no heading, which the page has. */
	readonly embedded?: boolean;
}

export function EgressPage({
	source,
	sandboxId,
	accountId,
	sandboxesHref,
	environmentHref,
	navigate,
	initialFilter = "all",
	embedded = false,
}: EgressPageProps) {
	const { state, reload } = useLoad(() => source.get(sandboxId), [source, sandboxId]);
	const [saved, setSaved] = useState<SandboxEgress>();
	const [filter, setFilter] = useState<LogFilter>(initialFilter);
	const egress = saved ?? (state.status === "ready" ? state.value : undefined);
	const back = embedded ? null : (
		<a
			className="inline-flex items-center gap-1 text-sm text-muted no-underline hover:text-fg"
			href={sandboxesHref}
			onClick={(event) => {
				if (navigate === undefined) return;
				event.preventDefault();
				navigate(sandboxesHref);
			}}
		>
			<BackIcon />
			Sandboxes
		</a>
	);
	if (egress === undefined) {
		return (
			<div className={computePage}>
				{back}
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the sandbox's egress.")}
					</Notice>
				) : (
					<Skeleton lines={4} />
				)}
			</div>
		);
	}
	if (accountId !== undefined && egress.accountId !== accountId) {
		return (
			<div className={computePage}>
				{back}
				<Notice level="error">
					This sandbox belongs to another account. Switch to that account to see its egress or change its grants.
				</Notice>
			</div>
		);
	}
	const entries = egress.entries.filter((entry) => shown(entry, filter));
	const counts: Record<LogFilter, number> = {
		all: egress.entries.length,
		denied: egress.entries.filter((entry) => shown(entry, "denied")).length,
		swapped: egress.entries.filter((entry) => shown(entry, "swapped")).length,
	};
	const env = egress.environment;
	return (
		<div className={computePage}>
			{back}
			{embedded ? null : (
				<PageHeader
					title={`Egress from ${egress.sandboxName}`}
					lede="Every request and connection the sandbox made through its host's egress proxy, what was decided and which protected variables were swapped in. Values never appear here."
					actions={
						env === undefined ? null : environmentHref === undefined ? (
							<Badge>Environment {env.name}</Badge>
						) : (
							<a
								className="text-sm text-muted underline decoration-border-strong underline-offset-2 hover:text-fg"
								href={environmentHref(env.id)}
							>
								Environment {env.name}
							</a>
						)
					}
				/>
			)}

			<section className="flex min-w-0 flex-col gap-2" aria-labelledby="egress-log-title">
				<SectionHeading
					id="egress-log-title"
					title="Log"
					actions={
						<SegmentedControl
							label="Show"
							options={FILTERS.map((option) => ({ ...option, count: counts[option.value] }))}
							value={filter}
							onChange={setFilter}
						/>
					}
				/>
				{entries.length === 0 ? (
					<p className="m-0 text-sm text-muted">
						{egress.entries.length === 0 ? "Nothing has left this sandbox yet." : "Nothing matches."}
					</p>
				) : (
					// Nothing in it takes focus, so the frame does: in a narrow window it scrolls sideways, and the keyboard must
					// reach it.
					<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-label="Egress log table">
						<table className={table}>
							<thead>
								<tr>
									<th className={th} scope="col">
										Time
									</th>
									<th className={th} scope="col">
										Request
									</th>
									<th className={th} scope="col">
										Decision
									</th>
									<th className={th} scope="col">
										Swapped
									</th>
									<th className={`${th} text-right`} scope="col">
										Sent
									</th>
									<th className={`${th} text-right`} scope="col">
										Received
									</th>
								</tr>
							</thead>
							<tbody>
								{entries.map((entry) => (
									<tr key={entry.id} data-egress={entry.id} data-decision={entry.decision}>
										<td className={td}>
											<span className="text-muted tabular-nums" title={new Date(entry.at).toLocaleString("en-GB")}>
												{timeText(entry.at)}
											</span>
										</td>
										{/* The request takes what the other columns leave, cut short with its whole in the tooltip, so the log
										    is never wider than the page and its last column is never clipped. */}
										<td className={`${td} w-full max-w-0`}>
											<span
												className={`${cellMono} block truncate`}
												title={`${entry.method} ${entry.host}${entry.port === 443 ? "" : `:${entry.port}`}${entry.path ?? ""}`}
											>
												<span className="text-muted">{entry.method} </span>
												<span className="text-fg">
													{entry.host}
													{entry.port === 443 ? "" : `:${entry.port}`}
												</span>
												{entry.path ?? ""}
											</span>
											<span className={cellSub}>
												{entry.method === "CONNECT"
													? "Tunnelled: the proxy didn't look inside"
													: entry.inspected
														? "Inspected HTTPS"
														: "Plain HTTP"}
											</span>
										</td>
										<td className={td}>
											<span className="flex items-center gap-2">
												{entry.decision === "allowed" ? (
													<Badge tone="done">Allowed</Badge>
												) : (
													<Badge tone="error">Denied</Badge>
												)}
												{entry.status === undefined ? null : (
													<span className="text-xs text-muted tabular-nums">{entry.status}</span>
												)}
											</span>
											{entry.reason === undefined ? null : (
												<span className={`${cellSub} max-w-popover whitespace-normal`}>{entry.reason}</span>
											)}
											{entry.rule === undefined ? null : <span className={`${cellSub} font-mono`}>{entry.rule}</span>}
										</td>
										<td className={td}>
											{entry.swapped.length === 0 ? (
												<span className="text-faint">None</span>
											) : (
												<span className="flex flex-wrap gap-1">
													{entry.swapped.map((name) => (
														<Badge key={name} tone="accent">
															{name}
														</Badge>
													))}
												</span>
											)}
										</td>
										<td className={`${td} text-right tabular-nums text-muted`}>
											{entry.bytesUp === 0 ? <None /> : bytesText(entry.bytesUp)}
										</td>
										<td className={`${td} text-right tabular-nums text-muted`}>
											{entry.bytesDown === 0 ? <None /> : bytesText(entry.bytesDown)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</TableFrame>
				)}
			</section>

			<section className="flex min-w-0 flex-col gap-2" aria-labelledby="egress-protected-title">
				<SectionHeading id="egress-protected-title" title="Protected variables" />
				{egress.protectedVariables.length === 0 ? (
					<p className="m-0 text-sm text-muted">
						{env === undefined
							? "This sandbox wasn't made from an environment."
							: `${env.name} has no protected variables.`}
					</p>
				) : (
					<>
						<p className="m-0 text-sm text-muted">
							What this sandbox sees instead of each value. The placeholder is its own: it's no use in another sandbox,
							and sent to any other host the request is refused.
						</p>
						<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-label="Protected variables table">
							<table className={table}>
								<thead>
									<tr>
										<th className={th} scope="col">
											Variable
										</th>
										<th className={th} scope="col">
											Placeholder
										</th>
										<th className={th} scope="col">
											Swapped in only for
										</th>
									</tr>
								</thead>
								<tbody>
									{egress.protectedVariables.map((variable) => (
										<tr key={variable.name}>
											<td className={td}>
												<span className="font-mono text-code text-fg">{variable.name}</span>
											</td>
											<td className={td}>
												<span className={cellMono}>{variable.placeholderPrefix}…</span>
											</td>
											<td className={td}>
												<span className="flex flex-col gap-0.5">
													{variable.bindings.map((binding) => (
														<span key={bindingText(binding)} className={cellMono}>
															{bindingText(binding)}
														</span>
													))}
												</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</TableFrame>
					</>
				)}
			</section>

			<GrantsSection
				id="egress-grants-title"
				title="Grants"
				description="This sandbox's own allow and deny rules, on top of its environment's and the account's proxy settings. They apply to its next request. Deny wins."
				grants={egress.grants}
				inherited={egress.environmentGrants}
				{...(env === undefined ? {} : { inheritedFrom: env.name })}
				onSave={async (grants) => setSaved(await source.setGrants(egress.sandboxId, grants))}
			/>
		</div>
	);
}
