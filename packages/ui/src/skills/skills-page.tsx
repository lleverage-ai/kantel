import type { SkillPackage, SkillRevision, SkillVisibility } from "@harbour/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { CopyButton, SelectField, type SelectOption, TextField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { FileIcon, PencilIcon, PlusIcon, TextFileIcon } from "../primitives/icons.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { useLoad } from "../primitives/load.ts";
import { ownerName } from "../primitives/owner.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import { ResourceSharingPanel } from "../sharing/resource-sharing-panel.tsx";
import type { SharingDirectory, SharingSource } from "../sharing/sharing-model.ts";
import { FileViewer } from "../workspace/file-viewer.tsx";
import { NoteViewer } from "../workspace/note-viewer.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import { SkillEditor, type SkillEditorTarget } from "./skill-editor.tsx";
import {
	extensionNames,
	filterSkills,
	groupSkills,
	loadListedSkills,
	type OwnerChoice,
	type SkillsAuthor,
	type SkillsSource,
	scopeLabel,
	shortDigest,
	sortFiles,
	sourceText,
	splitSkillMarkdown,
} from "./skills-model.ts";
import "./skills-page.css";

export interface SkillsPageProps {
	/** `Skills`' reads, bound to the viewer (see `bindSkills`). */
	readonly source: SkillsSource;
	/** Whose view of the skills to show: a session in this project, opened by this user. */
	readonly visibility: SkillVisibility;
	/** Projects the viewer may switch the view to; an option whose value is `""` means no project. Hidden when absent. */
	readonly projects?: readonly SelectOption[];
	/** Names for people, agents and projects, from the host's directories. */
	readonly directory?: AuditDirectory;
	/** The time the page measures from, for stories. Default `Date.now()` when it renders. */
	readonly now?: number;
	/** The skill open when the page loads, by ID. */
	readonly initialSelected?: string;
	readonly onSelect?: (skillId: string | undefined) => void;
	/**
	 * `Skills`' writes, bound to the viewer (see `bindSkillsAuthor`), with the owners a new skill may go under. Absent,
	 * the page is read-only. Bind it only for people: agents may not create or publish.
	 */
	readonly author?: SkillsAuthor;
	readonly owners?: readonly OwnerChoice[];
	/** Open the new-skill form when the page loads, for stories. */
	readonly initialCreating?: boolean;
	/** Shows a project's skill's sharing (who has it, and requests for it) on its page. Absent, no sharing panel. */
	readonly sharing?: SkillSharing;
}

/** The sharing seam a skill's page reads its shares and requests through. */
export interface SkillSharing {
	readonly source: SharingSource;
	readonly directory?: SharingDirectory;
}

/**
 * The skills a session sees, by scope: the viewer's own, the project's, the organisation's and the built-in ones, as
 * `Skills.list` chooses them (a narrower scope's skill replaces a wider one's of the same name). Opening one shows its
 * published revisions and, for the revision picked, its files and their content: SKILL.md as a note with its
 * frontmatter as fields, anything else as text.
 *
 * With an `author`, the viewer can create a skill and edit one they may own: saving keeps a draft sessions don't see,
 * and publishing makes it the next revision, which every session started after that gets (a session pins its
 * revisions when it starts).
 */
