// The Egress page (compute console): an account's egress in one place. What sandboxes may reach sits at the top as one
// control; under it, three views. Log: every sandbox's requests through its host's proxy, with what was denied and
// swapped, a denial opening to say why and offer its fixes. Rules: the account's, its environments' and its
// sandboxes' allow and deny rules in one table with what each applies to, and the protected variables with where each
// is swapped in. Settings: the upstream proxy and the log, and at its foot turning the proxy off. HTTPS inspection has
// no setting: the proxy looks inside the HTTPS of the hosts protected variables and method or path rules name, which
// they need. Credentials go on requests as protected variables, bound to hosts; the proxy adds no headers of its own.

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormActions, FormField, FormLayout, FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { type PageTab, PageTabs } from "../primitives/page-tabs.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import type { ComputeAccount, EgressPolicy, ProxySettings, ProxySettingsChange } from "./compute-model.ts";
import { BUSY_TEXT, type ChangeResult, EgressEditor } from "./egress-editor.ts";
import { EgressLog } from "./egress-log.tsx";
import {
	type EgressOverview,
	type EgressOverviewSources,
	type EgressRule,
	type LoggedEntry,
	loadEgressOverview,
	logOf,
	protectedVariablesOf,
	type RuleScope,
	rulesOf,
} from "./egress-overview.ts";
import { AddRuleDialog, EgressRulesTable, type NewRule, ProtectedVariablesTable } from "./egress-rules-table.tsx";
import { computePage, messageOf } from "./parts.tsx";

export type EgressTab = "log" | "rules" | "settings";

export const EGRESS_TABS: readonly EgressTab[] = ["log", "rules", "settings"];

/**
 * The `auth` that removes an upstream proxy's credentials and keeps its URL. `ProxySettingsChange` has no other way
 * to say it: an absent `auth` keeps the credentials, and `upstream: null` drops the proxy altogether.
 */
export const REMOVE_UPSTREAM_AUTH = "";

const POLICIES: readonly { value: EgressPolicy; label: string }[] = [
	{ value: "open", label: "Anything" },
	{ value: "allowlist", label: "Allowed hosts" },
	{ value: "closed", label: "Nothing" },
];

/** What turning the proxy off loses, said where it is turned off and while it is off. */
const OFF_TEXT =
	"Sandboxes go straight out: the policy, the rules for every sandbox and the upstream proxy stop applying. An environment's or a sandbox's own rules, and its protected variables, still do.";

export interface AccountEgressPageProps {
	readonly source: EgressOverviewSources;
	readonly account: ComputeAccount;
	/** The view shown first, from the address. */
	readonly tab?: EgressTab;
	/** A view's address, for its tab's link. */
	readonly tabHref?: (tab: EgressTab) => string;
	/** Told when the person shows another view, to put it in the address. */
	readonly onTab?: (tab: EgressTab) => void;
	/** An environment's page, where its rules and protected variables are edited. */
	readonly environmentHref?: (environmentId: string) => string;
	/** A sandbox's egress, from a rule that is its own. */
	readonly sandboxHref?: (sandboxId: string) => string;
	/** A phone: the log and the rules as two-line rows. */
	readonly narrow?: boolean;
	/** A fixed time, for stories. */
	readonly now?: number;
}

type Dialogs =
	| { readonly kind: "add"; readonly initial?: Partial<Pick<NewRule, "action" | "host" | "scope">> }
	| { readonly kind: "first" }
	| { readonly kind: "closed" }
	| { readonly kind: "off" };

/** Said when a change was saved but the account's egress couldn't be read again after it. */
const UNREFRESHED_TEXT =
	"Saved. Kantel couldn't read the rest of the account's egress again, so some of the page may be out of date.";

