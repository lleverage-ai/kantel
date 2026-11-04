// The Templates pages (compute console, experimental): how a sandbox's machine is made. A template is a Kantel base
// image the deployment publishes (a channel it follows, or a digest it pins), its default vCPUs and memory, variables,
// a setup script that installs what it needs inside the machine, and egress grants, versioned. Kantel builds each
// version once (image to disk, boot, setup, snapshot) and new sandboxes start from that snapshot; the snapshot is only
// a cache, rebuilt in the background whenever what it was built from changes (the version, the base's digest, the
// kernel, Firecracker or the size), and until one is ready sandboxes boot the image fresh. The list shows each
// template's base, size and build; a template's page its definition, what new sandboxes start from, its snapshot cache
// and its versions. Every call goes through the `TemplatesSource` the host binds.

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextAreaField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormActions, FormField, FormGrid, FormLayout, FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { bytesText, compactAge } from "../primitives/format.ts";
import { PencilIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { BackIcon, EllipsisIcon, ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import type { Status } from "../tokens/tokens.ts";
import type {
	ComputeAccount,
	EgressGrant,
	Template,
	TemplateBaseChannel,
	TemplateBuild,
	TemplateSnapshot,
	TemplateSnapshotState,
	TemplateSpec,
	TemplatesSource,
	TemplateVersion,
} from "./compute-model.ts";
import { startingSnapshot, startsNewSandboxes } from "./compute-model.ts";
import {
	cellMono,
	cellSub,
	computePage,
	messageOf,
	SectionHeading,
	TableFrame,
	table,
	tableFrame,
	td,
	th,
} from "./parts.tsx";
import {
	type TemplateDraft,
	templateBaseChoices,
	templateBasePicked,
	templateDraftProblems,
	templateVariableDraft,
} from "./template-draft.ts";
import { buildPollMs, NewTemplateView, TEMPLATE_POLL_MS, TemplateView } from "./template-view.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Words shared by the list and a template's page

const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Memory in megabytes as people say it: "512 MB", "8 GB". */
export const memoryText = (mb: number): string => (mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`);

/** "4 vCPU, 8 GB". */
export const resourcesText = (spec: Pick<TemplateSpec, "vcpus" | "memoryMb">): string =>
	`${spec.vcpus} vCPU, ${memoryText(spec.memoryMb)}`;

/** A digest's first twelve hex digits, as Docker shows one. */
export const shortDigest = (digest: string): string =>
	digest === "" ? "none yet" : digest.replace(/^sha256:/, "").slice(0, 12);

/** What a template's machines boot, in a few words: "Kantel base (kantel/sandbox)". */
export function imageText(spec: Pick<TemplateSpec, "base">): string {
	return `Kantel base (${spec.base.image})`;
}

/** Its base: the channel it follows (`kantel/sandbox:stable`), or the digest it's pinned to. */
export function baseText(spec: Pick<TemplateSpec, "base">): string {
	return spec.base.channel !== undefined
		? `${spec.base.image}:${spec.base.channel}`
		: `${spec.base.image}@${shortDigest(spec.base.digest)}`;
}

const BUILD_STATUS: Readonly<Record<TemplateBuild["state"], { status: Status; label: string }>> = {
	none: { status: "idle", label: "Not built" },
	building: { status: "working", label: "Building" },
	ready: { status: "done", label: "Ready" },
	stale: { status: "approval", label: "Out of date" },
	failed: { status: "error", label: "Failed" },
};

const SNAPSHOT_STATUS: Readonly<Record<TemplateSnapshotState, { status: Status; label: string }>> = {
	queued: { status: "idle", label: "Queued" },
	building: { status: "working", label: "Building" },
	ready: { status: "done", label: "Ready" },
	stale: { status: "approval", label: "Stale, in use" },
	failed: { status: "error", label: "Failed" },
	discarded: { status: "idle", label: "Discarded" },
};

/** A stale entry of an older version: kept in the cache, but no new sandbox starts from it. */
const STALE_UNUSED: { status: Status; label: string } = { status: "idle", label: "Stale, not used" };

/**
 * What new sandboxes made from it start from now, in one line: the snapshot they restore (and how old it is), or a
 * fresh boot of the image while none of its current version is built.
 */
export function freshnessText(template: Pick<Template, "version" | "build">, now: number): string {
	const { build } = template;
	const ready = build.ready;
	const start = startingSnapshot(template);
	const serving =
		start === undefined
			? "new sandboxes boot the image fresh"
			: `new sandboxes start from its snapshot, built ${agoText(start.readyAt ?? start.startedAt, now)}`;
	switch (build.state) {
		case "ready":
			return ready === undefined ? "Ready" : `Snapshot built ${agoText(ready.readyAt ?? ready.startedAt, now)}`;
		case "building":
			return `Building v${build.building?.version ?? template.version}; ${serving}`;
		case "stale":
			return `Out of date, rebuilding soon; ${serving}`;
		case "failed":
			return `Build failed; ${serving}`;
		case "none":
			return "Not built yet; new sandboxes boot the image fresh";
	}
}

/**
 * What Rebuild says once Kantel has started it, from the template it answers: a snapshot of its current version goes on
 * serving, stale, until the rebuild's replaces it, and after a rebuild that fails; with none, sandboxes boot fresh until
 * it's ready.
 */
export function rebuildText(template: Pick<Template, "version" | "build">): string {
	const start = startingSnapshot(template);
	return start === undefined
		? "Rebuilding. New sandboxes boot the image fresh until it's ready."
		: `Rebuilding. New sandboxes start from v${start.version}'s current snapshot until the new one is ready, and still do if the rebuild fails.`;
}

/** What picking a template in New sandbox means for how it starts. */
export function templatePickHint(template: Pick<Template, "version" | "build">, now: number): string {
	const start = startingSnapshot(template);
	if (start !== undefined) return `Starts from its snapshot, built ${agoText(start.readyAt ?? start.startedAt, now)}.`;
	return template.build.ready === undefined
		? "Nothing built yet: it boots the image and runs the setup itself, which takes longer."
		: `v${template.version} isn't built yet: it boots the image and runs the setup itself, which takes longer.`;
}

/** The same, in a few words for the list: "Built 2h ago", "v3 serves while it rebuilds", "Boots fresh until built". */
export function shortFreshnessText(template: Pick<Template, "version" | "build">, now: number): string {
	const { build } = template;
	const ready = build.ready;
	if (build.state === "ready" && ready !== undefined) return `Built ${agoText(ready.readyAt ?? ready.startedAt, now)}`;
	const start = startingSnapshot(template);
	if (start === undefined) return build.state === "failed" ? "Boots fresh" : "Boots fresh until built";
	if (build.state === "building") return `v${start.version} serves while it rebuilds`;
	return `v${start.version}'s snapshot serves`;
}

/** How far a pinned base is behind its channel: "3 releases behind stable". */
export function behindText(template: Pick<Template, "build" | "spec">): string | undefined {
	const behind = template.build.behind;
	if (behind === undefined || behind.releases === 0) return undefined;
	return `Base ${plural(behind.releases, "release")} behind`;
}

function BuildStatus({ build }: { build: TemplateBuild }) {
	const { status, label } = BUILD_STATUS[build.state];
	return <StatusLabel status={status}>{label}</StatusLabel>;
}

function ListSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} lines={2} />
				))}
			</div>
		</div>
	);
}

