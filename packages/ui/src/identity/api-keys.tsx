import type { ApiKey, ApiKeyScope, HeldRole, IssuedApiKey, Role } from "@kantel/contracts";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import {
	CheckboxField,
	CopyButton,
	Disclosure,
	SegmentedControl,
	SelectField,
	TextField,
} from "../primitives/controls.tsx";
import { FormActions, FormField, FormGrid, FormLayout, PageHeader } from "../primitives/form-layout.tsx";
import { KeyIcon, PlusIcon } from "../primitives/icons.tsx";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import {
	type ApiKeysApi,
	type ApiKeysFlow,
	type ApiKeysProblem,
	type ApiKeysState,
	administeredProjects,
	ago,
	createApiKeysFlow,
	expiryText,
	type KeyExpiry,
	type KeyProject,
	keyCreatesProjects,
	keyIsActive,
	keyName,
	keyScope,
	lastUsedText,
	mayIssueOrganisationKeys,
	prefixText,
	rolesForScope,
	sortKeys,
} from "./api-keys-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). After Stripe's Developers > API keys: a heading with New key,
// the secret once, the form, then the keys in one column at reading width, the revoked and expired ones folded away.
// Revoke is in each active key's "…" menu, which is always visible (not on hover), so it works the same with touch.

/** A panel's heading: the secret's and the form's. */
const panelTitle = "m-0 text-sm font-medium wrap-anywhere";
/** A line of facts about a key, wrapping between them. */
const meta = "flex flex-wrap gap-x-2.5 text-xs text-muted wrap-anywhere";
/** The list of keys, a hairline between rows. */
const rows = "m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0";

export interface ApiKeysPageProps {
	/** `GET`, `POST /v1/keys` and `POST /v1/keys/:id/revoke`; the identity client's key calls fit. */
	readonly api: ApiKeysApi;
	/** The caller's projects, by name; they name each key's projects. */
	readonly projects: readonly KeyProject[];
	/**
	 * The caller's roles, as `GET /v1/me` lists them. Keys can be issued only for projects the caller is admin of; with
	 * none, the page says keys need project admin rather than showing a bare empty list. Unknown: every project.
	 */
	readonly roles?: readonly HeldRole[];
	/** A fixed time, for stories and screenshots. Default `Date.now`. */
	readonly now?: () => number;
	/** Where the page starts, for stories; it loads the list either way. */
	readonly initial?: ApiKeysState;
}

const ROLE_OPTIONS: readonly { value: Role; label: string }[] = [
	{ value: "viewer", label: "Viewer" },
	{ value: "operator", label: "Operator" },
	{ value: "admin", label: "Admin" },
];

const ROLE_HINT: Readonly<Record<Role, string>> = {
	viewer: "Reads sessions, files and the audit log. Starts nothing.",
	operator: "Starts and steers sessions, as a host app's supervisor does.",
	admin: "Everything an operator does, and manages keys and roles on the project.",
};

const SCOPE_OPTIONS: readonly { value: ApiKeyScope; label: string }[] = [
	{ value: "projects", label: "One project" },
	{ value: "organisation", label: "Whole organisation" },
];

const SCOPE_HINT: Readonly<Record<ApiKeyScope, string>> = {
	projects: "The key acts only in the project you pick.",
	organisation:
		"The key acts in every project of this organisation, including new ones, and in organisation sessions. At most operator.",
};

/** What a key covers, for its row and its secret's panel. */
const coverage = (key: ApiKey, projectName: (id: string) => string): string =>
	keyScope(key) === "organisation" ? "Whole organisation" : key.projectIds.map(projectName).join(", ");

const EXPIRY_OPTIONS: readonly { value: KeyExpiry; label: string }[] = [
	{ value: "never", label: "No expiry" },
	{ value: "30d", label: "30 days" },
	{ value: "90d", label: "90 days" },
	{ value: "365d", label: "1 year" },
];

/** The sentence for a problem, by what was being done. */
function problemText(problem: ApiKeysProblem, doing: "load" | "create" | "revoke"): string {
	switch (problem.kind) {
		case "signed-out":
			return "You're signed out. Reload the page to sign in.";
		case "forbidden":
			return doing === "create"
				? "You can't issue this key. It needs the admin role on the project, and on the organisation for a new host app or an organisation key."
				: doing === "revoke"
					? "You can't revoke this key. It needs the admin role on each of its projects."
					: "API keys need the operator role or stronger, and each key the admin role on its projects. Ask an admin of this organisation.";
		case "not-found":
			return doing === "create"
				? "Kantel has no such project any more. Pick another."
				: "Kantel has no such key any more. It may have been removed.";
		case "invalid":
			return problem.message;
		case "unavailable":
			return doing === "load"
				? "Kantel can't list its keys right now. Try again in a moment."
				: doing === "create"
					? "Kantel couldn't issue the key. Try again in a moment."
					: "Kantel couldn't revoke the key. Try again in a moment.";
	}
}