export function AccountEgressPage({
	source,
	account,
	tab: initialTab = "log",
	tabHref = (tab) => `?tab=${tab}`,
	onTab,
	environmentHref,
	sandboxHref,
	narrow = false,
	now: fixedNow,
}: AccountEgressPageProps) {
	const { state, reload } = useLoad(() => loadEgressOverview(source, account.id), [source, account.id]);
	const loaded = state.status === "ready" ? state.value : undefined;
	const [busy, setBusy] = useState<string>();
	// What the editor has published, with the editor that published it: another account's, or an earlier read's, is old.
	const [latest, setLatest] = useState<{ readonly editor: EgressEditor; readonly overview: EgressOverview }>();
	// Every change goes through one editor, one at a time, each written from the newest snapshot.
	const editor = useMemo(() => {
		if (loaded === undefined) return undefined;
		const made: EgressEditor = new EgressEditor({
			source,
			accountId: account.id,
			initial: loaded,
			publish: (overview) => setLatest({ editor: made, overview }),
			onBusy: setBusy,
		});
		return made;
	}, [source, account.id, loaded]);
	const [tab, setTab] = useState<EgressTab>(initialTab);
	// The address's tab wins when it changes, as with Back.
	useEffect(() => setTab(initialTab), [initialTab]);
	const [dialog, setDialog] = useState<Dialogs>();
	const [notice, setNotice] = useState<{ level: "info" | "warning" | "error"; text: string }>();
	// Counts the settings saves, so each one empties the form's draft: replacing credentials changes nothing else.
	const [settingsSaves, setSettingsSaves] = useState(0);
	const now = fixedNow ?? Date.now();
	const overview = latest !== undefined && latest.editor === editor ? latest.overview : loaded;

	const header = (
		<PageHeader
			title="Egress"
			actions={
				// On a phone, only over the rules: the log and settings keep the screen for themselves.
				overview === undefined || (narrow && tab !== "rules") ? undefined : (
					<Button
						variant="primary"
						size="md"
						icon={<PlusIcon size="sm" />}
						disabled={busy !== undefined}
						onClick={() => setDialog({ kind: "add" })}
					>
						Add rule
					</Button>
				)
			}
		/>
	);

	if (overview === undefined || editor === undefined) {
		return (
			<div className={computePage}>
				{header}
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the account's egress.")}
					</Notice>
				) : (
					<div className="flex flex-col gap-4" aria-busy="true">
						<Skeleton lines={2} />
						<Skeleton lines={6} />
					</div>
				)}
			</div>
		);
	}

	const proxy = overview.proxy;
	const rules = rulesOf(overview);
	const variables = protectedVariablesOf(overview);
	const log = logOf(overview);

	/** Says how a change went: saved, saved with the page partly out of date, or not run as another was. */
	const report = (result: ChangeResult, done?: string): boolean => {
		if (result.status === "busy") setNotice({ level: "warning", text: BUSY_TEXT });
		else if (result.status === "saved-unrefreshed") setNotice({ level: "warning", text: UNREFRESHED_TEXT });
		else if (done !== undefined) setNotice({ level: "info", text: done });
		return result.status !== "busy";
	};

	/** Runs one of the editor's changes from the page, saying on the page what went wrong. */
	const change = async (run: () => Promise<ChangeResult>, done?: string): Promise<boolean> => {
		setNotice(undefined);
		try {
			return report(await run(), done);
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't save the change. Try again.") });
			return false;
		}
	};

	const updateProxy = (what: string, update: ProxySettingsChange, done?: string) =>
		change(() => editor.updateProxy(what, update), done);

	const choosePolicy = (policy: EgressPolicy) => {
		if (policy === proxy.policy || busy !== undefined) return;
		if (policy === "closed") {
			setDialog({ kind: "closed" });
			return;
		}
		// With no host allowed for every sandbox, Kantel's API reads Allowed hosts back as Nothing: ask for the first.
		if (policy === "allowlist" && proxy.allow.length === 0) {
			setDialog({ kind: "first" });
			return;
		}
		void change(() => editor.choosePolicy(policy));
	};

	const removeRule = (rule: EgressRule) => void change(() => editor.removeRule(rule));

	/** A dialog's change: what went wrong stays in the dialog, which stays open. */
	const fromDialog = async (run: () => Promise<ChangeResult>): Promise<void> => {
		const result = await run();
		if (result.status === "busy") throw new Error(BUSY_TEXT);
		report(result);
		setDialog(undefined);
	};

	const addRule = async (rule: NewRule): Promise<void> => {
		await fromDialog(() => editor.addRule(rule));
		setTab("rules");
		onTab?.("rules");
	};

	const scopes: RuleScope[] = [
		{ kind: "account" },
		...overview.environments.map((env) => ({ kind: "environment" as const, id: env.id, name: env.name })),
		...overview.sandboxes.map((box) => ({ kind: "sandbox" as const, id: box.sandboxId, name: box.sandboxName })),
	];

	const allowFrom = (entry: LoggedEntry) =>
		setDialog({
			kind: "add",
			initial: {
				action: "allow",
				host: entry.host,
				// The narrowest place: the sandbox that asked.
				scope: { kind: "sandbox", id: entry.sandboxId, name: entry.sandboxName },
			},
		});

	const show = (next: EgressTab) => {
		setTab(next);
		onTab?.(next);
	};
	const tabs: PageTab[] = [
		{ id: "log", label: "Log" },
		{ id: "rules", label: "Rules", count: rules.length },
		{ id: "settings", label: "Settings" },
	].map((each) => ({ ...each, href: tabHref(each.id as EgressTab), selected: each.id === tab }));

	const scopeHref = (scope: RuleScope): string | undefined =>
		scope.kind === "environment"
			? environmentHref?.(scope.id)
			: scope.kind === "sandbox"
				? sandboxHref?.(scope.id)
				: undefined;

	return (
		<div className={computePage}>
			{header}
			<PolicyControl policy={proxy.policy} busy={busy === "policy"} narrow={narrow} onChange={choosePolicy} />
			{proxy.enabled ? null : (
				<Notice
					level="warning"
					action={
						<Button
							size="sm"
							busy={busy === "enabled"}
							onClick={() => void updateProxy("enabled", { enabled: true }, "The proxy is on.")}
						>
							Turn on
						</Button>
					}
				>
					The proxy is off. {OFF_TEXT}
				</Notice>
			)}
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
			<div className="flex min-w-0 flex-col gap-4">
				<PageTabs label="Egress" tabs={tabs} onSelect={(id) => show(id as EgressTab)} />
				{tab === "log" ? (
					<div className="flex min-w-0 flex-col gap-3">
						{overview.unread.length === 0 ? null : (
							<Notice
								level="warning"
								action={
									<Button size="sm" disabled={busy !== undefined} onClick={() => void change(() => editor.refresh())}>
										Try again
									</Button>
								}
							>
								Kantel couldn't read the log of {overview.unread.join(", ")}.
							</Notice>
						)}
						<EgressLog
							entries={log}
							variables={variables}
							now={now}
							narrow={narrow}
							onAllow={allowFrom}
							emptyText={
								overview.sandboxes.length === 0
									? "No sandboxes yet: their requests will show here."
									: "Nothing has left a sandbox yet."
							}
							{...(environmentHref === undefined ? {} : { environmentHref })}
						/>
					</div>
				) : tab === "rules" ? (
					<div className="flex min-w-0 flex-col gap-6">
						<EgressRulesTable
							rules={rules}
							narrow={narrow}
							scopeHref={scopeHref}
							onRemove={removeRule}
							{...(busy === undefined ? {} : { busy })}
						/>
						<section className="flex min-w-0 flex-col gap-2" aria-labelledby="egress-protected-title">
							<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
								<h2 id="egress-protected-title" className="m-0 text-sm font-strong leading-tight text-fg">
									Protected variables
								</h2>
								{narrow ? null : (
									<p className="m-0 text-sm text-muted">
										Sandboxes hold a placeholder. Kantel swaps in the value only for these hosts.
									</p>
								)}
							</div>
							<ProtectedVariablesTable
								variables={variables}
								narrow={narrow}
								{...(environmentHref === undefined ? {} : { environmentHref })}
							/>
						</section>
					</div>
				) : (
					<SettingsView
						key={`${settingsKey(proxy)}|${settingsSaves}`}
						proxy={proxy}
						busy={busy}
						onSave={async (update) => {
							const ok = await updateProxy("settings", update, "Saved. Every host has it within a few seconds.");
							if (ok) setSettingsSaves((count) => count + 1);
							return ok;
						}}
						onTurnOff={() => setDialog({ kind: "off" })}
						onTurnOn={() => void updateProxy("enabled", { enabled: true }, "The proxy is on.")}
					/>
				)}
			</div>

			{dialog?.kind === "add" ? (
				<AddRuleDialog
					scopes={scopes}
					closed={proxy.policy === "closed"}
					{...(dialog.initial === undefined ? {} : { initial: dialog.initial })}
					onClose={() => setDialog(undefined)}
					onAdd={addRule}
				/>
			) : null}
			{dialog?.kind === "first" ? (
				<AddRuleDialog
					scopes={scopes}
					firstHost
					onClose={() => setDialog(undefined)}
					onAdd={(rule) => fromDialog(() => editor.choosePolicy("allowlist", rule.host))}
				/>
			) : null}
			{dialog?.kind === "closed" ? (
				<ConfirmDialog
					title="Allow nothing?"
					confirm="Allow nothing"
					busy={busy === "policy"}
					onClose={() => setDialog(undefined)}
					onConfirm={async () => {
						const ok = await updateProxy("policy", { policy: "closed" });
						if (ok) setDialog(undefined);
					}}
				>
					<p className="m-0">
						Sandboxes may reach no host but those an environment's or a sandbox's own rule allows. Running sandboxes
						lose the rest within a few seconds.
					</p>
					{proxy.allow.length === 0 ? null : (
						<p className="m-0">
							The {proxy.allow.length === 1 ? "rule" : `${proxy.allow.length} rules`} allowing hosts for every sandbox{" "}
							{proxy.allow.length === 1 ? "is" : "are"} removed.
						</p>
					)}
				</ConfirmDialog>
			) : null}
			{dialog?.kind === "off" ? (
				<ConfirmDialog
					title="Turn off the proxy?"
					confirm="Turn off"
					busy={busy === "enabled"}
					onClose={() => setDialog(undefined)}
					onConfirm={async () => {
						// The warning over the page says so: no notice of its own.
						const ok = await updateProxy("enabled", { enabled: false });
						if (ok) setDialog(undefined);
					}}
				>
					<p className="m-0">{OFF_TEXT}</p>
				</ConfirmDialog>
			) : null}
		</div>
	);
}

