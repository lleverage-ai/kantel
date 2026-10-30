// The two ways to connect what the catalogue doesn't list: a remote MCP server by its URL (#338), and any HTTP API
// with a key (#330). Both ask who the connection is for. A key or a client secret is typed here once, sent once, and
// never shown again: after saving, the page says only that it is set and how it ends.

import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, Disclosure, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormLayout } from "../primitives/form-layout.tsx";
import { CheckCircleIcon } from "../primitives/icons.tsx";
import { KeyRoundIcon, ServerIcon } from "../primitives/lucide.tsx";
import { Notice } from "../primitives/surface.tsx";
import { type ConnectFlow, ConnectProgress } from "./connect-flow.tsx";
import {
	type Connection,
	type ConnectionsViewer,
	type ConnectStart,
	detectKey,
	hostPatternError,
	type Injection,
	type KeyConnectionInput,
	type KeyConnectionResult,
	type McpServerInput,
	type McpServerStart,
	mcpUrlError,
	type OwnerChoice,
	ownerChoiceHint,
	ownerChoices,
	type ProviderTemplate,
	parseHosts,
	secretText,
	usageText,
} from "./connections-model.ts";
import { ProviderLogo } from "./provider-logo.tsx";

/** Who a new connection is for: the viewer, one of their projects, or the organisation for an admin. */
export function OwnerField({
	viewer,
	value,
	onChange,
	disabled,
}: {
	viewer: ConnectionsViewer;
	value: OwnerChoice;
	onChange: (choice: OwnerChoice) => void;
	disabled?: boolean;
}) {
	const choices = ownerChoices(viewer);
	const key = value.kind === "project" ? `project:${value.projectId}` : value.kind;
	return (
		<SelectField
			label="Who can use it"
			value={key}
			disabled={disabled}
			options={choices.map(({ value: v, label }) => ({ value: v, label }))}
			hint={ownerChoiceHint(value, viewer)}
			onChange={(event) => {
				const found = choices.find((choice) => choice.value === event.target.value);
				if (found !== undefined) onChange(found.choice);
			}}
		/>
	);
}

/** A form's heading: the tile and what it adds. */
function FormHead({ icon, title, lede }: { icon: ReactNode; title: string; lede: string }) {
	return (
		<header className="flex min-w-0 items-start gap-3">
			{icon}
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className="m-0 text-lg font-strong text-fg">{title}</h2>
				<p className="m-0 max-w-content text-sm text-muted">{lede}</p>
			</div>
		</header>
	);
}

const iconTile =
	"box-border flex size-14 shrink-0 items-center justify-center rounded-panel border border-border bg-sunken text-muted";

// ---------------------------------------------------------------------------------------------------------------------
// MCP server

export interface McpServerFormProps {
	readonly viewer: ConnectionsViewer;
	readonly flow: ConnectFlow;
	readonly onAdd: (input: McpServerInput) => Promise<McpServerStart>;
	/** A server that takes a key: the key, stored as a key connection whose injection is the header. */
	readonly onKey: (input: KeyConnectionInput) => Promise<KeyConnectionResult>;
	readonly onDone: (connection?: Connection) => void;
	readonly onCancel: () => void;
	/** A URL to start with, for stories. */
	readonly initialUrl?: string;
}

