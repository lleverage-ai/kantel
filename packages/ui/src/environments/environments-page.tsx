// The Environments page (sandbox tier 3, experimental): the long-lived machines a project's sessions run commands on,
// each with its state, who owns it, Start or Stop, and which sessions hold it now. Every call goes through the
// `EnvironmentsSource` the host binds to `/v1/environments`; stories bind it to fixtures. The view is plain state the
// host can mirror in its address (`view` and `onViewChange`), as the Tool servers page's is.

import type { Environment, EnvironmentDetail, EnvironmentLease } from "@kantel/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { ChevronRightIcon, StopIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { PlayIcon, ProjectIcon, ServerIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusDot, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import {
	commandCountText,
	type EnvironmentLinks,
	type EnvironmentsDirectory,
	type EnvironmentsSource,
	environmentMoving,
	environmentStatusText,
	eventText,
	idleText,
	leaseCountText,
	leaseSinceText,
	ownerText,
	PROVIDER_LABELS,
	powerAction,
	resumeText,
	runningText,
	STATE_STATUS,
	sizeText,
	sortLeases,
} from "./environments-model.ts";

/** Where the page is. */
export type EnvironmentsView =
	| { readonly name: "list" }
	| { readonly name: "environment"; readonly environmentId: string };

export interface EnvironmentsPageProps {
	readonly source: EnvironmentsSource;
	readonly directory: EnvironmentsDirectory;
	readonly links: EnvironmentLinks;
	/** A project's page: only its environments. */
	readonly projectId?: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** How often a starting or stopping environment is read again, in milliseconds. Default 1500. */
	readonly pollMs?: number;
	readonly view?: EnvironmentsView;
	readonly onViewChange?: (view: EnvironmentsView) => void;
	/** Where to start, when the page keeps its own view. */
	readonly initialView?: EnvironmentsView;
	/** Whether the page has its own heading. */
	readonly heading?: boolean;
}

const pageFrame =
	"kt-environments-page flex w-full max-w-[calc(var(--kt-content-width)_+_var(--kt-sidebar-width))] min-w-0 flex-col gap-5 text-sm leading-normal text-fg";
/** A line of facts, wrapping between them. */
const rowMeta = "m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted";
/** A list in a hairline frame, a hairline between rows. */
const rows = "m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0";

const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback);

/** Re-renders every `ms` while `on`, so a countdown and a moving state keep up. */
function useTick(on: boolean, ms: number): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setTick((value) => value + 1), ms);
		return () => clearInterval(timer);
	}, [on, ms]);
	return tick;
}

export function EnvironmentsPage({
	source,
	directory,
	links,
	projectId,
	now: fixedNow,
	pollMs = 1500,
	view: controlled,
	onViewChange,
	initialView = { name: "list" },
	heading = true,
}: EnvironmentsPageProps) {
	const [own, setOwn] = useState<EnvironmentsView>(initialView);
	const view = controlled ?? own;
	const go = useCallback(
		(next: EnvironmentsView) => {
			setOwn(next);
			onViewChange?.(next);
		},
		[onViewChange],
	);
	const now = fixedNow ?? Date.now();

	let body: ReactNode;
	if (view.name === "environment") {
		body = (
			<EnvironmentView
				key={view.environmentId}
				environmentId={view.environmentId}
				source={source}
				directory={directory}
				links={links}
				now={now}
				pollMs={pollMs}
				heading={heading}
				onBack={() => go({ name: "list" })}
			/>
		);
	} else {
		body = (
			<>
				{heading ? (
					<PageHeader
						title="Environments"
						lede="Long-lived machines your sessions run commands on, with Docker and room for a whole dev stack. Each starts when a session first needs it and stops when it has been idle."
					/>
				) : null}
				<Notice level="info" announce={false}>
					Experimental. Kantel doesn't run the network of these machines, so code on them can reach the internet
					directly. No credential is ever written to them.
				</Notice>
				<EnvironmentList
					source={source}
					directory={directory}
					projectId={projectId}
					now={now}
					pollMs={pollMs}
					onOpen={(environment) => go({ name: "environment", environmentId: environment.id })}
				/>
			</>
		);
	}

	return <div className={pageFrame}>{body}</div>;
}

