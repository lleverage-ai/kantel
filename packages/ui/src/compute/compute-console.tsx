import type { ThemePreference } from "@kantel/contracts";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KantelLockup } from "../brand/kantel.tsx";
import { SignedInAs } from "../identity/signed-in-as.tsx";
import { Button, IconButton } from "../primitives/button.tsx";
import { KeyIcon, XIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import {
	BillingIcon,
	EnvironmentIcon,
	NavMenuIcon,
	OrganisationIcon,
	ProxyIcon,
	SandboxIcon,
	ServerIcon,
	SnapshotIcon,
	TelemetryIcon,
	WebhookIcon,
} from "../primitives/lucide.tsx";
import { Sidebar, SidebarBrand, SidebarItem, SidebarSection, SidebarToggle } from "../primitives/sidebar.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { ThemeMenu, ThemeSwitch } from "../theme/theme-switch.tsx";
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
import { ProxyPage } from "./proxy-page.tsx";
import { SandboxesPage } from "./sandboxes-page.tsx";
import { SnapshotsPage } from "./snapshots-page.tsx";
import { TelemetryPage } from "./telemetry-page.tsx";
import { WebhooksPage } from "./webhooks-page.tsx";

// The compute console: the shell around the compute plane's pages, with the account switcher at the top of its
// sidebar, the account's pages under it, and Hosts for a super-admin. It routes on the path under `base` (the root of
// the console app, `""`) and leaves where the data comes from to its `source`: the sample data in fixtures.ts, or the
// API. A super-admin on a deployment with no host yet is shown the way to add one first.

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
	/** A phone: no sidebar, but a top bar with the logo, the account and a menu that opens the nav as a drawer. */
	readonly narrow?: boolean;
	/** The pages run on sample data: the sidebar says so. */
	readonly sample?: boolean;
	/** The account to open on, for a story; otherwise the last one used, or the personal account. */
	readonly initialAccountId?: string;
	/** Ends the person's session, when they can end it themselves. */
	readonly onSignOut?: () => void;
	/** The sign-in's name and email, when the app knows them better than the source. */
	readonly signedInAs?: { readonly name?: string; readonly email?: string };
	/** The person chose a theme in the sidebar's switch, which has applied it: the app keeps it for them. */
	readonly onThemeChoose?: (preference: ThemePreference) => void;
}

const SHELL = "kt-app grid h-dvh";
const MAIN = "min-h-0 min-w-0 overflow-y-auto";

/** The phone's top bar, in the sidebar's place: the menu, the logo, and the account on the right. */
const TOP_BAR =
	"kt-top-bar flex h-topbar min-w-0 items-center gap-2 border-b border-border bg-panel px-2 [&_.kt-account-switcher]:max-w-full";

