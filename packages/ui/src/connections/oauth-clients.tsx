// OAuth clients settings (#340, on #326): the apps people sign in through, by service, and which one a new
// connection would use. The host's own clients are read-only here, under the host's name; an admin adds the
// organisation's own, and anyone can bring a personal one. A client secret is typed once and shows only as set.

import { type FormEvent, useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormActions, FormLayout } from "../primitives/form-layout.tsx";
import { AppWindowIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	type ConnectionsViewer,
	type OAuthClient,
	type OAuthClientInput,
	type ProviderTemplate,
	TIER_LABELS,
	winningClient,
} from "./connections-model.ts";
import { ProviderLogo } from "./provider-logo.tsx";

export interface OAuthClientsProps {
	readonly clients: readonly OAuthClient[];
	readonly catalogue: readonly ProviderTemplate[];
	readonly viewer: ConnectionsViewer;
	/** The redirect URI every client registers with its provider. */
	readonly redirectUri: string;
	readonly loading?: boolean;
	readonly error?: string | undefined;
	readonly onRetry?: () => void;
	readonly onCreate: (input: OAuthClientInput) => Promise<OAuthClient>;
	readonly onSetDisabled: (client: OAuthClient, disabled: boolean) => Promise<unknown>;
	readonly onDelete: (client: OAuthClient) => Promise<void>;
	/** Opens the add form for this template, as a service's page links here. */
	readonly initialTemplateId?: string | undefined;
}