/** Start or Stop, as the environment's state allows, with the error if it fails. */
function PowerButton({
	environment,
	source,
	onChanged,
	size = "sm",
}: {
	environment: Environment;
	source: EnvironmentsSource;
	onChanged: (environment: Environment) => void;
	size?: "xs" | "sm";
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const action = powerAction(environment.state);
	const moving = environmentMoving(environment.state);
	const run = async () => {
		if (action === undefined) return;
		setBusy(true);
		setFailure(undefined);
		try {
			onChanged(action === "start" ? await source.start(environment.id) : await source.stop(environment.id));
		} catch (caught) {
			setFailure(messageOf(caught, `Kantel couldn't ${action} it. Try again.`));
		} finally {
			setBusy(false);
		}
	};
	return (
		<span className="flex flex-none flex-col items-end gap-1">
			{action === "stop" ? (
				<Button
					size={size}
					icon={<StopIcon size="sm" />}
					busy={busy}
					aria-label={`Stop ${environment.name}`}
					onClick={() => void run()}
				>
					Stop
				</Button>
			) : (
				<Button
					size={size}
					variant={action === "start" ? "primary" : "secondary"}
					icon={<PlayIcon size="sm" />}
					busy={busy || moving}
					disabled={action === undefined}
					aria-label={`Start ${environment.name}`}
					onClick={() => void run()}
				>
					Start
				</Button>
			)}
			{failure === undefined ? null : (
				<span className="text-xs text-status-error" role="alert">
					{failure}
				</span>
			)}
		</span>
	);
}

function EnvironmentList({
	source,
	directory,
	projectId,
	now,
	pollMs,
	onOpen,
}: {
	source: EnvironmentsSource;
	directory: EnvironmentsDirectory;
	projectId: string | undefined;
	now: number;
	pollMs: number;
	onOpen: (environment: Environment) => void;
}) {
	const list = useLoad(() => source.list(projectId === undefined ? undefined : { projectId }), [source, projectId]);
	const value = list.state.status === "ready" ? list.state.value : undefined;
	const moving = value?.some((environment) => environmentMoving(environment.state)) ?? false;
	const tick = useTick(moving, pollMs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the poll.
	useEffect(() => {
		if (tick > 0) list.reload();
	}, [tick]);

	if (list.state.status === "error")
		return (
			<Notice
				level="error"
				action={
					<Button size="xs" onClick={list.reload}>
						Try again
					</Button>
				}
			>
				Kantel couldn't read the environments. Check your connection and try again.
			</Notice>
		);
	if (value === undefined)
		return (
			<div className="flex flex-col gap-5 rounded-panel border border-border bg-panel p-3" aria-busy="true">
				<span className="kt-sr-only">Loading environments</span>
				<Skeleton lines={2} />
				<Skeleton lines={2} />
				<Skeleton lines={2} />
			</div>
		);
	if (value.length === 0)
		return (
			<EmptyState title="No environments yet">
				An environment is a machine your sessions share, such as a dev stack with its Docker services. Kantel makes one
				when a project's agent profile names it.
			</EmptyState>
		);

	return (
		<ul className={rows} aria-label="Environments">
			{value.map((environment) => (
				<li key={environment.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
					<button
						type="button"
						onClick={() => onOpen(environment)}
						className="kt-focusable flex min-w-0 flex-[1_1_var(--kt-sidebar-width)] cursor-pointer flex-col gap-1 rounded-control border-0 bg-transparent p-0 text-left text-fg hover:[&>.kt-env-name]:underline"
					>
						<span className="kt-env-name flex min-w-0 items-baseline gap-2 text-md font-medium wrap-anywhere">
							{environment.name}
							<code className="font-mono text-code text-faint">{environment.alias}</code>
						</span>
						<span className={rowMeta}>
							<span className="inline-flex min-w-0 items-center gap-1">
								<span className="flex text-faint">
									<ProjectIcon size="sm" />
								</span>
								{ownerText(environment, directory)}
							</span>
							<span className="inline-flex items-center gap-1">
								<span className="flex text-faint">
									<ServerIcon size="sm" />
								</span>
								{PROVIDER_LABELS[environment.provider]}, {environment.size.vcpus} vCPU / {environment.size.memoryGb} GB
							</span>
						</span>
					</button>
					<span className="flex min-w-0 flex-none flex-col items-end gap-1 max-sm:items-start">
						<StatusLabel status={STATE_STATUS[environment.state]}>
							{environmentStatusText(environment, now)}
						</StatusLabel>
						<span className="text-xs text-faint tabular-nums">{leaseCountText(environment.leaseCount)}</span>
					</span>
					<PowerButton environment={environment} source={source} size="xs" onChanged={() => list.reload()} />
				</li>
			))}
		</ul>
	);
}

/** The way back to the list, above an environment. */
function Trail({ current, onBack }: { current: string; onBack: () => void }) {
	return (
		<nav aria-label="Breadcrumb">
			<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-xs text-muted">
				<li>
					<button
						type="button"
						onClick={onBack}
						className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-muted hover:text-fg hover:underline"
					>
						Environments
					</button>
				</li>
				<li aria-hidden="true" className="flex text-faint">
					<ChevronRightIcon size="sm" />
				</li>
				<li aria-current="page" className="min-w-0 truncate text-fg">
					{current}
				</li>
			</ol>
		</nav>
	);
}

function EnvironmentView({
	environmentId,
	source,
	directory,
	links,
	now,
	pollMs,
	heading,
	onBack,
}: {
	environmentId: string;
	source: EnvironmentsSource;
	directory: EnvironmentsDirectory;
	links: EnvironmentLinks;
	now: number;
	pollMs: number;
	heading: boolean;
	onBack: () => void;
}) {
	const detail = useLoad(() => source.get(environmentId), [source, environmentId]);
	const found = detail.state.status === "ready" ? detail.state.value : undefined;
	const moving = found !== undefined && environmentMoving(found.environment.state);
	const tick = useTick(moving, pollMs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the poll.
	useEffect(() => {
		if (tick > 0) detail.reload();
	}, [tick]);

	return (
		<>
			<Trail current={found?.environment.name ?? "Environment"} onBack={onBack} />
			{detail.state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="xs" onClick={detail.reload}>
							Try again
						</Button>
					}
				>
					Kantel couldn't read this environment. It may have been removed, or the connection dropped.
				</Notice>
			) : found === undefined ? (
				<div className="flex max-w-content flex-col gap-4" aria-busy="true">
					<span className="kt-sr-only">Loading the environment</span>
					<Skeleton width="30%" />
					<Skeleton lines={3} />
				</div>
			) : (
				<EnvironmentDetailView
					detail={found}
					source={source}
					directory={directory}
					links={links}
					now={now}
					heading={heading}
					onChanged={detail.reload}
				/>
			)}
		</>
	);
}

function EnvironmentDetailView({
	detail,
	source,
	directory,
	links,
	now,
	heading,
	onChanged,
}: {
	detail: EnvironmentDetail;
	source: EnvironmentsSource;
	directory: EnvironmentsDirectory;
	links: EnvironmentLinks;
	now: number;
	heading: boolean;
	onChanged: () => void;
}) {
	const { environment } = detail;
	const leases = sortLeases(detail.leases);
	const grants = detail.grants.filter((grant) => grant.status === "active");
	const wakes = resumeText(environment);
	const power = <PowerButton environment={environment} source={source} onChanged={onChanged} />;

	return (
		<div className="flex min-w-0 flex-col gap-6">
			{heading ? <PageHeader title={environment.name} lede={environment.description} actions={power} /> : power}
			{environment.state === "error" && environment.error !== undefined ? (
				<Notice level="error" announce={false}>
					{environment.error}
				</Notice>
			) : null}
			<Panel aria-label={`About ${environment.name}`} className="max-w-content">
				<FieldList>
					<Field label="Status">
						<StatusLabel status={STATE_STATUS[environment.state]}>
							{environmentStatusText(environment, now)}
						</StatusLabel>
					</Field>
					<Field label="Owner">{ownerText(environment, directory)}</Field>
					<Field
						label="Sessions see it as"
						extra={environment.sharing === "exclusive" ? <Badge tone="approval">One at a time</Badge> : undefined}
					>
						<code className="font-mono text-code">{environment.alias}</code>
					</Field>
					<Field label="Machine">
						{PROVIDER_LABELS[environment.provider]}, {sizeText(environment.size)}
					</Field>
					<Field
						label="Network"
						extra={environment.egress === "unmanaged" ? <Badge tone="approval">Unmanaged</Badge> : undefined}
					>
						{environment.egress === "unmanaged"
							? environment.placeholders
								? "Open to the internet. Connections work through Kantel's proxy; their secrets never reach the machine."
								: "Open to the internet. Connections don't work on it."
							: "Through Kantel's egress proxy"}
					</Field>
					<Field label="When idle">{idleText(environment.idleTimeoutMs)}</Field>
					<Field label="Start-up">{wakes ?? "Not started yet"}</Field>
					<Field label="Running time">{runningText(environment.runningMsThisMonth)}</Field>
					{environment.definition.template === undefined ? null : (
						<Field label="Template">
							<span className="font-mono text-code">
								{environment.definition.template}, version {environment.definition.version}
							</span>
						</Field>
					)}
				</FieldList>
			</Panel>

			<FormSection
				level={2}
				title={leases.length === 0 ? "Sessions on it now" : `Sessions on it now (${leases.length})`}
				description="Each session works in its own worktree with its own Compose project, so their services don't collide. A session lets go when it ends or stops running commands; the machine stops once none is left and it has been idle."
			>
				{leases.length === 0 ? (
					<EmptyState title="No sessions on it">
						{grants.length === 0
							? "A session attaches when it runs a command here."
							: "Sessions that may use it attach when they next run a command here."}
					</EmptyState>
				) : (
					<ul className={rows} aria-label="Sessions holding it">
						{leases.map((lease) => (
							<LeaseRow
								key={lease.id}
								lease={lease}
								projectId={environment.owner.projectId}
								directory={directory}
								links={links}
								now={now}
							/>
						))}
					</ul>
				)}
			</FormSection>

			<FormSection
				level={2}
				title="Sessions that may use it"
				description="A session gets it from its project's default, or from a person or a supervising session. The agent picks it by name for a command; it never sees the machine itself."
			>
				{grants.length === 0 ? (
					<EmptyState title="No grants">None of this project's sessions has been given it yet.</EmptyState>
				) : (
					<ul className={rows} aria-label="Grants">
						{grants.map((grant) => (
							<li key={grant.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
								<a
									href={links.session(grant.sessionId, environment.owner.projectId)}
									className="kt-focusable min-w-0 flex-1 truncate text-fg no-underline hover:underline"
								>
									{directory.session(grant.sessionId) ?? grant.sessionId}
								</a>
								<span className="flex-none text-xs text-faint">
									as <code className="font-mono">{grant.alias}</code>
									{grant.rights === "machine" ? ", may change the machine" : ""}
								</span>
							</li>
						))}
					</ul>
				)}
			</FormSection>

			<FormSection level={2} title="History" description="Starts, stops and sessions coming and going, newest first.">
				{detail.events.length === 0 ? (
					<EmptyState title="Nothing yet" />
				) : (
					<ul className={rows} aria-label="History">
						{detail.events.map((event) => (
							<li
								key={`${event.at}-${event.kind}-${event.sessionId ?? ""}`}
								className="flex min-w-0 items-baseline gap-3 px-3 py-2"
							>
								<span className="min-w-0 flex-1 wrap-anywhere">{eventText(event, directory)}</span>
								<span className="flex-none text-xs text-faint tabular-nums">
									<ClockTime at={event.at} now={now} />
								</span>
							</li>
						))}
					</ul>
				)}
			</FormSection>
		</div>
	);
}

function LeaseRow({
	lease,
	projectId,
	directory,
	links,
	now,
}: {
	lease: EnvironmentLease;
	projectId: string;
	directory: EnvironmentsDirectory;
	links: EnvironmentLinks;
	now: number;
}) {
	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-baseline gap-2 [&>.kt-status-dot]:translate-y-(--kt-on-cap)">
					<StatusDot status="done" label="Attached" />
					<a
						href={links.session(lease.sessionId, projectId)}
						className="kt-focusable min-w-0 truncate text-fg no-underline hover:underline"
					>
						{directory.session(lease.sessionId) ?? lease.sessionId}
					</a>
				</span>
				<p className={rowMeta}>
					<span className="font-mono">{lease.worktree}</span>
					<span>
						Compose project <code className="font-mono">{lease.composeProject}</code>
					</span>
					<span className="tabular-nums">
						Ports {lease.portBase}-{lease.portBase + 9}
					</span>
				</p>
			</div>
			<div className="flex flex-none flex-col items-end gap-0.5 text-xs text-faint tabular-nums">
				<span>{leaseSinceText(lease, now)}</span>
				<span>{commandCountText(lease.commands)}</span>
			</div>
		</li>
	);
}
