// The Environments pages (compute console): what each new sandbox starts with. The list shows an account's
// environments; opening one shows its variables, secret files, repositories and egress grants, each with its own add
// and remove. A variable can be protected: it's bound to the hosts it may be sent to, every sandbox gets its own
// `kph_` placeholder for it, and the host's egress proxy swaps the placeholder for the value only on a request to one
// of those hosts, so the value never enters a sandbox. Every call goes through the `EnvironmentsSource` the host binds.

import { useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SelectField, TextAreaField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField, PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PencilIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { BackIcon, EllipsisIcon, ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import {
	bytesText,
	type ComputeAccount,
	type DestinationBinding,
	type Environment,
	type EnvironmentFile,
	type EnvironmentRepo,
	type EnvironmentsSource,
	type EnvironmentVariable,
	type HttpMethod,
	type VariableInput,
} from "./compute-model.ts";
import {
	bindingText,
	hostProblem,
	inspectedHosts,
	isMethod,
	modeText,
	pathProblem,
	repoUrlProblem,
	splitList,
	variableNameProblem,
} from "./egress-rules.ts";
import { GrantsSection } from "./grants-section.tsx";
import { cellMono, cellSub, computePage, messageOf, SectionHeading, table, tableFrame, td, th } from "./parts.tsx";

type NoticeState = { level: "info" | "error"; text: string } | undefined;

const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------------
// The list

export interface EnvironmentsPageProps {
	readonly source: EnvironmentsSource;
	readonly account: ComputeAccount;
	/** An environment's own page. */
	readonly environmentHref: (environmentId: string) => string;
	/** Goes to a path without reloading: where New environment lands. */
	readonly navigate?: (path: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open New environment when the page opens, for a story. */
	readonly creating?: boolean;
}

export function EnvironmentsPage({
	source,
	account,
	environmentHref,
	navigate,
	now: fixedNow,
	creating = false,
}: EnvironmentsPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	const [newOpen, setNewOpen] = useState(creating);
	const now = fixedNow ?? Date.now();
	const addButton = (
		<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
			New environment
		</Button>
	);
	return (
		<div className={computePage}>
			<PageHeader
				title="Environments"
				lede="What each new sandbox starts with: variables, secret files and repositories, and where it may connect. Mark a variable protected and sandboxes only ever see a placeholder for it."
				actions={addButton}
			/>
			{state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the environments.")}
				</Notice>
			) : state.status === "loading" ? (
				<ListSkeleton />
			) : state.value.length === 0 ? (
				<EmptyState title="No environments yet" action={addButton}>
					An environment holds the variables, files and repositories a sandbox starts with, such as a GitHub token the
					sandbox can use but never read.
				</EmptyState>
			) : (
				<div className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Name
								</th>
								<th className={th} scope="col">
									Variables
								</th>
								<th className={th} scope="col">
									Files
								</th>
								<th className={th} scope="col">
									Repositories
								</th>
								<th className={th} scope="col">
									Grants
								</th>
								<th className={th} scope="col">
									Sandboxes
								</th>
								<th className={th} scope="col">
									Updated
								</th>
							</tr>
						</thead>
						<tbody>
							{state.value.map((env) => {
								const protectedCount = env.variables.filter((variable) => variable.protected).length;
								return (
									<tr key={env.id} data-environment={env.id} className="hover:bg-hover">
										<td className={td}>
											<a
												className="block max-w-(--kt-card-width) truncate font-medium text-fg underline decoration-border-strong underline-offset-2"
												href={environmentHref(env.id)}
											>
												{env.name}
											</a>
											{env.description === undefined ? null : (
												<span className={`${cellSub} max-w-(--kt-card-width) truncate`}>{env.description}</span>
											)}
										</td>
										<td className={td}>
											<span className="tabular-nums">{env.variables.length}</span>
											{protectedCount === 0 ? null : <span className={cellSub}>{protectedCount} protected</span>}
										</td>
										<td className={`${td} tabular-nums`}>{env.files.length}</td>
										<td className={`${td} tabular-nums`}>{env.repos.length}</td>
										<td className={`${td} tabular-nums`}>{env.grants.length}</td>
										<td className={`${td} tabular-nums`}>{env.sandboxCount}</td>
										<td className={td}>
											<span className="text-muted" title={new Date(env.updatedAt).toLocaleString("en-GB")}>
												{agoText(env.updatedAt, now)}
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{newOpen ? (
				<DetailsDialog
					title="New environment"
					submitLabel="Create"
					onClose={() => setNewOpen(false)}
					onSave={async (input) => {
						const made = await source.create({ accountId: account.id, ...input });
						setNewOpen(false);
						if (navigate !== undefined) navigate(environmentHref(made.id));
						else reload();
					}}
				/>
			) : null}
		</div>
	);
}

function ListSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1].map((row) => (
					<Skeleton key={row} lines={2} />
				))}
			</div>
		</div>
	);
}

/** New environment and Edit details: a name and a description. */
function DetailsDialog({
	title,
	submitLabel,
	environment,
	onClose,
	onSave,
}: {
	title: string;
	submitLabel: string;
	environment?: Environment;
	onClose: () => void;
	onSave: (input: { name: string; description: string }) => Promise<void>;
}) {
	const [name, setName] = useState(environment?.name ?? "");
	const [description, setDescription] = useState(environment?.description ?? "");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const nameError =
		name === "" || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
			? undefined
			: "Use lowercase letters, digits and dashes.";
	const submit = () => {
		if (name === "" || nameError !== undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		onSave({ name, description: description.trim() }).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't save the environment. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title={title}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={name === "" || nameError !== undefined}>
						{submitLabel}
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					hint="Lowercase letters, digits and dashes. kantel new --env takes it."
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="backend-dev"
					mono
					spellCheck={false}
					{...(nameError === undefined ? {} : { error: nameError })}
				/>
				<TextField
					label="Description"
					hint="Optional. What it's for."
					value={description}
					onChange={(event) => setDescription(event.currentTarget.value)}
					placeholder="The API and its workers"
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// One environment

export interface EnvironmentPageProps {
	readonly source: EnvironmentsSource;
	readonly environmentId: string;
	/** The list, for the way back and after a delete. */
	readonly listHref: string;
	readonly navigate?: (path: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open Add variable when the page opens, protected, for a story. */
	readonly addingProtected?: boolean;
}

type Editing =
	| { readonly kind: "variable"; readonly variable?: EnvironmentVariable; readonly protect?: boolean }
	| { readonly kind: "rotate"; readonly variable: EnvironmentVariable }
	| { readonly kind: "file"; readonly file?: EnvironmentFile }
	| { readonly kind: "repo" }
	| { readonly kind: "details" }
	| { readonly kind: "delete" };

export function EnvironmentPage({
	source,
	environmentId,
	listHref,
	navigate,
	now: fixedNow,
	addingProtected = false,
}: EnvironmentPageProps) {
	const { state, reload } = useLoad(() => source.get(environmentId), [source, environmentId]);
	// What a change answered, ahead of the next read.
	const [saved, setSaved] = useState<Environment>();
	const [editing, setEditing] = useState<Editing | undefined>(
		addingProtected ? { kind: "variable", protect: true } : undefined,
	);
	const [notice, setNotice] = useState<NoticeState>();
	// The repository list is saved whole, from the list it was changed from, so one change waits for the last.
	const [savingRepos, setSavingRepos] = useState(false);
	const now = fixedNow ?? Date.now();
	const env = saved ?? (state.status === "ready" ? state.value : undefined);

	const apply = async (change: Promise<Environment>, done?: string): Promise<void> => {
		const next = await change;
		setSaved(next);
		if (done !== undefined) setNotice({ level: "info", text: done });
	};
	const applyRepos = async (repos: readonly EnvironmentRepo[], done: string): Promise<void> => {
		if (env === undefined || savingRepos) return;
		setSavingRepos(true);
		try {
			await apply(source.setRepos(env.id, repos), done);
		} finally {
			setSavingRepos(false);
		}
	};

	const back = (
		<a
			className="inline-flex items-center gap-1 text-sm text-muted no-underline hover:text-fg"
			href={listHref}
			onClick={(event) => {
				if (navigate === undefined) return;
				event.preventDefault();
				navigate(listHref);
			}}
		>
			<BackIcon />
			Environments
		</a>
	);

	if (env === undefined) {
		return (
			<div className={computePage}>
				{back}
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the environment.")}
					</Notice>
				) : (
					<ListSkeleton />
				)}
			</div>
		);
	}

	const bindings = env.variables.flatMap((variable) => variable.bindings);
	const inspected = inspectedHosts(bindings, env.grants);
	const pageMenu: MenuEntry[] = [
		{
			kind: "item",
			id: "details",
			label: "Edit name and description",
			icon: <PencilIcon size="sm" />,
			onSelect: () => setEditing({ kind: "details" }),
		},
		{ kind: "separator", id: "sep-delete" },
		{
			kind: "item",
			id: "delete",
			label: "Delete environment",
			icon: <TrashIcon />,
			danger: true,
			onSelect: () => setEditing({ kind: "delete" }),
		},
	];

	return (
		<div className={computePage}>
			{back}
			<PageHeader
				title={env.name}
				{...(env.description === undefined ? {} : { lede: env.description })}
				actions={
					<>
						<Badge>{plural(env.sandboxCount, "sandbox", "sandboxes")}</Badge>
						<Menu label={`Actions for ${env.name}`} icon={<EllipsisIcon />} entries={pageMenu} align="end" />
					</>
				}
			/>
			<Notice announce={false}>
				New sandboxes start with what's here. A protected variable's new value reaches running sandboxes on their next
				request, with the same placeholder.
			</Notice>
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

			<VariablesSection
				env={env}
				now={now}
				onAdd={(protect) => setEditing({ kind: "variable", protect })}
				onEdit={(variable) => setEditing({ kind: "variable", variable })}
				onRotate={(variable) => setEditing({ kind: "rotate", variable })}
				onRemove={(variable) =>
					apply(source.removeVariable(env.id, variable.name), `Removed ${variable.name}.`).catch((caught: unknown) =>
						setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't remove ${variable.name}.`) }),
					)
				}
			/>

			<FilesSection
				env={env}
				now={now}
				onAdd={() => setEditing({ kind: "file" })}
				onReplace={(file) => setEditing({ kind: "file", file })}
				onRemove={(file) =>
					apply(source.removeFile(env.id, file.path), `Removed ${file.path}.`).catch((caught: unknown) =>
						setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't remove ${file.path}.`) }),
					)
				}
			/>

			<ReposSection
				env={env}
				saving={savingRepos}
				onAdd={() => setEditing({ kind: "repo" })}
				onRemove={(repo) =>
					applyRepos(
						env.repos.filter((each) => each.url !== repo.url),
						`Removed ${repo.url}.`,
					).catch((caught: unknown) =>
						setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't remove ${repo.url}.`) }),
					)
				}
			/>

			<GrantsSection
				id="environment-grants-title"
				title="Egress grants"
				description={`Hosts sandboxes may or may not reach, on top of the account's proxy settings, with no one asked. Deny wins. ${
					inspected.length === 0
						? "Everything else is tunnelled without being decrypted."
						: `The proxy looks inside HTTPS to ${inspected.join(", ")}; everything else is tunnelled without being decrypted.`
				}`}
				grants={env.grants}
				onSave={(grants) => apply(source.setGrants(env.id, grants), "Saved the grants.")}
			/>

			{editing?.kind === "variable" ? (
				<VariableDialog
					{...(editing.variable === undefined ? {} : { variable: editing.variable })}
					protect={editing.protect ?? editing.variable?.protected ?? false}
					taken={env.variables.map((variable) => variable.name)}
					onClose={() => setEditing(undefined)}
					onSave={async (input) => {
						await apply(
							source.setVariable(env.id, input),
							editing.variable === undefined ? `Added ${input.name}.` : `Saved ${input.name}.`,
						);
						setEditing(undefined);
					}}
				/>
			) : null}
			{editing?.kind === "rotate" ? (
				<RotateDialog
					variable={editing.variable}
					onClose={() => setEditing(undefined)}
					onRotate={async (value) => {
						await apply(
							source.setVariable(env.id, {
								name: editing.variable.name,
								protected: true,
								value,
								bindings: editing.variable.bindings,
							}),
							`Rotated ${editing.variable.name}. Running sandboxes use the new value from their next request.`,
						);
						setEditing(undefined);
					}}
				/>
			) : null}
			{editing?.kind === "file" ? (
				<FileDialog
					{...(editing.file === undefined ? {} : { file: editing.file })}
					onClose={() => setEditing(undefined)}
					onSave={async (input) => {
						await apply(source.setFile(env.id, input), `Saved ${input.path}.`);
						setEditing(undefined);
					}}
				/>
			) : null}
			{editing?.kind === "repo" ? (
				<RepoDialog
					taken={env.repos.map((repo) => repo.url)}
					onClose={() => setEditing(undefined)}
					onAdd={async (repo) => {
						await applyRepos([...env.repos, repo], `Added ${repo.url}.`);
						setEditing(undefined);
					}}
				/>
			) : null}
			{editing?.kind === "details" ? (
				<DetailsDialog
					title="Edit environment"
					submitLabel="Save"
					environment={env}
					onClose={() => setEditing(undefined)}
					onSave={async (input) => {
						await apply(source.update(env.id, input), "Saved.");
						setEditing(undefined);
					}}
				/>
			) : null}
			{editing?.kind === "delete" ? (
				<DeleteEnvironmentDialog
					env={env}
					onClose={() => setEditing(undefined)}
					onDelete={async () => {
						await source.remove(env.id);
						setEditing(undefined);
						if (navigate !== undefined) navigate(listHref);
					}}
				/>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables

function Bindings({ bindings }: { bindings: readonly DestinationBinding[] }) {
	return (
		<span className="flex max-w-(--kt-card-width) flex-col gap-0.5">
			{bindings.map((binding) => (
				<span key={bindingText(binding)} className={`${cellMono} truncate`} title={bindingText(binding)}>
					{binding.methods.length === 0 ? null : <span className="text-muted">{binding.methods.join(", ")} </span>}
					<span className="text-fg">{binding.host}</span>
					{binding.pathPrefixes.length === 0 ? null : (
						<span className="text-muted"> {binding.pathPrefixes.join(", ")}</span>
					)}
				</span>
			))}
		</span>
	);
}

function VariablesSection({
	env,
	now,
	onAdd,
	onEdit,
	onRotate,
	onRemove,
}: {
	env: Environment;
	now: number;
	onAdd: (protect: boolean) => void;
	onEdit: (variable: EnvironmentVariable) => void;
	onRotate: (variable: EnvironmentVariable) => void;
	onRemove: (variable: EnvironmentVariable) => void;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="environment-variables-title">
			<SectionHeading
				id="environment-variables-title"
				title="Variables"
				actions={
					<>
						<Button size="sm" icon={<PlusIcon size="sm" />} onClick={() => onAdd(false)}>
							Add variable
						</Button>
						<Button size="sm" icon={<PlusIcon size="sm" />} onClick={() => onAdd(true)}>
							Add protected variable
						</Button>
					</>
				}
			/>
			{env.variables.length === 0 ? (
				<p className="m-0 text-sm text-muted">
					No variables. A plain one is its value in the sandbox; a protected one is a placeholder there.
				</p>
			) : (
				<div className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Name
								</th>
								<th className={th} scope="col">
									In the sandbox
								</th>
								<th className={th} scope="col">
									Swapped in for
								</th>
								<th className={th} scope="col">
									Updated
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{env.variables.map((variable) => {
								const entries: MenuEntry[] = [
									{
										kind: "item",
										id: "edit",
										label: variable.protected ? "Edit bindings" : "Edit",
										icon: <PencilIcon size="sm" />,
										onSelect: () => onEdit(variable),
									},
									...(variable.protected
										? [
												{
													kind: "item" as const,
													id: "rotate",
													label: "Rotate value",
													icon: <ReconnectIcon />,
													onSelect: () => onRotate(variable),
												},
											]
										: []),
									{ kind: "separator", id: "sep-remove" },
									{
										kind: "item",
										id: "remove",
										label: "Remove",
										icon: <TrashIcon />,
										danger: true,
										onSelect: () => onRemove(variable),
									},
								];
								return (
									<tr key={variable.name} data-variable={variable.name}>
										<td className={td}>
											<span className="font-mono text-code text-fg">{variable.name}</span>
										</td>
										<td className={td}>
											{variable.protected ? (
												<span className="flex items-center gap-2">
													<Badge tone="accent">Protected</Badge>
													<span className={cellMono}>kph_ placeholder</span>
												</span>
											) : (
												<span
													className={`${cellMono} block max-w-(--kt-popover-width) truncate`}
													title={variable.value}
												>
													{variable.value}
												</span>
											)}
										</td>
										<td className={td}>
											{variable.protected ? (
												<Bindings bindings={variable.bindings} />
											) : (
												<span className="text-faint">Not swapped</span>
											)}
										</td>
										<td className={td}>
											<span className="text-muted" title={new Date(variable.updatedAt).toLocaleString("en-GB")}>
												{agoText(variable.updatedAt, now)}
											</span>
										</td>
										<td className={`${td} w-0 text-right`}>
											<Menu
												label={`Actions for ${variable.name}`}
												icon={<EllipsisIcon />}
												entries={entries}
												align="end"
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

/** One binding as the dialog edits it: its fields as typed. */
interface BindingDraft {
	readonly key: number;
	readonly host: string;
	readonly paths: string;
	readonly methods: string;
}

let bindingKeys = 0;
const bindingDraft = (binding?: DestinationBinding): BindingDraft => {
	bindingKeys += 1;
	return {
		key: bindingKeys,
		host: binding?.host ?? "",
		paths: binding?.pathPrefixes.join(", ") ?? "",
		methods: binding?.methods.join(", ") ?? "",
	};
};

/** A draft binding as a binding, or what's wrong with it. */
function checkBinding(draft: BindingDraft): {
	binding?: DestinationBinding;
	host?: string;
	paths?: string;
	methods?: string;
} {
	const host = hostProblem(draft.host);
	const pathPrefixes = splitList(draft.paths);
	const paths = pathPrefixes.map(pathProblem).find((problem) => problem !== undefined);
	const typed = splitList(draft.methods).map((method) => method.toUpperCase());
	const unknown = typed.find((method) => !isMethod(method));
	const methods = unknown === undefined ? undefined : `${unknown} isn't an HTTP method Kantel knows.`;
	if (host !== undefined || paths !== undefined || methods !== undefined) {
		return {
			...(host === undefined ? {} : { host }),
			...(paths === undefined ? {} : { paths }),
			...(methods === undefined ? {} : { methods }),
		};
	}
	return {
		binding: {
			host: draft.host.trim().toLowerCase(),
			pathPrefixes,
			methods: typed.filter(isMethod) as HttpMethod[],
		},
	};
}

/** Add variable, Add protected variable and Edit: a name, a value, and for a protected one where it may go. */
function VariableDialog({
	variable,
	protect,
	taken,
	onClose,
	onSave,
}: {
	variable?: EnvironmentVariable;
	protect: boolean;
	taken: readonly string[];
	onClose: () => void;
	onSave: (input: VariableInput) => Promise<void>;
}) {
	const editing = variable !== undefined;
	const [name, setName] = useState(variable?.name ?? "");
	const [value, setValue] = useState(variable?.protected === false ? (variable.value ?? "") : "");
	const [isProtected, setProtected] = useState(protect);
	const [drafts, setDrafts] = useState<readonly BindingDraft[]>(() =>
		variable !== undefined && variable.bindings.length > 0 ? variable.bindings.map(bindingDraft) : [bindingDraft()],
	);
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	// Keeping a protected value: an edit of a protected variable that stays protected may leave the value empty.
	const keepsValue = editing && variable.protected && isProtected;
	const nameError = editing
		? undefined
		: (variableNameProblem(name) ?? (taken.includes(name) ? `There's already a ${name}.` : undefined));
	const valueError = value === "" && !keepsValue ? "Give it a value." : undefined;
	const checked = drafts.map(checkBinding);
	const bindingsBad = isProtected && checked.some((each) => each.binding === undefined);
	const submit = () => {
		setTried(true);
		if (nameError !== undefined || valueError !== undefined || bindingsBad || busy) return;
		setBusy(true);
		setFailure(undefined);
		onSave({
			name,
			protected: isProtected,
			...(value === "" && keepsValue ? {} : { value }),
			bindings: isProtected ? checked.flatMap((each) => (each.binding === undefined ? [] : [each.binding])) : [],
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't save the variable. Try again."));
			},
		);
	};
	const setDraft = (key: number, change: Partial<Omit<BindingDraft, "key">>) =>
		setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
	const title = editing ? `Edit ${variable.name}` : isProtected ? "Add protected variable" : "Add variable";
	return (
		<Dialog
			open
			title={title}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						{editing ? "Save" : "Add variable"}
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				{editing ? null : (
					<TextField
						label="Name"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						placeholder={isProtected ? "GH_TOKEN" : "NODE_ENV"}
						mono
						spellCheck={false}
						{...(tried && nameError !== undefined ? { error: nameError } : {})}
					/>
				)}
				<Switch
					label="Protected"
					checked={isProtected}
					onChange={setProtected}
					hint={
						isProtected
							? "Each sandbox gets a kph_ placeholder. The host's egress proxy swaps it for the value only on requests to the hosts below; sent anywhere else, the request is refused."
							: "The sandbox gets the value itself, readable by anything in it."
					}
				/>
				<TextAreaField
					label={keepsValue ? "New value" : "Value"}
					hint={
						keepsValue
							? "Leave it empty to keep the current value. Kantel never shows a protected value again."
							: isProtected
								? "Write-only: Kantel keeps it encrypted and never shows it again."
								: "Shown to anyone who can see this environment."
					}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					rows={isProtected ? 2 : 3}
					mono
					spellCheck={false}
					autoComplete="off"
					{...(tried && valueError !== undefined ? { error: valueError } : {})}
				/>
				{isProtected ? (
					<FormField
						id="variable-bindings"
						label="Swapped in only for"
						hint="A host, and optionally path prefixes and methods (comma-separated). The proxy looks inside HTTPS to these hosts only."
					>
						<div className="flex flex-col gap-3">
							{drafts.map((draft, at) => {
								const problems = checked[at] ?? {};
								return (
									<div
										key={draft.key}
										className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-2 rounded-panel border border-border p-3"
									>
										<TextField
											label="Host"
											value={draft.host}
											onChange={(event) => setDraft(draft.key, { host: event.currentTarget.value })}
											placeholder="api.github.com"
											mono
											spellCheck={false}
											{...(tried && problems.host !== undefined ? { error: problems.host } : {})}
										/>
										<IconButton
											size="sm"
											variant="ghost"
											icon={<TrashIcon />}
											label={`Remove the binding to ${draft.host || "this host"}`}
											disabled={drafts.length === 1}
											onClick={() => setDrafts((current) => current.filter((each) => each.key !== draft.key))}
											className="mt-6"
										/>
										<div className="col-span-2 grid grid-cols-2 gap-2">
											<TextField
												label="Path prefixes"
												value={draft.paths}
												onChange={(event) => setDraft(draft.key, { paths: event.currentTarget.value })}
												placeholder="Any path"
												mono
												spellCheck={false}
												{...(tried && problems.paths !== undefined ? { error: problems.paths } : {})}
											/>
											<TextField
												label="Methods"
												value={draft.methods}
												onChange={(event) => setDraft(draft.key, { methods: event.currentTarget.value })}
												placeholder="Any method"
												mono
												spellCheck={false}
												{...(tried && problems.methods !== undefined ? { error: problems.methods } : {})}
											/>
										</div>
									</div>
								);
							})}
							<div>
								<Button
									size="xs"
									icon={<PlusIcon size="sm" />}
									onClick={() => setDrafts((current) => [...current, bindingDraft()])}
								>
									Add another host
								</Button>
							</div>
						</div>
					</FormField>
				) : null}
				{isProtected ? (
					<p className="m-0 text-xs text-muted">
						Protected suits a token sent in a header or a request body: GitHub, npm, OpenAI, Anthropic and most HTTP
						APIs. It can't work for a value that signs requests (AWS SigV4), a database password or an SSH key: give
						those as plain or short-lived values. A client that pins certificates refuses the proxy.
					</p>
				) : null}
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** Rotate value: a protected variable's new value, nothing else. */
function RotateDialog({
	variable,
	onClose,
	onRotate,
}: {
	variable: EnvironmentVariable;
	onClose: () => void;
	onRotate: (value: string) => Promise<void>;
}) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const submit = () => {
		if (value === "" || busy) return;
		setBusy(true);
		setFailure(undefined);
		onRotate(value).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't rotate the value. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title={`Rotate ${variable.name}`}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={value === ""}>
						Rotate
					</Button>
				</>
			}
		>
			<p>
				Running sandboxes use the new value from their next request. Their placeholder doesn't change, so nothing in
				them needs restarting.
			</p>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="New value"
					type="password"
					autoComplete="off"
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					mono
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Secret files and repositories

function FilesSection({
	env,
	now,
	onAdd,
	onReplace,
	onRemove,
}: {
	env: Environment;
	now: number;
	onAdd: () => void;
	onReplace: (file: EnvironmentFile) => void;
	onRemove: (file: EnvironmentFile) => void;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="environment-files-title">
			<SectionHeading
				id="environment-files-title"
				title="Secret files"
				actions={
					<Button size="sm" icon={<PlusIcon size="sm" />} onClick={onAdd}>
						Add file
					</Button>
				}
			/>
			<p className="m-0 text-sm text-muted">
				Written to each new sandbox's disk, so anything in the sandbox can read them. Kantel keeps them encrypted and
				never shows them again.
			</p>
			{env.files.length === 0 ? null : (
				<div className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Path
								</th>
								<th className={th} scope="col">
									Mode
								</th>
								<th className={`${th} text-right`} scope="col">
									Size
								</th>
								<th className={th} scope="col">
									Updated
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{env.files.map((file) => (
								<tr key={file.path}>
									<td className={td}>
										<span className={`${cellMono} text-fg`}>{file.path}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{modeText(file.mode)}</span>
									</td>
									<td className={`${td} text-right tabular-nums`}>{bytesText(file.sizeBytes)}</td>
									<td className={td}>
										<span className="text-muted">{agoText(file.updatedAt, now)}</span>
									</td>
									<td className={`${td} w-0 text-right`}>
										<Menu
											label={`Actions for ${file.path}`}
											icon={<EllipsisIcon />}
											align="end"
											entries={[
												{
													kind: "item",
													id: "replace",
													label: "Replace",
													icon: <PencilIcon size="sm" />,
													onSelect: () => onReplace(file),
												},
												{ kind: "separator", id: "sep-remove" },
												{
													kind: "item",
													id: "remove",
													label: "Remove",
													icon: <TrashIcon />,
													danger: true,
													onSelect: () => onRemove(file),
												},
											]}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

const MODES = [
	{ value: "384", label: "0600: only its owner reads and writes it" },
	{ value: "256", label: "0400: only its owner reads it" },
	{ value: "420", label: "0644: everyone reads it" },
	{ value: "493", label: "0755: everyone runs it" },
] as const;

function FileDialog({
	file,
	onClose,
	onSave,
}: {
	file?: EnvironmentFile;
	onClose: () => void;
	onSave: (input: { path: string; mode: number; content?: string }) => Promise<void>;
}) {
	const [path, setPath] = useState(file?.path ?? "");
	const [mode, setMode] = useState(String(file?.mode ?? 0o600));
	const [content, setContent] = useState("");
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const pathError = path.startsWith("/") ? undefined : "Give the whole path, starting /.";
	const contentError = content === "" && file === undefined ? "Give the file's contents." : undefined;
	const submit = () => {
		setTried(true);
		if (pathError !== undefined || contentError !== undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		onSave({ path, mode: Number(mode), ...(content === "" ? {} : { content }) }).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't save the file. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title={file === undefined ? "Add secret file" : `Replace ${file.path}`}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						Save
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				{file === undefined ? (
					<TextField
						label="Path"
						value={path}
						onChange={(event) => setPath(event.currentTarget.value)}
						placeholder="/home/user/.npmrc"
						mono
						spellCheck={false}
						{...(tried && pathError !== undefined ? { error: pathError } : {})}
					/>
				) : null}
				<SelectField
					label="Permissions"
					value={mode}
					onChange={(event) => setMode(event.currentTarget.value)}
					options={MODES}
				/>
				<TextAreaField
					label="Contents"
					hint={file === undefined ? "Write-only." : "Leave it empty to keep the current contents."}
					value={content}
					onChange={(event) => setContent(event.currentTarget.value)}
					rows={5}
					mono
					spellCheck={false}
					{...(tried && contentError !== undefined ? { error: contentError } : {})}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function ReposSection({
	env,
	saving,
	onAdd,
	onRemove,
}: {
	env: Environment;
	/** A change to the list is being saved: nothing else changes it until it's done. */
	saving: boolean;
	onAdd: () => void;
	onRemove: (repo: EnvironmentRepo) => void;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="environment-repos-title">
			<SectionHeading
				id="environment-repos-title"
				title="Repositories"
				actions={
					<Button size="sm" icon={<PlusIcon size="sm" />} disabled={saving} onClick={onAdd}>
						Add repository
					</Button>
				}
			/>
			<p className="m-0 text-sm text-muted">
				Cloned into each new sandbox when it starts, through the egress proxy: a private one needs a protected token
				bound to its host.
			</p>
			{env.repos.length === 0 ? null : (
				<div className={tableFrame}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Repository
								</th>
								<th className={th} scope="col">
									Cloned to
								</th>
								<th className={th} scope="col">
									Ref
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{env.repos.map((repo) => (
								<tr key={repo.url}>
									<td className={td}>
										<span className={`${cellMono} text-fg`}>{repo.url}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{repo.path ?? `~/${repoName(repo.url)}`}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{repo.ref ?? "Default branch"}</span>
									</td>
									<td className={`${td} w-0 text-right`}>
										<IconButton
											size="xs"
											variant="ghost"
											icon={<TrashIcon />}
											label={`Remove ${repo.url}`}
											disabled={saving}
											onClick={() => onRemove(repo)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

const repoName = (url: string): string =>
	url
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean)
		.at(-1) ?? "repo";

function RepoDialog({
	taken,
	onClose,
	onAdd,
}: {
	/** The environment's repositories' addresses: a repository is known by its address, so one can't be added twice. */
	taken: readonly string[];
	onClose: () => void;
	onAdd: (repo: EnvironmentRepo) => Promise<void>;
}) {
	const [url, setUrl] = useState("");
	const [path, setPath] = useState("");
	const [ref, setRef] = useState("");
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const urlError = repoUrlProblem(url, taken);
	const pathError = path === "" || path.startsWith("/") ? undefined : "Give the whole path, starting /.";
	const submit = () => {
		setTried(true);
		if (urlError !== undefined || pathError !== undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		onAdd({
			url: url.trim(),
			...(path === "" ? {} : { path }),
			...(ref.trim() === "" ? {} : { ref: ref.trim() }),
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't add the repository. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title="Add repository"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						Add repository
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Address"
					value={url}
					onChange={(event) => setUrl(event.currentTarget.value)}
					placeholder="https://github.com/lleverage-ai/kantel"
					mono
					spellCheck={false}
					{...(tried && urlError !== undefined ? { error: urlError } : {})}
				/>
				<TextField
					label="Clone to"
					hint="Optional. Default: a folder of its name in the home directory."
					value={path}
					onChange={(event) => setPath(event.currentTarget.value)}
					placeholder="/home/user/src/kantel"
					mono
					spellCheck={false}
					{...(tried && pathError !== undefined ? { error: pathError } : {})}
				/>
				<TextField
					label="Ref"
					hint="Optional. A branch, tag or commit."
					value={ref}
					onChange={(event) => setRef(event.currentTarget.value)}
					placeholder="main"
					mono
					spellCheck={false}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function DeleteEnvironmentDialog({
	env,
	onClose,
	onDelete,
}: {
	env: Environment;
	onClose: () => void;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	return (
		<Dialog
			open
			title="Delete this environment?"
			onClose={onClose}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							onDelete().then(
								() => setBusy(false),
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete it. Try again."));
								},
							);
						}}
					>
						Delete
					</Button>
				</>
			}
		>
			<p>
				<strong>{env.name}</strong> and its values go for good.{" "}
				{env.sandboxCount === 0
					? "No sandbox uses it."
					: `The ${plural(env.sandboxCount, "sandbox", "sandboxes")} made from it keep their plain variables and files, but their protected variables stop working.`}
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
