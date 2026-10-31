import type { SkillPackage, SkillRevision, SkillVisibility } from "@harbour/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { FilePreview, saveFile } from "../preview/file-preview.tsx";
import type { PreviewContent, PreviewFile } from "../preview/preview-model.ts";
import { Button } from "../primitives/button.tsx";
import { SelectField, type SelectOption, TextField } from "../primitives/controls.tsx";
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

// Styled with Tailwind utilities (src/tokens/tailwind.css): a heading, then the skills by scope, and the open skill
// beside them once one is open. As Claude.ai's Settings > Capabilities > Skills and Linear's list->detail: with nothing
// open the list stands alone at a reading width, no placeholder column. Under 900px the two stack and only one shows
// at a time; that switch stays in skills-page.css, on the hb-skills classes kept here as its hooks.

/** A column of rows, 2px apart: the skills in a scope, a skill's revisions, a revision's files. */
const rowList = "m-0 flex list-none flex-col gap-0.5 p-0";
/** A faint figure at the end of a row: a revision number, a file's size. */
const rowFigure = "text-xs whitespace-nowrap text-faint";
const loading = "flex flex-col gap-4";
/** The open skill, or the editor: its parts in a column. */
const skillColumn = "flex min-w-0 flex-col gap-4";
/** Under 900px only (skills-page.css): the way back to the list. */
const backRow = "hb-skills-back hidden";
/** A panel's heading. */
const skillSection = "m-0 text-sm font-medium";
/** A panel's heading with a count or badges beside it. */
const sectionRow = "flex flex-1 flex-wrap items-baseline justify-between gap-x-2 gap-y-1.5";

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
	const startNew = () => {
		setPublished(undefined);
		setEditor({ kind: "new" });
	};
	const listOnly = selected === undefined && editor === undefined;

	return (
		<div
			className={`hb-skills flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0 ${listOnly ? "max-w-content" : ""}`}
			data-view={listOnly ? "list" : "detail"}
		>
			<PageHeader
				className="hb-skills-head"
				title="Skills"
				{...(canWrite
					? {
							actions: (
								<Button
									variant="primary"
									icon={<PlusIcon size="sm" />}
									disabled={editor?.kind === "new"}
									onClick={startNew}
								>
									New skill
								</Button>
							),
						}
					: {})}
			/>
			{/* Nothing open: the list alone, one column at a reading width (Linear's list before an issue opens). Something
			    open: the list beside it. Under 900px skills-page.css makes it one column either way. */}
			<div
				className={`hb-skills-body grid min-w-0 items-start gap-6 ${
					listOnly ? "grid-cols-1" : "grid-cols-[calc(var(--hb-sidebar-width)_+_var(--hb-step-8))_minmax(0,1fr)]"
				}`}
			>
				<section className="hb-skills-list flex min-w-0 flex-col gap-4" aria-label="Skills">
					{/* One toolbar row, search first, as Linear's filter bar: it wraps when the column is narrow. */}
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<TextField
							label="Search skills"
							hideLabel
							className="min-w-0 flex-[1_1_calc(var(--hb-sidebar-width)*0.5)]"
							type="search"
							placeholder="Search skills"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
						{projects === undefined || projects.length === 0 ? null : (
							<SelectField
								label="Seen from"
								hideLabel
								className="max-w-full flex-none"
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
					</div>
					{state.status === "loading" ? (
						<div className={loading}>
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
						<EmptyState
							title="No skills yet"
							{...(canWrite
								? {
										action: (
											<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={startNew}>
												New skill
											</Button>
										),
									}
								: {})}
						>
							Published skills show here.
						</EmptyState>
					) : groups.length === 0 ? (
						<EmptyState title="No skills match">Try fewer words, or clear the filter.</EmptyState>
					) : (
						<div className="flex min-w-0 flex-col gap-5">
							{groups.map((group) => (
								<section
									key={group.key}
									className="flex min-w-0 flex-col gap-1.5"
									aria-labelledby={`hb-skills-${group.key}`}
								>
									<h2 id={`hb-skills-${group.key}`} className="m-0 px-2.5 text-xs font-medium text-muted">
										{group.label}
									</h2>
									<ul className={rowList}>
										{group.skills.map(({ listing, pkg }) => (
											<li key={listing.skillId}>
												<ListRow
													density="comfortable"
													title={<span className="hb-mono">{listing.name}</span>}
													meta={listing.description}
													trailing={
														pkg.draftDigest === undefined ? (
															<span className={rowFigure}>Revision {listing.revision}</span>
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
				{listOnly ? null : (
					<section className="hb-skills-detail min-w-0" aria-label="Skill">
						{published === undefined ? null : (
							<div className="mb-4">
								<Notice level="info">
									Published revision {published.revision.revision} of{" "}
									<span className="hb-mono">{published.revision.name}</span>. Sessions started from now get it; running
									sessions keep the revision they started with.
								</Notice>
							</div>
						)}
						{editor !== undefined && author !== undefined ? (
							<div className={skillColumn}>
								<div className={backRow}>
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
						) : selected === undefined ? null : (
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
				)}
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
			<div className={backRow}>
				<Button size="sm" variant="ghost" onClick={onBack}>
					All skills
				</Button>
			</div>
		);

	if (state.status !== "ready") {
		return (
			<div className={skillColumn}>
				{back}
				{state.status === "loading" ? (
					<div className={loading} aria-busy="true">
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
		<article className={skillColumn} aria-labelledby="hb-skill-title">
			{back}
			<header className="flex min-w-0 flex-col gap-1.5">
				<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
					<h2
						id="hb-skill-title"
						className="m-0 font-mono text-lg font-strong leading-tight wrap-anywhere focus:outline-none"
						ref={heading}
						tabIndex={-1}
					>
						{pkg.name}
					</h2>
					{onEdit === undefined || pkg.owner.kind === "platform" ? null : (
						<Button size="sm" icon={<PencilIcon size="sm" />} onClick={() => onEdit(pkg, latest)}>
							{pkg.draftDigest === undefined ? "Edit" : "Edit draft"}
						</Button>
					)}
				</div>
				<div className="flex flex-wrap gap-1.5">
					<Badge>{scopeLabel(pkg.owner, directory, viewerId)}</Badge>
					{latest === undefined ? (
						<Badge tone="waiting">Not published</Badge>
					) : (
						<Badge>Revision {latest.revision}</Badge>
					)}
					{pkg.draftDigest === undefined ? null : <Badge tone="approval">Draft open</Badge>}
				</div>
				<p className="text-muted">{latest?.description ?? pkg.description}</p>
			</header>

			{pkg.draftDigest === undefined || latest === undefined ? null : (
				<Notice level="info" announce={false}>
					A newer draft is open. Sessions get revision {latest.revision} until the draft is published.
				</Notice>
			)}

			<Panel header={<h3 className={skillSection}>About</h3>}>
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
					<div className={sectionRow}>
						<h3 className={skillSection}>Revisions</h3>
						<span className="text-xs text-faint">{revisions.length}</span>
					</div>
				}
			>
				{revisions.length === 0 ? (
					<p className="text-muted">Nothing published yet. Sessions don't see a skill until it is.</p>
				) : (
					<ul className={rowList}>
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
				<section aria-label="Sharing">
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
	const files = useMemo(() => sortFiles(revision.files), [revision.files]);
	const [path, setPath] = useState(files[0]?.path ?? "SKILL.md");
	const file = files.find((item) => item.path === path);
	const { state, reload } = useLoad(
		() => source.readFile(revision.skillId, revision.revision, path),
		[source, revision.skillId, revision.revision, path],
	);
	const extensions = extensionNames(revision);
	const isSkillMd = path === "SKILL.md";
	const split = state.status === "ready" && isSkillMd ? splitSkillMarkdown(state.value) : undefined;
	const shown = split === undefined ? (state.status === "ready" ? state.value : undefined) : split.body;
	const preview = useMemo(
		(): PreviewFile => ({
			key: `${revision.name}/${path}`,
			name: path.slice(path.lastIndexOf("/") + 1),
			path: `${revision.name}/${path}`,
			...(file === undefined ? {} : { size: file.size }),
		}),
		[revision.name, path, file],
	);
	const content = useMemo(
		(): PreviewContent =>
			shown === undefined ? { status: "loading" } : { status: "ready", bytes: new TextEncoder().encode(shown) },
		[shown],
	);
	const siblings = useMemo(
		() =>
			files.map(
				(item): PreviewFile => ({
					key: `${revision.name}/${item.path}`,
					name: item.path.slice(item.path.lastIndexOf("/") + 1),
					path: `${revision.name}/${item.path}`,
					size: item.size,
				}),
			),
		[files, revision.name],
	);

	return (
		<Panel
			header={
				<div className={sectionRow}>
					<h3 className={skillSection}>Files in revision {revision.revision}</h3>
					{extensions.length === 0 ? null : (
						<span className="flex flex-wrap gap-1.5">
							{extensions.map((name) => (
								<Badge key={name}>{name} data</Badge>
							))}
						</span>
					)}
				</div>
			}
		>
			<ul className={rowList}>
				{files.map((item) => (
					<li key={item.path}>
						<ListRow
							leading={item.path.endsWith(".md") ? <TextFileIcon /> : <FileIcon />}
							title={<span className="hb-mono">{item.path}</span>}
							trailing={<span className={rowFigure}>{formatBytes(item.size)}</span>}
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
			{/* The file's content fills a fixed-height frame (576px under 900px, in skills-page.css) and scrolls inside it,
			    as the workspace viewers expect. */}
			<div className="hb-skill-viewer flex h-120 flex-col overflow-hidden rounded-panel border border-border [&>.hb-notice]:m-3">
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
				) : (
					// The same preview every file in the console opens in, embedded: SKILL.md's body (its fields are above),
					// any other file as itself, with Previous and Next through the revision's files.
					<FilePreview
						layout="docked"
						file={preview}
						content={content}
						siblings={siblings}
						onNavigate={(next) => setPath(next.path.slice(revision.name.length + 1))}
						onDownload={
							state.status === "ready"
								? () => saveFile(new TextEncoder().encode(state.value), preview.name, "text/plain")
								: undefined
						}
					/>
				)}
			</div>
		</Panel>
	);
}