/**
 * The organisation's API keys, for an admin: what each host app calls Kantel with, which projects and role it has,
 * and when it was last used. A new key's secret is shown once, with Copy, until the person says they have stored it;
 * Kantel keeps only a hash, so no later view can show it again. Revoking asks first, then refuses the key's next
 * call.
 *
 * No timers: times are read when the page renders, and the list is read once on open and after each change.
 */
export function ApiKeysPage({ api, projects, roles, now = Date.now, initial }: ApiKeysPageProps) {
	const issuable = administeredProjects(projects, roles);
	const latest = useRef({ api, projects: issuable });
	latest.current = { api, projects: issuable };
	const [flow] = useState<ApiKeysFlow>(() =>
		createApiKeysFlow({
			api: {
				list: () => latest.current.api.list(),
				create: (input) => latest.current.api.create(input),
				revoke: (keyId) => latest.current.api.revoke(keyId),
			},
			projects: () => latest.current.projects,
			now,
			...(initial === undefined ? {} : { initial }),
		}),
	);
	const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
	useEffect(() => {
		void flow.load();
	}, [flow]);

	const at = now();
	const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
	const { active, ended } = sortKeys(state.keys ?? [], at);
	const organisationKeys = mayIssueOrganisationKeys(roles);
	const canCreate = issuable.length > 0 || organisationKeys;
	/** An operator who reaches the page but administers no project: keys are not theirs to see. */
	const notAdmin = projects.length > 0 && issuable.length === 0;

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0">
			<PageHeader
				title="API keys"
				{...(state.draft === undefined && canCreate
					? {
							actions: (
								<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => flow.openCreate()}>
									New key
								</Button>
							),
						}
					: {})}
			/>

			{state.issued === undefined ? null : (
				<IssuedSecret issued={state.issued} project={projectName} onDone={() => flow.dismissSecret()} />
			)}

			{state.draft === undefined ? null : (
				<NewKeyForm flow={flow} state={state} projects={issuable} organisationKeys={organisationKeys} />
			)}

			{/* No heading over the active keys: they're the page's one list, and the revoked ones are folded below it. */}
			<section className="flex min-w-0 flex-col gap-2" aria-label="Active keys">
				{state.loadProblem === undefined ? null : (
					<Notice
						level={state.loadProblem.kind === "forbidden" ? "warning" : "error"}
						action={
							state.loadProblem.kind === "unavailable" ? (
								<Button size="xs" busy={state.loading} onClick={() => void flow.load()}>
									Try again
								</Button>
							) : undefined
						}
					>
						{problemText(state.loadProblem, "load")}
					</Notice>
				)}
				{state.keys === undefined ? (
					state.loadProblem === undefined ? (
						<div className="flex flex-col gap-4">
							<span className="kt-sr-only">Loading API keys</span>
							<Skeleton lines={2} />
							<Skeleton lines={2} />
						</div>
					) : null
				) : active.length === 0 && notAdmin ? (
					<EmptyState title="Keys need project admin">Ask an admin of this organisation for the role.</EmptyState>
				) : active.length === 0 ? (
					<EmptyState
						title={ended.length === 0 ? "No API keys yet" : "No active keys"}
						action={
							state.draft === undefined && canCreate ? (
								<Button size="sm" icon={<PlusIcon size="sm" />} onClick={() => flow.openCreate()}>
									New key
								</Button>
							) : undefined
						}
					>
						{canCreate ? "Issue one for each host app that calls Kantel." : "Create a project first."}
					</EmptyState>
				) : (
					<ul className={rows}>
						{active.map((key) => (
							<KeyRow key={key.id} apiKey={key} flow={flow} state={state} now={at} projectName={projectName} />
						))}
					</ul>
				)}
			</section>

			{ended.length === 0 ? null : (
				<Disclosure summary={`Revoked and expired (${ended.length})`}>
					<ul className={`${rows} mt-1`}>
						{ended.map((key) => (
							<KeyRow key={key.id} apiKey={key} flow={flow} state={state} now={at} projectName={projectName} />
						))}
					</ul>
				</Disclosure>
			)}
		</div>
	);
}