/** The nav's drawer on a phone: the sidebar, from the left edge, over a scrim. */
const DRAWER = "kt-nav-drawer fixed inset-0 z-(--kt-z-overlay) flex";
const DRAWER_PANEL = "relative h-full w-sidebar max-w-[85%] shadow-float";
const DRAWER_SCRIM = "absolute inset-0 cursor-default border-0 bg-scrim p-0";

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
	const [railChoice, setRailChoice] = useState(false);
	// A phone has no rail: the whole sidebar opens as a drawer from the top bar's menu.
	const collapsed = !narrow && railChoice;
	const [drawer, setDrawer] = useState(false);
	const drawerRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLButtonElement>(null);
	// The drawer closes on a page change, on a wider window, and on Escape, which hands focus back to the menu button.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new path closes it.
	useEffect(() => setDrawer(false), [pathname, narrow]);
	useEffect(() => {
		if (!drawer) return;
		drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setDrawer(false);
			menuRef.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [drawer]);

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

	const switcher =
		list !== undefined && account !== undefined ? (
			<AccountSwitcher
				accounts={list}
				current={account}
				onSwitch={switchTo}
				onCreate={() => setDialog("create")}
				onJoin={() => setDialog("join")}
				collapsed={collapsed}
			/>
		) : null;

	const sidebar = (
		<Sidebar
			collapsed={collapsed}
			role="complementary"
			aria-label="Compute console"
			className="min-h-0"
			head={
				<>
					<SidebarBrand>
						<KantelLockup className="h-(--kt-brand-sm)" title="Kantel" />
					</SidebarBrand>
					{narrow ? (
						<IconButton
							variant="ghost"
							label="Close the menu"
							icon={<XIcon />}
							onClick={() => {
								setDrawer(false);
								menuRef.current?.focus();
							}}
						/>
					) : (
						<SidebarToggle collapsed={collapsed} onToggle={() => setRailChoice((on) => !on)} />
					)}
				</>
			}
			foot={
				<Foot
					collapsed={collapsed}
					hosting={source.hosting}
					sample={sample}
					viewer={me}
					signedInAs={signedInAs}
					onSignOut={onSignOut}
					onThemeChoose={onThemeChoose}
				/>
			}
		>
			{/* On a phone the account is in the top bar, not repeated in the drawer. */}
			{narrow ? null : <div className={collapsed ? "flex justify-center" : ""}>{switcher}</div>}
			<SidebarSection label="Compute" heading={false}>
				<SidebarItem
					icon={<SandboxIcon />}
					label="Sandboxes"
					href={computePath("sandboxes", base)}
					selected={page === "sandboxes" || page === "egress"}
				/>
				<SidebarItem
					icon={<SnapshotIcon />}
					label="Snapshots"
					href={computePath("snapshots", base)}
					selected={page === "snapshots"}
				/>
				<SidebarItem
					icon={<EnvironmentIcon />}
					label="Environments"
					href={computePath("environments", base)}
					selected={page === "environments"}
				/>
			</SidebarSection>
			<SidebarSection label="Settings">
				<SidebarItem icon={<KeyIcon />} label="API keys" href={computePath("keys", base)} selected={page === "keys"} />
				<SidebarItem
					icon={<ProxyIcon />}
					label="Egress proxy"
					href={computePath("proxy", base)}
					selected={page === "proxy"}
				/>
				<SidebarItem
					icon={<WebhookIcon />}
					label="Webhooks"
					href={computePath("webhooks", base)}
					selected={page === "webhooks"}
				/>
				<SidebarItem
					icon={<TelemetryIcon />}
					label="OpenTelemetry"
					href={computePath("telemetry", base)}
					selected={page === "telemetry"}
				/>
			</SidebarSection>
			<SidebarSection label="Account">
				<SidebarItem
					icon={<OrganisationIcon />}
					label={account?.kind === "organisation" ? "Organisation" : "Organisations"}
					href={computePath("organisation", base)}
					selected={page === "organisation"}
				/>
				{hostsShown && !superAdmin ? (
					<SidebarItem
						icon={<ServerIcon />}
						label="Hosts"
						href={computePath("hosts", base)}
						selected={page === "hosts"}
					/>
				) : null}
				{billingShown ? (
					<SidebarItem
						icon={<BillingIcon />}
						label="Plan and billing"
						href={computePath("billing", base)}
						selected={page === "billing"}
					/>
				) : null}
			</SidebarSection>
			{hostsShown && superAdmin ? (
				<SidebarSection label="Super-admin">
					<SidebarItem
						icon={<ServerIcon />}
						label="Hosts"
						href={computePath("hosts", base)}
						selected={page === "hosts"}
					/>
				</SidebarSection>
			) : null}
		</Sidebar>
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks on the links inside; each link is focusable.
		// biome-ignore lint/a11y/useKeyWithClickEvents: a link's Enter is a click, so the keyboard takes the same path.
		<div
			className={`${SHELL} ${
				narrow
					? "grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
					: collapsed
						? "grid-cols-[var(--kt-rail-width)_minmax(0,1fr)]"
						: "grid-cols-[var(--kt-sidebar-width)_minmax(0,1fr)]"
			}`}
			data-sidebar={narrow ? "drawer" : collapsed ? "collapsed" : undefined}
			onClick={onClick}
		>
			{narrow ? (
				<header className={TOP_BAR}>
					<IconButton
						ref={menuRef}
						variant="ghost"
						label="Open the menu"
						icon={<NavMenuIcon />}
						aria-expanded={drawer}
						aria-controls="kt-nav-drawer"
						onClick={() => setDrawer(true)}
					/>
					<KantelLockup className="h-(--kt-brand-sm) flex-none" title="Kantel" />
					<div className="ml-auto flex min-w-0 max-w-[60%] justify-end">{switcher}</div>
				</header>
			) : (
				sidebar
			)}
			{narrow && drawer ? (
				<div id="kt-nav-drawer" className={DRAWER} role="dialog" aria-modal="true" aria-label="Menu">
					<button
						type="button"
						className={DRAWER_SCRIM}
						aria-label="Close the menu"
						tabIndex={-1}
						onClick={() => setDrawer(false)}
					/>
					<div ref={drawerRef} className={DRAWER_PANEL}>
						{sidebar}
					</div>
				</div>
			) : null}
			<main className={MAIN}>
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
							hosts={hostsSource}
							ownHosts={!superAdmin}
							onCreate={() => setDialog("create")}
							onJoin={() => setDialog("join")}
							onLeft={() => {
								const personal = list?.find((each) => each.kind === "personal");
								if (personal !== undefined) switchTo(personal);
								accounts.reload();
							}}
						/>
					</div>
				)}
			</main>
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
	hosts,
	ownHosts,
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
	/** The hosts this person manages, when there are any to manage. */
	hosts: HostsSource | undefined;
	/** They are the account's own, not the deployment's. */
	ownHosts: boolean;
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
					snapshotsHref={(sandboxId) => computePath("snapshots", base, sandboxId)}
					environments={(accountId) => source.environments.list(accountId)}
					onEgress={(sandboxId) => navigate(computePath("egress", base, sandboxId))}
					creating={new URLSearchParams(search).has("new")}
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
			return <ComputeApiKeysPage source={source.keys} account={account} {...timing} />;
		case "proxy":
			return <ProxyPage source={source.proxy} account={account} {...timing} />;
		case "webhooks":
			return <WebhooksPage source={source.webhooks} account={account} {...timing} />;
		case "telemetry":
			return <TelemetryPage source={source.telemetry} account={account} {...timing} />;
		case "organisation":
			return (
				<OrganisationPage
					source={source.accounts}
					account={account}
					viewerId={viewer.id}
					onCreate={onCreate}
					onJoin={onJoin}
					onLeft={onLeft}
					{...timing}
				/>
			);
		case "billing":
			return source.billing === undefined ? null : (
				<BillingPage source={source.billing} account={account} {...timing} />
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

/** The sidebar's foot: which Kantel this is, the theme switch, and who is signed in. */
function Foot({
	collapsed,
	hosting,
	sample,
	viewer,
	signedInAs,
	onSignOut,
	onThemeChoose,
}: {
	collapsed: boolean;
	hosting: ComputeSource["hosting"];
	sample: boolean;
	viewer: ComputeViewer | undefined;
	signedInAs: { readonly name?: string; readonly email?: string } | undefined;
	onSignOut: (() => void) | undefined;
	onThemeChoose: ((preference: ThemePreference) => void) | undefined;
}) {
	const name = signedInAs?.name ?? viewer?.name;
	const email = signedInAs?.email ?? viewer?.email;
	return (
		<>
			{collapsed ? null : (
				<div className="flex flex-wrap items-center gap-1.5 px-2.5">
					<Badge tone={hosting === "hosted" ? "accent" : "neutral"}>
						{hosting === "hosted" ? "Hosted demo" : "Self-hosted"}
					</Badge>
					{sample ? <Badge tone="waiting">Sample data</Badge> : null}
				</div>
			)}
			{collapsed ? (
				// The rail (and a phone, whose sidebar is always one): the same choices behind an icon.
				<div className="flex justify-center">
					<ThemeMenu {...(onThemeChoose === undefined ? {} : { onChoose: onThemeChoose })} />
				</div>
			) : (
				<div className="flex items-center justify-between gap-2 px-2.5">
					<span className="text-xs text-faint" aria-hidden="true">
						Theme
					</span>
					<ThemeSwitch {...(onThemeChoose === undefined ? {} : { onChoose: onThemeChoose })} />
				</div>
			)}
			<SignedInAs
				{...(name === undefined ? {} : { name })}
				{...(email === undefined ? {} : { email })}
				{...(onSignOut === undefined ? {} : { onSignOut })}
			/>
		</>
	);
}
