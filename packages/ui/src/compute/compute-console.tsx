import type { ThemePreference } from "@kantel/contracts";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { KantelLockup, KantelMark } from "../brand/kantel.tsx";
import { Button } from "../primitives/button.tsx";
import { AlertIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import {
	BackIcon,
	EnvironmentIcon,
	ProxyIcon,
	SandboxIcon,
	ServerIcon,
	SettingsIcon,
	SnapshotIcon,
} from "../primitives/lucide.tsx";
import { Sidebar, SidebarBrand, SidebarItem, SidebarSection } from "../primitives/sidebar.tsx";
import { Skeleton, skeletonClass } from "../primitives/spinner.tsx";
import { TabBar } from "../primitives/tab-bar.tsx";
import { AccountEgressPage, EGRESS_TABS, type EgressTab } from "./account-egress-page.tsx";
import { AccountSwitcher, CreateOrganisationDialog, JoinOrganisationDialog } from "./account-switcher.tsx";
import { ComputeApiKeysPage } from "./api-keys-page.tsx";
import { BillingPage } from "./billing-page.tsx";
import { BrowserDeviceDialog } from "./browser-device.tsx";
import type {
	BrowserStanding,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	E2EMode,
	E2ESource,
	HostsSource,
	SandboxKind,
} from "./compute-model.ts";
import { DeviceLoginPage } from "./device-page.tsx";
import { EgressPage } from "./egress-page.tsx";
import { EnvironmentPage, EnvironmentsPage } from "./environments-page.tsx";
import { FirstRun } from "./first-run.tsx";
import { HostsPage } from "./hosts-page.tsx";
import { InstallPage } from "./install-page.tsx";
import { MountsPage } from "./mounts-page.tsx";
import { OrganisationPage } from "./organisation-page.tsx";
import { messageOf } from "./parts.tsx";
import { ProfilePage } from "./profile-page.tsx";
import { SANDBOX_VIEWS, SandboxPage, type SandboxView } from "./sandbox-page.tsx";
import { SandboxesPage } from "./sandboxes-page.tsx";
import { SettingsFrame, type SettingsNavItem } from "./settings-nav.tsx";
import type { FilesAt } from "./snapshot-files.tsx";
import { SnapshotsPage, type SnapshotsView } from "./snapshots-page.tsx";
import { TelemetryPage } from "./telemetry-page.tsx";
import { UserMenu } from "./user-menu.tsx";
import { WebhooksPage } from "./webhooks-page.tsx";

// The compute console: the shell around the compute plane's pages. On a wide screen, a sidebar with the account
// switcher, the account's five pages (Sandboxes, Snapshots, Environments, Egress, Settings), Admin for a super-admin
// and your menu at its foot; on a phone, a top bar with the switcher and your initials, and the five pages in a tab bar
// along the bottom. Admin is its own area, outside the accounts: a super-admin's Hosts and Install, with its own
// sidebar and a way back. It routes on the path under `base` (the root of the console app, `""`) and leaves where the
// data comes from to its `source`: the sample data in fixtures.ts, or the API. A super-admin on a deployment with no
// host yet is shown the first run: Sandboxes leads with adding one, right there.

export type ComputePage =
	| "sandboxes"
	| "snapshots"
	| "environments"
	| "egress"
	| "keys"
	| "webhooks"
	| "telemetry"
	| "organisation"
	| "profile"
	| "billing"
	| "hosts"
	| "mounts"
	| "install"
	| "device";

export const COMPUTE_PAGES: readonly ComputePage[] = [
	"sandboxes",
	"snapshots",
	"environments",
	"egress",
	"keys",
	"webhooks",
	"telemetry",
	"organisation",
	"profile",
	"billing",
	"hosts",
	"mounts",
	"install",
	"device",
];

/**
 * What a path under the console's base shows: a page, for Sandboxes and Snapshots the sandbox it's about, for Egress
 * the sandbox when it is one sandbox's rather than the account's, for a sandbox's page its tab or screen, and for
 * Environments the environment that's open.
 */
export type ComputeRoute = {
	readonly page: ComputePage;
	readonly sandboxId?: string;
	readonly sandboxView?: SandboxView;
	readonly environmentId?: string;
};

/** The route for `pathname`, or undefined when it isn't under `base` or names no page. `base` itself is Sandboxes. */
export function parseComputePath(pathname: string, base = "/compute"): ComputeRoute | undefined {
	if (pathname !== base && !pathname.startsWith(`${base}/`)) return undefined;
	const parts = pathname.slice(base.length).split("/").filter(Boolean);
	const [first, second, third] = parts;
	if (first === undefined) return { page: "sandboxes" };
	// The Egress proxy page's address before Egress was one page: a link to it still opens Egress.
	if (first === "proxy" && parts.length === 1) return { page: "egress" };
	if (!(COMPUTE_PAGES as readonly string[]).includes(first)) return undefined;
	const page = first as ComputePage;
	// A sandbox's page, and its tab or screen: /sandboxes/<id>/<view>.
	if (page === "sandboxes" && second !== undefined && parts.length <= 3) {
		if (third !== undefined && !(SANDBOX_VIEWS as readonly string[]).includes(third)) return undefined;
		return { page, sandboxId: decodeURIComponent(second), sandboxView: (third ?? "overview") as SandboxView };
	}
	if (parts.length > 2) return undefined;
	if (page === "snapshots" && second !== undefined) return { page, sandboxId: decodeURIComponent(second) };
	if (page === "environments" && second !== undefined) return { page, environmentId: decodeURIComponent(second) };
	// Egress is the account's, or one sandbox's.
	if (page === "egress" && second !== undefined) return { page, sandboxId: decodeURIComponent(second) };
	return parts.length === 1 ? { page } : undefined;
}

/**
 * Where switching accounts goes from `pathname`, or undefined to stay. An environment, or a sandbox's egress, belongs to
 * the account it was opened in: another account goes back to its list rather than showing (and editing) the last
 * one's under the new name.
 */
export function pathAfterAccountSwitch(pathname: string, base = "/compute"): string | undefined {
	const open = parseComputePath(pathname, base);
	if (open?.page === "environments" && open.environmentId !== undefined) return computePath("environments", base);
	if ((open?.page === "egress" || open?.page === "sandboxes") && open.sandboxId !== undefined)
		return computePath("sandboxes", base);
	// A snapshot's files, or a sandbox's history, are the last account's: the new one's saved snapshots instead.
	if (open?.page === "snapshots") return computePath("snapshots", base);
	return undefined;
}

/** The path of a sandbox's page under `base`, or of one of its tabs or screens. */
export function sandboxPath(base: string, sandboxId: string, view: SandboxView = "overview"): string {
	const page = computePath("sandboxes", base, sandboxId);
	return view === "overview" ? page : `${page}/${view}`;
}

/** The query parameters a file browser keeps in the address: the folder, the file open in it, and whose files. */
const FILES_PARAMS = ["path", "file", "snapshot"] as const;

/**
 * Where a file browser is, from the address: its query, `?path=/home/user&file=notes.md`, or for an end-to-end sandbox
 * its fragment, `#path=/home/user&file=notes.md`, which the fragment wins. `path=/` is the root; without `path`, where
 * the browser starts (an isolate's /workspace, a microVM's /home/user).
 */
export function filesAtOf(search: string, hash = ""): FilesAt {
	const fragment = new URLSearchParams(hash.replace(/^#/, ""));
	const params = fragment.has("path") || fragment.has("file") ? fragment : new URLSearchParams(search);
	const named = params.get("path");
	const folder = named === null ? {} : { path: named.replace(/^\/+|\/+$/g, "") };
	const file = params.get("file") ?? "";
	return file === "" || file.includes("/") ? folder : { ...folder, file };
}

/** A place's folder as the address has it: the API's absolute path, `/home/user`, and `/` for the root. */
const pathParam = (at: FilesAt): string | undefined => (at.path === undefined ? undefined : `/${at.path}`);

/**
 * `search` with a file browser's place in it (`snapshot`, when given, says whose files), the rest kept (`?hosting`).
 * The folder is the API's absolute path, `/home/user`; where the browser starts has none.
 */
export function filesSearch(search: string, at: FilesAt, snapshot?: string): string {
	const params = new URLSearchParams(search);
	for (const name of FILES_PARAMS) params.delete(name);
	if (snapshot !== undefined) params.set("snapshot", snapshot);
	const path = pathParam(at);
	if (path !== undefined) params.set("path", path);
	if (at.file !== undefined) params.set("file", at.file);
	// The slashes in a path read as they are.
	const query = params.toString().replaceAll("%2F", "/");
	return query === "" ? "" : `?${query}`;
}

/** `search` without a file browser's place, with its `?` when anything is left. */
export function searchWithoutFiles(search: string): string {
	return filesSearch(search, {});
}

/**
 * An end-to-end sandbox's place in the file browser as the address's fragment, `#path=/home/user&file=notes.md`. A
 * browser never sends a fragment, in a request or a `Referer`, so its folder and file names stay out of the gateway's
 * sight as its files do; Back, Forward and copied links work as with the query.
 */
export function filesHash(at: FilesAt): string {
	const params = new URLSearchParams();
	const path = pathParam(at);
	if (path !== undefined) params.set("path", path);
	if (at.file !== undefined) params.set("file", at.file);
	const fragment = params.toString().replaceAll("%2F", "/");
	return fragment === "" ? "" : `#${fragment}`;
}

/** The path of a page under `base`, and of one sandbox's or environment's when `id` is given. */
export function computePath(page: ComputePage, base = "/compute", id?: string): string {
	return id === undefined ? `${base}/${page}` : `${base}/${page}/${encodeURIComponent(id)}`;
}

/**
 * The address of the account's Egress on `tab`. Every tab names itself, Log too: an address with a query of its own
 * replaces the current one (`?tab=rules`) when the console navigates, so one without would keep it. The rest of
 * `search` (`?hosting`) is kept.
 */
export function egressTabPath(tab: EgressTab, search: string, base = "/compute"): string {
	const params = new URLSearchParams(search);
	params.set("tab", tab);
	return `${computePath("egress", base)}?${params}`;
}

const ACCOUNT_KEY = "kantel.compute.account";

function keptAccount(): string | undefined {
	try {
		return localStorage.getItem(ACCOUNT_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

function keepAccount(id: string): void {
	try {
		localStorage.setItem(ACCOUNT_KEY, id);
	} catch {
		// No storage (a private window): the console opens on the personal account next time.
	}
}

export interface ComputeConsoleProps {
	readonly source: ComputeSource;
	/** The address's path, which picks the page. */
	readonly pathname: string;
	/** The address's query: `?new` opens New sandbox. */
	readonly search?: string;
	/** The address's fragment, with its `#`: where an end-to-end sandbox's file browser is. */
	readonly hash?: string;
	/** Goes to a path in the app without reloading the page. */
	readonly navigate: (path: string) => void;
	/** Where the console lives. Default `/compute`. */
	readonly base?: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** A phone: a top bar and a tab bar instead of the sidebar. */
	readonly narrow?: boolean;
	/** The pages run on sample data: the sidebar says so. */
	readonly sample?: boolean;
	/** The account to open on, for a story; otherwise the last one used, or the personal account. */
	readonly initialAccountId?: string;
	/** Ends the person's session, when they can end it themselves. */
	readonly onSignOut?: () => void;
	/** The sign-in's name and email, when the app knows them better than the source. */
	readonly signedInAs?: { readonly name?: string; readonly email?: string };
	/** The person chose a theme in their menu, which has applied it: the app keeps it for them. */
	readonly onThemeChoose?: (preference: ThemePreference) => void;
	/** An invite's code from its email's link: the console opens Join with it. */
	readonly joinCode?: string;
	/** The Join `joinCode` opened is done with, joined or closed: the app forgets the code. */
	readonly onJoinCodeDone?: () => void;
}

/** A wide screen: the sidebar beside the page. A phone: the top bar, the page, and the tab bar under it. */
const SHELL = "kt-app grid h-dvh";
const SHELL_WIDE = "grid-cols-[var(--kt-nav-width)_minmax(0,1fr)]";
const SHELL_NARROW = "grid-rows-[auto_minmax(0,1fr)_auto]";
const MAIN = "min-h-0 min-w-0 overflow-y-auto";

/**
 * What the strip over the page says about end-to-end encryption in this account, and in which tone; undefined for
 * nothing (the gateway's console in an account without it says nothing). `setup` offers to make this browser a device
 * in the chain (or show where it stands), from `standing`.
 */
export function e2eStrip(
	e2e: E2ESource | undefined,
	mode: E2EMode | undefined,
	standing?: BrowserStanding,
): { readonly text: string; readonly tone: "done" | "waiting" | "idle"; readonly setup?: string } | undefined {
	if (e2e === undefined || mode === undefined) return undefined;
	if (e2e.served === "local") {
		if (mode === "off") {
			return {
				tone: "idle",
				text: "Served by kantel console on this computer. End-to-end encryption is off here.",
			};
		}
		const device = e2e.device === undefined ? "this device's key" : `the key of ${e2e.device}`;
		return {
			tone: "done",
			text: `Served by kantel console on this computer. Commands and their history go to each sandbox's host end to end, with ${device}.`,
		};
	}
	if (mode === "off") return undefined;
	if (mode === "on" && e2e.browser !== undefined && standing !== undefined) {
		if (standing.kind === "ready") {
			return {
				tone: "done",
				text: `End-to-end encryption is on here. This browser is a device in the chain (${standing.label}), so commands and their history go to each sandbox's host end to end.`,
				setup: "About this browser",
			};
		}
		if (standing.kind === "refused") {
			return {
				tone: "waiting",
				text: `End-to-end encryption is on here. ${standing.reason.replace(/\.$/, "")}. Run kantel console on your computer to see commands and files.`,
			};
		}
		return {
			tone: "waiting",
			text: "End-to-end encryption is on here. This console shows commands and files once this browser is a device in the chain, or run kantel console on your computer.",
			setup: standing.kind === "pending" ? "Waiting for an admin" : "Use this browser",
		};
	}
	return {
		tone: "waiting",
		text:
			mode === "strict"
				? "End-to-end encryption is strict here, so this console can't show commands or files and no browser is let in. Run kantel console on your computer to see them."
				: "End-to-end encryption is on here, so this console can't show commands or files. Run kantel console on your computer to see them.",
	};
}

const STRIP_TONES = {
	done: "bg-status-done-soft text-status-done",
	waiting: "bg-status-waiting-soft text-status-waiting",
	idle: "text-muted",
} as const;

/** The pages under Settings: your profile and the account's own settings, each at the address it had before. */
const SETTINGS_PAGES: ReadonlySet<ComputePage> = new Set([
	"profile",
	"organisation",
	"keys",
	"webhooks",
	"telemetry",
	"mounts",
	"billing",
]);

/** The compute console: the sidebar with the account switcher and its pages, and the page the path names. */
export function ComputeConsole({
	source,
	pathname,
	search = "",
	hash = "",
	navigate,
	base = "/compute",
	now,
	narrow = false,
	sample = false,
	initialAccountId,
	onSignOut,
	signedInAs,
	onThemeChoose,
	joinCode,
	onJoinCodeDone,
}: ComputeConsoleProps) {
	const viewer = useLoad(() => source.accounts.viewer(), [source]);
	const accounts = useLoad(() => source.accounts.list(), [source]);
	const [accountId, setAccountId] = useState<string | undefined>(() => initialAccountId ?? keptAccount());
	const [dialog, setDialog] = useState<"create" | "join" | undefined>(joinCode === undefined ? undefined : "join");
	// A link's code that arrives once the console is up opens Join too.
	useEffect(() => {
		if (joinCode !== undefined) setDialog("join");
	}, [joinCode]);
	const closeJoin = () => {
		setDialog(undefined);
		onJoinCodeDone?.();
	};

	const list = accounts.state.status === "ready" ? accounts.state.value : undefined;
	const account = useMemo(
		() => list?.find((each) => each.id === accountId) ?? list?.find((each) => each.kind === "personal") ?? list?.[0],
		[list, accountId],
	);
	const switchTo = useCallback(
		(next: ComputeAccount) => {
			setAccountId(next.id);
			keepAccount(next.id);
			const away = pathAfterAccountSwitch(pathname, base);
			if (away !== undefined) navigate(away);
		},
		[pathname, base, navigate],
	);

	// Links under the console move without reloading the page; others, and modified clicks, are left alone.
	const onClick = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
			const anchor = (event.target as Element).closest("a");
			const href = anchor?.getAttribute("href");
			if (anchor === null || href == null || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
			if (href !== base && !href.startsWith(`${base}/`) && !href.startsWith(`${base}?`)) return;
			event.preventDefault();
			navigate(href);
		},
		[base, navigate],
	);

	const e2eMode = useLoad(
		() =>
			source.e2e !== undefined && account !== undefined
				? source.e2e.mode(account.id).catch(() => undefined)
				: Promise.resolve(undefined),
		[source, account?.id],
	);
	const mode = e2eMode.state.status === "ready" ? e2eMode.state.value : undefined;
	const browserDevice = source.e2e?.browser;
	const standing = useLoad(
		() =>
			browserDevice !== undefined && account !== undefined && mode === "on"
				? browserDevice
						.standing(account.id)
						.catch((error: unknown): BrowserStanding => ({ kind: "refused", reason: messageOf(error, "Unknown") }))
				: Promise.resolve(undefined),
		[browserDevice, account?.id, mode],
	);
	const standingNow = standing.state.status === "ready" ? standing.state.value : undefined;
	const strip = e2eStrip(source.e2e, mode, standingNow);
	const [deviceOpen, setDeviceOpen] = useState(false);

	const route = parseComputePath(pathname, base) ?? { page: "sandboxes" as const };
	const me = viewer.state.status === "ready" ? viewer.state.value : undefined;
	// A super-admin manages the deployment's hosts; anyone else, where the deployment allows it, their account's own.
	const superAdmin = me?.superAdmin === true;
	const accountKey = account?.id;
	const hostsSource = useMemo(
		() =>
			superAdmin
				? source.hosts
				: me !== undefined && accountKey !== undefined
					? source.ownHosts?.(accountKey)
					: undefined,
		[source, superAdmin, me, accountKey],
	);
	const hostsShown = hostsSource !== undefined;
	// Whether there's a host yet: with none, Sandboxes leads to adding one. Read again on every page change, so a host
	// added on Hosts counts once the person goes back.
	const hosts = useLoad(
		() => (hostsSource !== undefined ? hostsSource.list() : Promise.resolve(undefined)),
		[hostsSource, pathname],
	);
	// The deployment's hosts (a super-admin's) tell whether there's any; an account's own don't, since it may still use
	// shared hosts, so none of its own only adds a link to Add a host beside New sandbox (PageFor).
	const noHosts = hosts.state.status === "ready" && hosts.state.value?.length === 0;
	const billingShown = source.hosting === "hosted" && source.billing !== undefined;
	// Read-only mounts' bundles and bucket sources, where the deployment has turned mounts on (experimental).
	const mountsShown = source.mounts !== undefined;
	// A page this person can't open goes to Sandboxes rather than showing nothing. Device sign-in has no sidebar item:
	// a terminal running `kantel login` opens it.
	// Install, the deployment's public URL, is a super-admin's, where the API can set it.
	const installSource = superAdmin ? hostsSource?.publicUrl : undefined;
	const page =
		(route.page === "hosts" && me !== undefined && !hostsShown) ||
		(route.page === "install" && me !== undefined && installSource === undefined) ||
		(route.page === "billing" && !billingShown) ||
		(route.page === "mounts" && !mountsShown) ||
		(route.page === "device" && source.devices === undefined)
			? "sandboxes"
			: route.page;

	const failed =
		viewer.state.status === "error" ? viewer.state : accounts.state.status === "error" ? accounts.state : undefined;

	// Admin is the deployment's, not an account's: a super-admin's Hosts, outside the switcher, with a way back.
	const adminShown = hostsShown && superAdmin;
	const inAdmin = adminShown && (page === "hosts" || page === "install");
	const adminHref = computePath("hosts", base);
	const adminItems: SettingsNavItem[] = [
		{ id: "hosts", label: "Hosts" },
		...(installSource === undefined ? [] : [{ id: "install", label: "Install" }]),
	].map((item) => ({ ...item, href: computePath(item.id as ComputePage, base), selected: page === item.id }));
	const hostCount = hosts.state.status === "ready" ? hosts.state.value?.length : undefined;
	// An account's own hosts, where the deployment lets it add them, are one of its settings.
	const ownHostsShown = hostsShown && !superAdmin;
	const inSettings = SETTINGS_PAGES.has(page) || (ownHostsShown && page === "hosts");
	// Your profile is the personal account's first setting; from an organisation, your menu opens it.
	const personal = account?.kind === "personal";
	const settingsItems: SettingsNavItem[] = [
		...(personal || page === "profile" ? [{ id: "profile", label: "Profile" }] : []),
		{ id: "organisation", label: personal ? "Organisations" : "General" },
		{ id: "keys", label: "API keys" },
		{ id: "webhooks", label: "Webhooks" },
		{ id: "telemetry", label: "OpenTelemetry" },
		...(mountsShown ? [{ id: "mounts", label: "Mounts" }] : []),
		...(ownHostsShown ? [{ id: "hosts", label: "Hosts" }] : []),
		...(billingShown ? [{ id: "billing", label: "Plan and billing" }] : []),
	].map((item) => ({ ...item, href: computePath(item.id as ComputePage, base), selected: page === item.id }));

	// The five pages: the sidebar's on a wide screen, the tab bar's on a phone. A sandbox's egress log is still one of
	// the sandbox's until the sandbox has a page of its own.
	const sandboxEgress = page === "egress" && route.sandboxId !== undefined;
	const pages = [
		{
			id: "sandboxes",
			label: "Sandboxes",
			short: "Sandboxes",
			icon: <SandboxIcon />,
			on: page === "sandboxes" || sandboxEgress,
		},
		{ id: "snapshots", label: "Snapshots", short: "Snapshots", icon: <SnapshotIcon />, on: page === "snapshots" },
		{
			id: "environments",
			label: "Environments",
			short: "Envs",
			icon: <EnvironmentIcon />,
			on: page === "environments",
		},
		{ id: "egress", label: "Egress", short: "Egress", icon: <ProxyIcon />, on: page === "egress" && !sandboxEgress },
		{ id: "organisation", label: "Settings", short: "Settings", icon: <SettingsIcon />, on: inSettings },
	] as const;
	const href = (id: string) => computePath(id as ComputePage, base);

	const name = signedInAs?.name ?? me?.name;
	const email = signedInAs?.email ?? me?.email;
	const userMenu = (compact: boolean) => (
		<UserMenu
			compact={compact}
			{...(name === undefined ? {} : { name })}
			{...(email === undefined ? {} : { email })}
			unavailable={failed !== undefined}
			{...(compact && adminShown && !inAdmin ? { onAdmin: () => navigate(adminHref) } : {})}
			onProfile={() => navigate(computePath("profile", base))}
			{...(onSignOut === undefined ? {} : { onSignOut })}
			{...(onThemeChoose === undefined ? {} : { onThemeChoose })}
		/>
	);
	const switcher =
		list !== undefined && account !== undefined ? (
			<AccountSwitcher
				accounts={list}
				current={account}
				onSwitch={switchTo}
				onCreate={() => setDialog("create")}
				onJoin={() => setDialog("join")}
			/>
		) : failed === undefined ? (
			// While the accounts are read, the switcher's shape, so the pages under it don't move when it arrives.
			<span className={`${skeletonClass} h-control-md w-full rounded-control`} />
		) : (
			<span className="block h-control-md" />
		);
	const backToConsole = (
		<a
			className="kt-focusable inline-flex items-center gap-1 rounded-control px-1.5 py-1 text-sm text-muted no-underline hover:bg-hover hover:text-fg"
			href={computePath("sandboxes", base)}
		>
			<BackIcon size="sm" />
			Console
		</a>
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks on the links inside; each link is focusable.
		// biome-ignore lint/a11y/useKeyWithClickEvents: a link's Enter is a click, so the keyboard takes the same path.
		<div className={`${SHELL} ${narrow ? SHELL_NARROW : SHELL_WIDE}`} onClick={onClick}>
			{narrow ? (
				<header className="kt-console-top flex h-(--kt-topbar-height) min-w-0 items-center gap-2 border-b border-border bg-panel px-gutter-narrow">
					<KantelMark className="h-(--kt-brand-sm)" title="Kantel" />
					<div className="flex min-w-0 flex-1 items-center gap-2">
						{inAdmin ? (
							<>
								{backToConsole}
								<span className="truncate text-sm font-strong">Admin</span>
							</>
						) : (
							switcher
						)}
					</div>
					{userMenu(true)}
				</header>
			) : (
				<Sidebar
					role="complementary"
					aria-label={inAdmin ? "Admin" : "Compute console"}
					className="min-h-0"
					head={
						<SidebarBrand>
							<KantelLockup className="h-(--kt-brand-sm)" title="Kantel" />
						</SidebarBrand>
					}
					foot={
						<>
							{adminShown && !inAdmin ? (
								<SidebarSection label="Admin" heading={false}>
									<SidebarItem icon={<ServerIcon />} label="Admin" href={adminHref} />
								</SidebarSection>
							) : null}
							{userMenu(false)}
						</>
					}
				>
					{inAdmin ? (
						<>
							<div className="flex flex-col items-start gap-2">
								{backToConsole}
								<span className="flex flex-col gap-0.5 px-2.5 leading-tight">
									<span className="text-sm font-strong">Admin</span>
									<span className="text-sm text-faint">This whole install</span>
								</span>
							</div>
							<SidebarSection label="Admin" heading={false}>
								{adminItems.map((item) => (
									<SidebarItem
										key={item.id}
										icon={item.id === "hosts" ? <ServerIcon /> : <SettingsIcon />}
										label={item.label}
										href={item.href}
										selected={item.selected ?? false}
										{...(item.id === "hosts" && hostCount !== undefined && hostCount > 0
											? { trailing: String(hostCount) }
											: {})}
									/>
								))}
							</SidebarSection>
						</>
					) : (
						<>
							{switcher}
							<SidebarSection label="Pages" heading={false}>
								{pages.slice(0, 4).map((each) => (
									<SidebarItem
										key={each.id}
										icon={each.icon}
										label={each.label}
										href={href(each.id)}
										selected={each.on}
									/>
								))}
							</SidebarSection>
							<SidebarSection label="Settings" heading={false}>
								<SidebarItem
									icon={<SettingsIcon />}
									label="Settings"
									href={href("organisation")}
									selected={inSettings}
								/>
							</SidebarSection>
						</>
					)}
				</Sidebar>
			)}
			<main className={MAIN}>
				{sample && failed === undefined ? (
					<p
						className={`kt-sample-banner m-0 border-b border-border bg-status-waiting-soft py-1.5 text-sm text-status-waiting ${narrow ? "px-gutter-narrow" : "px-gutter"}`}
					>
						{source.hosting === "hosted" ? "Hosted demo on sample data." : "Sample data."} Nothing here is real.
					</p>
				) : null}
				{strip === undefined ? null : (
					<div
						className={`kt-e2e-strip flex items-center gap-3 border-b border-border py-1.5 text-sm ${STRIP_TONES[strip.tone]} ${narrow ? "px-gutter-narrow" : "px-gutter"}`}
					>
						<p className="m-0 min-w-0 flex-1">{strip.text}</p>
						{strip.setup === undefined ? null : (
							<Button size="sm" onClick={() => setDeviceOpen(true)}>
								{strip.setup}
							</Button>
						)}
					</div>
				)}
				{browserDevice === undefined || account === undefined ? null : (
					<BrowserDeviceDialog
						open={deviceOpen}
						accountName={account.name}
						standing={standing.state.status === "loading" ? undefined : standingNow}
						onTrust={async (genesis) => {
							await browserDevice.trust(account.id, genesis);
							standing.reload();
						}}
						onCheck={() => standing.reload()}
						onClose={() => setDeviceOpen(false)}
					/>
				)}
				{failed !== undefined ? (
					<div className={narrow ? "p-gutter-narrow" : "p-gutter"}>
						<ConsoleUnavailable
							title={inSettings ? "Settings" : pages.find((each) => each.on)?.label}
							message={messageOf(failed.error, "Try again in a moment.")}
							onRetry={() => {
								viewer.reload();
								accounts.reload();
							}}
						/>
					</div>
				) : account === undefined || me === undefined ? (
					<ConsoleLoading narrow={narrow} title={inSettings ? "Settings" : pages.find((each) => each.on)?.label} />
				) : (
					<div className={narrow ? "p-gutter-narrow" : "p-gutter"}>
						<SettingsFrameFor
							shown={inSettings || (inAdmin && narrow && adminItems.length > 1)}
							items={inAdmin ? adminItems : settingsItems}
							label={inAdmin ? "Admin" : "Settings"}
							titled={!inAdmin}
							narrow={narrow}
						>
							<PageFor
								// A new account or page starts afresh: nothing of the last one's dialogs or filters carries over.
								key={`${account.id}/${page}/${route.sandboxId ?? route.environmentId ?? ""}`}
								page={page}
								route={route}
								source={source}
								account={account}
								viewer={me}
								now={now}
								base={base}
								search={search}
								hash={hash}
								navigate={navigate}
								noHosts={noHosts}
								narrow={narrow}
								hosts={hostsSource}
								ownHosts={!superAdmin}
								accounts={list ?? []}
								onSwitch={switchTo}
								onRenamed={() => accounts.reload()}
								you={{ name: name ?? me.name, email: email ?? me.email }}
								{...(onThemeChoose === undefined ? {} : { onThemeChoose })}
								onHostJoined={hosts.reload}
								onCreate={() => setDialog("create")}
								onJoin={() => setDialog("join")}
								onLeft={() => {
									const personal = list?.find((each) => each.kind === "personal");
									if (personal !== undefined) switchTo(personal);
									accounts.reload();
								}}
							/>
						</SettingsFrameFor>
					</div>
				)}
			</main>
			{narrow && !inAdmin ? (
				<TabBar
					label="Pages"
					items={pages.map((each) => ({
						id: each.id,
						label: each.short,
						icon: each.icon,
						href: href(each.id),
						selected: each.on,
					}))}
				/>
			) : null}
			<CreateOrganisationDialog
				open={dialog === "create"}
				onClose={() => setDialog(undefined)}
				onCreate={async (input) => {
					const made = await source.accounts.createOrganisation(input);
					switchTo(made);
					accounts.reload();
					setDialog(undefined);
				}}
			/>
			<JoinOrganisationDialog
				open={dialog === "join"}
				onClose={closeJoin}
				{...(onSignOut === undefined ? {} : { onSignOut })}
				{...(joinCode === undefined ? {} : { initialCode: joinCode })}
				onJoin={async (code) => {
					const joined = await source.accounts.join(code);
					switchTo(joined);
					accounts.reload();
					closeJoin();
				}}
			/>
		</div>
	);
}

function PageFor({
	page,
	route,
	source,
	account,
	viewer,
	now,
	base,
	search,
	hash,
	navigate,
	noHosts,
	narrow,
	hosts,
	ownHosts,
	accounts,
	onSwitch,
	onRenamed,
	you,
	onThemeChoose,
	onHostJoined,
	onCreate,
	onJoin,
	onLeft,
}: {
	page: ComputePage;
	route: ComputeRoute;
	source: ComputeSource;
	account: ComputeAccount;
	viewer: ComputeViewer;
	now: number | undefined;
	base: string;
	search: string;
	hash: string;
	navigate: (path: string) => void;
	/** There's no host yet: the deployment's, for a super-admin, or the account's own. */
	noHosts: boolean;
	/** A phone. */
	narrow: boolean;
	/** The hosts this person manages, when there are any to manage. */
	hosts: HostsSource | undefined;
	/** They are the account's own, not the deployment's. */
	ownHosts: boolean;
	/** Every account the viewer has: the personal account's Organisations lists them. */
	accounts: readonly ComputeAccount[];
	onSwitch: (account: ComputeAccount) => void;
	/** The organisation was renamed: the switcher reads the accounts again. */
	onRenamed: () => void;
	/** Who is signed in, for Profile. */
	you: { readonly name: string; readonly email?: string };
	onThemeChoose?: (preference: ThemePreference) => void;
	/** The first run's host joined: the console reads the hosts again. */
	onHostJoined: () => void;
	onCreate: () => void;
	onJoin: () => void;
	onLeft: () => void;
}): ReactNode {
	const timing = now === undefined ? {} : { now };
	switch (page) {
		case "sandboxes":
			return route.sandboxId !== undefined ? (
				<SandboxPage
					source={source.sandboxes}
					snapshots={source.snapshots}
					egress={source.egress}
					hosting={source.hosting}
					sandboxId={route.sandboxId}
					accountId={account.id}
					view={route.sandboxView ?? "overview"}
					href={(view) => sandboxPath(base, route.sandboxId ?? "", view)}
					sandboxesHref={computePath("sandboxes", base)}
					environmentHref={(id) => computePath("environments", base, id)}
					navigate={navigate}
					narrow={narrow}
					{...(route.sandboxView === "files" ? { filesAt: filesAtOf(search, hash) } : {})}
					filesHref={(at, sealed) => {
						const files = sandboxPath(base, route.sandboxId ?? "", "files");
						return sealed
							? `${files}${searchWithoutFiles(search)}${filesHash(at)}`
							: `${files}${filesSearch(search, at)}`;
					}}
					{...timing}
				/>
			) : (
				<SandboxesPage
					source={source.sandboxes}
					snapshots={source.snapshots}
					account={account}
					hosting={source.hosting}
					sandboxHref={(sandboxId, view) => sandboxPath(base, sandboxId, view)}
					navigate={navigate}
					environments={(accountId) => source.environments.list(accountId)}
					creating={new URLSearchParams(search).has("new")}
					narrow={narrow}
					{...(noHosts ? { [ownHosts ? "ownHostHref" : "addHostHref"]: `${computePath("hosts", base)}?add` } : {})}
					{...(noHosts && !ownHosts && hosts !== undefined
						? { firstRun: <FirstRun source={hosts} onJoined={onHostJoined} {...timing} /> }
						: {})}
					{...timing}
				/>
			);
		case "snapshots":
			return (
				<SnapshotsRoute
					source={source}
					account={account}
					sandboxId={route.sandboxId}
					base={base}
					search={search}
					navigate={navigate}
					timing={timing}
				/>
			);
		case "environments":
			return route.environmentId === undefined ? (
				<EnvironmentsPage
					source={source.environments}
					account={account}
					environmentHref={(id) => computePath("environments", base, id)}
					navigate={navigate}
					creating={new URLSearchParams(search).has("new")}
					{...timing}
				/>
			) : (
				<EnvironmentPage
					source={source.environments}
					environmentId={route.environmentId}
					accountId={account.id}
					listHref={computePath("environments", base)}
					navigate={navigate}
					{...timing}
				/>
			);
		case "egress": {
			if (route.sandboxId === undefined) {
				const asked = new URLSearchParams(search).get("tab");
				const tab = (EGRESS_TABS as readonly string[]).includes(asked ?? "") ? (asked as EgressTab) : "log";
				const tabHref = (each: EgressTab) => egressTabPath(each, search, base);
				return (
					<AccountEgressPage
						source={source}
						account={account}
						tab={tab}
						tabHref={tabHref}
						onTab={(each) => navigate(tabHref(each))}
						environmentHref={(id) => computePath("environments", base, id)}
						sandboxHref={(id) => computePath("egress", base, id)}
						narrow={narrow}
						{...timing}
					/>
				);
			}
			return (
				<EgressPage
					source={source.egress}
					sandboxId={route.sandboxId}
					accountId={account.id}
					sandboxesHref={computePath("sandboxes", base)}
					environmentHref={(id) => computePath("environments", base, id)}
					navigate={navigate}
				/>
			);
		}
		case "keys":
			return <ComputeApiKeysPage source={source.keys} account={account} narrow={narrow} {...timing} />;
		case "webhooks":
			return <WebhooksPage source={source.webhooks} account={account} narrow={narrow} {...timing} />;
		case "telemetry":
			return <TelemetryPage source={source.telemetry} account={account} narrow={narrow} {...timing} />;
		case "organisation":
			return (
				<OrganisationPage
					source={source.accounts}
					account={account}
					viewerId={viewer.id}
					accounts={accounts}
					narrow={narrow}
					onSwitch={onSwitch}
					onRenamed={onRenamed}
					onCreate={onCreate}
					onJoin={onJoin}
					onLeft={onLeft}
					{...timing}
				/>
			);
		case "profile":
			return (
				<ProfilePage
					name={you.name}
					narrow={narrow}
					{...(you.email === undefined ? {} : { email: you.email })}
					{...(onThemeChoose === undefined ? {} : { onThemeChoose })}
				/>
			);
		case "billing":
			return source.billing === undefined ? null : (
				<BillingPage source={source.billing} account={account} narrow={narrow} {...timing} />
			);
		case "mounts":
			return source.mounts === undefined ? null : (
				<MountsPage key={account.id} source={source.mounts} account={account} {...timing} />
			);
		case "hosts":
			return hosts === undefined ? null : (
				<HostsPage
					source={hosts}
					hosting={source.hosting}
					{...(ownHosts ? { owner: account } : {})}
					adding={new URLSearchParams(search).has("add")}
					narrow={narrow}
					{...timing}
				/>
			);
		case "install":
			return hosts?.publicUrl === undefined || ownHosts ? null : (
				<InstallPage source={hosts.publicUrl} narrow={narrow} />
			);
		case "device": {
			const code = new URLSearchParams(search).get("code") ?? undefined;
			return source.devices === undefined ? null : (
				<DeviceLoginPage
					source={source.devices}
					account={account}
					{...(code === undefined ? {} : { code })}
					{...timing}
				/>
			);
		}
	}
}

/**
 * The Snapshots page, with a snapshot's files in the address (`?snapshot=ssn_1&path=/home/user&file=notes.md`), so Back,
 * Forward and links reach them. The saved list and a sandbox's history are the page's own, under `/snapshots[/<id>]`.
 */
function SnapshotsRoute({
	source,
	account,
	sandboxId,
	base,
	search,
	navigate,
	timing,
}: {
	source: ComputeSource;
	account: ComputeAccount;
	sandboxId: string | undefined;
	base: string;
	search: string;
	navigate: (path: string) => void;
	timing: { now?: number };
}) {
	const listed: SnapshotsView = sandboxId === undefined ? { name: "saved" } : { name: "sandbox", sandboxId };
	const [list, setList] = useState<SnapshotsView>(listed);
	// What each snapshot was called where it was opened, for its heading; a link to its files has none.
	const [labels] = useState(() => new Map<string, string>());
	// And the kind of sandbox it's of, which says where its files start; the page asks for it where a link doesn't say.
	const [kinds] = useState(() => new Map<string, SandboxKind>());
	const snapshot = new URLSearchParams(search).get("snapshot") ?? "";
	const at = filesAtOf(search);
	const label = labels.get(snapshot);
	const kind = kinds.get(snapshot);
	const view: SnapshotsView =
		snapshot === ""
			? list
			: {
					name: "files",
					snapshotId: snapshot,
					...(label === undefined ? {} : { label }),
					...(kind === undefined ? {} : { kind }),
					...(at.path === undefined ? {} : { path: at.path }),
					...(at.file === undefined ? {} : { file: at.file }),
					back: list,
				};
	const page = list.name === "sandbox" && list.sandboxId !== undefined ? list.sandboxId : undefined;
	const hrefOf = (next: SnapshotsView): string => {
		const path = computePath("snapshots", base, page);
		if (next.name !== "files") return `${path}${searchWithoutFiles(search)}`;
		const place = {
			...(next.path === undefined ? {} : { path: next.path }),
			...(next.file === undefined ? {} : { file: next.file }),
		};
		return `${path}${filesSearch(search, place, next.snapshotId)}`;
	};
	return (
		<SnapshotsPage
			source={source.snapshots}
			sandboxes={source.sandboxes}
			account={account}
			view={view}
			onViewChange={(next) => {
				if (next.name === "files") {
					if (next.label !== undefined) labels.set(next.snapshotId, next.label);
					if (next.kind !== undefined) kinds.set(next.snapshotId, next.kind);
					navigate(hrefOf(next));
					return;
				}
				setList(next);
				if (snapshot !== "") navigate(hrefOf(next));
			}}
			viewHref={hrefOf}
			onStartFrom={() => navigate(`${computePath("sandboxes", base)}?new`)}
			{...timing}
		/>
	);
}

/** Settings' navigation around a settings page; any other page as it is. */
function SettingsFrameFor({
	shown,
	items,
	label,
	titled,
	narrow,
	children,
}: {
	shown: boolean;
	items: readonly SettingsNavItem[];
	label: string;
	titled: boolean;
	narrow: boolean;
	children: ReactNode;
}): ReactNode {
	return shown ? (
		<SettingsFrame items={items} label={label} titled={titled} narrow={narrow}>
			{children}
		</SettingsFrame>
	) : (
		children
	);
}

/** The loaded table's columns after the name (state, machine, environment, stops, CPU, created), as placeholders. */
const LOADING_COLUMNS = ["w-16", "w-36", "w-24", "w-20", "w-24", "w-12"] as const;

/**
 * The console while its first read is on its way: the page's own shape (a title, the filters, a few rows) in
 * placeholders, so the page that arrives lands where the eye already is. Announced once, as a status.
 */
function ConsoleLoading({ narrow, title }: { narrow: boolean; title: string | undefined }) {
	const rows = narrow ? 6 : 8;
	return (
		<div
			className={`flex flex-col gap-6 ${narrow ? "p-gutter-narrow" : "p-gutter"}`}
			role="status"
			aria-label="Opening the console"
		>
			<div className="flex items-center justify-between gap-4 border-b border-border pb-4">
				{title === undefined ? (
					<span className={`${skeletonClass} h-(--kt-text-heading) w-32`} />
				) : (
					<p className="m-0 truncate text-heading font-strong leading-tight text-fg">{title}</p>
				)}
				<span className={`${skeletonClass} h-(--kt-control-md) w-20 rounded-control`} />
			</div>
			<div className={`flex gap-3 ${narrow ? "flex-col" : "items-center justify-between"}`}>
				<span className={`${skeletonClass} h-(--kt-control-md) w-72 max-w-full rounded-control`} />
				<span className={`${skeletonClass} h-(--kt-control-md) ${narrow ? "w-full" : "w-80"} rounded-control`} />
			</div>
			<div className="flex flex-col">
				{Array.from({ length: rows }, (_, row) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows.
						key={row}
						className={`flex items-center border-b border-border ${narrow ? "gap-3 py-4" : "gap-4 py-3.5"}`}
					>
						<span className={`${skeletonClass} size-3.5 flex-none`} />
						{narrow ? (
							<>
								<div className="flex min-w-0 flex-1 flex-col gap-2">
									<Skeleton width={`${40 + ((row * 17) % 30)}%`} />
									<Skeleton width={`${55 + ((row * 11) % 25)}%`} />
								</div>
								<div className="w-16 flex-none">
									<Skeleton />
								</div>
							</>
						) : (
							<>
								<div className="min-w-0 flex-1">
									<Skeleton width={`${30 + ((row * 17) % 30)}%`} />
								</div>
								{LOADING_COLUMNS.map((width, column) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder columns, some the same width.
									<div key={column} className={`${width} flex-none`}>
										<Skeleton width="75%" />
									</div>
								))}
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

/** The console can't read what it needs: what happened, in a sentence, and the one thing to do about it. */
function ConsoleUnavailable({
	title,
	message,
	onRetry,
}: {
	title: string | undefined;
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="flex w-full flex-col gap-6">
			{/* The page keeps its title, so the failure reads as this page's, not a blank takeover. */}
			{title === undefined ? null : (
				<p className="m-0 border-b border-border pb-4 text-heading font-strong leading-tight text-fg">{title}</p>
			)}
			<div className="flex flex-col items-center gap-4 py-16 text-center" role="alert">
				<span className="grid size-12 place-items-center rounded-full bg-status-error-soft text-status-error">
					<AlertIcon />
				</span>
				<div className="flex max-w-md flex-col gap-1.5">
					<h1 className="m-0 text-lg font-strong leading-tight text-fg">
						{title === undefined ? "Can't load the console" : `Can't load ${title.toLowerCase()}`}
					</h1>
					<p className="m-0 text-md leading-normal text-muted">
						{message} Check that the Kantel server is running and that this device is online.
					</p>
				</div>
				<Button variant="primary" size="md" onClick={onRetry}>
					Try again
				</Button>
			</div>
		</div>
	);
}
