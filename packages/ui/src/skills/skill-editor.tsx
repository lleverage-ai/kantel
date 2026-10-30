import type { SkillFile, SkillPackage, SkillRevision } from "@harbour/contracts";
import { SKILL_MD } from "@harbour/skills";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField, TextAreaField, TextField } from "../primitives/controls.tsx";
import { FormActions, FormLayout } from "../primitives/form-layout.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice, Panel } from "../primitives/surface.tsx";
import {
	authoringError,
	draftFiles,
	draftProblems,
	type OwnerChoice,
	type SkillsAuthor,
	type SkillsSource,
	skillTemplate,
} from "./skills-model.ts";

export type SkillEditorTarget =
	| { readonly kind: "new" }
	| { readonly kind: "edit"; readonly pkg: SkillPackage; readonly latest?: SkillRevision };

export interface SkillEditorProps {
	readonly target: SkillEditorTarget;
	readonly source: SkillsSource;
	readonly author: SkillsAuthor;
	/** Where a new skill may go. The first is the default. */
	readonly owners: readonly OwnerChoice[];
	/** Called once a revision is published, with the skill it belongs to. */
	readonly onPublished: (skillId: string, revision: SkillRevision) => void;
	/** Called after a draft is saved without publishing. */
	readonly onSaved?: (skillId: string) => void;
	readonly onCancel: () => void;
}

/**
 * Writes a skill: a new one (owner, name, description and its SKILL.md) or the next revision of one, starting from its
 * open draft or else its latest revision. Saving keeps a draft that sessions don't see; publishing makes it the next
 * revision, which sessions started from then on get. Only SKILL.md is edited here; the revision's other files carry
 * over unchanged.
 */
export function SkillEditor({ target, source, author, owners, onPublished, onSaved, onCancel }: SkillEditorProps) {
	const editing = target.kind === "edit" ? target.pkg : undefined;
	const start = useLoad(async (): Promise<readonly SkillFile[]> => {
		if (editing === undefined) return [];
		if (editing.draftDigest !== undefined) return author.readDraft(editing.id);
		const latest = target.kind === "edit" ? target.latest : undefined;
		if (latest === undefined) return [];
		return Promise.all(
			latest.files.map(async (file) => ({
				path: file.path,
				content: await source.readFile(editing.id, latest.revision, file.path),
			})),
		);
	}, [author, source, editing?.id, editing?.draftDigest]);

	if (start.state.status === "loading") {
		return (
			<Panel
				header={
					<h2 className="m-0 text-sm font-medium">{editing === undefined ? "New skill" : `Edit ${editing.name}`}</h2>
				}
			>
				<div className="flex flex-col gap-4" aria-busy="true">
					<span className="hb-sr-only">Loading the skill's files</span>
					<Skeleton lines={2} />
					<Skeleton lines={6} />
				</div>
			</Panel>
		);
	}
	if (start.state.status === "error") {
		return (
			<Notice
				level="error"
				action={
					<Button size="xs" onClick={start.reload}>
						Try again
					</Button>
				}
			>
				Couldn't read the skill's files to edit. Nothing has changed.
			</Notice>
		);
	}
	return (
		<SkillForm
			key={editing?.id ?? "new"}
			{...(editing === undefined ? {} : { editing })}
			startFiles={start.state.value}
			author={author}
			owners={owners}
			onPublished={onPublished}
			{...(onSaved === undefined ? {} : { onSaved })}
			onCancel={onCancel}
		/>
	);
}

type Busy = "save" | "publish" | undefined;