export function SkillsPage({
	source,
	visibility: initialVisibility,
	projects,
	directory = {},
	now: fixedNow,
	initialSelected,
	onSelect,
	author,
	owners = [],
	initialCreating = false,
	sharing,
}: SkillsPageProps) {
	const [visibility, setVisibility] = useState<SkillVisibility>(initialVisibility);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | undefined>(initialSelected);
	const [editor, setEditor] = useState<SkillEditorTarget | undefined>(
		initialCreating && author !== undefined ? { kind: "new" } : undefined,
	);
	const [published, setPublished] = useState<{ skillId: string; revision: SkillRevision }>();
	const [detailKey, setDetailKey] = useState(0);
	const { state, reload } = useLoad(
		() => loadListedSkills(source, visibility),
		[source, visibility.projectId, visibility.userId],
	);
	const now = fixedNow ?? Date.now();
	const shown = state.status === "ready" ? filterSkills(state.value, query) : [];
	const groups = groupSkills(shown, directory, visibility.userId);
	const open = useCallback(
		(id: string | undefined) => {
			setSelected(id);
			setEditor(undefined);
			setPublished(undefined);
			onSelect?.(id);
		},
		[onSelect],
	);
	const canWrite = author !== undefined && owners.length > 0;
	const projectName =
		visibility.projectId === undefined
			? undefined
			: (projects?.find((project) => project.value === visibility.projectId)?.label ??
				directory.project?.(visibility.projectId) ??
				visibility.projectId);

	return (
		<div className="hb-skills" data-view={selected === undefined && editor === undefined ? "list" : "detail"}>
			<PageHeader
				className="hb-skills-head"
				title="Skills"
				lede="What a session can read: Agent Skills packages by scope, each with every revision ever published."
				{...(canWrite
					? {
							actions: (
								<Button
									variant="primary"
									icon={<PlusIcon size="sm" />}
									disabled={editor?.kind === "new"}
									onClick={() => {
										setPublished(undefined);
										setEditor({ kind: "new" });
									}}
								>
									New skill
								</Button>
							),
						}
					: {})}
			/>
			<div className="hb-skills-body">
				<section className="hb-skills-list" aria-label="Skills">
					<div className="hb-skills-controls">
						{projects === undefined || projects.length === 0 ? null : (
							<SelectField
								label="Seen from"
								options={projects}
								value={visibility.projectId ?? ""}
								onChange={(event) => {
									// An option whose value is "" is no project: the organisation's view.
									const { projectId: _, ...rest } = visibility;
									setVisibility(event.target.value === "" ? rest : { ...rest, projectId: event.target.value });
									open(undefined);
								}}
							/>
						)}
						<TextField
							label="Filter"
							type="search"
							placeholder="Name or description"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					{state.status === "loading" ? (
						<div className="hb-skills-loading">
							<span className="hb-sr-only">Loading skills</span>
							<Skeleton lines={2} />
							<Skeleton lines={2} />
							<Skeleton lines={2} />
						</div>
					) : state.status === "error" ? (
						<Notice
							level="error"
							action={
								<Button size="xs" onClick={reload}>
									Try again
								</Button>
							}
						>
							Couldn't read the skills. Nothing has changed; try again.
						</Notice>
					) : state.value.length === 0 ? (
						<EmptyState title="No skills yet">
							{projectName === undefined
								? "Publish a skill and sessions see it here."
								: `Publish a skill to ${projectName} or the organisation and sessions there see it here.`}
						</EmptyState>
					) : groups.length === 0 ? (
						<EmptyState title="No skills match">Try fewer words, or clear the filter.</EmptyState>
					) : (
						<div className="hb-skills-groups">
							{projectName === undefined ? null : (
								<p className="hb-skills-seen">
									{state.value.length} {state.value.length === 1 ? "skill" : "skills"} a session in {projectName} sees
								</p>
							)}
							{groups.map((group) => (
								<section key={group.key} className="hb-skills-group" aria-labelledby={`hb-skills-${group.key}`}>
									<h2 id={`hb-skills-${group.key}`} className="hb-skills-group-title">
										{group.label}
									</h2>
									<ul className="hb-skills-rows">
										{group.skills.map(({ listing, pkg }) => (
											<li key={listing.skillId}>
												<ListRow
													density="comfortable"
													title={<span className="hb-mono">{listing.name}</span>}
													meta={listing.description}
													trailing={
														pkg.draftDigest === undefined ? (
															<span className="hb-skills-revision">Revision {listing.revision}</span>
														) : (
															<Badge tone="approval">Draft open</Badge>
														)
													}
													selected={listing.skillId === selected}
													onSelect={() => open(listing.skillId)}
												/>
											</li>
										))}
									</ul>
								</section>
							))}
						</div>
					)}
				</section>
				<section className="hb-skills-detail" aria-label="Skill">
					{published === undefined ? null : (
						<div className="hb-skills-published">
							<Notice level="info">
								Published revision {published.revision.revision} of{" "}
								<span className="hb-mono">{published.revision.name}</span>. Sessions started from now get it; running
								sessions keep the revision they started with.
							</Notice>
						</div>
					)}
					{editor !== undefined && author !== undefined ? (
						<div className="hb-skill">
							<div className="hb-skills-back">
								<Button size="sm" variant="ghost" onClick={() => setEditor(undefined)}>
									{selected === undefined ? "All skills" : "Back to the skill"}
								</Button>
							</div>
							<SkillEditor
								key={editor.kind === "new" ? "new" : editor.pkg.id}
								target={editor}
								source={source}
								author={author}
								owners={owners}
								onCancel={() => setEditor(undefined)}
								onSaved={() => {
									setDetailKey((value) => value + 1);
									reload();
								}}
								onPublished={(skillId, revision) => {
									setEditor(undefined);
									setSelected(skillId);
									onSelect?.(skillId);
									setPublished({ skillId, revision });
									setDetailKey((value) => value + 1);
									reload();
								}}
							/>
						</div>
					) : selected === undefined ? (
						<div className="hb-skills-placeholder">
							<EmptyState title="Pick a skill">See its revisions, its files and what each file says.</EmptyState>
						</div>
					) : (
						<SkillDetail
							key={`${selected}:${detailKey}`}
							skillId={selected}
							source={source}
							directory={directory}
							viewerId={visibility.userId}
							now={now}
							onBack={() => open(undefined)}
							{...(sharing === undefined ? {} : { sharing })}
							{...(canWrite
								? {
										onEdit: (pkg: SkillPackage, latest: SkillRevision | undefined) => {
											setPublished(undefined);
											setEditor({ kind: "edit", pkg, ...(latest === undefined ? {} : { latest }) });
										},
									}
								: {})}
						/>
					)}
				</section>
			</div>
		</div>
	);
}