/** The settings form starts again from what was saved. */
const settingsKey = (proxy: ProxySettings): string =>
	`${proxy.upstream?.url ?? ""}|${proxy.upstream?.authSet === true}|${proxy.logRequests ?? ""}|${proxy.enabled}`;

/** "Sandboxes may reach": the policy, applied the moment it is chosen. */
function PolicyControl({
	policy,
	busy,
	narrow,
	onChange,
}: {
	policy: EgressPolicy;
	busy: boolean;
	narrow: boolean;
	onChange: (policy: EgressPolicy) => void;
}) {
	return (
		<div
			className={
				narrow ? "flex min-w-0 flex-col items-start gap-2" : "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
			}
			aria-busy={busy || undefined}
		>
			<span className="text-sm font-medium text-fg" aria-hidden="true">
				Sandboxes may reach
			</span>
			<SegmentedControl label="Sandboxes may reach" options={POLICIES} value={policy} onChange={onChange} />
			{narrow ? null : (
				<span className="text-sm text-muted">Deny wins. The cloud metadata address is always blocked.</span>
			)}
		</div>
	);
}

/** An upstream proxy's URL: http or https. */
function upstreamProblem(url: string): string | undefined {
	if (url === "") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "Write the whole URL, such as https://gateway.example.com:8443.";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http or https URL.";
	return undefined;
}

