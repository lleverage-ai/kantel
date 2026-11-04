// A sandbox's page (compute console): everything about one sandbox and every way into it. The header has its name and
// state, Browser, Desktop and Stop, and ⋯ for Fork, Save snapshot, Auto-stop and Delete; under it its address, its
// environment and when it stops. Five tabs follow. Overview: live previews of its desktop and browser (which open in
// the console, full size), the SSH command in full, its ports, its CPU and memory, and its details. Logs: commands
// and what happened to it, in one timeline. Egress: its egress log. Snapshots: its own history. Files: what's in it
// now, or in its latest snapshot while it's stopped. On a phone the previews and Stop go (Stop is in ⋯) and the
// sections stack. Every call goes through the sources the host binds; stories bind them to fixtures.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumbs } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { compactAge } from "../primitives/format.ts";
import { ClockIcon, EyeIcon, GlobeIcon, StopIcon } from "../primitives/icons.tsx";
import { type Loaded, useLoad, useReloadOn } from "../primitives/load.ts";
import { DesktopIcon, EllipsisIcon, EnvironmentIcon, PlayIcon, ReconnectIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { PageTabs } from "../primitives/page-tabs.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	costText,
	type EgressSource,
	type HostingMode,
	SANDBOX_KIND_LABELS,
	SANDBOX_STATE_LABELS,
	SANDBOX_STATE_STATUS,
	type Sandbox,
	type SandboxAccess,
	type SandboxesSource,
	type SnapshotsSource,
	sandboxActions,
	sandboxMoving,
	sizeSpec,
	stopsInText,
} from "./compute-model.ts";
import { EgressPage } from "./egress-page.tsx";
import { computePage, messageOf, SectionHeading, Sparkline } from "./parts.tsx";
import { type SandboxNotice, useSandboxMenu } from "./sandbox-actions.tsx";
import { SandboxLogs } from "./sandbox-logs.tsx";
import { SandboxPorts } from "./sandbox-ports.tsx";
import { embedUrl, popOut, SandboxViewer, ScreenPreview, type ScreenView } from "./sandbox-screen.tsx";
import { showsCpu } from "./sandboxes-page.tsx";
import { SnapshotFiles } from "./snapshot-files.tsx";
import { agoText, SandboxHistory } from "./snapshots-page.tsx";

/** The page's tabs. */
export type SandboxTab = "overview" | "logs" | "egress" | "snapshots" | "files";

/** Where the page is: one of its tabs, or its desktop or browser full size. */
export type SandboxView = SandboxTab | ScreenView;

export const SANDBOX_VIEWS: readonly SandboxView[] = [
	"overview",
	"logs",
	"egress",
	"snapshots",
	"files",
	"desktop",
	"watch",
	"browser",
];

const isScreen = (view: SandboxView): view is ScreenView =>
	view === "desktop" || view === "watch" || view === "browser";

/**
 * The view the page shows for the one asked for. A screen goes to Overview where it opens in a tab of its own instead
 * (`inTab`) or has nothing to show (a known sandbox without one: stopped, or an isolate), as does a tab it hasn't.
 */
export function sandboxViewShown(
	asked: SandboxView,
	{ inTab, windows, known, tabs }: { inTab: boolean; windows: boolean; known: boolean; tabs: readonly SandboxTab[] },
): SandboxView {
	if (isScreen(asked)) return inTab || (!windows && known) ? "overview" : asked;
	return tabs.includes(asked) ? asked : "overview";
}

/** Access older than this is read again before a screen opens: its tokens last ten minutes. */
const ACCESS_FRESH_MS = 5 * 60_000;

