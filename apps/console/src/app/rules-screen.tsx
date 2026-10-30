import type { OwnerRef, PromptRule } from "@harbour/contracts";
import { PROMPT_RULE_TEXT_LIMIT } from "@harbour/contracts";
import {
	Badge,
	Button,
	Disclosure,
	EmptyState,
	FormActions,
	FormGrid,
	FormSection,
	ListRow,
	Notice,
	PageHeader,
	Panel,
	PlusIcon,
	SegmentedControl,
	type SegmentOption,
	SelectField,
	Skeleton,
	TextAreaField,
	TextField,
} from "@harbour/ui";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { isOrganisationScope, type ProjectSummary } from "../api/client.ts";
import { type ConsoleRules, type RuleDraft, ruleDraftErrors, ruleInput } from "../api/rules-http.ts";

// The Rules page: prompt rules, named pieces of system prompt that every new session gets around its agent's own
// prompt, in layers: the platform's, the organisation's, the project's, the agent's own prompt, then the person's.
// One owner's rules at a time, each with Edit and Remove and an Add rule form, and a preview of what a new session in
// the organisation or in a project would get. The server decides who may write what (packages/rules/CONTRACT.md): the
// page offers every write but the platform's, which only Harbour itself makes, and shows a refusal as the server
// words it.

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const count = (value: number) => value.toLocaleString("en-GB");

type Whose = OwnerRef["kind"];

const LAYER_LABELS: Readonly<Record<Whose, string>> = {
	platform: "Platform",
	organisation: "Organisation",
	project: "Project",
	user: "Yours",
};

type Load<T> =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly value: T }
	| { readonly status: "error"; readonly message: string };

/**
 * Reads, and reads again on `reload` or a new `version`, keeping what it showed until the new answer comes. A new
 * `read` (another owner or project) belongs to a new component, keyed by it, so it starts from loading.
 */
function useLoad<T>(read: (signal: AbortSignal) => Promise<T>, version = 0): { state: Load<T>; reload: () => void } {
	const [state, setState] = useState<Load<T>>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt and version re-run the read.
	useEffect(() => {
		const abort = new AbortController();
		setState((now) => (now.status === "ready" ? now : { status: "loading" }));
		read(abort.signal).then(
			(value) => {
				if (!abort.signal.aborted) setState({ status: "ready", value });
			},
			(reason: unknown) => {
				if (!abort.signal.aborted) setState({ status: "error", message: messageOf(reason) });
			},
		);
		return () => abort.abort();
	}, [read, attempt, version]);
	const reload = useCallback(() => setAttempt((now) => now + 1), []);
	return { state, reload };
}

function Loading({ label }: { label: string }) {
	return (
		<div className="rules-loading">
			<span className="hb-sr-only">{label}</span>
			<Skeleton lines={3} />
		</div>
	);
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
	return (
		<Notice
			level="error"
			action={
				<Button size="xs" onClick={onRetry}>
					Try again
				</Button>
			}
		>
			Couldn't read the rules. {message}
		</Notice>
	);
}

const EMPTY_DRAFT: RuleDraft = { name: "", order: "0", text: "" };

