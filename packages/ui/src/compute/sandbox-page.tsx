// A sandbox's page (compute console): everything about one sandbox and every way into it. The header has its name and
// state, Browser, Desktop and Stop, and ⋯ for Fork, Save snapshot, Auto-stop and Delete; under it its address, its
// environment and when it stops. Five tabs follow. Overview: live previews of its desktop and browser (which open in
// the console, full size), SSH (sandbox-ssh.tsx), its ports, its CPU and memory, its details and its read-only
// mounts, where it has any. Logs: commands and what happened to it, in one timeline. Egress: its egress log.
// Snapshots: its own history. Files: what's in it now, or in its latest snapshot while it's stopped. On a phone the
// previews and Stop go (Stop is in ⋯) and the sections stack. Every call goes through the sources the host binds;
// stories bind them to fixtures.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumbs } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { compactAge } from "../primitives/format.ts";
import { CheckIcon, ClockIcon, EyeIcon, GlobeIcon, MinusCircleIcon, StopIcon } from "../primitives/icons.tsx";
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
	imageLacks,
	SANDBOX_KIND_LABELS,
	SANDBOX_STATE_LABELS,
	SANDBOX_STATE_STATUS,
	type Sandbox,
	type SandboxAccess,
	type SandboxesSource,
	type SandboxFeature,
	type SandboxImage,
	type SnapshotsSource,
	sandboxActions,
	sandboxMoving,
	screenUnavailable,
	sizeSpec,
	sizeText,
	stopsInText,
} from "./compute-model.ts";
import { EgressPage } from "./egress-page.tsx";
import { gbBytes, gbText, lineOf, seriesOf, USAGE_KEEP_MS, useLiveUsage } from "./live-usage.ts";
import { computePage, messageOf, SectionHeading, UsageGraph } from "./parts.tsx";
import { type SandboxNotice, useSandboxMenu } from "./sandbox-actions.tsx";
import { SandboxLogs } from "./sandbox-logs.tsx";
import { SandboxMounts } from "./sandbox-mounts.tsx";
import { SandboxPorts } from "./sandbox-ports.tsx";
import { embedUrl, popOut, SandboxViewer, ScreenPreview, type ScreenView } from "./sandbox-screen.tsx";
import { SandboxSsh } from "./sandbox-ssh.tsx";
import { showsCpu } from "./sandboxes-page.tsx";
import { type FilesAt, filesRoot, SnapshotFiles } from "./snapshot-files.tsx";
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
	/** Where the Files tab is, as the address names it: its folder and open file. The page keeps its own when absent. */
	readonly filesAt?: FilesAt;
	/** The address of the Files tab at a folder and file; with `navigate`, the tab moves through the address. */
	readonly filesHref?: (at: FilesAt, sealed: boolean) => string;
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
	filesAt,
	filesHref,
}: SandboxPageProps) {
	const { state, reload } = useLoad(() => source.get(sandboxId), [source, sandboxId]);
	const [own, setOwn] = useState<SandboxView>(initialView);
	const [ownFiles, setOwnFiles] = useState<FilesAt>(filesAt ?? {});
	const routed = navigate !== undefined && filesHref !== undefined;
	const files = routed ? (filesAt ?? {}) : ownFiles;
	const goFiles = (at: FilesAt) => {
		if (routed) navigate(filesHref(at, sealed));
		else setOwnFiles(at);
	};
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
	// A screen its image lacks (no desktop in it, say) is never opened: its address shows Overview, which says so.
	const lacked =
		sandbox !== undefined && isScreen(asked)
			? imageLacks(sandbox, asked === "browser" ? "browser" : "desktop") !== undefined
			: false;
	const view = lacked
		? "overview"
		: sandboxViewShown(asked, { inTab, windows, known: sandbox !== undefined, tabs: tabsShown });
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
	// Its file browser's place goes in the address's fragment unless it's known not to be end to end: a fragment never
	// reaches the gateway, so neither do the names of the files it reads over its own session.
	const sealed = !(e2e.state.status === "ready" && !e2e.state.value);

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
	const held = access?.value;
	const readyAccess = held !== undefined && held !== "loading" && !(held instanceof Error) ? held : undefined;
	const screenLink = (to: ScreenView, label: string, icon: ReactNode) => {
		// One its image lacks isn't offered at all: Overview's Image section says what's missing.
		if (imageLacks(sandbox, to === "browser" ? "browser" : "desktop") !== undefined) return null;
		// One that can't open here is shown disabled with its reason, never opened onto an error page.
		const unavailable = readyAccess === undefined ? undefined : screenUnavailable(readyAccess, to);
		const link =
			unavailable !== undefined ? (
				<Button
					size={narrow ? "md" : "sm"}
					icon={icon}
					disabled
					title={unavailable}
					className={narrow ? "w-full" : undefined}
				>
					{label}
				</Button>
			) : (
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
					at={files}
					onNavigate={goFiles}
					{...(filesHref === undefined ? {} : { href: (at: FilesAt) => filesHref(at, sealed) })}
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

	const lacks = { desktop: imageLacks(sandbox, "desktop"), browser: imageLacks(sandbox, "browser") };
	const tiles = (["desktop", "browser"] as const).filter(
		(kind) => lacks[kind] === undefined || lacks.desktop === undefined || lacks.browser === undefined,
	);
	const tile = (kind: "desktop" | "browser") => {
		// What the image lacks first: no access makes a desktop the image doesn't have.
		const unavailable = lacks[kind] ?? (ready === undefined ? undefined : screenUnavailable(ready, kind));
		if (unavailable !== undefined) {
			// Nothing to open: the drawing, dimmed, and why under it.
			return (
				<div className="kt-sandbox-tile flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel">
					<div className="opacity-50">
						<ScreenPreview kind={kind} label={kind === "desktop" ? "Desktop" : "Browser"} />
					</div>
					<div className="flex h-control-lg items-center gap-2 border-t border-border px-3">
						<span className="font-medium text-fg">{kind === "desktop" ? "Desktop" : "Browser"}</span>
						<span className="flex-1" />
						<span className="truncate text-muted text-sm">{unavailable}</span>
					</div>
				</div>
			);
		}
		return (
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
	};

	const ssh = !windows ? null : (
		<SandboxSsh source={source} sandboxId={sandbox.id} access={access} onAccessRetry={onAccessRetry} now={now} />
	);

	const usage = showsCpu(sandbox) ? <Usage source={source} sandbox={sandbox} refreshKey={usageKey} /> : null;
	const image = sandbox.image === undefined ? null : <ImageSection image={sandbox.image} />;

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
					{sizeText(spec)}
					{spec.diskGb > 0 ? `, ${spec.diskGb} GB disk` : ""}
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

	// Its read-only mounts (experimental), only where it has any.
	const mounts =
		sandbox.mounts === undefined || sandbox.mounts.length === 0 ? null : <SandboxMounts mounts={sandbox.mounts} />;

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
				? tiles.length === 0
					? "Resume it to use SSH."
					: "Resume it to use its desktop, browser and SSH."
				: undefined;

	if (narrow) {
		return (
			<div className="flex min-w-0 flex-col gap-8">
				{windows || hint === undefined ? null : <p className="m-0 text-sm text-muted">{hint}</p>}
				{ssh}
				{portsSection}
				{usage}
				{image}
				{details}
				{mounts}
			</div>
		);
	}
	return (
		<div className="grid min-w-0 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_var(--kt-popover-width)]">
			<div className="flex min-w-0 flex-col gap-8">
				{windows && tiles.length > 0 ? <div className="grid grid-cols-2 gap-4">{tiles.map(tile)}</div> : null}
				{windows && tiles.length === 0 ? <NoScreens /> : null}
				{ssh}
				{portsSection}
				{hint === undefined ? null : <p className="m-0 text-sm text-muted">{hint}</p>}
			</div>
			<aside className="flex min-w-0 flex-col gap-8">
				{usage}
				{image}
				{details}
				{mounts}
			</aside>
		</div>
	);
}

/** Where the previews would be, for an image with neither a desktop nor a browser: said once, plainly. */
function NoScreens() {
	return (
		<div className="flex min-w-0 items-start gap-3 rounded-panel border border-border border-dashed px-4 py-3 text-sm">
			<span className="mt-0.5 flex-none text-faint" aria-hidden="true">
				<DesktopIcon size="sm" />
			</span>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-fg">No desktop or browser in this image</span>
				<span className="text-muted">Commands, files, ports and SSH work as in any sandbox.</span>
			</span>
		</div>
	);
}

/** One feature's row: a check and what was found, or a dash and why it's missing. */
function FeatureRow({ label, feature }: { label: string; feature: SandboxFeature }) {
	return (
		<li className="flex min-w-0 items-start gap-2">
			<span className={`mt-0.5 flex-none ${feature.available ? "text-success" : "text-faint"}`} aria-hidden="true">
				{feature.available ? <CheckIcon size="sm" /> : <MinusCircleIcon size="sm" />}
			</span>
			<span className="flex min-w-0 flex-col">
				<span className={feature.available ? "text-fg" : "text-muted"}>
					{label}
					<span className="kt-sr-only">{feature.available ? ": yes" : ": no"}</span>
				</span>
				{feature.available ? (
					feature.detail === undefined ? null : (
						<span className="truncate text-muted text-xs" title={feature.detail}>
							{feature.detail}
						</span>
					)
				) : (
					<span className="text-muted text-xs">{feature.reason}</span>
				)}
			</span>
		</li>
	);
}

const LIBC_LABELS: Readonly<Record<SandboxImage["libc"], string>> = {
	glibc: "glibc",
	musl: "musl",
	none: "None (static)",
};

/**
 * What its image has, as its guest agent found it: the OS, and the desktop, browser, Docker and nested virtualisation,
 * each there or plainly missing, so nothing the image lacks is offered as a button that fails.
 */
export function ImageSection({ image }: { image: SandboxImage }) {
	const kvm: SandboxFeature = image.kvm
		? { available: true, detail: "/dev/kvm" }
		: { available: false, reason: "Not on this host" };
	return (
		<section className="flex min-w-0 flex-col gap-3" aria-labelledby="sandbox-image">
			<SectionHeading id="sandbox-image" title="Image" />
			<dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
				<dt className={dt}>OS</dt>
				<dd className={`${dd} truncate`} title={image.os}>
					{image.os}
				</dd>
				<dt className={dt}>Architecture</dt>
				<dd className={`${dd} font-mono text-code`}>{image.arch}</dd>
				<dt className={dt}>C library</dt>
				<dd className={dd}>{LIBC_LABELS[image.libc]}</dd>
				<dt className={dt}>Agent</dt>
				<dd className={dd}>
					{image.injected ? "Added by Kantel" : "In the image"}
					<span className="text-muted">, {image.agentVersion}</span>
				</dd>
			</dl>
			<ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm" aria-label="What the image has">
				<FeatureRow label="Desktop" feature={image.desktop} />
				<FeatureRow label="Browser" feature={image.browser} />
				<FeatureRow label="Docker" feature={image.docker} />
				<FeatureRow label="Nested virtualisation" feature={kvm} />
			</ul>
		</section>
	);
}

/**
 * Its CPU and its memory against its limit as live graphs over the last 10 minutes, read again every few seconds while
 * the page is visible, and its disk where the host says. Without a live source, the CPU line is its recent CPU as
 * listed and memory is a meter, as the host last said.
 */
function Usage({ source, sandbox, refreshKey }: { source: SandboxesSource; sandbox: Sandbox; refreshKey: unknown }) {
	const { usageNow } = source;
	const { state, reload } = useLoad(
		() => (usageNow === undefined ? Promise.resolve(undefined) : usageNow(sandbox.id)),
		[usageNow, sandbox.id],
	);
	// Each read of the sandbox: disk follows, keeping the last while it's read.
	useReloadOn(refreshKey, reload);
	const live = useLiveUsage(sandbox.state === "error" ? undefined : source.usageSeries, sandbox.id);
	const series = seriesOf(live);
	const loading = live.status === "loading";
	const spec = sandbox.resources ?? sizeSpec(sandbox.size);
	const liveCpu = lineOf(series, (point) => point.cpu, USAGE_KEEP_MS);
	const liveMemory = lineOf(series, (point) => point.memUsedBytes, USAGE_KEEP_MS);
	// Without a live source, its recent CPU as listed, untimed.
	const cpu = series !== undefined ? liveCpu.values : live.status === "off" ? sandbox.usage : [];
	const memory = liveMemory.values;
	const limit = series?.memLimitBytes ?? gbBytes(spec.memoryGb);
	const latestCpu = cpu.at(-1);
	const latestMemory = memory.at(-1);
	const peak = Math.round(Math.max(0, ...cpu) * 100);
	const span = series === undefined ? "lately" : "over the last 10 minutes";
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
			<SectionHeading
				id="sandbox-usage"
				title="Usage"
				actions={<span className="text-xs text-muted">{live.status === "off" ? "Recent" : "Last 10 minutes"}</span>}
			/>
			<div className="flex flex-col gap-4 text-sm">
				<UsageGraph
					title="CPU"
					{...(latestCpu === undefined ? {} : { value: `${Math.round(latestCpu * 100)}%` })}
					values={cpu}
					{...(series === undefined ? { slots: cpu.length } : { timed: liveCpu.timed })}
					tone={sandbox.state === "error" ? "error" : "done"}
					loading={loading}
					label={cpu.length === 0 ? "No CPU readings yet" : `CPU ${span}, peak ${peak}%`}
				/>
				{live.status === "off" ? (
					now?.memoryGb === undefined ? null : (
						meter("Memory", now.memoryGb, spec.memoryGb)
					)
				) : (
					<UsageGraph
						title="Memory"
						{...(latestMemory === undefined ? {} : { value: `${gbText(latestMemory)} of ${gbText(limit)} GB` })}
						values={memory}
						max={limit}
						timed={liveMemory.timed}
						tone="working"
						loading={loading}
						label={
							latestMemory === undefined
								? "No memory readings yet"
								: `Memory over the last 10 minutes, ${gbText(latestMemory)} of ${gbText(limit)} GB now`
						}
					/>
				)}
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
	const [browsing, setBrowsing] = useState<{ snapshotId: string; at: FilesAt }>();
	if (browsing !== undefined) {
		return (
			<div className="flex min-w-0 flex-col gap-4">
				<SnapshotFiles
					key={browsing.snapshotId}
					source={source}
					snapshotId={browsing.snapshotId}
					root={filesRoot(sandbox.kind)}
					at={browsing.at}
					now={now}
					backLabel="Back to snapshots"
					onBack={() => setBrowsing(undefined)}
					onNavigate={(at) => setBrowsing({ ...browsing, at })}
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
				onBrowse={(snap) => setBrowsing({ snapshotId: snap.id, at: {} })}
				onNotice={onNotice}
			/>
		</div>
	);
}

/**
 * What the Files tab shows: what's in it now while it runs, read from its host (over an E2E session where its space
 * has one: the source decides); its latest snapshot's files while it's stopped, or nothing before it has one. An
 * end-to-end sandbox's snapshots can't be read here (the host serves their contents to no one): one line says so, and
 * no snapshot is read until it's known whether it is one.
 */
export function filesShown(
	sandbox: Pick<Sandbox, "state" | "snapshot">,
	source: Pick<SandboxesSource, "files">,
	endToEnd: Loaded<boolean>,
): "live" | "checking" | "unchecked" | "sealed" | "snapshot" | "none" {
	if (sandbox.state === "running" && source.files !== undefined) return "live";
	if (sandbox.snapshot === undefined) return "none";
	if (endToEnd.status === "loading") return "checking";
	if (endToEnd.status === "error") return "unchecked";
	return endToEnd.value ? "sealed" : "snapshot";
}

/** What's in it now, while it runs; its latest snapshot's files while it's stopped. */
function FilesTab({
	source,
	snapshots,
	sandbox,
	now,
	endToEnd,
	onRecheck,
	at,
	onNavigate,
	href,
}: {
	source: SandboxesSource;
	snapshots: SnapshotsSource;
	sandbox: Sandbox;
	now: number;
	endToEnd: Loaded<boolean>;
	onRecheck: () => void;
	at: FilesAt;
	onNavigate: (at: FilesAt) => void;
	href?: (at: FilesAt) => string;
}) {
	const shown = filesShown(sandbox, source, endToEnd);
	const files = source.files;
	// An isolate's files are its /workspace only; a microVM's open at /home/user and go up to /.
	const browse = { at, now, onNavigate, root: filesRoot(sandbox.kind), ...(href === undefined ? {} : { href }) };
	if (shown === "checking") return <Skeleton width="40%" />;
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
	if (shown === "sealed") {
		return <p className="m-0 text-sm text-muted">End-to-end encrypted: start it to see its files.</p>;
	}
	if (shown === "live" && files !== undefined) {
		return (
			<div className="flex min-w-0 flex-col gap-3">
				<SnapshotFiles source={files} snapshotId={sandbox.id} {...browse} />
			</div>
		);
	}
	if (sandbox.snapshot === undefined) {
		return <p className="m-0 text-sm text-muted">No files yet: they show here once it's running.</p>;
	}
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<p className="m-0 text-sm text-muted">From its snapshot {agoText(sandbox.snapshot.takenAt, now)}.</p>
			<SnapshotFiles source={snapshots} snapshotId={sandbox.snapshot.id} {...browse} />
		</div>
	);
}