export interface SandboxPageProps {
	readonly source: SandboxesSource;
	readonly snapshots: SnapshotsSource;
	/** Its egress log; without it there's no Egress tab. */
	readonly egress?: EgressSource;
	readonly hosting: HostingMode;
	readonly sandboxId: string;
	/** The account the console has selected: a sandbox of another one says so. */
	readonly accountId?: string;
	/** The view the address names; the page keeps its own when absent. */
	readonly view?: SandboxView;
	/** Where to start, when the page keeps its own view. */
	readonly initialView?: SandboxView;
	/** The address of each view of this sandbox. */
	readonly href: (view: SandboxView) => string;
	readonly sandboxesHref: string;
	/** An environment's page, from the sandbox's environment. */
	readonly environmentHref?: (environmentId: string) => string;
	/** Goes to a path in the app; without it the page changes view in place. */
	readonly navigate?: (path: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** How often the sandbox is read again while it starts or stops, in milliseconds. Default 1000. */
	readonly pollMs?: number;
	/** A phone. */
	readonly narrow?: boolean;
	/** Open ⋯ on mount, for a story. */
	readonly menuOpen?: boolean;
}

/** The state, in its colour. */
const StateLabel = ({ state }: { state: Sandbox["state"] }) => (
	<StatusLabel status={SANDBOX_STATE_STATUS[state]}>{SANDBOX_STATE_LABELS[state]}</StatusLabel>
);

type HeldAccess = { readonly value: SandboxAccess | "loading" | Error; readonly at: number };

const youngAccess = (held: HeldAccess | undefined): SandboxAccess | undefined =>
	held !== undefined &&
	held.value !== "loading" &&
	!(held.value instanceof Error) &&
	Date.now() - held.at <= ACCESS_FRESH_MS
		? held.value
		: undefined;

/**
 * Reads a sandbox's access while it can be reached, and again on asking. `fresh` answers access young enough for a
 * new connection (an SSH command to copy, a pop-out) without replacing what the screens on show use.
 */
function useAccess(source: SandboxesSource, sandboxId: string, reachable: boolean) {
	const [access, setAccess] = useState<HeldAccess>();
	const held = useRef<HeldAccess | undefined>(undefined);
	held.current = access;
	const spare = useRef<HeldAccess | undefined>(undefined);
	const generation = useRef(0);
	const read = useCallback(() => {
		generation.current += 1;
		const mine = generation.current;
		setAccess({ value: "loading", at: Date.now() });
		source.access(sandboxId).then(
			(value) => mine === generation.current && setAccess({ value, at: Date.now() }),
			(caught: unknown) =>
				mine === generation.current &&
				setAccess({ value: caught instanceof Error ? caught : new Error(String(caught)), at: Date.now() }),
		);
	}, [source, sandboxId]);
	useEffect(() => {
		if (reachable) read();
		else {
			generation.current += 1;
			setAccess(undefined);
		}
		return () => {
			generation.current += 1;
		};
	}, [reachable, read]);
	const fresh = useCallback(async (): Promise<SandboxAccess> => {
		const young = youngAccess(held.current) ?? youngAccess(spare.current);
		if (young !== undefined) return young;
		const value = await source.access(sandboxId);
		spare.current = { value, at: Date.now() };
		return value;
	}, [source, sandboxId]);
	// Old access, or none that worked, when a new screen or preview is about to open.
	const stale = () => access !== undefined && access.value !== "loading" && youngAccess(access) === undefined;
	return { access, read, fresh, stale };
}

export function SandboxPage({
	source,
	snapshots,
	egress,
	hosting,
	sandboxId,
	accountId,
	view: controlled,
	initialView = "overview",
	href,
	sandboxesHref,
	environmentHref,
	navigate,
	now: fixedNow,
	pollMs = 1000,
	narrow = false,
	menuOpen = false,
}: SandboxPageProps) {
	const { state, reload } = useLoad(() => source.get(sandboxId), [source, sandboxId]);
	const [own, setOwn] = useState<SandboxView>(initialView);
	const asked = controlled ?? own;
	// What this page changed, ahead of the next read.
	const [local, setLocal] = useState<Sandbox>();
	const [deleted, setDeleted] = useState(false);
	const [notice, setNotice] = useState<SandboxNotice>();
	const now = fixedNow ?? Date.now();

	const read = state.status === "ready" ? state.value : undefined;
	// Each read (a new `state`, even when the source answers with the same record) replaces what this page changed.
	useEffect(() => {
		if (state.status === "ready") setLocal(undefined);
	}, [state]);
	const sandbox = local ?? read;

	// Read again while it moves between states; while it runs, now and then for its CPU.
	const moving = sandbox !== undefined && sandboxMoving(sandbox.state);
	const running = sandbox?.state === "running";
	// biome-ignore lint/correctness/useExhaustiveDependencies: each read schedules the next.
	useEffect(() => {
		const wait = moving ? pollMs : running && fixedNow === undefined ? 30_000 : undefined;
		if (wait === undefined) return;
		const timer = setTimeout(reload, wait);
		return () => clearTimeout(timer);
	}, [moving, running, pollMs, fixedNow, reload, state]);

	const windows = running && sandbox?.kind === "microvm";
	const { access, read: readAccess, fresh: freshAccess, stale: accessStale } = useAccess(source, sandboxId, windows);

	const tabsShown: readonly SandboxTab[] = [
		"overview",
		"logs",
		...(egress === undefined ? [] : ["egress" as const]),
		"snapshots",
		"files",
	];
	// Browser and Desktop each in a tab of their own, where the page can't frame them (`kantel console`).
	const inTab = source.screens === "tab";
	const view = sandboxViewShown(asked, { inTab, windows, known: sandbox !== undefined, tabs: tabsShown });
	// A screen, or Overview's previews, mount new connections: old access is read again first.
	const opensScreens = (next: SandboxView) => isScreen(next) || next === "overview";
	const go = (next: SandboxView) => {
		if (inTab && isScreen(next)) {
			// The tab opens now and goes to the screen once fresh access is read.
			popOut(next, undefined, freshAccess);
			return;
		}
		if (opensScreens(next) && next !== view && accessStale()) readAccess();
		if (navigate === undefined) setOwn(next);
		else navigate(href(next));
	};
	// The same when the address changes the view (Back and Forward), not this page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a change of view opens new connections.
	useEffect(() => {
		if (opensScreens(view) && accessStale()) readAccess();
	}, [view]);

	// Whether its files and output can be read here, or only end to end; the gateway's console may ask its chain.
	const e2e = useLoad(
		async () => (source.endToEnd === undefined ? false : source.endToEnd(sandboxId)),
		[source, sandboxId],
	);

	const counts = useLoad(async () => {
		const [history, log] = await Promise.all([
			snapshots.history(sandboxId).catch(() => undefined),
			egress?.get(sandboxId).catch(() => undefined),
		]);
		return { snapshots: history?.length, egress: log?.entries.length };
	}, [snapshots, egress, sandboxId]);
	// A stop or a save adds a snapshot to count.
	useReloadOn(sandbox?.snapshot?.id, counts.reload);

	const menu = useSandboxMenu(sandbox, {
		source,
		save: snapshots.save,
		onChange: (box, id) => {
			if (id !== sandboxId) return;
			if (box === null) {
				setDeleted(true);
				navigate?.(sandboxesHref);
			} else setLocal(box);
		},
		onNotice: setNotice,
	});

	const act = (what: string, call: () => Promise<Sandbox>) => {
		if (sandbox === undefined) return;
		call().then(
			(box) => {
				setLocal(box);
				reload();
			},
			(caught: unknown) =>
				setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't ${what} ${sandbox.name}. Try again.`) }),
		);
	};

	const crumbs = (current: ReactNode) => (
		<Breadcrumbs
			label="Sandbox"
			parents={[{ key: "sandboxes", label: "Sandboxes", href: sandboxesHref }]}
			current={current}
		/>
	);

	if (deleted) {
		return (
			<div className={computePage}>
				{crumbs(<span>{sandbox?.name ?? sandboxId}</span>)}
				<EmptyState title="Deleted">{notice?.text}</EmptyState>
			</div>
		);
	}
	if (sandbox === undefined) {
		return (
			<div className={computePage}>
				{crumbs(<span>{sandboxId}</span>)}
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the sandbox.")}
					</Notice>
				) : (
					<Skeleton lines={4} />
				)}
			</div>
		);
	}
	if (accountId !== undefined && sandbox.accountId !== accountId) {
		return (
			<div className={computePage}>
				{crumbs(<span>{sandbox.name}</span>)}
				<Notice level="error">This sandbox belongs to another account. Switch to that account to open it.</Notice>
			</div>
		);
	}

	if (isScreen(view)) {
		return (
			<SandboxViewer
				name={sandbox.name}
				view={view}
				access={access?.value ?? "loading"}
				sandboxesHref={sandboxesHref}
				sandboxHref={href("overview")}
				viewHref={href}
				onView={go}
				onRetry={readAccess}
				freshAccess={freshAccess}
				narrow={narrow}
			/>
		);
	}

	const can = sandboxActions(sandbox.state);
	const stop = () => act("stop", () => source.stop(sandbox.id));
	const entries: readonly MenuEntry[] =
		narrow && can.stop
			? [
					{ kind: "item", id: "stop", label: "Stop", icon: <StopIcon size="sm" />, onSelect: stop },
					{ kind: "separator", id: "sep-stop" },
					...menu.entries,
				]
			: menu.entries;
	const screenLink = (to: ScreenView, label: string, icon: ReactNode) => {
		const link = (
			<a
				className={`${buttonClass("secondary", narrow ? "md" : "sm")} no-underline ${narrow ? "w-full" : ""}`}
				href={href(to)}
				onClick={(event) => {
					if (event.metaKey || event.ctrlKey || event.shiftKey) return;
					event.preventDefault();
					go(to);
				}}
			>
				{icon}
				<span className={buttonLabelClass}>{label}</span>
			</a>
		);
		// A button doesn't grow; on a phone its wrapper does, so the two share the row.
		return narrow ? <span className="flex min-w-0 flex-1">{link}</span> : link;
	};
	const actions = (
		<>
			{windows ? (
				<>
					{screenLink("browser", "Browser", <GlobeIcon size="sm" />)}
					{screenLink("desktop", "Desktop", <DesktopIcon size="sm" />)}
				</>
			) : null}
			{can.recover ? (
				<Button
					size={narrow ? "md" : "sm"}
					icon={<ReconnectIcon size="sm" />}
					onClick={() => act("recover", () => source.recover(sandbox.id))}
				>
					Recover
				</Button>
			) : null}
			{can.resume ? (
				<Button
					size={narrow ? "md" : "sm"}
					variant={can.recover ? "secondary" : "primary"}
					icon={<PlayIcon size="sm" />}
					onClick={() => act("resume", () => source.resume(sandbox.id))}
				>
					Resume
				</Button>
			) : null}
			{can.stop && !narrow ? (
				<Button size="sm" icon={<StopIcon size="sm" />} onClick={stop}>
					Stop
				</Button>
			) : null}
			<Menu
				label={`Actions for ${sandbox.name}`}
				icon={<EllipsisIcon />}
				entries={entries}
				align="end"
				size={narrow ? "sm" : "xs"}
				defaultOpen={menuOpen}
			/>
			{menu.dialogs}
		</>
	);
	const stops = stopsInText(sandbox, now);
	const tabCount = (tab: SandboxTab): number | undefined => {
		if (counts.state.status !== "ready") return undefined;
		const count =
			tab === "egress" ? counts.state.value.egress : tab === "snapshots" ? counts.state.value.snapshots : undefined;
		return count === 0 ? undefined : count;
	};
	const labels: Readonly<Record<SandboxTab, string>> = {
		overview: "Overview",
		logs: "Logs",
		egress: "Egress",
		snapshots: "Snapshots",
		files: "Files",
	};

	return (
		<div className={computePage}>
			{crumbs(<span>{sandbox.name}</span>)}
			<header className="kt-sandbox-header flex min-w-0 flex-col gap-3">
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-3">
					<h1 className={`m-0 min-w-0 truncate font-strong leading-tight text-fg text-lg`}>{sandbox.name}</h1>
					<StateLabel state={sandbox.state} />
					<div className={`flex items-center gap-2 ${narrow ? "w-full" : "ml-auto"}`}>{actions}</div>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
					{sandbox.hostname === "" ? null : (
						<span className="min-w-0 truncate font-mono text-code">{sandbox.hostname}</span>
					)}
					{sandbox.environment === undefined ? null : (
						<span className="inline-flex items-center gap-1.5">
							<EnvironmentIcon size="sm" />
							{environmentHref === undefined ? (
								sandbox.environment.name
							) : (
								<a
									className="text-fg underline decoration-border-strong underline-offset-2"
									href={environmentHref(sandbox.environment.id)}
								>
									{sandbox.environment.name}
								</a>
							)}
						</span>
					)}
					{stops === "–" ? null : (
						<span className="inline-flex items-center gap-1.5">
							<ClockIcon size="sm" />
							{/^\d/.test(stops) ? `Stops in ${stops}` : stops === "Now" ? "Stopping now" : stops}
						</span>
					)}
				</div>
			</header>
			{sandbox.state === "error" && sandbox.error !== undefined ? <Notice level="error">{sandbox.error}</Notice> : null}
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
			<PageTabs
				label={sandbox.name}
				tabs={tabsShown.map((tab) => {
					const count = tabCount(tab);
					return {
						id: tab,
						label: labels[tab],
						href: href(tab),
						selected: tab === view,
						...(count === undefined ? {} : { count }),
					};
				})}
				onSelect={(id) => go(id as SandboxView)}
			/>
			{view === "overview" ? (
				<Overview
					source={source}
					sandbox={sandbox}
					hosting={hosting}
					now={now}
					narrow={narrow}
					windows={windows}
					access={access?.value}
					freshAccess={freshAccess}
					onAccessRetry={readAccess}
					onOpen={go}
					screenHref={href}
					onNotice={setNotice}
					usageKey={state}
				/>
			) : view === "logs" ? (
				<SandboxLogs
					source={source}
					snapshots={snapshots}
					sandbox={sandbox}
					now={now}
					narrow={narrow}
					endToEnd={e2e.state.status === "ready" && e2e.state.value}
				/>
			) : view === "egress" && egress !== undefined ? (
				<EgressPage
					source={egress}
					sandboxId={sandbox.id}
					sandboxesHref={sandboxesHref}
					{...(accountId === undefined ? {} : { accountId })}
					embedded
				/>
			) : view === "snapshots" ? (
				<SnapshotsTab source={snapshots} sandbox={sandbox} now={now} onNotice={setNotice} />
			) : (
				<FilesTab
					source={source}
					snapshots={snapshots}
					sandbox={sandbox}
					now={now}
					endToEnd={e2e.state}
					onRecheck={e2e.reload}
				/>
			)}
		</div>
	);
}