/** The new key's secret, once. Done forgets it. */
function IssuedSecret({
	issued,
	project,
	onDone,
}: {
	issued: IssuedApiKey;
	project: (id: string) => string;
	onDone: () => void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	// The secret is what the person came for: take focus there, so a screen reader reads it out next.
	useEffect(() => heading.current?.focus(), []);
	return (
		<Panel
			tone="approval"
			className="max-w-content"
			aria-labelledby="kt-api-keys-issued-title"
			header={
				<h2 id="kt-api-keys-issued-title" className={`${panelTitle} focus:outline-none`} ref={heading} tabIndex={-1}>
					Copy the key for {keyName(issued.key)} now
				</h2>
			}
		>
			<div className="flex min-w-0 flex-col gap-4">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<code className="min-w-0 flex-1 rounded-control border border-border-input bg-sunken px-2.5 py-2 font-mono text-code select-all wrap-anywhere">
						{issued.secret}
					</code>
					<CopyButton text={issued.secret} label="Copy key" size="sm" />
				</div>
				<Notice level="warning" announce={false}>
					Kantel shows this key only once and keeps just a hash of it. Store it where the host app reads its secrets; if
					it's lost, revoke the key and issue another.
				</Notice>
				<p className={meta}>
					<span>{ROLE_OPTIONS.find((option) => option.value === issued.key.role)?.label}</span>
					<span>{coverage(issued.key, project)}</span>
					{keyCreatesProjects(issued.key) ? <span>Creates projects</span> : null}
					<span>{expiryText(issued.key, issued.key.createdAt)}</span>
				</p>
				<p className={meta}>
					Host apps send it as <code className="kt-mono">Authorization: Bearer &lt;key&gt;</code>
				</p>
				<FormActions>
					<Button variant="primary" size="sm" onClick={onDone}>
						I've stored it
					</Button>
				</FormActions>
			</div>
		</Panel>
	);
}

function NewKeyForm({
	flow,
	state,
	projects,
	organisationKeys,
}: {
	flow: ApiKeysFlow;
	state: ApiKeysState;
	projects: readonly KeyProject[];
	/** Whether the caller may issue organisation keys: an organisation-wide admin. */
	organisationKeys: boolean;
}) {
	const draft = state.draft;
	if (draft === undefined) return null;
	const organisation = draft.scope === "organisation";
	const allowed = rolesForScope(
		draft.scope,
		ROLE_OPTIONS.map((option) => option.value),
	);
	const roleOptions = ROLE_OPTIONS.filter((option) => allowed.includes(option.value));
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void flow.create();
	};
	return (
		<Panel
			className="max-w-content"
			aria-labelledby="kt-api-keys-form-title"
			header={
				<h2 id="kt-api-keys-form-title" className={panelTitle}>
					New key
				</h2>
			}
		>
			<form onSubmit={submit} noValidate>
				<FormLayout>
					{organisationKeys ? (
						<FormField id="kt-api-keys-scope" label="Acts in" hint={SCOPE_HINT[draft.scope]}>
							<SegmentedControl
								label="Acts in"
								options={
									projects.length > 0 ? SCOPE_OPTIONS : SCOPE_OPTIONS.filter((option) => option.value !== "projects")
								}
								value={draft.scope}
								onChange={(scope) => flow.editDraft({ scope })}
							/>
						</FormField>
					) : null}
					{/* Two columns either way, so the name keeps its width when the project field goes. */}
					<FormGrid columns={2}>
						<TextField
							label="Name"
							name="name"
							autoComplete="off"
							spellCheck={false}
							// The form opened because the person asked for a key; the name is the first thing it needs.
							autoFocus
							value={draft.name}
							disabled={draft.busy}
							onChange={(event) => flow.editDraft({ name: event.target.value })}
							{...(draft.nameError === undefined
								? { hint: "Say what will use it, such as a host app's supervisor." }
								: { error: draft.nameError })}
						/>
						{organisation ? null : (
							<SelectField
								label="Project"
								name="project"
								options={projects.map((project) => ({ value: project.id, label: project.name }))}
								value={draft.projectId}
								disabled={draft.busy}
								onChange={(event) => flow.editDraft({ projectId: event.target.value })}
							/>
						)}
					</FormGrid>
					<FormField id="kt-api-keys-role" label="Role" hint={ROLE_HINT[draft.role]}>
						<SegmentedControl
							label="Role"
							options={roleOptions}
							value={draft.role}
							onChange={(role) => flow.editDraft({ role })}
						/>
					</FormField>
					{organisation ? (
						<CheckboxField
							label="Can create projects"
							name="createProjects"
							hint="Lets the host app call POST /v1/projects, as one that makes a project per customer does."
							checked={draft.createProjects}
							disabled={draft.busy}
							onChange={(event) => flow.editDraft({ createProjects: event.target.checked })}
						/>
					) : null}
					<FormField id="kt-api-keys-expiry" label="Expires">
						<SegmentedControl
							label="Expires"
							options={EXPIRY_OPTIONS}
							value={draft.expiry}
							onChange={(expiry) => flow.editDraft({ expiry })}
						/>
					</FormField>
					{draft.problem === undefined ? null : <Notice level="error">{problemText(draft.problem, "create")}</Notice>}
					<FormActions>
						<Button variant="primary" size="sm" type="submit" busy={draft.busy}>
							Issue key
						</Button>
						<Button variant="ghost" size="sm" disabled={draft.busy} onClick={() => flow.cancelCreate()}>
							Cancel
						</Button>
					</FormActions>
				</FormLayout>
			</form>
		</Panel>
	);
}