/** Adds a remote MCP server by URL (#338): Harbour finds how it signs in, signs in for you and holds the token. */
export function McpServerForm({ viewer, flow, onAdd, onKey, onDone, onCancel, initialUrl = "" }: McpServerFormProps) {
	const [url, setUrl] = useState(initialUrl);
	const [name, setName] = useState("");
	const [owner, setOwner] = useState<OwnerChoice>({ kind: "user" });
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [touched, setTouched] = useState(false);
	const [keyServer, setKeyServer] = useState<Extract<McpServerStart, { auth: "key" }>>();
	const [serverName, setServerName] = useState<string>();
	const urlError = touched ? mcpUrlError(url) : undefined;
	const busy = flow.state.phase === "starting";

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (mcpUrlError(url) !== undefined) return;
		const input: McpServerInput = {
			url: url.trim(),
			owner,
			...(name.trim() === "" ? {} : { name: name.trim() }),
			...(clientId.trim() === ""
				? {}
				: { client: { clientId: clientId.trim(), ...(clientSecret === "" ? {} : { clientSecret }) } }),
		};
		// The secret goes once, with this call; the field is cleared whatever happens next.
		setClientSecret("");
		flow.run(async (): Promise<ConnectStart | undefined> => {
			const started = await onAdd(input);
			setServerName(started.serverName);
			if (started.auth === "key") {
				setKeyServer(started);
				return undefined;
			}
			return started;
		});
	};

	if (keyServer !== undefined)
		return (
			<KeyConnectionForm
				viewer={viewer}
				custom={{
					name: keyServer.serverName,
					hosts: [safeHost(url)],
					injection: { kind: "header", name: keyServer.header },
				}}
				lede={`${keyServer.serverName} takes a key rather than a sign-in. Harbour sends it in the ${keyServer.header} header, only to ${safeHost(url)}.`}
				onSave={onKey}
				onDone={onDone}
				onCancel={() => setKeyServer(undefined)}
			/>
		);

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-5">
			<FormHead
				icon={
					<span className={iconTile}>
						<ServerIcon />
					</span>
				}
				title="Add a custom MCP server"
				lede="Paste a remote MCP server's URL. Harbour reads how it signs in, signs in for you and holds the token, so agents use its tools without seeing it. Read-only tools are allowed; the rest ask first."
			/>
			{flow.state.phase === "idle" || flow.state.phase === "starting" ? (
				<form onSubmit={submit} noValidate className="min-w-0">
					<FormLayout>
						<TextField
							label="Server URL"
							mono
							type="url"
							inputMode="url"
							placeholder="https://mcp.example.com/mcp"
							value={url}
							spellCheck={false}
							autoComplete="off"
							autoFocus
							disabled={busy}
							onChange={(event) => setUrl(event.target.value)}
							onBlur={() => setTouched(url !== "")}
							{...(urlError === undefined
								? { hint: "The server's streamable HTTP endpoint, over https." }
								: { error: urlError })}
						/>
						<TextField
							label="Name"
							placeholder="Optional"
							value={name}
							disabled={busy}
							autoComplete="off"
							hint="How it shows in your connections. Without one, the server's own name."
							onChange={(event) => setName(event.target.value)}
						/>
						<OwnerField viewer={viewer} value={owner} onChange={setOwner} disabled={busy} />
						<Disclosure summary="Use your own OAuth client">
							<div className="flex flex-col gap-3 pt-2">
								<p className="m-0 text-xs text-muted">
									For a server that needs a registered app. Harbour tries this client first, then its published client
									metadata, and registers a client only as a last resort.
								</p>
								<TextField
									label="Client ID"
									mono
									value={clientId}
									disabled={busy}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) => setClientId(event.target.value)}
								/>
								<TextField
									label="Client secret"
									type="password"
									mono
									value={clientSecret}
									disabled={busy}
									autoComplete="new-password"
									hint="Stored once and never shown again. Leave it empty for a public client."
									onChange={(event) => setClientSecret(event.target.value)}
								/>
							</div>
						</Disclosure>
						<FormActions>
							<Button type="submit" variant="primary" busy={busy} icon={<ServerIcon size="sm" />}>
								Connect
							</Button>
							<Button variant="ghost" onClick={onCancel}>
								Cancel
							</Button>
						</FormActions>
					</FormLayout>
				</form>
			) : (
				<div className="rounded-panel border border-border bg-panel p-5">
					<ConnectProgress
						flow={flow}
						name={serverName ?? (safeHost(url) || "the server")}
						connectedText={(connection) =>
							`${connection.mcp?.tools === undefined ? "Its tools are" : `Its ${connection.mcp.tools} tools are`} ready for agents. ${usageText(connection, viewer)}`
						}
						onDone={() => onDone()}
					/>
				</div>
			)}
		</div>
	);
}