/** Add rule's form, or Edit's for one rule: a name, an order and the text, checked before they are sent. */
function RuleForm({
	initial,
	editing,
	names,
	busy,
	onSave,
	onCancel,
}: {
	initial: RuleDraft;
	/** Editing a rule: its name says which rule it is, so it stays as it is. */
	editing: boolean;
	/** The owner's rules' names, to say when a new rule would replace one. */
	names: readonly string[];
	busy: boolean;
	onSave: (draft: RuleDraft) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(initial);
	// Problems show once Save has been pressed, then follow the typing.
	const [checked, setChecked] = useState(false);
	const errors: ReturnType<typeof ruleDraftErrors> = checked ? ruleDraftErrors(draft) : {};
	const replaces = !editing && names.includes(draft.name.trim());
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setChecked(true);
		if (Object.keys(ruleDraftErrors(draft)).length === 0) onSave(draft);
	};
	const nameHint = editing
		? "A rule keeps its name. To rename it, add it under the new name and remove this one."
		: replaces
			? "There's a rule with this name already: saving replaces it."
			: "Letters, digits, dots, underscores and hyphens.";
	return (
		<form className="rules-form" onSubmit={submit} noValidate>
			<FormGrid columns={2}>
				<TextField
					label="Name"
					value={draft.name}
					readOnly={editing}
					mono
					autoComplete="off"
					spellCheck={false}
					hint={nameHint}
					{...(errors.name === undefined ? {} : { error: errors.name })}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
				/>
				<TextField
					label="Order"
					type="number"
					width="short"
					value={draft.order}
					hint="Lowest first; ties go by name."
					{...(errors.order === undefined ? {} : { error: errors.order })}
					onChange={(event) => setDraft({ ...draft, order: event.target.value })}
				/>
			</FormGrid>
			<TextAreaField
				label="Text"
				rows={6}
				value={draft.text}
				hint={`${count(draft.text.length)} of ${count(PROMPT_RULE_TEXT_LIMIT)} characters.`}
				{...(errors.text === undefined ? {} : { error: errors.text })}
				onChange={(event) => setDraft({ ...draft, text: event.target.value })}
			/>
			<FormActions>
				<Button type="submit" variant="primary" busy={busy}>
					{editing ? "Save" : "Add rule"}
				</Button>
				<Button variant="ghost" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</FormActions>
		</form>
	);
}

type FormOpen = { readonly kind: "add" } | { readonly kind: "edit"; readonly ruleId: string };

/** Where a write's refusal shows: in Add rule's panel, or in the rule's own. */
type Problem = { readonly at: string; readonly message: string };

const ADDING = "add";
const SAVED = "New sessions get it; running ones keep the rules they started with.";

/** One owner's rules, with Edit, Remove and Add rule unless they are read-only here. */
function OwnerRules({
	rules,
	owner,
	title,
	description,
	readOnly,
	onChanged,
}: {
	rules: ConsoleRules;
	owner: OwnerRef;
	title: string;
	description: string;
	/** The platform's rules: shown, never written from the console. */
	readOnly: boolean;
	/** A rule was saved or removed, so what a new session gets may have changed. */
	onChanged: () => void;
}) {
	const read = useCallback((signal: AbortSignal) => rules.list(owner, signal), [rules, owner]);
	const { state, reload } = useLoad(read);
	const [form, setForm] = useState<FormOpen>();
	const [removing, setRemoving] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<Problem>();
	const [done, setDone] = useState<string>();

	const write = async (at: string, act: () => Promise<unknown>, success: string) => {
		setBusy(true);
		setProblem(undefined);
		setDone(undefined);
		try {
			await act();
			setForm(undefined);
			setRemoving(undefined);
			setDone(success);
			reload();
			onChanged();
		} catch (reason) {
			setProblem({ at, message: messageOf(reason) });
		} finally {
			setBusy(false);
		}
	};
	const open = (next: FormOpen | undefined) => {
		setForm(next);
		setRemoving(undefined);
		setProblem(undefined);
		setDone(undefined);
	};
	const save = (at: string, draft: RuleDraft) =>
		void write(at, () => rules.put(ruleInput(owner, draft)), `Saved ${draft.name.trim()}. ${SAVED}`);
	const remove = (rule: PromptRule) => void write(rule.id, () => rules.remove(rule.id), `Removed ${rule.name}.`);
	const problemAt = (at: string) => (problem?.at === at ? <Notice level="error">{problem.message}</Notice> : null);

	const names = state.status === "ready" ? state.value.map((rule) => rule.name) : [];
	return (
		<FormSection
			level={2}
			title={title}
			description={description}
			action={
				readOnly || form?.kind === "add" ? undefined : (
					<Button size="sm" icon={<PlusIcon size="sm" />} disabled={busy} onClick={() => open({ kind: "add" })}>
						Add rule
					</Button>
				)
			}
		>
			{done === undefined ? null : <Notice>{done}</Notice>}
			{form?.kind === "add" ? (
				<Panel aria-label="New rule" header="New rule">
					{problemAt(ADDING)}
					<RuleForm
						initial={EMPTY_DRAFT}
						editing={false}
						names={names}
						busy={busy}
						onSave={(draft) => save(ADDING, draft)}
						onCancel={() => open(undefined)}
					/>
				</Panel>
			) : null}
			{state.status === "loading" ? (
				<Loading label="Loading the rules" />
			) : state.status === "error" ? (
				<Failed message={state.message} onRetry={reload} />
			) : state.value.length === 0 ? (
				<EmptyState title="No rules yet">
					{readOnly
						? "Harbour adds none of its own, and the operator hasn't added any."
						: "Add one and new sessions get it."}
				</EmptyState>
			) : (
				<div className="rules-list">
					{state.value.map((rule) => {
						const editing = form?.kind === "edit" && form.ruleId === rule.id;
						return (
							<Panel
								key={rule.id}
								aria-label={rule.name}
								header={
									<div className="rules-rule-head">
										<span className="rules-rule-name">{rule.name}</span>
										<Badge>{`Order ${rule.order}`}</Badge>
										{readOnly || editing ? null : (
											<span className="rules-rule-actions">
												<Button
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() => open({ kind: "edit", ruleId: rule.id })}
												>
													Edit
												</Button>
												<Button
													size="xs"
													variant="ghost"
													disabled={busy || removing === rule.id}
													onClick={() => {
														open(undefined);
														setRemoving(rule.id);
													}}
												>
													Remove
												</Button>
											</span>
										)}
									</div>
								}
								footer={
									removing === rule.id ? (
										<div className="rules-confirm">
											<span>Remove this rule? New sessions stop getting it; running ones keep it.</span>
											<Button size="xs" variant="danger" busy={busy} onClick={() => remove(rule)}>
												Remove rule
											</Button>
											<Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>
												Cancel
											</Button>
										</div>
									) : undefined
								}
							>
								{problemAt(rule.id)}
								{editing ? (
									<RuleForm
										initial={{ name: rule.name, order: String(rule.order), text: rule.text }}
										editing
										names={names}
										busy={busy}
										onSave={(draft) => save(rule.id, draft)}
										onCancel={() => open(undefined)}
									/>
								) : (
									<p className="rules-text">{rule.text}</p>
								)}
							</Panel>
						);
					})}
				</div>
			)}
		</FormSection>
	);
}