export interface SkillDetailProps {
	readonly skillId: string;
	readonly source: SkillsSource;
	readonly directory?: AuditDirectory;
	readonly viewerId?: string | undefined;
	readonly now: number;
	/** The revision to show first. Default the latest. */
	readonly initialRevision?: number;
	readonly onBack?: () => void;
	/** Shows Edit, for a skill the viewer may change (never a built-in one). */
	readonly onEdit?: (pkg: SkillPackage, latest: SkillRevision | undefined) => void;
	/** Shows the skill's sharing, when a project owns it. */
	readonly sharing?: SkillSharing;
}

/** One skill: what it is, its revisions newest first, and the picked revision's files. */
export function SkillDetail({
	skillId,
	source,
	directory = {},
	viewerId,
	now,
	initialRevision,
	onBack,
	onEdit,
	sharing,
}: SkillDetailProps) {
	const { state, reload } = useLoad(async () => {
		const [pkg, revisions] = await Promise.all([source.get(skillId), readRevisions(source, skillId)]);
		return { pkg, revisions };
	}, [source, skillId]);
	const [picked, setPicked] = useState<number | undefined>(initialRevision);
	const heading = useRef<HTMLHeadingElement>(null);
	const ready = state.status === "ready";
	useEffect(() => {
		if (ready) heading.current?.focus({ preventScroll: true });
	}, [ready]);

	const back =
		onBack === undefined ? null : (
			<div className="hb-skills-back">
				<Button size="sm" variant="ghost" onClick={onBack}>
					All skills
				</Button>
			</div>
		);

	if (state.status !== "ready") {
		return (
			<div className="hb-skill">
				{back}
				{state.status === "loading" ? (
					<div className="hb-skills-loading" aria-busy="true">
						<span className="hb-sr-only">Loading the skill</span>
						<Skeleton width="40%" />
						<Skeleton lines={3} />
						<Skeleton lines={4} />
					</div>
				) : (
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={reload}>
								Try again
							</Button>
						}
					>
						Couldn't read this skill. It may have been removed, or Harbour is unavailable.
					</Notice>
				)}
			</div>
		);
	}

	const { pkg, revisions } = state.value;
	const latest = revisions[0];
	const revision = revisions.find((item) => item.revision === picked) ?? latest;
	const origin = sourceText(pkg.source);
	return (
		<article className="hb-skill" aria-labelledby="hb-skill-title">
			{back}
			<header className="hb-skill-head">
				<div className="hb-skill-title-row">
					<h2 id="hb-skill-title" className="hb-skill-title hb-mono" ref={heading} tabIndex={-1}>
						{pkg.name}
					</h2>
					{onEdit === undefined || pkg.owner.kind === "platform" ? null : (
						<Button size="sm" icon={<PencilIcon size="sm" />} onClick={() => onEdit(pkg, latest)}>
							{pkg.draftDigest === undefined ? "Edit" : "Edit draft"}
						</Button>
					)}
				</div>
				<div className="hb-skill-tags">
					<Badge>{scopeLabel(pkg.owner, directory, viewerId)}</Badge>
					{latest === undefined ? (
						<Badge tone="waiting">Not published</Badge>
					) : (
						<Badge>Revision {latest.revision}</Badge>
					)}
					{pkg.draftDigest === undefined ? null : <Badge tone="approval">Draft open</Badge>}
				</div>
				<p className="hb-skill-description">{latest?.description ?? pkg.description}</p>
			</header>

			{pkg.draftDigest === undefined || latest === undefined ? null : (
				<Notice level="info" announce={false}>
					A newer draft is open. Sessions get revision {latest.revision} until the draft is published.
				</Notice>
			)}

			<Panel header={<h3 className="hb-skill-section">About</h3>}>
				<FieldList>
					<Field label="Owner">{ownerName(pkg.owner, directory)}</Field>
					<Field label="Mounted at">
						<span className="hb-mono">/skills/{pkg.name}/SKILL.md</span>
					</Field>
					{origin === undefined ? null : (
						<Field label="Imported from">
							<span className="hb-mono">{origin}</span>
						</Field>
					)}
					<Field label="Created">
						<ClockTime at={pkg.createdAt} now={now} />
					</Field>
					<Field label="Updated">
						<ClockTime at={pkg.updatedAt} now={now} />
					</Field>
				</FieldList>
			</Panel>

			<Panel
				header={
					<div className="hb-skill-section-row">
						<h3 className="hb-skill-section">Revisions</h3>
						<span className="hb-skill-count">{revisions.length}</span>
					</div>
				}
			>
				{revisions.length === 0 ? (
					<p className="hb-skill-note">Nothing published yet. Sessions don't see a skill until it is.</p>
				) : (
					<ul className="hb-skill-revisions">
						{revisions.map((item) => (
							<li key={item.revision}>
								<ListRow
									density="comfortable"
									title={`Revision ${item.revision}`}
									meta={
										<>
											{actorName(item.publishedBy, directory)}, <ClockTime at={item.publishedAt} now={now} />,{" "}
											{item.files.length === 1 ? "1 file" : `${item.files.length} files`},{" "}
											<span className="hb-mono">{shortDigest(item.digest)}</span>
										</>
									}
									trailing={item.revision === latest?.revision ? <Badge tone="done">Latest</Badge> : undefined}
									selected={item.revision === revision?.revision}
									onSelect={() => setPicked(item.revision)}
								/>
							</li>
						))}
					</ul>
				)}
			</Panel>

			{sharing === undefined || pkg.owner.kind !== "project" ? null : (
				<section className="hb-skill-sharing" aria-label="Sharing">
					<ResourceSharingPanel
						source={sharing.source}
						resource={{ kind: "skills.skill", id: pkg.id }}
						directory={{
							...directory,
							...sharing.directory,
							resource: (kind, id) =>
								kind === "skills.skill" && id === pkg.id ? pkg.name : sharing.directory?.resource?.(kind, id),
						}}
						now={now}
					/>
				</section>
			)}

			{revision === undefined ? null : <RevisionFiles key={revision.revision} source={source} revision={revision} />}
		</article>
	);
}

