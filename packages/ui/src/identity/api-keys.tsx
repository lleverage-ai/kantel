import type { ApiKey, HeldRole, IssuedApiKey, Role } from "@harbour/contracts";
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, Disclosure, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormGrid, FormLayout, PageHeader } from "../primitives/form-layout.tsx";
import { KeyIcon, PlusIcon } from "../primitives/icons.tsx";
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
	keyIsActive,
	keyName,
	lastUsedText,
	prefixText,
	sortKeys,
} from "./api-keys-model.ts";
import "./api-keys.css";

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
	operator: "Starts and steers sessions, as a host app such as Sal's supervisor does.",
	admin: "Everything an operator does, and manages keys and roles on the project.",
};

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
				? "You can't issue this key. It needs the admin role on the project, and on the organisation for a new host app."
				: doing === "revoke"
					? "You can't revoke this key. It needs the admin role on each of its projects."
					: "API keys need the operator role or stronger, and each key the admin role on its projects. Ask an admin of this organisation.";
		case "not-found":
			return doing === "create"
				? "Harbour has no such project any more. Pick another."
				: "Harbour has no such key any more. It may have been removed.";
		case "invalid":
			return problem.message;
		case "unavailable":
			return doing === "load"
				? "Harbour can't list its keys right now. Try again in a moment."
				: doing === "create"
					? "Harbour couldn't issue the key. Try again in a moment."
					: "Harbour couldn't revoke the key. Try again in a moment.";
	}
}