/** One rule a new session would get: its layer and name, with its text on demand. */
function PreviewRule({ rule }: { rule: PromptRule }) {
	return (
		<Disclosure
			summary={
				<span className="rules-preview-summary">
					<Badge>{LAYER_LABELS[rule.owner.kind]}</Badge>
					<span className="rules-rule-name">{rule.name}</span>
				</span>
			}
		>
			<p className="rules-text">{rule.text}</p>
		</Disclosure>
	);
}

/** The rules a new session in the project, or the organisation with none, would get, around the agent's own prompt. */
function ResolvedRules({ rules, projectId, version }: { rules: ConsoleRules; projectId?: string; version: number }) {
	const read = useCallback(
		(signal: AbortSignal) => rules.resolved(projectId === undefined ? {} : { projectId }, signal),
		[rules, projectId],
	);
	const { state, reload } = useLoad(read, version);
	if (state.status === "loading") return <Loading label="Loading what a new session would get" />;
	if (state.status === "error") return <Failed message={state.message} onRetry={reload} />;
	if (state.value.length === 0) {
		return <EmptyState title="No rules yet">A new session here gets only its agent's own prompt.</EmptyState>;
	}
	const before = state.value.filter((rule) => rule.owner.kind !== "user");
	const after = state.value.filter((rule) => rule.owner.kind === "user");
	return (
		<ol className="rules-preview" aria-label="What a new session gets, in order">
			{before.map((rule) => (
				<li key={rule.id}>
					<PreviewRule rule={rule} />
				</li>
			))}
			<li>
				<ListRow title="The agent's own prompt" meta="From its profile" quiet />
			</li>
			{after.map((rule) => (
				<li key={rule.id}>
					<PreviewRule rule={rule} />
				</li>
			))}
		</ol>
	);
}

const ORGANISATION_WIDE = "";