function SkillForm({
	editing,
	startFiles,
	author,
	owners,
	onPublished,
	onSaved,
	onCancel,
}: {
	editing?: SkillPackage;
	startFiles: readonly SkillFile[];
	author: SkillsAuthor;
	owners: readonly OwnerChoice[];
	onPublished: SkillEditorProps["onPublished"];
	onSaved?: (skillId: string) => void;
	onCancel: () => void;
}) {
	const [ownerIndex, setOwnerIndex] = useState(0);
	const [name, setName] = useState(editing?.name ?? "");
	const [description, setDescription] = useState(editing?.description ?? "");
	const initialMd = startFiles.find((file) => file.path === SKILL_MD)?.content;
	const [skillMd, setSkillMd] = useState(initialMd ?? skillTemplate(editing?.name ?? "", editing?.description ?? ""));
	// Until the person writes in SKILL.md, a new skill's frontmatter follows the name and description fields.
	const [touched, setTouched] = useState(initialMd !== undefined);
	const [busy, setBusy] = useState<Busy>();
	const [error, setError] = useState<string>();
	const [saved, setSaved] = useState(false);
	const [checked, setChecked] = useState(false);
	// A new skill is created once; a retry after a failed save writes to the same package.
	const created = useRef<string | undefined>(editing?.id);
	const heading = useRef<HTMLHeadingElement>(null);
	const textId = useId();
	useEffect(() => heading.current?.focus({ preventScroll: true }), []);

	const problems = draftProblems({ name, description, skillMd });
	const invalid = Object.keys(problems).length > 0;
	const others = startFiles.filter((file) => file.path !== SKILL_MD);
	const owner = owners[ownerIndex];

	const follow = (nextName: string, nextDescription: string) => {
		if (!touched && editing === undefined) setSkillMd(skillTemplate(nextName, nextDescription));
	};

	const write = async (publish: boolean) => {
		setChecked(true);
		if (invalid) return;
		setBusy(publish ? "publish" : "save");
		setError(undefined);
		setSaved(false);
		let action: "create" | "save" | "publish" = created.current === undefined ? "create" : "save";
		try {
			if (created.current === undefined) {
				if (owner === undefined) throw new Error("No owner to create the skill under");
				created.current = (await author.create({ owner: owner.owner, name, description: description.trim() })).id;
				action = "save";
			}
			const skillId = created.current;
			const { digest } = await author.saveDraft(skillId, {
				files: draftFiles(skillMd, others),
				description: description.trim(),
			});
			if (!publish) {
				setSaved(true);
				onSaved?.(skillId);
				return;
			}
			action = "publish";
			const revision = await author.publish(skillId, { expectedDigest: digest });
			onPublished(skillId, revision);
		} catch (caught) {
			setError(authoringError(caught, action));
		} finally {
			setBusy(undefined);
		}
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		void write(true);
	};

	const show = (problem: string | undefined) => (checked ? problem : undefined);
	return (
		<form onSubmit={submit} aria-labelledby="hb-skill-editor-title" noValidate>
			<Panel
				header={
					<h2
						id="hb-skill-editor-title"
						className="m-0 text-sm font-medium focus:outline-none"
						ref={heading}
						tabIndex={-1}
					>
						{editing === undefined ? "New skill" : `Edit ${editing.name}`}
					</h2>
				}
			>
				<FormLayout>
					{editing === undefined && owners.length > 1 ? (
						<SelectField
							label="Owner"
							hint="Who sees it: you alone, a project's sessions or the whole organisation."
							options={owners.map((choice, index) => ({ value: String(index), label: choice.label }))}
							value={String(ownerIndex)}
							onChange={(event) => setOwnerIndex(Number(event.target.value))}
						/>
					) : null}
					{editing === undefined ? (
						<TextField
							label="Name"
							hint="Lowercase letters, digits and dashes. Sessions find it at /skills/<name>/SKILL.md."
							autoComplete="off"
							spellCheck={false}
							value={name}
							{...(show(problems.name) === undefined ? {} : { error: show(problems.name)! })}
							onChange={(event) => {
								setName(event.target.value);
								follow(event.target.value, description);
							}}
						/>
					) : null}
					<TextField
						label="Description"
						hint="What it does and when to use it. Sessions decide whether to read the skill from this."
						value={description}
						{...(show(problems.description) === undefined ? {} : { error: show(problems.description)! })}
						onChange={(event) => {
							setDescription(event.target.value);
							follow(name, event.target.value);
						}}
					/>
					<TextAreaField
						id={textId}
						label="SKILL.md"
						// 336px tall. `!` so it replaces the text area's own height utility (primitives/controls.tsx) outright.
						className="[&_.hb-input]:h-84!"
						mono
						spellCheck={false}
						value={skillMd}
						onChange={(event) => {
							setSkillMd(event.target.value);
							setTouched(true);
						}}
						{...(show(problems.skillMd) === undefined
							? {
									hint:
										others.length === 0
											? "The instructions a session reads, after the frontmatter."
											: `The revision's other ${others.length === 1 ? "file carries" : `${others.length} files carry`} over unchanged.`,
								}
							: { error: show(problems.skillMd)! })}
					/>
					{error === undefined ? null : <Notice level="error">{error}</Notice>}
					{saved ? <Notice level="info">Draft saved. Sessions don't see it until it is published.</Notice> : null}
					<FormActions>
						<Button type="submit" variant="primary" busy={busy === "publish"} disabled={busy !== undefined}>
							Publish
						</Button>
						<Button busy={busy === "save"} disabled={busy !== undefined} onClick={() => void write(false)}>
							Save draft
						</Button>
						<Button variant="ghost" disabled={busy !== undefined} onClick={onCancel}>
							Cancel
						</Button>
					</FormActions>
				</FormLayout>
			</Panel>
		</form>
	);
}
