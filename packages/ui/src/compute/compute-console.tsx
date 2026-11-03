import { type MouseEvent, type ReactNode, useCallback, useMemo, useState } from "react";
import { KantelLockup } from "../brand/kantel.tsx";
import { SignedInAs } from "../identity/signed-in-as.tsx";
import { Button } from "../primitives/button.tsx";
import { KeyIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import {
	BillingIcon,
	EnvironmentIcon,
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
import { AccountSwitcher, CreateOrganisationDialog, JoinOrganisationDialog } from "./account-switcher.tsx";
import { ComputeApiKeysPage } from "./api-keys-page.tsx";
import { BillingPage } from "./billing-page.tsx";
import type { ComputeAccount, ComputeSource, ComputeViewer } from "./compute-model.ts";
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
	/** A phone: the sidebar is a rail. */
	readonly narrow?: boolean;
	/** The pages run on sample data: the sidebar says so. */
	readonly sample?: boolean;
	/** The account to open on, for a story; otherwise the last one used, or the personal account. */
	readonly initialAccountId?: string;
	/** Ends the person's session, when they can end it themselves. */
	readonly onSignOut?: () => void;
	/** The sign-in's name and email, when the app knows them better than the source. */
	readonly signedInAs?: { readonly name?: string; readonly email?: string };
}

const SHELL = "kt-app grid h-dvh";
const MAIN = "min-h-0 min-w-0 overflow-y-auto";

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
}: ComputeConsoleProps) {
	const viewer = useLoad(() => source.accounts.viewer(), [source]);
	const accounts = useLoad(() => source.accounts.list(), [source]);
	const [accountId, setAccountId] = useState<string | undefined>(() => initialAccountId ?? keptAccount());
	const [dialog, setDialog] = useState<"create" | "join">();
	const [railChoice, setRailChoice] = useState(false);
	const collapsed = narrow || railChoice;

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
	const hostsShown = me?.superAdmin === true && source.hosts !== undefined;
	// Whether the deployment has a host yet, for a super-admin: with none, Sandboxes leads to adding one. Read again on
	// every page change, so a host added on Hosts counts once the person goes back.
	const hosts = useLoad(
		() => (hostsShown && source.hosts !== undefined ? source.hosts.list() : Promise.resolve(undefined)),
		[source, hostsShown, pathname],
	);
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

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegates clicks on the links inside; each link is focusable.
		// biome-ignore lint/a11y/useKeyWithClickEvents: a link's Enter is a click, so the keyboard takes the same path.
		<div
			className={`${SHELL} ${collapsed ? "grid-cols-[var(--kt-rail-width)_minmax(0,1fr)]" : "grid-cols-[var(--kt-sidebar-width)_minmax(0,1fr)]"}`}
			data-sidebar={collapsed ? "collapsed" : undefined}
			onClick={onClick}
		>
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
						{narrow ? null : <SidebarToggle collapsed={collapsed} onToggle={() => setRailChoice((on) => !on)} />}
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
					/>
				}
			>
				<div className={collapsed ? "flex justify-center" : ""}>
					{list !== undefined && account !== undefined ? (
						<AccountSwitcher
							accounts={list}
							current={account}
							onSwitch={switchTo}
							onCreate={() => setDialog("create")}
							onJoin={() => setDialog("join")}
							collapsed={collapsed}
						/>
					) : null}
				</div>
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
					<SidebarItem
						icon={<KeyIcon />}
						label="API keys"
						href={computePath("keys", base)}
						selected={page === "keys"}
					/>
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
					{billingShown ? (
						<SidebarItem
							icon={<BillingIcon />}
							label="Plan and billing"
							href={computePath("billing", base)}
							selected={page === "billing"}
						/>
					) : null}
				</SidebarSection>
				{hostsShown ? (
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
	/** A super-admin's deployment has no host yet. */
	noHosts: boolean;
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
					{...(noHosts ? { addHostHref: `${computePath("hosts", base)}?add` } : {})}
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
			return source.hosts === undefined ? null : (
				<HostsPage
					source={source.hosts}
					hosting={source.hosting}
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

/** The sidebar's foot: which Kantel this is, and who is signed in. */
function Foot({
	collapsed,
	hosting,
	sample,
	viewer,
	signedInAs,
	onSignOut,
}: {
	collapsed: boolean;
	hosting: ComputeSource["hosting"];
	sample: boolean;
	viewer: ComputeViewer | undefined;
	signedInAs: { readonly name?: string; readonly email?: string } | undefined;
	onSignOut: (() => void) | undefined;
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
			<SignedInAs
				{...(name === undefined ? {} : { name })}
				{...(email === undefined ? {} : { email })}
				{...(onSignOut === undefined ? {} : { onSignOut })}
			/>
		</>
	);
}