const experimental = <Badge tone="accent">Experimental</Badge>;

// ---------------------------------------------------------------------------------------------------------------------
// The list

export interface TemplatesPageProps {
	readonly source: TemplatesSource;
	readonly account: ComputeAccount;
	/** A template's own page. */
	readonly templateHref: (templateId: string) => string;
	/** Goes to a path without reloading: where New template lands. */
	readonly navigate?: (path: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open New template when the page opens. */
	readonly creating?: boolean;
	/** How often it reads the list again while a build runs. */
	readonly pollMs?: number;
}

export function TemplatesPage({
	source,
	account,
	templateHref,
	navigate,
	now: fixedNow,
	creating = false,
	pollMs = TEMPLATE_POLL_MS,
}: TemplatesPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// New template's draft while it's open, and its create (see template-view.ts).
	const creator = useMemo(
		() => new NewTemplateView({ source, accountId: account.id, open: creating }),
		[source, account.id, creating],
	);
	const { draft: newDraft, saving: newSaving = false } = useSyncExternalStore(
		creator.subscribe,
		creator.state,
		creator.state,
	);
	const newOpen = newDraft !== undefined;
	// Read again while a build runs, so a row's build shows when it's ready or failed.
	const wait = state.status === "ready" && !newOpen ? buildPollMs(state.value, pollMs) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each read schedules the next while a build runs.
	useEffect(() => {
		if (wait === undefined) return;
		const timer = setTimeout(reload, wait);
		return () => clearTimeout(timer);
	}, [wait, reload, state]);
	const now = fixedNow ?? Date.now();
	const addButton = (
		<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={creator.open}>
			New template
		</Button>
	);
	const go = (href: string) => (event: { preventDefault: () => void }) => {
		if (navigate === undefined) return;
		event.preventDefault();
		navigate(href);
	};

	if (newDraft !== undefined) {
		return (
			<div className={computePage}>
				<PageHeader title="New template" actions={experimental} />
				<TemplateEditor
					source={source}
					now={now}
					draft={newDraft}
					saving={newSaving}
					onChange={creator.change}
					submitLabel="Create template"
					onCancel={creator.cancel}
					onSave={async () => {
						const made = await creator.save();
						if (navigate !== undefined) navigate(templateHref(made.id));
						else reload();
					}}
				/>
			</div>
		);
	}

	return (
		<div className={computePage}>
			<PageHeader
				title={<span className="inline-flex items-center gap-2">Templates {experimental}</span>}
				lede="How a sandbox's machine is made: Kantel's base image, its vCPUs and memory, variables, a setup script that installs what it needs and where it may connect, versioned. Kantel builds each version once and snapshots it, so sandboxes made from it start in about a second."
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
					{messageOf(state.error, "Kantel couldn't read the templates.")}
				</Notice>
			) : state.status === "loading" ? (
				<ListSkeleton />
			) : state.value.length === 0 ? (
				<EmptyState title="No templates yet" action={addButton}>
					A template gives sandboxes your tools from the start, such as Python with your packages installed, built once
					and restored in a second.
				</EmptyState>
			) : (
				<TableFrame>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Name
								</th>
								<th className={th} scope="col">
									Base
								</th>
								<th className={th} scope="col">
									Size
								</th>
								<th className={th} scope="col">
									Version
								</th>
								<th className={th} scope="col">
									Build
								</th>
								<th className={th} scope="col">
									Sandboxes
								</th>
							</tr>
						</thead>
						<tbody>
							{state.value.map((template) => {
								const behind = behindText(template);
								return (
									<tr key={template.id} data-template={template.id} className="hover:bg-hover">
										<td className={td}>
											<a
												className="block max-w-(--kt-card-width) truncate font-medium text-fg underline decoration-border-strong underline-offset-2"
												href={templateHref(template.id)}
												onClick={go(templateHref(template.id))}
											>
												{template.name}
											</a>
											{template.description === undefined ? null : (
												<span className={`${cellSub} max-w-(--kt-card-width) truncate`}>{template.description}</span>
											)}
										</td>
										<td className={td}>
											<span className="block max-w-(--kt-card-width) truncate font-mono text-code">
												{baseText(template.spec)}
											</span>
											{behind === undefined ? (
												<span className={cellSub}>
													{template.spec.base.channel === undefined ? "Pinned base" : "Follows its base"}
												</span>
											) : (
												<span className="block text-xs text-status-approval">{behind}</span>
											)}
										</td>
										<td className={`${td} tabular-nums`}>{resourcesText(template.spec)}</td>
										<td className={`${td} tabular-nums`}>v{template.version}</td>
										<td className={td}>
											<BuildStatus build={template.build} />
											<span className={cellSub} title={freshnessText(template, now)}>
												{shortFreshnessText(template, now)}
											</span>
										</td>
										<td className={`${td} tabular-nums`}>{template.sandboxCount}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</TableFrame>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// One template

export interface TemplatePageProps {
	readonly source: TemplatesSource;
	readonly templateId: string;
	/** The account the console has selected: a template of another account is shown as not this account's. */
	readonly accountId?: string;
	/** The list, for the way back and after a delete. */
	readonly listHref: string;
	/** New sandbox with this template picked. */
	readonly newSandboxHref?: (templateId: string) => string;
	readonly navigate?: (path: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open the editor when the page opens, for a story. */
	readonly editing?: boolean;
	/** How often it reads the template again while a build runs. */
	readonly pollMs?: number;
}

export function TemplatePage({
	source,
	templateId,
	accountId,
	listHref,
	newSandboxHref,
	navigate,
	now: fixedNow,
	editing: startEditing = false,
	pollMs = TEMPLATE_POLL_MS,
}: TemplatePageProps) {
	// The template, its snapshot cache and versions, read again while a build runs so the page shows it ready or failed,
	// and the editor, which no read reaches once it's open (see template-view.ts).
	const view = useMemo(
		() => new TemplateView({ source, templateId, pollMs, editing: startEditing }),
		[source, templateId, pollMs, startEditing],
	);
	useEffect(() => {
		view.start();
		return () => view.stop();
	}, [view]);
	const { read: state, editing } = useSyncExternalStore(view.subscribe, view.state, view.state);
	const reload = view.reload;
	const [deleting, setDeleting] = useState(false);
	const [rebuilding, setRebuilding] = useState(false);
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const now = fixedNow ?? Date.now();
	const go = (href: string) => (event: { preventDefault: () => void }) => {
		if (navigate === undefined) return;
		event.preventDefault();
		navigate(href);
	};

	const back = (
		<a
			className="inline-flex items-center gap-1 text-sm text-muted no-underline hover:text-fg"
			href={listHref}
			onClick={go(listHref)}
		>
			<BackIcon />
			Templates
		</a>
	);

	const otherAccount = (
		<div className={computePage}>
			{back}
			<Notice level="error">
				This template belongs to another account. Switch to that account to see or change it.
			</Notice>
		</div>
	);

	// The editor comes before the reads: what they answer, or a failure, waits until it closes.
	if (editing !== undefined) {
		const { template: edited, draft, saving = false } = editing;
		if (accountId !== undefined && edited.accountId !== accountId) return otherAccount;
		return (
			<div className={computePage}>
				{back}
				<PageHeader
					title={`Edit ${edited.name}`}
					lede={`Saving a change to the definition makes v${edited.version + 1}. It builds in the background; until it's ready, new sandboxes boot the image fresh and run its setup.`}
					actions={experimental}
				/>
				<TemplateEditor
					source={source}
					now={now}
					draft={draft}
					saving={saving}
					onChange={view.change}
					submitLabel="Save"
					onCancel={view.cancel}
					onSave={async () => {
						const next = await view.save();
						setNotice({
							level: "info",
							text: next.version === edited.version ? "Saved." : `Saved v${next.version}. Kantel is building it.`,
						});
					}}
				/>
			</div>
		);
	}

	if (state.status !== "ready") {
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
						{messageOf(state.error, "Kantel couldn't read the template.")}
					</Notice>
				) : (
					<ListSkeleton />
				)}
			</div>
		);
	}

	const { template, snapshots, versions } = state.value;
	if (accountId !== undefined && template.accountId !== accountId) return otherAccount;

	const rebuild = () => {
		setRebuilding(true);
		source.rebuild(template.id).then(
			(rebuilt) => {
				setRebuilding(false);
				setNotice({ level: "info", text: rebuildText(rebuilt) });
				reload();
			},
			(caught: unknown) => {
				setRebuilding(false);
				setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't rebuild the template.") });
			},
		);
	};
	const pageMenu: MenuEntry[] = [
		{
			kind: "item",
			id: "edit",
			label: "Edit template",
			icon: <PencilIcon size="sm" />,
			onSelect: view.edit,
		},
		{ kind: "separator", id: "sep-delete" },
		{
			kind: "item",
			id: "delete",
			label: "Delete template",
			icon: <TrashIcon />,
			danger: true,
			onSelect: () => setDeleting(true),
		},
	];
	const { spec, build } = template;
	const start = startingSnapshot(template);
	const live = snapshots.filter((entry) => entry.state !== "discarded");
	const env = Object.entries(spec.env);

	return (
		<div className={computePage}>
			{back}
			<PageHeader
				title={
					<span className="inline-flex items-center gap-2">
						{template.name} <Badge>v{template.version}</Badge>
					</span>
				}
				{...(template.description === undefined ? {} : { lede: template.description })}
				actions={
					<>
						{experimental}
						<Button icon={<ReconnectIcon />} busy={rebuilding} onClick={rebuild}>
							Rebuild
						</Button>
						{newSandboxHref === undefined ? null : (
							<Button
								variant="primary"
								icon={<PlusIcon size="sm" />}
								onClick={() => navigate?.(newSandboxHref(template.id))}
							>
								New sandbox
							</Button>
						)}
						<Menu label={`Actions for ${template.name}`} icon={<EllipsisIcon />} entries={pageMenu} align="end" />
					</>
				}
			/>
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

			<Panel header={<span className="font-medium text-fg">Build</span>} footer={freshnessText(template, now)}>
				<FieldList>
					<Field
						label="Status"
						extra={
							behindText(template) === undefined ? undefined : <Badge tone="approval">{behindText(template)}</Badge>
						}
					>
						<BuildStatus build={build} />
					</Field>
					<Field label="New sandboxes">
						{start === undefined
							? "Boot the image and run its setup (a fresh boot)"
							: `Restore v${start.version}'s snapshot on ${start.hostId ?? "its host"}`}
					</Field>
					{start === undefined ? null : (
						<Field label="Built from">
							<span className={cellMono}>
								{`${start.builtFrom.baseImage}${start.builtFrom.channel === undefined ? "" : `:${start.builtFrom.channel}`}@${shortDigest(start.builtFrom.baseDigest)}`}
							</span>
							<span className="text-muted">
								{" "}
								with kernel {start.key.kernel} and Firecracker {start.key.firecracker}
							</span>
						</Field>
					)}
					{build.building === undefined || build.state === "failed" ? null : (
						<Field label="Building">
							v{build.building.version}, started {agoText(build.building.startedAt, now)}
						</Field>
					)}
				</FieldList>
				{build.behind === undefined || build.behind.releases === 0 ? null : (
					<Notice announce={false} level="warning">
						The base is pinned to {shortDigest(spec.base.digest ?? "")}. Its channel has published{" "}
						{plural(build.behind.releases, "release")} since, the first {agoText(build.behind.since, now)}; the latest
						is {shortDigest(build.behind.latestDigest)}. Edit the template to follow the channel or pin the new digest.
					</Notice>
				)}
				{build.state !== "failed" ? null : (
					<Notice announce={false} level="error">
						<span className="block">The build of v{build.building?.version ?? template.version} failed.</span>
						{build.error === undefined ? null : (
							<pre className="m-0 mt-1 overflow-x-auto font-mono text-code leading-normal whitespace-pre-wrap text-muted">
								{build.error}
							</pre>
						)}
					</Notice>
				)}
			</Panel>

			<section className="flex flex-col gap-3" aria-labelledby="template-definition">
				<SectionHeading id="template-definition" title={`Definition (v${template.version})`} />
				<Panel>
					<FieldList>
						<Field label="Image">{imageText(spec)}</Field>
						<Field label="Base" extra={<Badge>{spec.base.channel === undefined ? "Pinned" : "Follows channel"}</Badge>}>
							<span className={cellMono}>{baseText(spec)}</span>
						</Field>
						<Field label="Resources">{resourcesText(spec)}</Field>
						<Field label="Variables">
							{env.length === 0 ? (
								<span className="text-muted">None</span>
							) : (
								<span className="flex flex-col gap-0.5 font-mono text-code">
									{env.map(([name, value]) => (
										<span key={name}>
											{name}=<span className="text-muted">{value}</span>
										</span>
									))}
								</span>
							)}
						</Field>
						<Field label="Egress">
							{spec.grants.length === 0 ? (
								<span className="text-muted">The account's proxy settings only</span>
							) : (
								<GrantList grants={spec.grants} />
							)}
						</Field>
					</FieldList>
					{spec.setup === undefined || spec.setup === "" ? null : (
						<Script title="Setup script, run once as root" code={spec.setup} />
					)}
				</Panel>
			</section>

			<section className="flex flex-col gap-3" aria-labelledby="template-snapshots">
				<SectionHeading id="template-snapshots" title="Snapshot cache" />
				<p className="m-0 max-w-content text-sm text-muted">
					A snapshot is rebuilt when the version, the base's digest, the host's kernel or Firecracker, or the size
					changes. Kantel throws these away at will; your sandboxes' own snapshots are kept apart and never touched.
				</p>
				{live.length === 0 ? (
					<Panel>
						<EmptyState title="Nothing built">New sandboxes boot the image fresh until a snapshot is ready.</EmptyState>
					</Panel>
				) : (
					<SnapshotTable template={template} snapshots={live} now={now} />
				)}
			</section>

			<section className="flex flex-col gap-3" aria-labelledby="template-versions">
				<SectionHeading id="template-versions" title="Versions" />
				<VersionTable versions={versions} now={now} />
			</section>

			{deleting ? (
				<DeleteTemplateDialog
					template={template}
					onClose={() => setDeleting(false)}
					onDelete={async () => {
						await source.remove(template.id);
						setDeleting(false);
						if (navigate !== undefined) navigate(listHref);
					}}
				/>
			) : null}
		</div>
	);
}

function Script({ title, code }: { title: string; code: string }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs text-faint">{title}</span>
			<pre className="kt-selectable m-0 overflow-x-auto rounded-panel border border-border bg-code-surface px-3 py-2 font-mono text-code leading-normal text-fg">
				{code}
			</pre>
		</div>
	);
}

function GrantList({ grants }: { grants: readonly EgressGrant[] }) {
	return (
		<span className="flex flex-col gap-0.5">
			{grants.map((grant) => (
				<span key={grant.id} className="inline-flex items-baseline gap-1.5">
					<Badge tone={grant.action === "allow" ? "done" : "error"}>
						{grant.action === "allow" ? "Allow" : "Deny"}
					</Badge>
					<span className="font-mono text-code">
						{grant.methods.length === 0 ? "" : `${grant.methods.join(", ")} `}
						{grant.host}
						{grant.paths.length === 0 ? "" : ` ${grant.paths.join(", ")}`}
					</span>
				</span>
			))}
		</span>
	);
}

function SnapshotTable({
	template,
	snapshots,
	now,
}: {
	template: Pick<Template, "version">;
	snapshots: readonly TemplateSnapshot[];
	now: number;
}) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							State
						</th>
						<th className={th} scope="col">
							Version
						</th>
						<th className={th} scope="col">
							Base
						</th>
						<th className={th} scope="col">
							Kernel, Firecracker
						</th>
						<th className={th} scope="col">
							vCPUs
						</th>
						<th className={th} scope="col">
							Host
						</th>
						<th className={th} scope="col">
							Built
						</th>
					</tr>
				</thead>
				<tbody>
					{snapshots.map((entry) => {
						const { status, label } =
							entry.state === "stale" && !startsNewSandboxes(template, entry)
								? STALE_UNUSED
								: SNAPSHOT_STATUS[entry.state];
						return (
							<tr key={entry.id} data-template-snapshot={entry.id}>
								<td className={td}>
									<StatusLabel status={status}>{label}</StatusLabel>
									<span className={`${cellSub} font-mono`} title={entry.keyHash}>
										{entry.id}
									</span>
								</td>
								<td className={`${td} tabular-nums`}>v{entry.version}</td>
								<td className={td}>
									<span className={cellMono}>{shortDigest(entry.key.baseDigest)}</span>
									<span className={cellSub}>
										{entry.builtFrom.pinned ? "pinned" : `${entry.builtFrom.channel ?? ""} channel`}
									</span>
								</td>
								<td className={td}>
									<span className={cellMono}>
										{entry.key.kernel}, {entry.key.firecracker}
									</span>
								</td>
								<td className={`${td} tabular-nums`}>{entry.key.vcpus}</td>
								<td className={td}>
									<span className={cellMono}>{entry.hostId ?? "–"}</span>
								</td>
								<td className={td}>
									{entry.readyAt === undefined ? (
										<span className="text-muted">
											{entry.state === "failed" ? "Failed" : "Started"} {agoText(entry.startedAt, now)}
										</span>
									) : (
										<span>{agoText(entry.readyAt, now)}</span>
									)}
									{entry.sizeBytes === undefined ? null : <span className={cellSub}>{bytesText(entry.sizeBytes)}</span>}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}

function VersionTable({ versions, now }: { versions: readonly TemplateVersion[]; now: number }) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Version
						</th>
						<th className={th} scope="col">
							Base
						</th>
						<th className={th} scope="col">
							Size
						</th>
						<th className={th} scope="col">
							Made
						</th>
					</tr>
				</thead>
				<tbody>
					{versions.map((entry) => (
						<tr key={entry.version}>
							<td className={`${td} tabular-nums`}>v{entry.version}</td>
							<td className={td}>
								<span className="block max-w-(--kt-card-width) truncate font-mono text-code">
									{baseText(entry.spec)}
								</span>
							</td>
							<td className={`${td} tabular-nums`}>{resourcesText(entry.spec)}</td>
							<td className={td}>
								{agoText(entry.createdAt, now)}
								{entry.by === undefined ? null : <span className={cellSub}>by {entry.by}</span>}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</TableFrame>
	);
}

function DeleteTemplateDialog({
	template,
	onClose,
	onDelete,
}: {
	template: Template;
	onClose: () => void;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const submit = () => {
		setBusy(true);
		onDelete().catch((caught: unknown) => {
			setBusy(false);
			setFailure(messageOf(caught, "Kantel couldn't delete the template."));
		});
	};
	return (
		<Dialog
			open
			title={`Delete ${template.name}?`}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="danger" busy={busy}>
						Delete
					</Button>
				</>
			}
		>
			<p className="m-0 text-sm text-muted">
				Its versions and built snapshots go.{" "}
				{template.sandboxCount === 0
					? "No sandbox was made from it."
					: `The ${plural(template.sandboxCount, "sandbox", "sandboxes")} made from it keep running, and keep their own snapshots.`}
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// The editor: New template, and Edit

const VCPU_CHOICES = [1, 2, 4, 8, 16];
const MEMORY_CHOICES = [1024, 2048, 4096, 8192, 16_384, 32_768];

/**
 * New template's and Edit's form, over a draft its page keeps (see template-draft.ts and template-view.ts), so nothing
 * but the person's own typing changes what's in it. While its save is on its way every field and Cancel are disabled,
 * so the save's answer closes nothing typed after it was sent.
 */
function TemplateEditor({
	source,
	now,
	draft,
	saving,
	onChange,
	submitLabel,
	onCancel,
	onSave,
}: {
	/** Where the published bases are read from. */
	source: TemplatesSource;
	now: number;
	draft: TemplateDraft;
	saving: boolean;
	onChange: (update: (draft: TemplateDraft) => TemplateDraft) => void;
	submitLabel: string;
	onCancel: () => void;
	/** Saves the draft its page keeps. */
	onSave: () => Promise<void>;
}) {
	const [failure, setFailure] = useState<string>();
	const variablesId = useId();
	const set = (change: Partial<TemplateDraft>) => onChange((current) => ({ ...current, ...change }));
	const setVariable = (key: number, change: { name?: string; value?: string }) =>
		onChange((current) => ({
			...current,
			variables: current.variables.map((variable) => (variable.key === key ? { ...variable, ...change } : variable)),
		}));
	const problems = templateDraftProblems(draft);
	// The published bases; while they load, or if they can't be read, the default base is offered alone.
	const { state: bases } = useLoad(() => source.bases(), [source]);
	const published: readonly TemplateBaseChannel[] = bases.status === "ready" ? bases.value : [];
	const choices = templateBaseChoices(draft, published);
	const { name, description, baseImage, baseMode, digest, vcpus, memory, variables, setup, hosts } = draft;

	const submit = () => {
		if (!problems.ready || saving) return;
		setFailure(undefined);
		onSave().catch((caught: unknown) => {
			setFailure(messageOf(caught, "Kantel couldn't save the template. Try again."));
		});
	};

	return (
		<form
			className="contents"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<fieldset className="contents" disabled={saving}>
				<FormLayout className="max-w-content">
					<FormSection title="Name">
						<FormGrid columns={2}>
							<TextField
								label="Name"
								hint="Lowercase letters, digits and dashes. kantel new --template takes it."
								value={name}
								onChange={(event) => set({ name: event.currentTarget.value })}
								placeholder="python-data"
								mono
								spellCheck={false}
								{...(problems.name === undefined ? {} : { error: problems.name })}
							/>
							<TextField
								label="Description"
								hint="Optional. What it's for."
								value={description}
								onChange={(event) => set({ description: event.currentTarget.value })}
								placeholder="Python with our data stack"
							/>
						</FormGrid>
					</FormSection>
					<FormSection
						title="Image"
						description="What its machines boot: one of Kantel's base images, with the guest's tools and patches, as this deployment publishes it. Follow a channel and the template rebuilds whenever it publishes a patched digest; pin a digest from its history only when you must hold it still, and the template shows how far behind it is. Custom images come later: until then, the setup script installs what the template needs."
					>
						<SegmentedControl
							label="Base"
							options={[
								{ value: "channel", label: "Follow a channel" },
								{ value: "digest", label: "Pin a digest" },
							]}
							value={baseMode}
							onChange={(mode) => onChange((current) => templateBasePicked(current, { mode }, published))}
						/>
						<FormGrid columns={2}>
							<SelectField
								label="Base image"
								hint={
									bases.status === "error"
										? "Kantel couldn't read the published bases, so only the default is offered."
										: "Published by this deployment."
								}
								value={baseImage}
								onChange={(event) => {
									const image = event.currentTarget.value;
									onChange((current) => templateBasePicked(current, { image }, published));
								}}
								options={choices.images.map((image) => ({ value: image, label: image }))}
							/>
							<SelectField
								label="Channel"
								hint={
									baseMode === "digest"
										? "The channel whose digests you pick from."
										: choices.current === ""
											? "Not published yet: until it is, each host boots its own sandbox image."
											: `Publishes ${shortDigest(choices.current)} now.`
								}
								value={choices.channel}
								onChange={(event) => {
									const picked = event.currentTarget.value;
									onChange((current) => templateBasePicked(current, { channel: picked }, published));
								}}
								options={choices.channels.map((each) => ({ value: each, label: each }))}
							/>
						</FormGrid>
						{baseMode === "channel" ? null : (
							<SelectField
								label="Digest"
								value={digest}
								disabled={choices.digests.length === 0}
								onChange={(event) => set({ digest: event.currentTarget.value, channel: choices.channel })}
								{...(choices.digests.length === 0
									? { error: "This channel hasn't published a digest to pin yet. Follow it instead." }
									: {})}
								options={
									choices.digests.length === 0
										? [{ value: "", label: "Nothing published yet" }]
										: choices.digests.map((release) => ({
												value: release.digest,
												label: `${shortDigest(release.digest)}${release.digest === choices.current ? " (current)" : ""}, ${
													release.publishedAt === undefined
														? `not one ${choices.channel} published`
														: `published ${agoText(release.publishedAt, now)}`
												}`,
											}))
								}
							/>
						)}
					</FormSection>
					<FormSection
						title="Size"
						description="Its sandboxes' vCPUs and memory unless New sandbox picks another size. Only this size starts from the snapshot; another boots fresh."
					>
						<FormGrid columns={2}>
							<SelectField
								label="vCPUs"
								value={vcpus}
								onChange={(event) => set({ vcpus: event.currentTarget.value })}
								options={VCPU_CHOICES.map((count) => ({ value: String(count), label: `${count} vCPU` }))}
							/>
							<SelectField
								label="Memory"
								value={memory}
								onChange={(event) => set({ memory: event.currentTarget.value })}
								options={MEMORY_CHOICES.map((mb) => ({ value: String(mb), label: memoryText(mb) }))}
							/>
						</FormGrid>
					</FormSection>
					<FormSection
						title="Setup"
						description="Run once as root inside the machine when the snapshot is built, with the variables below, then snapshotted."
					>
						<FormField
							id={variablesId}
							label="Variables"
							hint="Plain values, not secrets: an environment's protected variables are for those. A value is kept exactly as typed, line breaks and all."
						>
							<div className="flex flex-col gap-2">
								{variables.map((variable, at) => {
									const problem = problems.variables[at];
									const called = variable.name === "" ? `variable ${at + 1}` : variable.name;
									return (
										<div
											key={variable.key}
											data-template-variable={at}
											className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-2"
										>
											<TextField
												label={`Name of variable ${at + 1}`}
												hideLabel
												value={variable.name}
												onChange={(event) => setVariable(variable.key, { name: event.currentTarget.value })}
												placeholder="NAME"
												mono
												spellCheck={false}
												autoComplete="off"
												{...(problem === undefined ? {} : { error: problem })}
											/>
											<TextAreaField
												label={`Value of ${called}`}
												hideLabel
												rows={1}
												value={variable.value}
												onChange={(event) => setVariable(variable.key, { value: event.currentTarget.value })}
												placeholder="value"
												mono
												spellCheck={false}
												autoComplete="off"
											/>
											<div className="flex h-control-md items-center">
												<IconButton
													size="sm"
													variant="ghost"
													icon={<TrashIcon />}
													label={`Remove ${called}`}
													onClick={() =>
														onChange((current) => ({
															...current,
															variables: current.variables.filter((each) => each.key !== variable.key),
														}))
													}
												/>
											</div>
										</div>
									);
								})}
								<div>
									<Button
										size="xs"
										icon={<PlusIcon size="sm" />}
										onClick={() =>
											onChange((current) => ({
												...current,
												variables: [...current.variables, templateVariableDraft()],
											}))
										}
									>
										Add variable
									</Button>
								</div>
							</div>
						</FormField>
						<TextAreaField
							label="Setup script"
							hint="Optional. Installs what the template needs: packages, tools, warm caches. It runs inside the machine, behind the template's egress grants, so it reaches only the hosts under Network."
							rows={5}
							mono
							spellCheck={false}
							value={setup}
							onChange={(event) => set({ setup: event.currentTarget.value })}
							placeholder={
								"apt-get update && apt-get install -y --no-install-recommends ripgrep jq\nuv pip install --system pandas"
							}
						/>
					</FormSection>
					<FormSection
						title="Network"
						description="Hosts its sandboxes, and its setup script, may reach on top of the account's proxy settings."
					>
						<TextField
							label="Allowed hosts"
							hint="Comma separated."
							value={hosts}
							onChange={(event) => set({ hosts: event.currentTarget.value })}
							placeholder="snapshot.ubuntu.com, pypi.org, files.pythonhosted.org"
							mono
							spellCheck={false}
						/>
					</FormSection>
					{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
					<FormActions>
						<Button type="submit" variant="primary" busy={saving} disabled={!problems.ready}>
							{submitLabel}
						</Button>
						<Button onClick={onCancel}>Cancel</Button>
					</FormActions>
				</FormLayout>
			</fieldset>
		</form>
	);
}