export function OAuthClients({
	clients,
	catalogue,
	viewer,
	redirectUri,
	loading = false,
	error,
	onRetry,
	onCreate,
	onSetDisabled,
	onDelete,
	initialTemplateId,
}: OAuthClientsProps) {
	const [adding, setAdding] = useState(initialTemplateId !== undefined);
	const [deleting, setDeleting] = useState<OAuthClient>();
	const [busy, setBusy] = useState<string>();
	const [failure, setFailure] = useState<string>();
	const [saved, setSaved] = useState<OAuthClient>();
	const oauthTemplates = useMemo(() => catalogue.filter((t) => t.authTypes.includes("oauth2")), [catalogue]);
	const byTemplate = useMemo(() => {
		const groups = new Map<string, OAuthClient[]>();
		for (const client of clients) groups.set(client.templateId, [...(groups.get(client.templateId) ?? []), client]);
		return [...groups.entries()]
			.map(([templateId, list]) => ({
				template: catalogue.find((t) => t.id === templateId),
				templateId,
				clients: list.sort((a, b) => tierOrder(a) - tierOrder(b)),
			}))
			.sort((a, b) => (a.template?.name ?? a.templateId).localeCompare(b.template?.name ?? b.templateId));
	}, [clients, catalogue]);

	const act = async (key: string, run: () => Promise<unknown>) => {
		setBusy(key);
		setFailure(undefined);
		try {
			await run();
			return true;
		} catch (caught) {
			setFailure(caught instanceof Error ? caught.message : "That didn't work. Try again.");
			return false;
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<div className="flex min-w-0 flex-col gap-5">
			<div className="flex min-w-0 items-start justify-between gap-4 max-sm:flex-col">
				<p className="m-0 max-w-content text-sm text-muted">
					The apps people sign in through. For a new connection Harbour uses the narrowest one set up: yours or your
					project's, then {viewer.organisation}'s, then {viewer.host ?? "the host"}'s. A connection stays on the client
					that made it, even when another is added later.
				</p>
				{adding ? null : (
					<Button variant="primary" icon={<AppWindowIcon size="sm" />} onClick={() => setAdding(true)}>
						Add a client
					</Button>
				)}
			</div>
			{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			{saved === undefined ? null : (
				<Notice
					level="info"
					action={
						<Button variant="ghost" size="sm" onClick={() => setSaved(undefined)}>
							Dismiss
						</Button>
					}
				>
					Saved {saved.label ?? saved.clientId}.{" "}
					{saved.secret === undefined
						? "It has no secret: a public client signs in with PKCE alone."
						: `Its secret ends in ${saved.secret.last4} and won't be shown again.`}
				</Notice>
			)}
			{adding ? (
				<ClientForm
					templates={oauthTemplates}
					viewer={viewer}
					redirectUri={redirectUri}
					initialTemplateId={initialTemplateId}
					onCancel={() => setAdding(false)}
					onSave={async (input) => {
						const client = await onCreate(input);
						setAdding(false);
						setSaved(client);
					}}
				/>
			) : null}
			{error !== undefined ? (
				<Notice level="error" action={onRetry === undefined ? undefined : <Button onClick={onRetry}>Try again</Button>}>
					{error}
				</Notice>
			) : loading ? (
				<div className="flex flex-col gap-3 rounded-panel border border-border bg-panel p-4" aria-busy="true">
					<Skeleton lines={2} />
					<Skeleton lines={2} />
				</div>
			) : byTemplate.length === 0 ? (
				<EmptyState title="No OAuth clients yet">
					Add one for a service like GitHub or Google, and people can connect it in one click.
				</EmptyState>
			) : (
				byTemplate.map((group) => {
					const winner = winningClient(group.clients, group.templateId);
					const name = group.template?.name ?? group.templateId;
					return (
						<section
							key={group.templateId}
							aria-label={`${name} clients`}
							className="flex min-w-0 flex-col rounded-panel border border-border bg-panel"
						>
							<header className="flex min-w-0 items-center gap-3 border-0 border-b border-solid border-border px-4 py-3">
								<ProviderLogo name={name} icon={group.template?.icon} size="sm" />
								<div className="flex min-w-0 flex-col">
									<h3 className="m-0 text-sm font-strong text-fg">{name}</h3>
									<span className="text-xs text-muted">
										{winner === undefined
											? "No client enabled: people can't sign in to it yet."
											: `New connections use ${winner.label ?? winner.clientId}.`}
									</span>
								</div>
							</header>
							<ul className="m-0 flex list-none flex-col p-0">
								{group.clients.map((client) => {
									const readOnly = client.tier === "deployment" || (client.tier === "organisation" && !viewer.admin);
									const wins = winner?.id === client.id;
									return (
										<li
											key={client.id}
											className="flex min-w-0 items-start gap-3 border-0 border-t border-solid border-border px-4 py-3 first:border-t-0 max-sm:flex-col"
										>
											<div className="flex min-w-0 flex-1 flex-col gap-1">
												<span className="flex min-w-0 flex-wrap items-center gap-2">
													<span className="font-medium text-fg">{client.label ?? client.clientId}</span>
													<Badge tone={wins ? "accent" : "neutral"}>
														{client.tier === "deployment" ? client.ownerLabel : TIER_LABELS[client.tier]}
													</Badge>
													{wins ? <Badge tone="done">In use for new connections</Badge> : null}
													{client.disabled === true ? <Badge>Disabled</Badge> : null}
												</span>
												<span className="text-xs text-muted wrap-anywhere">
													Client ID <code className="hb-mono hb-selectable">{client.clientId}</code>.{" "}
													{client.secret === undefined ? (
														"Public client, no secret."
													) : (
														<>
															Secret set, ends in <code className="hb-mono">{client.secret.last4}</code>.
														</>
													)}
												</span>
												<span className="text-xs text-faint">
													{client.tier === "deployment"
														? `Supplied by ${client.ownerLabel}. `
														: client.tier === "user"
															? `${client.ownerLabel}'s own. `
															: ""}
													{client.pinnedConnections === 0
														? "No connections use it."
														: `${client.pinnedConnections} ${client.pinnedConnections === 1 ? "connection is" : "connections are"} pinned to it.`}
												</span>
											</div>
											{readOnly ? (
												<span className="shrink-0 text-xs text-faint">Read only</span>
											) : (
												<div className="flex shrink-0 items-center gap-2">
													<Button
														size="sm"
														variant="ghost"
														busy={busy === `toggle:${client.id}`}
														onClick={() =>
															void act(`toggle:${client.id}`, () => onSetDisabled(client, client.disabled !== true))
														}
													>
														{client.disabled === true ? "Enable" : "Disable"}
													</Button>
													<Button
														size="sm"
														variant="ghost"
														icon={<TrashIcon size="sm" />}
														disabled={client.pinnedConnections > 0}
														title={
															client.pinnedConnections > 0
																? "Connections are pinned to it. Disconnect them first, or disable it to stop new ones."
																: undefined
														}
														onClick={() => setDeleting(client)}
													>
														Delete
													</Button>
												</div>
											)}
										</li>
									);
								})}
							</ul>
						</section>
					);
				})
			)}
			<Dialog
				open={deleting !== undefined}
				title={`Delete ${deleting?.label ?? deleting?.clientId ?? "this client"}?`}
				onClose={() => setDeleting(undefined)}
				actions={
					<>
						<Button onClick={() => setDeleting(undefined)}>Cancel</Button>
						<Button
							variant="danger"
							busy={busy === "delete"}
							onClick={async () => {
								if (deleting === undefined) return;
								const target = deleting;
								if (await act("delete", () => onDelete(target))) setDeleting(undefined);
							}}
						>
							Delete
						</Button>
					</>
				}
			>
				<p className="m-0">
					No connection uses it, so nothing stops working. People connecting later use the next client in line.
				</p>
			</Dialog>
		</div>
	);
}

const TIER_ORDER = { user: 0, project: 1, organisation: 2, deployment: 3 } as const;
const tierOrder = (client: OAuthClient) => TIER_ORDER[client.tier];

/** Registers a client: the service, whose it is, the redirect URI to give the provider, then the ID and secret. */
function ClientForm({
	templates,
	viewer,
	redirectUri,
	initialTemplateId,
	onSave,
	onCancel,
}: {
	templates: readonly ProviderTemplate[];
	viewer: ConnectionsViewer;
	redirectUri: string;
	initialTemplateId?: string | undefined;
	onSave: (input: OAuthClientInput) => Promise<void>;
	onCancel: () => void;
}) {
	const id = useId();
	const [templateId, setTemplateId] = useState(initialTemplateId ?? templates[0]?.id ?? "");
	const [whose, setWhose] = useState(viewer.admin ? "organisation" : "user");
	const [label, setLabel] = useState("");
	const [clientId, setClientId] = useState("");
	const [secret, setSecret] = useState("");
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const template = templates.find((t) => t.id === templateId);
	const scopes = template?.scopeSets.flatMap((set) => set.scopes) ?? [];
	const errors = {
		clientId: clientId.trim() === "" ? "Paste the client ID from the provider." : undefined,
		secret: secret === "" ? "Paste the client secret." : undefined,
	};
	const whoseOptions = [
		...(viewer.admin ? [{ value: "organisation", label: `${viewer.organisation}, for everyone` }] : []),
		...viewer.projects.map((project) => ({ value: `project:${project.id}`, label: `${project.name} project` })),
		{ value: "user", label: `Just me (${viewer.name})` },
	];

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (errors.clientId !== undefined || errors.secret !== undefined || template === undefined) return;
		const input: OAuthClientInput = {
			templateId,
			tier: whose === "organisation" ? "organisation" : whose === "user" ? "user" : "project",
			...(whose.startsWith("project:") ? { projectId: whose.slice("project:".length) } : {}),
			...(label.trim() === "" ? {} : { label: label.trim() }),
			clientId: clientId.trim(),
			clientSecret: secret,
			scopes,
		};
		// The secret leaves the page once, with this call.
		setSecret("");
		setBusy(true);
		setFailure(undefined);
		try {
			await onSave(input);
		} catch (caught) {
			setFailure(
				caught instanceof Error
					? `${caught.message} Paste the secret again to retry.`
					: "The client wasn't saved. Paste the secret again to retry.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			aria-labelledby={`${id}-title`}
			className="flex min-w-0 flex-col gap-4 rounded-panel border border-border-strong bg-panel p-5"
		>
			<div className="flex min-w-0 items-center gap-3">
				{template === undefined ? null : <ProviderLogo name={template.name} icon={template.icon} size="sm" />}
				<h3 id={`${id}-title`} className="m-0 text-md font-strong text-fg">
					Add an OAuth client{template === undefined ? "" : ` for ${template.name}`}
				</h3>
			</div>
			<FormLayout>
				<SelectField
					label="Service"
					value={templateId}
					disabled={busy}
					options={templates.map((t) => ({ value: t.id, label: t.name }))}
					onChange={(event) => setTemplateId(event.target.value)}
				/>
				<SelectField
					label="Whose it is"
					value={whose}
					disabled={busy}
					options={whoseOptions}
					hint={
						whose === "organisation"
							? `Everyone in ${viewer.organisation} connects through it, unless they bring their own.`
							: whose === "user"
								? "Only your own connections use it."
								: "Connections made for this project use it."
					}
					onChange={(event) => setWhose(event.target.value)}
				/>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-sm font-medium text-fg">Redirect URI</span>
					<div className="flex min-w-0 items-center gap-2">
						<code className="min-w-0 flex-1 rounded-control border border-border-input bg-sunken px-2.5 py-1.5 font-mono text-code select-all wrap-anywhere">
							{redirectUri}
						</code>
						<CopyButton text={redirectUri} label="Copy" />
					</div>
					<span className="text-xs text-muted">
						Register this in {template?.name ?? "the provider"}'s app settings, exactly as it is.
					</span>
				</div>
				{scopes.length === 0 ? null : (
					<div className="flex min-w-0 flex-col gap-1.5">
						<span className="text-sm font-medium text-fg">Scopes it may ask for</span>
						<span className="flex flex-wrap gap-1.5">
							{scopes.map((scope) => (
								<code key={scope} className="hb-mono rounded-xs bg-sunken px-1.5 text-muted wrap-anywhere">
									{scope}
								</code>
							))}
						</span>
					</div>
				)}
				{template?.clientGuidance === undefined ? null : (
					<Notice level="info" announce={false}>
						{template.clientGuidance}
					</Notice>
				)}
				<TextField
					label="Label"
					placeholder={`Optional, such as ${viewer.organisation} ${template?.name ?? ""} app`.trim()}
					value={label}
					disabled={busy}
					autoComplete="off"
					onChange={(event) => setLabel(event.target.value)}
				/>
				<TextField
					label="Client ID"
					mono
					value={clientId}
					disabled={busy}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setClientId(event.target.value)}
					{...(touched && errors.clientId !== undefined ? { error: errors.clientId } : {})}
				/>
				<TextField
					label="Client secret"
					type="password"
					mono
					value={secret}
					disabled={busy}
					autoComplete="new-password"
					spellCheck={false}
					onChange={(event) => setSecret(event.target.value)}
					{...(touched && errors.secret !== undefined
						? { error: errors.secret }
						: { hint: "Stored once and never shown again: only that it's set, and its last four characters." })}
				/>
				{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
				<FormActions>
					<Button type="submit" variant="primary" busy={busy}>
						Save client
					</Button>
					<Button variant="ghost" onClick={onCancel} disabled={busy}>
						Cancel
					</Button>
				</FormActions>
			</FormLayout>
		</form>
	);
}