/**
 * The organisation's API keys, for an admin: what each host app calls Harbour with, which projects and role it has,
 * and when it was last used. A new key's secret is shown once, with Copy, until the person says they have stored it;
 * Harbour keeps only a hash, so no later view can show it again. Revoking asks first, then refuses the key's next
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
	const canCreate = issuable.length > 0;
	/** An operator who reaches the page but administers no project: keys are not theirs to see. */
	const notAdmin = projects.length > 0 && issuable.length === 0;

	return (
		<div className="hb-api-keys">
			<PageHeader
				title="API keys"
				lede="Host apps call Harbour with these keys. Each key acts only in its project, with its role."
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

			{state.draft === undefined ? null : <NewKeyForm flow={flow} state={state} projects={issuable} />}

			<section className="hb-api-keys-list" aria-label="Active keys">
				<div className="hb-api-keys-list-head">
					<h2 className="hb-api-keys-list-title">Active keys</h2>
					{active.length === 0 ? null : <span className="hb-api-keys-count">{active.length}</span>}
				</div>
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
						<div className="hb-api-keys-loading">
							<span className="hb-sr-only">Loading API keys</span>
							<Skeleton lines={2} />
							<Skeleton lines={2} />
						</div>
					) : null
				) : active.length === 0 && notAdmin ? (
					<EmptyState title="Keys need project admin">
						Harbour shows, issues and revokes a key only for an admin of each project it covers. You don't administer
						any project here; ask an admin of this organisation for the role.
					</EmptyState>
				) : active.length === 0 ? (
					<EmptyState
						title="No active keys"
						action={
							state.draft === undefined && canCreate ? (
								<Button size="sm" icon={<PlusIcon size="sm" />} onClick={() => flow.openCreate()}>
									New key
								</Button>
							) : undefined
						}
					>
						{canCreate
							? "Issue a key for each host app that calls Harbour, such as Sal's supervisor."
							: "Create a project first: every key acts in a project."}
					</EmptyState>
				) : (
					<ul className="hb-api-keys-rows">
						{active.map((key) => (
							<KeyRow key={key.id} apiKey={key} flow={flow} state={state} now={at} projectName={projectName} />
						))}
					</ul>
				)}
			</section>

			{ended.length === 0 ? null : (
				<Disclosure summary={`Revoked and expired keys (${ended.length})`} className="hb-api-keys-ended">
					<ul className="hb-api-keys-rows">
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
			className="hb-api-keys-issued"
			aria-labelledby="hb-api-keys-issued-title"
			header={
				<h2 id="hb-api-keys-issued-title" className="hb-api-keys-issued-title" ref={heading} tabIndex={-1}>
					Copy the key for {keyName(issued.key)} now
				</h2>
			}
		>
			<div className="hb-api-keys-issued-body">
				<div className="hb-api-keys-secret">
					<code className="hb-api-keys-secret-text">{issued.secret}</code>
					<CopyButton text={issued.secret} label="Copy key" size="sm" />
				</div>
				<Notice level="warning" announce={false}>
					Harbour shows this key only once and keeps just a hash of it. Store it where the host app reads its secrets;
					if it's lost, revoke the key and issue another.
				</Notice>
				<p className="hb-api-keys-issued-meta">
					<span>{ROLE_OPTIONS.find((option) => option.value === issued.key.role)?.label}</span>
					<span>{issued.key.projectIds.map(project).join(", ")}</span>
					<span>{expiryText(issued.key, issued.key.createdAt)}</span>
				</p>
				<p className="hb-api-keys-issued-meta">
					Host apps send it as <code className="hb-mono">Authorization: Bearer &lt;key&gt;</code>
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
}: {
	flow: ApiKeysFlow;
	state: ApiKeysState;
	projects: readonly KeyProject[];
}) {
	const draft = state.draft;
	if (draft === undefined) return null;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void flow.create();
	};
	return (
		<Panel
			className="hb-api-keys-form"
			aria-labelledby="hb-api-keys-form-title"
			header={
				<h2 id="hb-api-keys-form-title" className="hb-api-keys-form-title">
					New key
				</h2>
			}
		>
			<form onSubmit={submit} noValidate>
				<FormLayout>
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
								? { hint: "Say what will use it, such as Sal's supervisor." }
								: { error: draft.nameError })}
						/>
						<SelectField
							label="Project"
							name="project"
							options={projects.map((project) => ({ value: project.id, label: project.name }))}
							value={draft.projectId}
							disabled={draft.busy}
							onChange={(event) => flow.editDraft({ projectId: event.target.value })}
						/>
					</FormGrid>
					<FormField id="hb-api-keys-role" label="Role" hint={ROLE_HINT[draft.role]}>
						<SegmentedControl
							label="Role"
							options={ROLE_OPTIONS}
							value={draft.role}
							onChange={(role) => flow.editDraft({ role })}
						/>
					</FormField>
					<FormField id="hb-api-keys-expiry" label="Expires">
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
	const revokeButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	// Into the confirmation when it opens, and back to Revoke when it closes without revoking.
	useEffect(() => {
		if (confirming) cancelButton.current?.focus();
		else if (wasConfirming.current) revokeButton.current?.focus();
		wasConfirming.current = confirming;
	}, [confirming]);

	return (
		<li className={`hb-api-key-row${active ? "" : " hb-api-key-row-ended"}`}>
			<div className="hb-api-key-row-main">
				<KeyIcon size="sm" className="hb-api-key-row-icon" />
				<div className="hb-api-key-row-text">
					<p className="hb-api-key-row-title">
						<span className="hb-api-key-row-name">{name}</span>
						<Badge>{ROLE_OPTIONS.find((option) => option.value === apiKey.role)?.label ?? apiKey.role}</Badge>
						{apiKey.revokedAt !== undefined ? (
							<Badge tone="error">Revoked</Badge>
						) : active ? null : (
							<Badge>Expired</Badge>
						)}
					</p>
					<p className="hb-api-key-row-meta">
						<span className="hb-mono">{prefixText(apiKey)}</span>
						<span>{apiKey.projectIds.map(projectName).join(", ")}</span>
					</p>
					<p className="hb-api-key-row-meta">
						<span>Created {ago(apiKey.createdAt, now)}</span>
						<span>{lastUsedText(apiKey, now)}</span>
						<span>
							{apiKey.revokedAt === undefined ? expiryText(apiKey, now) : `Revoked ${ago(apiKey.revokedAt, now)}`}
						</span>
					</p>
				</div>
				{active && !confirming ? (
					<Button
						ref={revokeButton}
						size="xs"
						variant="danger"
						aria-label={`Revoke ${name}`}
						onClick={() => flow.askRevoke(apiKey.id)}
					>
						Revoke
					</Button>
				) : null}
			</div>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: a confirmation inside a list row, not a form or a fieldset.
				<div className="hb-api-key-confirm" role="group" aria-label={`Revoke ${name}`}>
					<p className="hb-api-key-confirm-text">
						Revoke {name}? Anything that calls Harbour with it is refused from its next call. This can't be undone.
					</p>
					<div className="hb-api-key-confirm-actions">
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
				<p className="hb-api-key-row-error" role="alert">
					{problemText(problem, "revoke")}
				</p>
			)}
		</li>
	);
}
