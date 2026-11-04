// The Egress proxy page (compute console, experimental): one form for an account's proxy, the one every sandbox's
// requests to the internet go through on its host. It says what sandboxes may reach (open, an allow list or closed,
// with a deny list over all three), sends their traffic on through an upstream proxy, inspects HTTPS so it can add
// headers holding credentials the sandbox never sees, and keeps a request log. One Save sends only what changed.
// Under the form, the recent requests through it. Every call goes through the `ProxySource` the host binds.

import { type KeyboardEvent, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, TextAreaField, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormGrid, FormLayout, FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { TrashIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import {
	bytesText,
	type ComputeAccount,
	type EgressPolicy,
	type InjectedHeader,
	type ProxyRequest,
	type ProxySettings,
	type ProxySettingsChange,
	type ProxySource,
} from "./compute-model.ts";
import { cellMono, computePage, messageOf, SectionHeading, TableFrame, table, tableFrame, td, th } from "./parts.tsx";

export interface ProxyPageProps {
	readonly source: ProxySource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
}

/**
 * The `auth` that removes an upstream proxy's credentials and keeps its URL. `ProxySettingsChange` has no other way
 * to say it: an absent `auth` keeps the credentials, and `upstream: null` drops the proxy altogether.
 */
export const REMOVE_UPSTREAM_AUTH = "";

const POLICIES: readonly { value: EgressPolicy; label: string; help: string }[] = [
	{ value: "open", label: "Open", help: "Sandboxes may reach any host but those on the deny list." },
	{ value: "allowlist", label: "Allow list", help: "Sandboxes may reach only the hosts on the allow list." },
	{ value: "closed", label: "Closed", help: "Sandboxes can't reach the internet at all." },
];

/** A host name or an address, optionally `*.` for every subdomain, with an optional port. */
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/i;

/** Why a host in a list or a header row isn't one, or undefined when it is. */
function hostProblem(host: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return "has a scheme. Write the host alone, such as api.github.com.";
	if (host.includes("/")) return "has a path. Write the host alone, with no slash.";
	if (!HOST_PATTERN.test(host)) return "isn't a host name.";
	return undefined;
}

/** A list field's text as hosts, one per line, blank lines skipped; or what's wrong with the first bad line. */
function parseHostList(text: string): { readonly hosts: readonly string[]; readonly error?: string } {
	const hosts: string[] = [];
	const lines = text.split("\n");
	for (const [at, raw] of lines.entries()) {
		const host = raw.trim();
		if (host === "") continue;
		const problem = hostProblem(host);
		if (problem !== undefined) return { hosts, error: `Line ${at + 1} ${problem}` };
		hosts.push(host);
	}
	return { hosts };
}

/** An upstream proxy's URL: http or https, with nothing after the host but a port. */
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

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** The form's fields as typed, before they're checked. */
interface ProxyDraft {
	readonly enabled: boolean;
	readonly policy: EgressPolicy;
	readonly allow: string;
	readonly deny: string;
	readonly upstreamUrl: string;
	/** The upstream's credentials field is showing: always when none are set, after Replace when they are. */
	readonly authEditing: boolean;
	readonly auth: string;
	readonly authRemoved: boolean;
	readonly tlsInspection: boolean;
	readonly headers: readonly InjectedHeader[];
	readonly logRequests: boolean;
}

const draftOf = (settings: ProxySettings): ProxyDraft => ({
	enabled: settings.enabled,
	policy: settings.policy,
	allow: settings.allow.join("\n"),
	deny: settings.deny.join("\n"),
	upstreamUrl: settings.upstream?.url ?? "",
	authEditing: settings.upstream?.authSet !== true,
	auth: "",
	authRemoved: false,
	tlsInspection: settings.tlsInspection,
	headers: settings.headers,
	logRequests: settings.logRequests,
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((entry, at) => entry === b[at]);

interface DraftCheck {
	readonly change: ProxySettingsChange;
	readonly errors: {
		readonly allow?: string;
		readonly deny?: string;
		readonly upstreamUrl?: string;
		readonly auth?: string;
	};
}

/** What the draft changes against the saved settings, and what's wrong with it. */
function checkDraft(settings: ProxySettings, draft: ProxyDraft): DraftCheck {
	const allow = parseHostList(draft.allow);
	const deny = parseHostList(draft.deny);
	const url = draft.upstreamUrl.trim();
	const auth = draft.authEditing && draft.auth !== "" ? draft.auth : undefined;
	const urlError = upstreamProblem(url);
	const authError =
		url === "" && auth !== undefined ? "Add the proxy's URL to send these credentials to it." : undefined;
	const before = settings.upstream;
	const upstreamChanged =
		url === "" ? before !== undefined : url !== before?.url || auth !== undefined || draft.authRemoved;
	const upstream: ProxySettingsChange["upstream"] =
		url === ""
			? null
			: {
					url,
					...(auth !== undefined ? { auth } : draft.authRemoved ? { auth: REMOVE_UPSTREAM_AUTH } : {}),
				};
	const headersChanged =
		draft.headers.length !== settings.headers.length ||
		draft.headers.some((header, at) => header.id !== settings.headers[at]?.id);
	return {
		change: {
			...(draft.enabled === settings.enabled ? {} : { enabled: draft.enabled }),
			...(draft.policy === settings.policy ? {} : { policy: draft.policy }),
			...(allow.error !== undefined || sameList(allow.hosts, settings.allow) ? {} : { allow: allow.hosts }),
			...(deny.error !== undefined || sameList(deny.hosts, settings.deny) ? {} : { deny: deny.hosts }),
			...(upstreamChanged ? { upstream } : {}),
			...(draft.tlsInspection === settings.tlsInspection ? {} : { tlsInspection: draft.tlsInspection }),
			...(headersChanged ? { headers: draft.headers } : {}),
			...(draft.logRequests === settings.logRequests ? {} : { logRequests: draft.logRequests }),
		},
		errors: {
			...(allow.error === undefined ? {} : { allow: allow.error }),
			...(deny.error === undefined ? {} : { deny: deny.error }),
			...(urlError === undefined ? {} : { upstreamUrl: urlError }),
			...(authError === undefined ? {} : { auth: authError }),
		},
	};
}

export function ProxyPage({ source, account, now: fixedNow }: ProxyPageProps) {
	const { state, reload } = useLoad(() => source.get(account.id), [source, account.id]);
	const recent = useLoad(() => source.recent(account.id), [source, account.id]);
	// The settings a Save answered with, ahead of any read; the form starts again from them.
	const [saved, setSaved] = useState<ProxySettings>();
	const [revision, setRevision] = useState(0);
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const now = fixedNow ?? Date.now();

	const settings =
		saved !== undefined && saved.accountId === account.id ? saved : state.status === "ready" ? state.value : undefined;

	const unread = state.status === "error" && settings === undefined;

	const save = async (change: ProxySettingsChange): Promise<void> => {
		setNotice(undefined);
		try {
			const next = await source.update(account.id, change);
			setSaved(next);
			setRevision((value) => value + 1);
			setNotice({ level: "info", text: "Saved the proxy settings." });
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't save the proxy settings. Try again.") });
		}
	};

	return (
		<div className={computePage}>
			<PageHeader
				title="Egress proxy"
				lede="Every request a sandbox makes to the internet goes through the proxy on its host. Choose what sandboxes may reach, send their traffic on through your own gateway, and add credentials on the way out so they never sit in a sandbox."
			/>
			{unread ? (
				// One notice for the page: the request log is read again with the settings.
				<Notice
					level="error"
					action={
						<Button
							size="sm"
							onClick={() => {
								reload();
								recent.reload();
							}}
						>
							Try again
						</Button>
					}
				>
					{messageOf(state.status === "error" ? state.error : undefined, "Kantel couldn't read the proxy settings.")}
				</Notice>
			) : settings === undefined ? (
				<FormSkeleton />
			) : (
				<ProxyForm
					key={`${account.id}-${revision}`}
					settings={settings}
					notice={notice}
					onDismissNotice={() => setNotice(undefined)}
					onSave={save}
				/>
			)}
			{unread ? null : (
				<div className="mt-4 flex min-w-0 flex-col gap-2">
					<SectionHeading id="proxy-recent-title" title="Recent requests" />
					{recent.state.status === "error" ? (
						<Notice
							level="error"
							action={
								<Button size="sm" onClick={recent.reload}>
									Try again
								</Button>
							}
						>
							{messageOf(recent.state.error, "Kantel couldn't read the request log.")}
						</Notice>
					) : recent.state.status === "loading" ? (
						<TableSkeleton />
					) : recent.state.value.length === 0 ? (
						<p className="m-0 text-sm text-muted">
							{settings?.logRequests === false
								? "No requests logged. Turn on the request log to keep one."
								: "No requests through the proxy yet."}
						</p>
					) : (
						<RequestsTable requests={recent.state.value} now={now} />
					)}
				</div>
			)}
		</div>
	);
}

function FormSkeleton() {
	return (
		<div className="flex max-w-content flex-col gap-4" aria-busy="true">
			{[0, 1, 2, 3].map((row) => (
				<Skeleton key={row} lines={2} />
			))}
		</div>
	);
}

function TableSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function ProxyForm({
	settings,
	notice,
	onDismissNotice,
	onSave,
}: {
	settings: ProxySettings;
	notice: { level: "info" | "error"; text: string } | undefined;
	onDismissNotice: () => void;
	onSave: (change: ProxySettingsChange) => Promise<void>;
}) {
	const [draft, setDraft] = useState<ProxyDraft>(() => draftOf(settings));
	const [busy, setBusy] = useState(false);
	const set = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));
	const { change, errors } = checkDraft(settings, draft);
	const changed = Object.keys(change).length > 0;
	const invalid = Object.keys(errors).length > 0;
	const policy = POLICIES.find((entry) => entry.value === draft.policy) ?? POLICIES[0];

	const submit = () => {
		if (!changed || invalid) return;
		setBusy(true);
		void onSave(change).finally(() => setBusy(false));
	};

	return (
		<form
			className="max-w-content"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<FormLayout>
				<FormSection title="Proxy">
					<Switch
						label="Enabled"
						checked={draft.enabled}
						onChange={(value) => set("enabled", value)}
						hint="Off, sandboxes reach the internet directly: no rules, no added headers and no log."
					/>
				</FormSection>
				<FormSection title="What sandboxes may reach">
					<FormField id="proxy-policy" label="Policy" hint={policy?.help}>
						<SegmentedControl
							label="Policy"
							options={POLICIES.map(({ value, label }) => ({ value, label }))}
							value={draft.policy}
							onChange={(value) => set("policy", value)}
						/>
					</FormField>
					{draft.policy === "allowlist" ? (
						<TextAreaField
							label="Allow list"
							hint="One host per line. *.example.com covers every subdomain of example.com."
							value={draft.allow}
							onChange={(event) => set("allow", event.currentTarget.value)}
							rows={5}
							mono
							spellCheck={false}
							{...(errors.allow === undefined ? {} : { error: errors.allow })}
						/>
					) : null}
					<TextAreaField
						label="Deny list"
						hint="Hosts that are never reachable, whatever the policy. One per line; wildcards work here too. The cloud metadata address is always blocked."
						value={draft.deny}
						onChange={(event) => set("deny", event.currentTarget.value)}
						rows={3}
						mono
						spellCheck={false}
						{...(errors.deny === undefined ? {} : { error: errors.deny })}
					/>
				</FormSection>
				<FormSection
					title="Upstream proxy"
					description="Send every request on through a proxy of your own. A gateway that adds credentials, such as Mehen, fits here."
				>
					<TextField
						label="URL"
						hint="An http or https proxy. Leave it empty to go straight out."
						value={draft.upstreamUrl}
						onChange={(event) => set("upstreamUrl", event.currentTarget.value)}
						placeholder="https://gateway.example.com:8443"
						mono
						spellCheck={false}
						{...(errors.upstreamUrl === undefined ? {} : { error: errors.upstreamUrl })}
					/>
					{draft.authEditing ? (
						<TextField
							label="Credentials"
							hint="user:password or a token. Kantel never shows it again."
							type="password"
							autoComplete="off"
							value={draft.auth}
							onChange={(event) => set("auth", event.currentTarget.value)}
							mono
							{...(errors.auth === undefined ? {} : { error: errors.auth })}
							{...(settings.upstream?.authSet === true
								? {
										extra: (
											<Button
												size="xs"
												variant="ghost"
												onClick={() => setDraft((current) => ({ ...current, authEditing: false, auth: "" }))}
											>
												Keep the current ones
											</Button>
										),
									}
								: {})}
						/>
					) : (
						<FormField
							id="proxy-upstream-auth"
							label="Credentials"
							hint={draft.authRemoved ? "Removed when you save." : "Write-only: Kantel never shows them."}
						>
							<span className="flex flex-wrap items-center gap-2">
								{draft.authRemoved ? <Badge tone="error">Removed</Badge> : <Badge tone="done">Set</Badge>}
								{draft.authRemoved ? (
									<Button size="xs" variant="ghost" onClick={() => set("authRemoved", false)}>
										Undo
									</Button>
								) : (
									<>
										<Button
											size="xs"
											onClick={() => setDraft((current) => ({ ...current, authEditing: true, auth: "" }))}
										>
											Replace
										</Button>
										<Button size="xs" variant="ghost" onClick={() => set("authRemoved", true)}>
											Remove
										</Button>
									</>
								)}
							</span>
						</FormField>
					)}
				</FormSection>
				<FormSection title="HTTPS inspection">
					<CheckboxField
						label="Inspect HTTPS requests"
						hint="Sandboxes trust Kantel's CA, so the proxy can add headers to HTTPS requests as well as plain HTTP."
						checked={draft.tlsInspection}
						onChange={(event) => set("tlsInspection", event.currentTarget.checked)}
					/>
				</FormSection>
				<FormSection
					title="Added headers"
					description="The proxy adds these to requests for a host. Sandboxes never see the values."
				>
					<HeadersEditor
						headers={draft.headers}
						tlsInspection={draft.tlsInspection}
						onChange={(headers) => set("headers", headers)}
					/>
				</FormSection>
				<FormSection title="Request log">
					<CheckboxField
						label="Log every request"
						hint="Keeps the host, method, status and size of each request, as in Recent requests below."
						checked={draft.logRequests}
						onChange={(event) => set("logRequests", event.currentTarget.checked)}
					/>
				</FormSection>
				<Notice announce={false}>Saved settings reach every host within a few seconds.</Notice>
				{notice === undefined ? null : (
					<Notice
						level={notice.level}
						action={
							<Button size="xs" variant="ghost" onClick={onDismissNotice}>
								Dismiss
							</Button>
						}
					>
						{notice.text}
					</Notice>
				)}
				<FormActions>
					<Button type="submit" variant="primary" busy={busy} disabled={!changed || invalid}>
						Save
					</Button>
					<Button
						variant="ghost"
						disabled={!changed || busy}
						onClick={() => {
							setDraft(draftOf(settings));
							onDismissNotice();
						}}
					>
						Discard
					</Button>
				</FormActions>
			</FormLayout>
		</form>
	);
}

let newHeaders = 0;

/** The added headers as a table, each with Remove, and a row of fields to add one. Values are write-only. */
function HeadersEditor({
	headers,
	tlsInspection,
	onChange,
}: {
	headers: readonly InjectedHeader[];
	tlsInspection: boolean;
	onChange: (headers: readonly InjectedHeader[]) => void;
}) {
	const [host, setHost] = useState("");
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [tried, setTried] = useState(false);
	const hostIssue = host.trim() === "" ? undefined : hostProblem(host.trim());
	const hostError =
		host.trim() === "" ? "Give the host." : hostIssue === undefined ? undefined : `The host ${hostIssue}`;
	const nameError =
		name.trim() === ""
			? "Give the header's name."
			: HEADER_NAME.test(name.trim())
				? undefined
				: "A header name has letters, digits and dashes only.";
	const valueError = value === "" ? "Give the value." : undefined;
	const add = () => {
		setTried(true);
		if (hostError !== undefined || nameError !== undefined || valueError !== undefined) return;
		newHeaders += 1;
		onChange([...headers, { id: `hdr_new_${newHeaders}`, host: host.trim(), header: name.trim(), value, set: false }]);
		setHost("");
		setName("");
		setValue("");
		setTried(false);
	};
	// Enter in the add row adds the header, rather than saving the whole form.
	const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		add();
	};
	return (
		<div className="flex min-w-0 flex-col gap-4">
			{headers.length === 0 ? (
				<p className="m-0 text-sm text-muted">No headers added.</p>
			) : (
				<TableFrame>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Host
								</th>
								<th className={th} scope="col">
									Header
								</th>
								<th className={th} scope="col">
									Value
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{headers.map((header) => (
								<tr key={header.id}>
									<td className={td}>
										<span className={`${cellMono} text-fg`}>{header.host}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{header.header}</span>
									</td>
									<td className={td}>
										<span className="flex items-center gap-2">
											<Badge tone="done">Set</Badge>
											{header.value === undefined ? null : <Badge tone="accent">New</Badge>}
										</span>
									</td>
									<td className={`${td} w-0 text-right`}>
										<IconButton
											size="xs"
											variant="ghost"
											icon={<TrashIcon />}
											label={`Remove ${header.header} for ${header.host}`}
											onClick={() => onChange(headers.filter((entry) => entry.id !== header.id))}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableFrame>
			)}
			{tlsInspection || headers.length === 0 ? null : (
				<p className="m-0 text-xs text-muted">
					With HTTPS inspection off, these are added to plain HTTP requests only.
				</p>
			)}
			<FormGrid columns={3}>
				<TextField
					label="Host"
					value={host}
					onChange={(event) => setHost(event.currentTarget.value)}
					placeholder="api.github.com"
					mono
					spellCheck={false}
					onKeyDown={addOnEnter}
					{...(tried && hostError !== undefined ? { error: hostError } : {})}
				/>
				<TextField
					label="Header name"
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="Authorization"
					mono
					spellCheck={false}
					onKeyDown={addOnEnter}
					{...(tried && nameError !== undefined ? { error: nameError } : {})}
				/>
				<TextField
					label="Value"
					type="password"
					autoComplete="off"
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					onKeyDown={addOnEnter}
					mono
					{...(tried && valueError !== undefined ? { error: valueError } : {})}
				/>
			</FormGrid>
			<div>
				<Button size="sm" icon={<PlusIcon size="sm" />} onClick={add}>
					Add header
				</Button>
			</div>
		</div>
	);
}

function RequestsTable({ requests, now }: { requests: readonly ProxyRequest[]; now: number }) {
	return (
		// Nothing in it takes focus, so the frame does: a narrow screen scrolls it sideways with the arrow keys.
		<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-labelledby="proxy-recent-title">
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							When
						</th>
						<th className={th} scope="col">
							Sandbox
						</th>
						<th className={th} scope="col">
							Request
						</th>
						<th className={`${th} text-right`} scope="col">
							Status
						</th>
						<th className={th} scope="col">
							Decision
						</th>
						<th className={`${th} text-right`} scope="col">
							Bytes
						</th>
					</tr>
				</thead>
				<tbody>
					{requests.map((request) => {
						const target = `${request.method} ${request.host}${request.path}`;
						return (
							<tr key={request.id}>
								<td className={td}>
									<span className="text-muted" title={new Date(request.at).toLocaleString("en-GB")}>
										{compactAge(request.at, now)}
									</span>
								</td>
								<td className={td}>
									<span className="block max-w-(--kt-card-width) truncate text-fg">{request.sandboxName}</span>
								</td>
								<td className={td}>
									<span className={`${cellMono} block max-w-(--kt-card-width) truncate`} title={target}>
										<span className="text-fg">{request.method}</span> {request.host}
										{request.path}
									</span>
								</td>
								<td className={`${td} text-right tabular-nums`}>{request.status}</td>
								<td className={td}>
									{request.decision === "allowed" ? (
										<Badge tone="done">Allowed</Badge>
									) : (
										<Badge tone="error">Denied</Badge>
									)}
								</td>
								<td className={`${td} text-right tabular-nums`}>{bytesText(request.bytes)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}