const dt = "text-muted";
const dd = "m-0 min-w-0 text-fg";

function Overview({
	source,
	sandbox,
	hosting,
	now,
	narrow,
	windows,
	access,
	freshAccess,
	onAccessRetry,
	onOpen,
	screenHref,
	onNotice,
	usageKey,
}: {
	source: SandboxesSource;
	sandbox: Sandbox;
	hosting: HostingMode;
	now: number;
	narrow: boolean;
	windows: boolean;
	access: SandboxAccess | "loading" | Error | undefined;
	/** Access young enough for a new connection: the SSH command copied. */
	freshAccess: () => Promise<SandboxAccess>;
	onAccessRetry: () => void;
	onOpen: (view: ScreenView) => void;
	screenHref: (view: ScreenView) => string;
	onNotice: (notice: SandboxNotice | undefined) => void;
	/** Changes with each read of the sandbox, so memory and disk are read again with its CPU. */
	usageKey: unknown;
}) {
	const ready = access !== undefined && access !== "loading" && !(access instanceof Error) ? access : undefined;
	// Where the page can't frame a screen, its tile is the drawing and opens the screen in a tab.
	const framed = ready !== undefined && source.screens !== "tab" ? ready : undefined;
	const spec = sandbox.resources ?? sizeSpec(sandbox.size);
	const { ports, exposePort, hidePort } = source;
	const portsShown = ports !== undefined && exposePort !== undefined && hidePort !== undefined;

	const tile = (kind: "desktop" | "browser") => (
		<div className="kt-sandbox-tile flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel">
			<a
				className="kt-focusable block"
				href={screenHref(kind)}
				aria-label={kind === "desktop" ? "Open the desktop" : "Open the browser"}
				onClick={(event) => {
					if (event.metaKey || event.ctrlKey || event.shiftKey) return;
					event.preventDefault();
					onOpen(kind);
				}}
			>
				<ScreenPreview
					kind={kind}
					label={kind === "desktop" ? `${sandbox.name}'s desktop` : `${sandbox.name}'s browser`}
					{...(framed === undefined
						? {}
						: (() => {
								const url = embedUrl(framed, kind === "desktop" ? "watch" : "browser");
								return url === undefined ? {} : { url };
							})())}
				/>
			</a>
			<div className="flex h-control-lg items-center gap-2 border-t border-border px-3">
				<span className="font-medium text-fg">{kind === "desktop" ? "Desktop" : "Browser"}</span>
				<span className="flex-1" />
				{kind === "desktop" ? (
					<a
						className={`${buttonClass("ghost", "xs")} no-underline`}
						href={screenHref("watch")}
						onClick={(event) => {
							if (event.metaKey || event.ctrlKey || event.shiftKey) return;
							event.preventDefault();
							onOpen("watch");
						}}
					>
						<EyeIcon size="sm" />
						<span className={buttonLabelClass}>Watch</span>
					</a>
				) : null}
			</div>
		</div>
	);

	const ssh = !windows ? null : (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="sandbox-ssh">
			<SectionHeading id="sandbox-ssh" title="SSH" />
			{access instanceof Error ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={onAccessRetry}>
							Try again
						</Button>
					}
				>
					{messageOf(access, "Kantel couldn't reach the sandbox.")}
				</Notice>
			) : (
				<div className="flex min-h-control-lg min-w-0 items-center gap-2 rounded-panel border border-border bg-sunken py-1 pr-1 pl-3 font-mono text-code">
					<span className="flex-none text-faint" aria-hidden="true">
						$
					</span>
					{ready === undefined ? (
						<span className="flex-1">
							<Skeleton />
						</span>
					) : (
						<code className="kt-selectable min-w-0 flex-1 truncate text-fg" title={ready.ssh}>
							{ready.ssh}
						</code>
					)}
					{ready === undefined ? null : (
						<CopyButton text={async () => (await freshAccess()).ssh} size="sm" variant="ghost" />
					)}
				</div>
			)}
		</section>
	);

	const usage = showsCpu(sandbox) ? <Usage source={source} sandbox={sandbox} refreshKey={usageKey} /> : null;

	const created = compactAge(sandbox.createdAt, now);
	const details = (
		<section className="flex min-w-0 flex-col gap-3" aria-labelledby="sandbox-details">
			<SectionHeading id="sandbox-details" title="Details" />
			<dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
				<dt className={dt}>ID</dt>
				<dd className={`${dd} flex items-center gap-1`}>
					<span className="truncate font-mono text-code">{sandbox.id}</span>
					<CopyButton text={sandbox.id} iconOnly size="xs" variant="ghost" label="Copy ID" />
				</dd>
				<dt className={dt}>Type</dt>
				<dd className={dd}>{SANDBOX_KIND_LABELS[sandbox.kind]}</dd>
				<dt className={dt}>Size</dt>
				<dd className={dd}>
					{spec.vcpus} vCPU, {spec.memoryGb} GB, {spec.diskGb} GB disk
				</dd>
				{sandbox.snapshot === undefined ? null : (
					<>
						<dt className={dt}>Snapshot</dt>
						<dd className={dd}>{agoText(sandbox.snapshot.takenAt, now)}</dd>
					</>
				)}
				<dt className={dt}>Created</dt>
				<dd className={dd}>
					{created === "now" ? "Just now" : `${created} ago`}
					{sandbox.createdBy === "" ? "" : ` by ${sandbox.createdBy}`}
				</dd>
				{hosting === "hosted" && sandbox.costCents !== undefined ? (
					<>
						<dt className={dt}>Cost</dt>
						<dd className={dd}>{costText(sandbox.costCents)} this period</dd>
					</>
				) : null}
				{sandbox.hostId === undefined ? null : (
					<>
						<dt className={dt}>Host</dt>
						<dd className={`${dd} truncate font-mono text-code`}>{sandbox.hostId}</dd>
					</>
				)}
			</dl>
		</section>
	);

	const portsSection =
		// A port's URL reaches a running microVM only.
		portsShown && windows ? (
			<SandboxPorts source={{ ports, exposePort, hidePort }} sandboxId={sandbox.id} onNotice={onNotice} />
		) : null;

	// Why there's no way in, when there isn't one.
	const hint =
		sandbox.kind === "isolate"
			? "An isolate has no desktop, browser or SSH."
			: sandboxActions(sandbox.state).resume
				? "Resume it to use its desktop, browser and SSH."
				: undefined;

	if (narrow) {
		return (
			<div className="flex min-w-0 flex-col gap-8">
				{windows || hint === undefined ? null : <p className="m-0 text-sm text-muted">{hint}</p>}
				{ssh}
				{portsSection}
				{usage}
				{details}
			</div>
		);
	}
	return (
		<div className="grid min-w-0 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_var(--kt-popover-width)]">
			<div className="flex min-w-0 flex-col gap-8">
				{windows ? (
					<div className="grid grid-cols-2 gap-4">
						{tile("desktop")}
						{tile("browser")}
					</div>
				) : null}
				{ssh}
				{portsSection}
				{hint === undefined ? null : <p className="m-0 text-sm text-muted">{hint}</p>}
			</div>
			<aside className="flex min-w-0 flex-col gap-8">
				{usage}
				{details}
			</aside>
		</div>
	);
}