async function readRevisions(source: SkillsSource, skillId: string): Promise<SkillRevision[]> {
	const revisions: SkillRevision[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < 20; index += 1) {
		const page = await source.listRevisions(skillId, cursor === undefined ? { limit: 100 } : { limit: 100, cursor });
		revisions.push(...page.items);
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	return revisions.sort((left, right) => right.revision - left.revision);
}

/** A revision's files, SKILL.md first, and the picked file's content. */
function RevisionFiles({ source, revision }: { source: SkillsSource; revision: SkillRevision }) {
	const files = sortFiles(revision.files);
	const [path, setPath] = useState(files[0]?.path ?? "SKILL.md");
	const file = files.find((item) => item.path === path);
	const { state, reload } = useLoad(
		() => source.readFile(revision.skillId, revision.revision, path),
		[source, revision.skillId, revision.revision, path],
	);
	const extensions = extensionNames(revision);
	const isSkillMd = path === "SKILL.md";
	const split = state.status === "ready" && isSkillMd ? splitSkillMarkdown(state.value) : undefined;

	return (
		<Panel
			header={
				<div className="hb-skill-section-row">
					<h3 className="hb-skill-section">Files in revision {revision.revision}</h3>
					{extensions.length === 0 ? null : (
						<span className="hb-skill-extensions">
							{extensions.map((name) => (
								<Badge key={name}>{name} data</Badge>
							))}
						</span>
					)}
				</div>
			}
		>
			<ul className="hb-skill-files">
				{files.map((item) => (
					<li key={item.path}>
						<ListRow
							leading={item.path.endsWith(".md") ? <TextFileIcon /> : <FileIcon />}
							title={<span className="hb-mono">{item.path}</span>}
							trailing={<span className="hb-skill-size">{formatBytes(item.size)}</span>}
							selected={item.path === path}
							onSelect={() => setPath(item.path)}
						/>
					</li>
				))}
			</ul>
			{split === undefined || split.fields.length === 0 ? null : (
				<FieldList>
					{split.fields.map((field) => (
						<Field key={field.key} label={`${field.key[0]!.toUpperCase()}${field.key.slice(1)}`}>
							{field.key === "name" ? <span className="hb-mono">{field.value}</span> : field.value}
						</Field>
					))}
				</FieldList>
			)}
			<div className="hb-skill-viewer">
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={reload}>
								Try again
							</Button>
						}
					>
						Couldn't read {path}. Try again.
					</Notice>
				) : isSkillMd ? (
					<NoteViewer
						path={`${revision.name}/SKILL.md`}
						state={split === undefined ? { status: "loading" } : { status: "ready", markdown: split.body }}
						actions={
							state.status === "ready" ? (
								<CopyButton text={state.value} label="Copy SKILL.md" iconOnly variant="ghost" />
							) : undefined
						}
					/>
				) : (
					<FileViewer
						path={path}
						state={
							state.status === "ready"
								? { status: "ready", text: state.value, size: file?.size ?? state.value.length }
								: { status: "loading" }
						}
					/>
				)}
			</div>
		</Panel>
	);
}