function safeHost(url: string): string {
	try {
		return new URL(url.trim()).hostname;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Key connection

type InjectionKind = Injection["kind"];

const INJECTION_OPTIONS: readonly { value: InjectionKind; label: string }[] = [
	{ value: "bearer", label: "Bearer" },
	{ value: "header", label: "Header" },
	{ value: "query", label: "Query" },
	{ value: "basic", label: "Basic" },
];

const INJECTION_HINTS: Record<InjectionKind, string> = {
	bearer: "Sent as Authorization: Bearer and the key.",
	header: "Sent in a header you name, with an optional prefix.",
	query: "Added to the URL as a query parameter.",
	basic: "Sent as HTTP basic auth, with a user name.",
};

export interface KeyConnectionFormProps {
	readonly viewer: ConnectionsViewer;
	/** The catalogue, to suggest a template for a pasted key. */
	readonly catalogue?: readonly ProviderTemplate[];
	/** A catalogue template to connect with a key. Without one, a custom service. */
	readonly template?: ProviderTemplate | undefined;
	/** A custom service's starting description: a name, its hosts and injection. */
	readonly custom?: { readonly name?: string; readonly hosts?: readonly string[]; readonly injection?: Injection };
	readonly lede?: string;
	readonly onSave: (input: KeyConnectionInput) => Promise<KeyConnectionResult>;
	readonly onDone: (connection?: Connection) => void;
	readonly onCancel: () => void;
	/** For stories: a stored result to show. */
	readonly initialResult?: KeyConnectionResult;
	/** For stories: a key already pasted, to show its suggestion. The real form never starts with one. */
	readonly initialKey?: string;
}

/**
 * Connects a service with a key (#330), from a template or as a custom service. Pasting a key that looks like a
 * template's suggests it; a custom service's hosts must be confirmed before the key is stored.
 */
export function KeyConnectionForm({
	viewer,
	catalogue = [],
	template: initialTemplate,
	custom,
	lede,
	onSave,
	onDone,
	onCancel,
	initialResult,
	initialKey = "",
}: KeyConnectionFormProps) {
	const ids = useId();
	const [template, setTemplate] = useState(initialTemplate);
	const [name, setName] = useState(custom?.name ?? "");
	const [hostsText, setHostsText] = useState((custom?.hosts ?? []).join(", "));
	const [injection, setInjection] = useState<InjectionKind>(custom?.injection?.kind ?? "bearer");
	const [headerName, setHeaderName] = useState(
		custom?.injection?.kind === "header" ? custom.injection.name : "X-API-Key",
	);
	const [prefix, setPrefix] = useState(custom?.injection?.kind === "header" ? (custom.injection.prefix ?? "") : "");
	const [queryName, setQueryName] = useState(custom?.injection?.kind === "query" ? custom.injection.name : "api_key");
	const [username, setUsername] = useState("");
	const [key, setKey] = useState(initialKey);
	const [label, setLabel] = useState("");
	const [owner, setOwner] = useState<OwnerChoice>({ kind: "user" });
	const [hostsConfirmed, setHostsConfirmed] = useState(false);
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [result, setResult] = useState<KeyConnectionResult | undefined>(initialResult);

	const hosts = template?.apiHosts ?? parseHosts(hostsText);
	const hostError =
		template !== undefined
			? undefined
			: hosts.length === 0
				? hostPatternError("")
				: hosts.map(hostPatternError).find((e) => e !== undefined);
	const suggestion = useMemo(() => {
		const found = detectKey(catalogue, key);
		return found === undefined || found.template.id === template?.id ? undefined : found;
	}, [catalogue, key, template]);
	const errors = {
		name: template === undefined && name.trim() === "" ? "Name the service." : undefined,
		hosts: template === undefined ? hostError : undefined,
		key: key.trim() === "" ? "Paste the key." : undefined,
		header:
			template === undefined && injection === "header" && headerName.trim() === "" ? "Name the header." : undefined,
		query:
			template === undefined && injection === "query" && queryName.trim() === "" ? "Name the parameter." : undefined,
		username:
			injection === "basic" && template === undefined && username.trim() === "" ? "Add the user name." : undefined,
		confirm:
			template === undefined && !hostsConfirmed ? "Confirm where the key may be sent before saving it." : undefined,
	};
	const shown = (error: string | undefined) => (touched ? error : undefined);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (Object.values(errors).some((error) => error !== undefined)) return;
		const input: KeyConnectionInput = {
			owner,
			key: key.trim(),
			...(label.trim() === "" ? {} : { label: label.trim() }),
			...(template !== undefined
				? { templateId: template.id }
				: {
						name: name.trim(),
						hosts,
						injection:
							injection === "header"
								? { kind: "header", name: headerName.trim(), ...(prefix === "" ? {} : { prefix }) }
								: injection === "query"
									? { kind: "query", name: queryName.trim() }
									: { kind: injection },
					}),
			...(injection === "basic" && username.trim() !== "" ? { username: username.trim() } : {}),
		};
		// The key leaves the page once, with this call, and the field is emptied whatever happens next.
		setKey("");
		setBusy(true);
		setFailure(undefined);
		try {
			setResult(await onSave(input));
		} catch (caught) {
			setFailure(
				caught instanceof Error
					? `${caught.message} Paste the key again to retry.`
					: "The key wasn't saved. Paste it again to retry.",
			);
		} finally {
			setBusy(false);
		}
	};

	const title =
		template === undefined
			? custom?.name
				? `Connect ${custom.name}`
				: "Connect any API with a key"
			: `Connect ${template.name} with an API key`;
	const head = (
		<FormHead
			icon={
				template === undefined ? (
					<span className={iconTile}>
						<KeyRoundIcon />
					</span>
				) : (
					<ProviderLogo name={template.name} icon={template.icon} size="lg" />
				)
			}
			title={title}
			lede={
				lede ??
				(template === undefined
					? "Describe where the key goes and how it's sent. You enter the key once: Harbour stores it, sends it only to these hosts over https, and nobody sees it again, agents included."
					: `${template.keyHelp ?? "Make a key in the service's settings, with only the access agents need."} Harbour sends it only to ${template.apiHosts.join(" and ")}, and nobody sees it again.`)
			}
		/>
	);

	if (result !== undefined) {
		const { connection, test } = result;
		return (
			<div className="flex w-full max-w-content min-w-0 flex-col gap-5">
				{head}
				<div className="flex flex-col gap-4 rounded-panel border border-border bg-panel p-5" role="status">
					<div className="flex items-start gap-3">
						<span className="mt-0.5 text-status-done">
							<CheckCircleIcon />
						</span>
						<div className="flex min-w-0 flex-col gap-1">
							<p className="m-0 font-medium text-fg">Key saved for {connection.name}</p>
							<p className="m-0 text-xs text-muted">
								{connection.key === undefined ? "Set." : `${secretText(connection.key)}.`} It won't be shown again; to
								change it, replace it from the connection's page. {usageText(connection, viewer)}
							</p>
						</div>
					</div>
					{test === undefined ? null : test.ok ? (
						<Notice level="info" announce={false}>
							The test request worked{test.account === undefined ? "." : `: the key belongs to ${test.account}.`}
						</Notice>
					) : (
						<Notice level="warning" announce={false}>
							Saved, but the test request failed. {test.message ?? ""} The connection shows as failing its test until it
							works.
						</Notice>
					)}
					<div className="flex gap-2">
						<Button variant="primary" onClick={() => onDone(connection)}>
							Done
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-5">
			{head}
			<form onSubmit={(event) => void submit(event)} noValidate className="min-w-0">
				<FormLayout>
					{template !== undefined ? (
						<FormField id={`${ids}-hosts`} label="Sent only to">
							<span className="flex min-h-control-md flex-wrap items-center gap-1.5">
								{template.apiHosts.map((host) => (
									<code key={host} className="hb-mono rounded-xs bg-sunken px-1.5">
										{host}
									</code>
								))}
							</span>
						</FormField>
					) : (
						<>
							<TextField
								label="Service name"
								placeholder="Internal status API"
								value={name}
								disabled={busy}
								autoComplete="off"
								onChange={(event) => setName(event.target.value)}
								{...(shown(errors.name) === undefined ? {} : { error: shown(errors.name) })}
							/>
							<TextField
								label="Hosts"
								mono
								placeholder="api.example.com, *.example.com"
								value={hostsText}
								disabled={busy}
								spellCheck={false}
								autoComplete="off"
								onChange={(event) => {
									setHostsText(event.target.value);
									setHostsConfirmed(false);
								}}
								{...(shown(errors.hosts) === undefined
									? { hint: "Where the key may be sent, over https only. Separate several with commas." }
									: { error: shown(errors.hosts) })}
							/>
							<FormField id={`${ids}-inject`} label="How the key is sent" hint={INJECTION_HINTS[injection]}>
								<SegmentedControl
									label="How the key is sent"
									options={INJECTION_OPTIONS}
									value={injection}
									onChange={setInjection}
								/>
							</FormField>
							{injection === "header" ? (
								<div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
									<TextField
										label="Header"
										mono
										value={headerName}
										disabled={busy}
										spellCheck={false}
										onChange={(event) => setHeaderName(event.target.value)}
										{...(shown(errors.header) === undefined ? {} : { error: shown(errors.header) })}
									/>
									<TextField
										label="Prefix"
										mono
										placeholder="Optional, such as Token"
										value={prefix}
										disabled={busy}
										spellCheck={false}
										onChange={(event) => setPrefix(event.target.value)}
									/>
								</div>
							) : injection === "query" ? (
								<TextField
									label="Parameter"
									mono
									value={queryName}
									disabled={busy}
									spellCheck={false}
									onChange={(event) => setQueryName(event.target.value)}
									{...(shown(errors.query) === undefined ? {} : { error: shown(errors.query) })}
								/>
							) : null}
						</>
					)}
					{injection === "basic" ? (
						<TextField
							label="User name"
							value={username}
							disabled={busy}
							autoComplete="off"
							onChange={(event) => setUsername(event.target.value)}
							{...(shown(errors.username) === undefined ? {} : { error: shown(errors.username) })}
						/>
					) : null}
					<TextField
						label={injection === "basic" ? "Password or key" : "API key"}
						type="password"
						mono
						value={key}
						disabled={busy}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => setKey(event.target.value)}
						{...(shown(errors.key) === undefined
							? { hint: "Stored once and never shown again, not even to you." }
							: { error: shown(errors.key) })}
					/>
					{suggestion === undefined ? null : (
						<Notice
							level="info"
							action={
								<Button size="sm" onClick={() => setTemplate(suggestion.template)}>
									Use {suggestion.template.name}
								</Button>
							}
						>
							This looks like {suggestion.shape.label}. Use the {suggestion.template.name} template so Harbour knows its
							hosts and can test it?
						</Notice>
					)}
					<TextField
						label="Label"
						placeholder="Optional, such as Work or Read-only"
						value={label}
						disabled={busy}
						autoComplete="off"
						hint="Tells it apart from other connections to the same service."
						onChange={(event) => setLabel(event.target.value)}
					/>
					<OwnerField viewer={viewer} value={owner} onChange={setOwner} disabled={busy} />
					{template === undefined ? (
						<div className="flex flex-col gap-1">
							<CheckboxField
								label={
									hosts.length === 0 || hostError !== undefined
										? "Send this key only to the hosts above"
										: `Send this key only to ${hosts.join(", ")}`
								}
								checked={hostsConfirmed}
								disabled={busy || hosts.length === 0 || hostError !== undefined}
								onChange={(event) => setHostsConfirmed(event.target.checked)}
							/>
							{shown(errors.confirm) === undefined ? null : (
								<p className="m-0 text-xs text-status-error">{shown(errors.confirm)}</p>
							)}
						</div>
					) : null}
					{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
					<FormActions>
						<Button type="submit" variant="primary" busy={busy} icon={<KeyRoundIcon size="sm" />}>
							Save key
						</Button>
						<Button variant="ghost" onClick={onCancel} disabled={busy}>
							Cancel
						</Button>
					</FormActions>
				</FormLayout>
			</form>
		</div>
	);
}