/**
 * Its recent CPU, larger than a row's, and memory and disk where the host says. The samples carry no times, and the
 * host takes one on each usage read, so the line claims no fixed window.
 */
function Usage({ source, sandbox, refreshKey }: { source: SandboxesSource; sandbox: Sandbox; refreshKey: unknown }) {
	const { usageNow } = source;
	const { state, reload } = useLoad(
		() => (usageNow === undefined ? Promise.resolve(undefined) : usageNow(sandbox.id)),
		[usageNow, sandbox.id],
	);
	// Each read of the sandbox brings new CPU samples: memory and disk follow, keeping the last while they're read.
	useReloadOn(refreshKey, reload);
	const spec = sandbox.resources ?? sizeSpec(sandbox.size);
	const latest = Math.round((sandbox.usage.at(-1) ?? 0) * 100);
	const peak = Math.round(Math.max(0, ...sandbox.usage) * 100);
	const now = state.status === "ready" ? state.value : undefined;
	const meter = (label: string, used: number, total: number) => (
		<div className="flex flex-col gap-1.5">
			<div className="flex justify-between gap-3">
				<span className="text-muted">{label}</span>
				<span className="tabular-nums">
					{used} of {total} GB
				</span>
			</div>
			<span className="block h-1 overflow-hidden rounded-full bg-active" aria-hidden="true">
				<span
					className="block h-full rounded-full bg-muted"
					style={{ width: `${Math.min(100, Math.round((used / Math.max(total, 1)) * 100))}%` }}
				/>
			</span>
		</div>
	);
	return (
		<section className="flex min-w-0 flex-col gap-3" aria-labelledby="sandbox-usage">
			<SectionHeading id="sandbox-usage" title="Usage" actions={<span className="text-xs text-muted">Recent</span>} />
			<div className="flex flex-col gap-4 text-sm">
				<div className="flex flex-col gap-1.5">
					<div className="flex justify-between gap-3">
						<span className="text-muted">CPU</span>
						<span className="tabular-nums">{latest}%</span>
					</div>
					<Sparkline
						size="lg"
						values={sandbox.usage}
						tone={sandbox.state === "error" ? "error" : "done"}
						label={`Recent CPU, peak ${peak}%`}
					/>
				</div>
				{now?.memoryGb === undefined ? null : meter("Memory", now.memoryGb, spec.memoryGb)}
				{now?.diskGb === undefined ? null : meter("Disk", now.diskGb, spec.diskGb)}
			</div>
		</section>
	);
}