function KeyRow({
	apiKey,
	flow,
	state,
	now,
	projectName,
}: {
	apiKey: ApiKey;
	flow: ApiKeysFlow;
	state: ApiKeysState;
	now: number;
	projectName: (id: string) => string;
}) {
	const active = keyIsActive(apiKey, now);
	const name = keyName(apiKey);
	const confirming = state.confirming === apiKey.id;
	const revoking = state.revoking === apiKey.id;
	const problem = state.revokeProblem?.keyId === apiKey.id ? state.revokeProblem.problem : undefined;
	/** Holds the row's menu, whose trigger takes focus back when the confirmation closes. */
	const menuSlot = useRef<HTMLSpanElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	// Into the confirmation when it opens, and back to the row's menu when it closes without revoking.
	useEffect(() => {
		if (confirming) cancelButton.current?.focus();
		else if (wasConfirming.current) menuSlot.current?.querySelector<HTMLButtonElement>("button")?.focus();
		wasConfirming.current = confirming;
	}, [confirming]);

	return (
		<li className="flex min-w-0 flex-col gap-2.5 px-3 py-2.5">
			<div className="flex min-w-0 items-start gap-2.5">
				<KeyIcon size="sm" className="mt-0.5 flex-none text-faint" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className={`font-medium wrap-anywhere ${active ? "" : "text-muted"}`}>{name}</span>
						<Badge>{ROLE_OPTIONS.find((option) => option.value === apiKey.role)?.label ?? apiKey.role}</Badge>
						{keyScope(apiKey) === "organisation" ? <Badge>Organisation</Badge> : null}
						{keyCreatesProjects(apiKey) ? <Badge>Creates projects</Badge> : null}
						{apiKey.revokedAt !== undefined ? (
							<Badge tone="error">Revoked</Badge>
						) : active ? null : (
							<Badge>Expired</Badge>
						)}
					</p>
					<p className={meta}>
						<span className="kt-mono">{prefixText(apiKey)}</span>
						<span>{coverage(apiKey, projectName)}</span>
					</p>
					<p className={meta}>
						<span>Created {ago(apiKey.createdAt, now)}</span>
						<span>{lastUsedText(apiKey, now)}</span>
						<span>
							{apiKey.revokedAt === undefined ? expiryText(apiKey, now) : `Revoked ${ago(apiKey.revokedAt, now)}`}
						</span>
					</p>
				</div>
				{active ? (
					<span ref={menuSlot} className="flex flex-none">
						<Menu
							label={`Actions for ${name}`}
							icon={<EllipsisIcon />}
							align="end"
							entries={[
								{
									kind: "item",
									id: "revoke",
									label: "Revoke",
									icon: <TrashIcon />,
									danger: true,
									disabled: confirming || revoking,
									onSelect: () => flow.askRevoke(apiKey.id),
								},
							]}
						/>
					</span>
				) : null}
			</div>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: a confirmation inside a list row, not a form or a fieldset.
				<div
					className="flex flex-col gap-2 rounded-control border border-status-error-line bg-status-error-soft px-3 py-2.5"
					role="group"
					aria-label={`Revoke ${name}`}
				>
					<p className="wrap-anywhere">
						Revoke {name}? Anything that calls Kantel with it is refused from its next call. This can't be undone.
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="xs" variant="danger" busy={revoking} onClick={() => void flow.revoke()}>
							Revoke key
						</Button>
						<Button
							ref={cancelButton}
							size="xs"
							variant="ghost"
							disabled={revoking}
							onClick={() => flow.cancelRevoke()}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
			{problem === undefined ? null : (
				<p className="text-xs text-status-error" role="alert">
					{problemText(problem, "revoke")}
				</p>
			)}
		</li>
	);
}