/** What a new session would get: organisation-wide, or in a project picked here. */
function Preview({
	rules,
	projects,
	version,
}: {
	rules: ConsoleRules;
	projects: readonly ProjectSummary[];
	version: number;
}) {
	const [projectId, setProjectId] = useState(ORGANISATION_WIDE);
	const project = projects.find((candidate) => candidate.id === projectId);
	return (
		<FormSection
			level={2}
			title="Preview"
			description="What a new session would get, in order. Running sessions keep the rules they started with."
		>
			<SelectField
				label="A new session in"
				value={project?.id ?? ORGANISATION_WIDE}
				onChange={(event) => setProjectId(event.target.value)}
				options={[
					{ value: ORGANISATION_WIDE, label: "The organisation, in no project" },
					...projects.map((candidate) => ({ value: candidate.id, label: candidate.name })),
				]}
			/>
			<ResolvedRules
				key={project?.id ?? ORGANISATION_WIDE}
				rules={rules}
				{...(project === undefined ? {} : { projectId: project.id })}
				version={version}
			/>
		</FormSection>
	);
}

/** The Rules page: one owner's rules at a time, picked above them, then the preview. */
export function RulesScreen({ rules, projects }: { rules: ConsoleRules; projects: readonly ProjectSummary[] }) {
	const choices = useMemo(() => projects.filter((project) => !isOrganisationScope(project.id)), [projects]);
	const { organisationId, viewer } = rules;
	const [whose, setWhose] = useState<Whose>("organisation");
	const [projectId, setProjectId] = useState<string>();
	// Bumped by each saved or removed rule, so the preview reads again.
	const [version, setVersion] = useState(0);
	const changed = useCallback(() => setVersion((now) => now + 1), []);
	const project = choices.find((candidate) => candidate.id === projectId) ?? choices[0];
	const pickedId = project?.id;

	const owner = useMemo((): OwnerRef | undefined => {
		if (whose === "platform") return { kind: "platform" };
		if (whose === "organisation") return { kind: "organisation", organisationId };
		if (whose === "project") {
			return pickedId === undefined ? undefined : { kind: "project", organisationId, projectId: pickedId };
		}
		return viewer === undefined ? undefined : { kind: "user", organisationId, userId: viewer };
	}, [whose, organisationId, pickedId, viewer]);

	const options: SegmentOption<Whose>[] = [
		{ value: "platform", label: LAYER_LABELS.platform },
		{ value: "organisation", label: LAYER_LABELS.organisation },
		{ value: "project", label: LAYER_LABELS.project },
		...(viewer === undefined ? [] : [{ value: "user" as const, label: LAYER_LABELS.user }]),
	];
	const section: Readonly<Record<Whose, { readonly title: string; readonly description: string }>> = {
		platform: {
			title: "Platform rules",
			description:
				"Every organisation's sessions get these first. Only Harbour's operator sets them, so they're read-only here.",
		},
		organisation: {
			title: "The organisation's rules",
			description:
				"Every session in the organisation gets these, after the platform's. Changing them needs an organisation-wide admin.",
		},
		project: {
			title: project === undefined ? "Project rules" : `Rules for ${project.name}`,
			description:
				"Sessions in the project get these, after the organisation's. Changing them needs an admin on the project.",
		},
		user: {
			title: "Your rules",
			description:
				"Your sessions get these last, after the agent's own prompt. You or an organisation-wide admin may change them.",
		},
	};

	return (
		<div className="rules">
			<PageHeader
				title="Rules"
				lede="Rules are added around every new session's prompt, in this order: platform, organisation, project, the agent's own prompt, then yours. Running sessions keep the rules they started with."
			/>
			<div className="rules-whose">
				<SegmentedControl label="Whose rules" options={options} value={whose} onChange={setWhose} />
				{whose === "project" && project !== undefined ? (
					<SelectField
						label="Project"
						value={project.id}
						onChange={(event) => setProjectId(event.target.value)}
						options={choices.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
					/>
				) : null}
			</div>
			{owner === undefined ? (
				<EmptyState title="No projects yet">A project's rules can be set once there is a project.</EmptyState>
			) : (
				<OwnerRules
					key={whose === "project" ? `project:${pickedId ?? ""}` : whose}
					rules={rules}
					owner={owner}
					title={section[whose].title}
					description={section[whose].description}
					readOnly={whose === "platform"}
					onChanged={changed}
				/>
			)}
			<Preview rules={rules} projects={choices} version={version} />
		</div>
	);
}