/** Its own history, and the files in one of its snapshots in place. */
function SnapshotsTab({
	source,
	sandbox,
	now,
	onNotice,
}: {
	source: SnapshotsSource;
	sandbox: Sandbox;
	now: number;
	onNotice: (notice: SandboxNotice | undefined) => void;
}) {
	const [browsing, setBrowsing] = useState<{ snapshotId: string; label: string; path: string }>();
	if (browsing !== undefined) {
		return (
			<div className="flex min-w-0 flex-col gap-4">
				<SnapshotFiles
					key={browsing.snapshotId}
					source={source}
					snapshotId={browsing.snapshotId}
					path={browsing.path}
					now={now}
					backLabel="Back to snapshots"
					onBack={() => setBrowsing(undefined)}
					onOpenFolder={(path) => setBrowsing({ ...browsing, path })}
				/>
			</div>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<SandboxHistory
				source={source}
				sandbox={sandbox}
				now={now}
				onBrowse={(snap) => setBrowsing({ snapshotId: snap.id, label: agoText(snap.takenAt, now), path: "" })}
				onNotice={onNotice}
			/>
		</div>
	);
}

/**
 * What the Files tab shows: what's in it now while it runs, or one line where its files can't be read end to end yet;
 * its latest snapshot's files while it's stopped, or nothing before it has one.
 */
export function filesShown(
	sandbox: Pick<Sandbox, "state" | "snapshot">,
	source: Pick<SandboxesSource, "files">,
	endToEnd: Loaded<boolean>,
): "live" | "checking" | "unchecked" | "end-to-end" | "snapshot" | "none" {
	if (sandbox.state === "running" && source.files !== undefined) {
		// Nothing is read until it's known whether the gateway may read them.
		if (endToEnd.status === "loading") return "checking";
		if (endToEnd.status === "error") return "unchecked";
		return endToEnd.value ? "end-to-end" : "live";
	}
	return sandbox.snapshot === undefined ? "none" : "snapshot";
}

/** What's in it now, while it runs; its latest snapshot's files while it's stopped. */
function FilesTab({
	source,
	snapshots,
	sandbox,
	now,
	endToEnd,
	onRecheck,
}: {
	source: SandboxesSource;
	snapshots: SnapshotsSource;
	sandbox: Sandbox;
	now: number;
	endToEnd: Loaded<boolean>;
	onRecheck: () => void;
}) {
	const [path, setPath] = useState("");
	const shown = filesShown(sandbox, source, endToEnd);
	const files = source.files;
	if (shown === "checking") return <Skeleton lines={4} />;
	if (shown === "unchecked" && endToEnd.status === "error") {
		return (
			<Notice
				level="error"
				action={
					<Button size="sm" onClick={onRecheck}>
						Try again
					</Button>
				}
			>
				{messageOf(endToEnd.error, "Kantel couldn't check how to read its files.")}
			</Notice>
		);
	}
	if (shown === "end-to-end") return <p className="m-0 text-sm text-muted">Files aren't available end to end yet.</p>;
	if (shown === "live" && files !== undefined) {
		return (
			<div className="flex min-w-0 flex-col gap-4">
				<SnapshotFiles
					source={{ list: files.list, read: files.read, downloadUrl: () => undefined }}
					snapshotId={sandbox.id}
					path={path}
					now={now}
					onOpenFolder={setPath}
				/>
			</div>
		);
	}
	if (sandbox.snapshot === undefined) {
		return <EmptyState title="No files to show yet">Its files show here once it's running.</EmptyState>;
	}
	return (
		<div className="flex min-w-0 flex-col gap-4">
			<p className="m-0 text-sm text-muted">From its snapshot {agoText(sandbox.snapshot.takenAt, now)}.</p>
			<SnapshotFiles source={snapshots} snapshotId={sandbox.snapshot.id} path={path} now={now} onOpenFolder={setPath} />
		</div>
	);
}