/**
 * Settings: the upstream proxy and the log, one Save for both; turning the proxy off or on at the foot. While a save
 * runs, through the read after it, the draft can't change: the page starts the form again from what was saved, which
 * would drop anything typed meanwhile.
 */
export function SettingsView({
	proxy,
	busy,
	onSave,
	onTurnOff,
	onTurnOn,
}: {
	proxy: ProxySettings;
	busy: string | undefined;
	onSave: (change: ProxySettingsChange) => Promise<boolean>;
	onTurnOff: () => void;
	onTurnOn: () => void;
}) {
	const [url, setUrl] = useState(proxy.upstream?.url ?? "");
	// The credentials field shows when none are set, and after Replace when they are.
	const [authEditing, setAuthEditing] = useState(proxy.upstream?.authSet !== true);
	const [auth, setAuth] = useState("");
	const [authRemoved, setAuthRemoved] = useState(false);
	const [logRequests, setLogRequests] = useState(proxy.logRequests);

	const trimmed = url.trim();
	const newAuth = authEditing && auth !== "" ? auth : undefined;
	const urlError = upstreamProblem(trimmed);
	const authError =
		trimmed === "" && newAuth !== undefined ? "Add the proxy's URL to send these credentials to it." : undefined;
	const before = proxy.upstream;
	const upstreamChanged =
		trimmed === "" ? before !== undefined : trimmed !== before?.url || newAuth !== undefined || authRemoved;
	const update: ProxySettingsChange = {
		...(upstreamChanged
			? {
					upstream:
						trimmed === ""
							? null
							: {
									url: trimmed,
									...(newAuth !== undefined ? { auth: newAuth } : authRemoved ? { auth: REMOVE_UPSTREAM_AUTH } : {}),
								},
				}
			: {}),
		...(logRequests === proxy.logRequests || logRequests === undefined ? {} : { logRequests }),
	};
	const changed = Object.keys(update).length > 0;
	const invalid = urlError !== undefined || authError !== undefined;
	const saving = busy === "settings";
	// Read-only rather than disabled, so the field keeps the focus it has.
	const locked = saving ? { readOnly: true, "aria-readonly": true } : {};
	const discard = () => {
		setUrl(proxy.upstream?.url ?? "");
		setAuthEditing(proxy.upstream?.authSet !== true);
		setAuth("");
		setAuthRemoved(false);
		setLogRequests(proxy.logRequests);
	};

	return (
		<div className="flex max-w-content min-w-0 flex-col gap-8">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (changed && !invalid && !saving) void onSave(update);
				}}
			>
				<FormLayout>
					<FormSection
						title="Upstream proxy"
						description="Send every request on through a proxy of your own, such as a gateway that adds credentials."
					>
						<TextField
							label="URL"
							extra={<span className="text-xs text-faint">optional</span>}
							hint="An http or https proxy. Leave it empty to go straight out."
							value={url}
							onChange={(event) => setUrl(event.currentTarget.value)}
							placeholder="https://gateway.example.com:8443"
							mono
							spellCheck={false}
							{...locked}
							{...(urlError === undefined ? {} : { error: urlError })}
						/>
						{authEditing ? (
							<TextField
								label="Credentials"
								hint="user:password or a token. Kantel never shows it again."
								type="password"
								autoComplete="off"
								value={auth}
								onChange={(event) => setAuth(event.currentTarget.value)}
								mono
								{...locked}
								{...(authError === undefined ? {} : { error: authError })}
								{...(proxy.upstream?.authSet === true
									? {
											extra: (
												<Button
													size="xs"
													variant="ghost"
													disabled={saving}
													onClick={() => {
														setAuthEditing(false);
														setAuth("");
													}}
												>
													Keep the current ones
												</Button>
											),
										}
									: {})}
							/>
						) : (
							<FormField
								id="egress-upstream-auth"
								label="Credentials"
								hint={authRemoved ? "Removed when you save." : "Write-only: Kantel never shows them."}
							>
								<span className="flex flex-wrap items-center gap-2">
									{authRemoved ? <Badge tone="error">Removed</Badge> : <Badge tone="done">Set</Badge>}
									{authRemoved ? (
										<Button size="xs" variant="ghost" disabled={saving} onClick={() => setAuthRemoved(false)}>
											Undo
										</Button>
									) : (
										<>
											<Button
												size="xs"
												disabled={saving}
												onClick={() => {
													setAuthEditing(true);
													setAuth("");
												}}
											>
												Replace
											</Button>
											<Button size="xs" variant="ghost" disabled={saving} onClick={() => setAuthRemoved(true)}>
												Remove
											</Button>
										</>
									)}
								</span>
							</FormField>
						)}
					</FormSection>
					<FormSection title="Log">
						{logRequests === undefined ? (
							<p className="m-0 text-sm text-muted">Kantel keeps each sandbox's newest requests.</p>
						) : (
							<Switch
								label="Log every request"
								checked={logRequests}
								disabled={saving}
								onChange={setLogRequests}
								hint="The host, method, status and size of each request, on the Log tab."
							/>
						)}
					</FormSection>
					<FormActions>
						<Button type="submit" variant="primary" busy={saving} disabled={!changed || invalid}>
							Save
						</Button>
						<Button variant="ghost" disabled={!changed || saving} onClick={discard}>
							Discard
						</Button>
					</FormActions>
				</FormLayout>
			</form>
			{proxy.enabled ? (
				<SwitchSection
					title="Turn off the proxy"
					description={OFF_TEXT}
					action={
						<Button variant="danger" size="sm" disabled={busy !== undefined} onClick={onTurnOff}>
							Turn off
						</Button>
					}
				/>
			) : (
				<SwitchSection
					title="The proxy is off"
					description="Turn it on to apply the policy, the rules for every sandbox and the upstream proxy again."
					action={
						<Button size="sm" busy={busy === "enabled"} disabled={busy !== undefined} onClick={onTurnOn}>
							Turn on
						</Button>
					}
				/>
			)}
		</div>
	);
}

/** The proxy's own switch, at the foot of Settings: what it does, and the one button beside it. */
function SwitchSection({ title, description, action }: { title: string; description: string; action: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2 border-t border-border pt-6" aria-labelledby="egress-switch-title">
			<h3 id="egress-switch-title" className="m-0 text-sm font-medium leading-tight text-fg">
				{title}
			</h3>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<p className="m-0 min-w-0 flex-[1_1_var(--kt-card-width)] text-sm text-muted">{description}</p>
				{action}
			</div>
		</section>
	);
}

/** A yes or no on a change that takes something away, with what it takes. */
function ConfirmDialog({
	title,
	confirm,
	busy,
	onClose,
	onConfirm,
	children,
}: {
	title: string;
	confirm: string;
	busy: boolean;
	onClose: () => void;
	onConfirm: () => Promise<void>;
	children: ReactNode;
}) {
	return (
		<Dialog
			open
			title={title}
			onClose={onClose}
			onSubmit={() => void onConfirm()}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="danger" busy={busy}>
						{confirm}
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-2 pt-1 text-sm text-muted">{children}</div>
		</Dialog>
	);
}
