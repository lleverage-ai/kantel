import type { ThemePreference } from "@kantel/contracts";
import { type MouseEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { KantelLockup, KantelMark } from "../brand/kantel.tsx";
import { Button } from "../primitives/button.tsx";
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
import { Spinner } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { TabBar } from "../primitives/tab-bar.tsx";
import { AccountSwitcher, CreateOrganisationDialog, JoinOrganisationDialog } from "./account-switcher.tsx";
import { ComputeApiKeysPage } from "./api-keys-page.tsx";
import { BillingPage } from "./billing-page.tsx";
import type { ComputeAccount, ComputeSource, ComputeViewer, HostsSource } from "./compute-model.ts";
import { DeviceLoginPage } from "./device-page.tsx";
import { EgressPage } from "./egress-page.tsx";
import { EnvironmentPage, EnvironmentsPage } from "./environments-page.tsx";
import { HostsPage } from "./hosts-page.tsx";
import { OrganisationPage } from "./organisation-page.tsx";
import { messageOf } from "./parts.tsx";
import { ProfilePage } from "./profile-page.tsx";
import { ProxyPage } from "./proxy-page.tsx";
import { SandboxesPage } from "./sandboxes-page.tsx";
import { SettingsFrame, type SettingsNavItem } from "./settings-nav.tsx";
import { SnapshotsPage } from "./snapshots-page.tsx";
import { TelemetryPage } from "./telemetry-page.tsx";
import { UserMenu } from "./user-menu.tsx";
import { WebhooksPage } from "./webhooks-page.tsx";

// The compute console: the shell around the compute plane's pages. On a wide screen, a sidebar with the account
// switcher, the account's five pages (Sandboxes, Snapshots, Environments, Egress, Settings), Admin for a super-admin
// and your menu at its foot; on a phone, a top bar with the switcher and your initials, and the five pages in a tab bar
// along the bottom. Admin is its own area, outside the accounts: a super-admin's Hosts, with its own sidebar and a way
// back. It routes on the path under `base` (the root of the console app, `""`) and leaves where the data comes from to
// its `source`: the sample data in fixtures.ts, or the API. A super-admin on a deployment with no host yet is shown the
// way to add one first.

export type ComputePage =
	| "sandboxes"
	| "snapshots"
	| "environments"
	| "egress"
	| "keys"
	| "proxy"
	| "webhooks"
	| "telemetry"
	| "organisation"
	| "profile"
	| "billing"
	| "hosts"
	| "device";

export const COMPUTE_PAGES: readonly ComputePage[] = [
	"sandboxes",
	"snapshots",
	"environments",
	"egress",
	"keys",
	"proxy",
	"webhooks",
	"telemetry",
	"organisation",
	"profile",
	"billing",
	"hosts",
	"device",
];

/**
 * What a path under the console's base shows: a page, for Snapshots and Egress the sandbox it's about, and for
 * Environments the environment that's open.
 */
export type ComputeRoute = {
	readonly page: ComputePage;
	readonly sandboxId?: string;
	readonly environmentId?: string;
};

/** The route for `pathname`, or undefined when it isn't under `base` or names no page. `base` itself is Sandboxes. */
export function parseComputePath(pathname: string, base = "/compute"): ComputeRoute | undefined {
	if (pathname !== base && !pathname.startsWith(`${base}/`)) return undefined;
	const parts = pathname.slice(base.length).split("/").filter(Boolean);
	const [first, second] = parts;
	if (first === undefined) return { page: "sandboxes" };
	if (!(COMPUTE_PAGES as readonly string[]).includes(first)) return undefined;
	const page = first as ComputePage;
	if (parts.length > 2) return undefined;
	if (page === "snapshots" && second !== undefined) return { page, sandboxId: decodeURIComponent(second) };
	if (page === "environments" && second !== undefined) return { page, environmentId: decodeURIComponent(second) };
	// Egress is always one sandbox's.
	if (page === "egress") return second === undefined ? undefined : { page, sandboxId: decodeURIComponent(second) };
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
	if (open?.page === "egress") return computePath("sandboxes", base);
	return undefined;
}

/** The path of a page under `base`, and of one sandbox's or environment's when `id` is given. */
export function computePath(page: ComputePage, base = "/compute", id?: string): string {
	return id === undefined ? `${base}/${page}` : `${base}/${page}/${encodeURIComponent(id)}`;
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
}

/** A wide screen: the sidebar beside the page. A phone: the top bar, the page, and the tab bar under it. */
const SHELL = "kt-app grid h-dvh";
const SHELL_WIDE = "grid-cols-[var(--kt-nav-width)_minmax(0,1fr)]";
const SHELL_NARROW = "grid-rows-[auto_minmax(0,1fr)_auto]";
const MAIN = "min-h-0 min-w-0 overflow-y-auto";

/** The pages under Settings: your profile and the account's own settings, each at the address it had before. */
const SETTINGS_PAGES: ReadonlySet<ComputePage> = new Set([
	"profile",
	"organisation",
	"keys",
	"webhooks",
	"telemetry",
	"billing",
]);

/** The compute console: the sidebar with the account switcher and its pages, and the page the path names. */
export function ComputeConsole({
	source,
	pathname,
	search = "",
	navigate,
	base = "/compute",
	now,
	narrow = false,
	sample = false,
	initialAccountId,
	onSignOut,
	signedInAs,
	onThemeChoose,
}: ComputeConsoleProps) {
	const viewer = useLoad(() => source.accounts.viewer(), [source]);
	const accounts = useLoad(() => source.accounts.list(), [source]);
	const [accountId, setAccountId] = useState<string | undefined>(() => initialAccountId ?? keptAccount());
	const [dialog, setDialog] = useState<"create" | "join">();

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
	// A page this person can't open goes to Sandboxes rather than showing nothing. Device sign-in has no sidebar item:
	// a terminal running `kantel login` opens it.
	const page =
		(route.page === "hosts" && me !== undefined && !hostsShown) ||
		(route.page === "billing" && !billingShown) ||
		(route.page === "device" && source.devices === undefined)
			? "sandboxes"
			: route.page;

	const failed =
		viewer.state.status === "error" ? viewer.state : accounts.state.status === "error" ? accounts.state : undefined;

	// Admin is the deployment's, not an account's: a super-admin's Hosts, outside the switcher, with a way back.
	const adminShown = hostsShown && superAdmin;
	const inAdmin = adminShown && page === "hosts";
	const adminHref = computePath("hosts", base);
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
		...(ownHostsShown ? [{ id: "hosts", label: "Hosts" }] : []),
		...(billingShown ? [{ id: "billing", label: "Plan and billing" }] : []),
	].map((item) => ({ ...item, href: computePath(item.id as ComputePage, base), selected: page === item.id }));

	// The five pages: the sidebar's on a wide screen, the tab bar's on a phone. Egress is the account's egress proxy
	// until its own page comes; a sandbox's egress log is still one of the sandbox's.
	const pages = [
		{
			id: "sandboxes",
			label: "Sandboxes",
			short: "Sandboxes",
			icon: <SandboxIcon />,
			on: page === "sandboxes" || page === "egress",
		},
		{ id: "snapshots", label: "Snapshots", short: "Snapshots", icon: <SnapshotIcon />, on: page === "snapshots" },
		{
			id: "environments",
			label: "Environments",
			short: "Envs",
			icon: <EnvironmentIcon />,
			on: page === "environments",
		},
		{ id: "proxy", label: "Egress", short: "Egress", icon: <ProxyIcon />, on: page === "proxy" },
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
									<span className="text-xs text-faint">This whole install</span>
								</span>
							</div>
							<SidebarSection label="Admin" heading={false}>
								<SidebarItem icon={<ServerIcon />} label="Hosts" href={adminHref} selected />
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
				{sample ? (
					<p
						className={`kt-sample-banner m-0 border-b border-border bg-status-waiting-soft py-1.5 text-xs text-status-waiting ${narrow ? "px-gutter-narrow" : "px-gutter"}`}
					>
						{source.hosting === "hosted" ? "Hosted demo on sample data." : "Sample data."} Nothing here is real.
					</p>
				) : null}
				{failed !== undefined ? (
					<div className={`grid h-full place-items-center ${narrow ? "p-gutter-narrow" : "p-gutter"}`}>
						<Notice
							level="error"
							action={
								<Button
									size="sm"
									onClick={() => {
										viewer.reload();
										accounts.reload();
									}}
								>
									Try again
								</Button>
							}
						>
							Kantel can't open the console right now. {messageOf(failed.error, "Try again in a moment.")}
						</Notice>
					</div>
				) : account === undefined || me === undefined ? (
					<div className="grid h-full place-items-center">
						<Spinner label="Opening the console" />
					</div>
				) : (
					<div className={narrow ? "p-gutter-narrow" : "p-gutter"}>
						<SettingsFrameFor shown={inSettings} items={settingsItems} narrow={narrow}>
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
				onClose={() => setDialog(undefined)}
				onJoin={async (code) => {
					const joined = await source.accounts.join(code);
					switchTo(joined);
					accounts.reload();
					setDialog(undefined);
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
	onCreate: () => void;
	onJoin: () => void;
	onLeft: () => void;
}): ReactNode {
	const timing = now === undefined ? {} : { now };
	switch (page) {
		case "sandboxes":
			return (
				<SandboxesPage
					source={source.sandboxes}
					snapshots={source.snapshots}
					account={account}
					hosting={source.hosting}
					onSnapshots={(sandboxId) => navigate(computePath("snapshots", base, sandboxId))}
					environments={(accountId) => source.environments.list(accountId)}
					onEgress={(sandboxId) => navigate(computePath("egress", base, sandboxId))}
					creating={new URLSearchParams(search).has("new")}
					narrow={narrow}
					{...(noHosts ? { [ownHosts ? "ownHostHref" : "addHostHref"]: `${computePath("hosts", base)}?add` } : {})}
					{...timing}
				/>
			);
		case "snapshots":
			return (
				<SnapshotsPage
					source={source.snapshots}
					sandboxes={source.sandboxes}
					account={account}
					initialView={
						route.sandboxId === undefined ? { name: "saved" } : { name: "sandbox", sandboxId: route.sandboxId }
					}
					onStartFrom={() => navigate(`${computePath("sandboxes", base)}?new`)}
					{...timing}
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
		case "egress":
			return route.sandboxId === undefined ? null : (
				<EgressPage
					source={source.egress}
					sandboxId={route.sandboxId}
					accountId={account.id}
					sandboxesHref={computePath("sandboxes", base)}
					environmentHref={(id) => computePath("environments", base, id)}
					navigate={navigate}
				/>
			);
		case "keys":
			return <ComputeApiKeysPage source={source.keys} account={account} narrow={narrow} {...timing} />;
		case "proxy":
			return <ProxyPage source={source.proxy} account={account} {...timing} />;
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
		case "hosts":
			return hosts === undefined ? null : (
				<HostsPage
					source={hosts}
					hosting={source.hosting}
					{...(ownHosts ? { owner: account } : {})}
					adding={new URLSearchParams(search).has("add")}
					{...timing}
				/>
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

/** Settings' navigation around a settings page; any other page as it is. */
function SettingsFrameFor({
	shown,
	items,
	narrow,
	children,
}: {
	shown: boolean;
	items: readonly SettingsNavItem[];
	narrow: boolean;
	children: ReactNode;
}): ReactNode {
	return shown ? (
		<SettingsFrame items={items} narrow={narrow}>
			{children}
		</SettingsFrame>
	) : (
		children
	);
}
