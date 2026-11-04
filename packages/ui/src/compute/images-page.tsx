// The Images page (compute console, super-admin, experimental): the base images Kantel builds sandboxes from and the
// templates built on them. Each image's stable version and its age, whether it's signed, and what its latest scan
// found, which opens to the findings and the recent versions; each template's channel or pinned digest and how far
// its base is behind, or that it's rebuilding. Kantel rebuilds the images daily and on a fixable High or Critical;
// a running sandbox never changes, and moves on a restart. Every call goes through the `BaseImagesSource` the host
// binds; stories bind it to fixtures.

import { Fragment, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { ChevronRightIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { behindText } from "./base-outdated.tsx";
import type {
	BaseImage,
	BaseImagesOverview,
	BaseImagesSource,
	BaseImageTemplate,
	BaseImageVersion,
	ImageBuildReason,
	ImageFinding,
	ImageScan,
	ImageSeverity,
} from "./compute-model.ts";
import {
	cellMono,
	cellSub,
	computePage,
	messageOf,
	None,
	rowHover,
	SectionHeading,
	TableFrame,
	table,
	tableFrame,
	td,
	th,
} from "./parts.tsx";

export interface ImagesPageProps {
	readonly source: BaseImagesSource;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Images whose findings are open when the page opens, by name, for a story. */
	readonly open?: readonly string[];
}

/** A badge's tone and words. */
export interface Tagged {
	readonly tone: BadgeTone;
	readonly text: string;
}

/**
 * What a scan says in a word or two, the worst first: "1 critical fixable", "2 high", "No high or critical". A
 * fixable Critical or High is what makes Kantel rebuild the image; the findings say which Highs have a fix.
 */
export function scanStatus(scan: ImageScan | undefined): Tagged {
	if (scan === undefined) return { tone: "neutral", text: "Not scanned" };
	if (scan.fixable.critical > 0) return { tone: "error", text: `${scan.fixable.critical} critical fixable` };
	if (scan.counts.critical > 0) return { tone: "error", text: `${scan.counts.critical} critical` };
	if (scan.counts.high > 0) return { tone: "approval", text: `${scan.counts.high} high` };
	return { tone: "done", text: "No high or critical" };
}

/** A template's state: rebuilding, up to date, or how far behind its base is. */
export function templateStatus(template: Pick<BaseImageTemplate, "base" | "rebuilding">): Tagged {
	if (template.rebuilding) return { tone: "accent", text: "Rebuilding" };
	if (!template.base.outdated) return { tone: "done", text: "Up to date" };
	const behind = template.base.behind === undefined ? "behind the latest" : behindText(template.base.behind);
	return { tone: "approval", text: `${behind.charAt(0).toUpperCase()}${behind.slice(1)}` };
}

/** "sha256:abcd1234": a digest short enough for a cell. */
export const shortDigest = (digest: string): string => `sha256:${digest.replace(/^sha256:/, "").slice(0, 8)}`;

/** The NVD's page for a CVE; none for another scanner's IDs. */
export const findingHref = (id: string): string | undefined =>
	/^CVE-\d{4}-\d+$/i.test(id) ? `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id.toUpperCase())}` : undefined;

const SEVERITY_ORDER: readonly ImageSeverity[] = ["critical", "high", "medium", "low", "unknown"];

const SEVERITY_LABELS: Readonly<Record<ImageSeverity, string>> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	unknown: "Unknown",
};

const SEVERITY_TONES: Readonly<Record<ImageSeverity, BadgeTone>> = {
	critical: "error",
	high: "approval",
	medium: "neutral",
	low: "neutral",
	unknown: "neutral",
};

/** Findings, the worst first, then by package. */
export const findingsInOrder = (findings: readonly ImageFinding[]): readonly ImageFinding[] =>
	[...findings].sort(
		(a, b) =>
			SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.package.localeCompare(b.package),
	);

const REASON_LABELS: Readonly<Record<ImageBuildReason, string>> = {
	daily: "Daily rebuild",
	cve: "CVE rebuild",
	manual: "Built by hand",
	push: "Recipe changed",
};

/** "3h ago", "just now". */
const ago = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

const when = (at: number) => new Date(at).toLocaleString("en-GB");

export function ImagesPage({ source, now: fixedNow, open: initiallyOpen = [] }: ImagesPageProps) {
	const { state, reload } = useLoad(() => source.overview(), [source]);
	const now = fixedNow ?? Date.now();
	return (
		<div className={computePage}>
			<PageHeader
				title="Images"
				lede="Kantel rebuilds its base images every day and whenever a scan finds a fixable High or Critical vulnerability. Sandboxes never change underneath anyone: they move on restart."
				actions={<Badge tone="accent">Super-admin</Badge>}
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
					{messageOf(state.error, "Kantel couldn't read the base images.")}
				</Notice>
			) : state.status === "loading" ? (
				<>
					<TableSkeleton />
					<TableSkeleton />
				</>
			) : (
				<Overview overview={state.value} now={now} initiallyOpen={initiallyOpen} />
			)}
		</div>
	);
}

function TableSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function Overview({
	overview,
	now,
	initiallyOpen,
}: {
	overview: BaseImagesOverview;
	now: number;
	initiallyOpen: readonly string[];
}) {
	const { images, templates, error } = overview;
	return (
		<>
			{error === undefined ? null : (
				<Notice level="warning">{`Kantel couldn't read the image index: ${error.replace(/\.$/, "")}.`}</Notice>
			)}
			<p className="m-0 min-w-0 text-xs text-muted">
				From the image index at{" "}
				<a className="font-mono text-code text-accent-text" href={overview.indexUrl} target="_blank" rel="noreferrer">
					{overview.indexUrl}
				</a>
				{overview.generatedAt === undefined ? "" : `, made ${ago(overview.generatedAt, now)}`}.
			</p>
			{error !== undefined && images.length === 0 && templates.length === 0 ? null : (
				<>
					<section className="flex min-w-0 flex-col gap-3" aria-labelledby="images-base">
						<SectionHeading id="images-base" title="Base images" />
						{images.length === 0 ? (
							<EmptyState title="No base images yet">They show here once the image index lists one.</EmptyState>
						) : (
							<ImagesTable images={images} now={now} initiallyOpen={initiallyOpen} />
						)}
					</section>
					<section className="flex min-w-0 flex-col gap-3" aria-labelledby="images-templates">
						<SectionHeading id="images-templates" title="Templates" />
						{templates.length === 0 ? (
							<EmptyState title="No templates yet">
								A template is a base image with a setup on top; Kantel rebuilds it when its base moves.
							</EmptyState>
						) : (
							<TemplatesTable templates={templates} />
						)}
					</section>
				</>
			)}
		</>
	);
}

function ImagesTable({
	images,
	now,
	initiallyOpen,
}: {
	images: readonly BaseImage[];
	now: number;
	initiallyOpen: readonly string[];
}) {
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen));
	const toggle = (name: string) =>
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={th} scope="col">
							Stable version
						</th>
						<th className={th} scope="col">
							Signed
						</th>
						<th className={th} scope="col">
							Scan
						</th>
						<th className={th} scope="col">
							Last scanned
						</th>
					</tr>
				</thead>
				<tbody>
					{images.map((image) => {
						const isOpen = open.has(image.name);
						const detailId = `image-${image.name}`;
						const latest = image.latest;
						const scan = scanStatus(latest?.scan);
						return (
							<Fragment key={image.name}>
								<tr
									className={isOpen ? "bg-hover" : rowHover}
									data-image={image.name}
									data-row={isOpen ? "open" : undefined}
								>
									<td className={td}>
										<button
											type="button"
											className="kt-focusable -ml-1 flex min-w-0 max-w-full cursor-pointer items-start gap-1 rounded-sm border-0 bg-transparent p-1 text-left"
											aria-expanded={isOpen}
											aria-controls={isOpen ? detailId : undefined}
											onClick={() => toggle(image.name)}
										>
											<ChevronRightIcon
												size="sm"
												className={`mt-0.5 flex-none text-faint transition-transform ${isOpen ? "rotate-90" : ""}`}
											/>
											<span className="flex min-w-0 flex-col">
												<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{image.name}</span>
												<span className={`${cellSub} max-w-72 truncate font-mono`} title={image.repository}>
													{image.repository}
												</span>
											</span>
										</button>
									</td>
									<td className={td}>
										{latest === undefined ? (
											<None className="text-faint" />
										) : (
											<>
												<span className="block font-mono text-code text-fg">{latest.version}</span>
												<span className={cellSub} title={when(latest.builtAt)}>
													built {ago(latest.builtAt, now)}
												</span>
											</>
										)}
									</td>
									<td className={td}>
										{latest === undefined ? (
											<None className="text-faint" />
										) : latest.signed ? (
											<Badge tone="done">Signed</Badge>
										) : (
											<Badge tone="error">Unsigned</Badge>
										)}
									</td>
									<td className={td}>
										<Badge tone={scan.tone}>{scan.text}</Badge>
									</td>
									<td className={td}>
										{latest?.scan === undefined ? (
											<None className="text-faint" />
										) : (
											<span className="text-muted" title={`${when(latest.scan.scannedAt)}, ${latest.scan.scanner}`}>
												{ago(latest.scan.scannedAt, now)}
											</span>
										)}
									</td>
								</tr>
								{isOpen ? (
									<tr>
										<td className={`${td} bg-sunken`} colSpan={5} id={detailId}>
											<ImageDetail image={image} now={now} />
										</td>
									</tr>
								) : null}
							</Fragment>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}

/** An image opened: its latest version's findings, the worst first, and its recent versions. */
function ImageDetail({ image, now }: { image: BaseImage; now: number }) {
	const scan = image.latest?.scan;
	return (
		<div className="flex min-w-0 flex-col gap-4 py-1 whitespace-normal">
			<div className="flex min-w-0 flex-col gap-2">
				<span className="text-xs font-medium text-muted">
					{image.latest === undefined ? "Findings" : `Findings in ${image.latest.version}`}
				</span>
				{scan === undefined ? (
					<p className="m-0 text-sm text-muted">Kantel hasn't scanned this version yet.</p>
				) : scan.findings.length === 0 ? (
					<p className="m-0 text-sm text-muted">The latest scan found no high or critical vulnerabilities.</p>
				) : (
					<Findings findings={scan.findings} />
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-2">
				<span className="text-xs font-medium text-muted">Recent versions</span>
				{image.versions.length === 0 ? (
					<p className="m-0 text-sm text-muted">None yet.</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
						{image.versions.slice(0, 5).map((version) => (
							<VersionLine key={version.digest} version={version} now={now} />
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function Findings({ findings }: { findings: readonly ImageFinding[] }) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Severity
						</th>
						<th className={th} scope="col">
							ID
						</th>
						<th className={th} scope="col">
							Package
						</th>
						<th className={th} scope="col">
							Installed
						</th>
						<th className={th} scope="col">
							Fixed in
						</th>
					</tr>
				</thead>
				<tbody>
					{findingsInOrder(findings).map((finding) => {
						const href = findingHref(finding.id);
						return (
							<tr key={`${finding.id}/${finding.package}`} data-finding={finding.id}>
								<td className={td}>
									<Badge tone={SEVERITY_TONES[finding.severity]}>{SEVERITY_LABELS[finding.severity]}</Badge>
								</td>
								<td className={td}>
									{href === undefined ? (
										<span className="font-mono text-code text-fg" title={finding.title}>
											{finding.id}
										</span>
									) : (
										<a
											className="font-mono text-code text-accent-text"
											href={href}
											target="_blank"
											rel="noreferrer"
											title={finding.title}
										>
											{finding.id}
										</a>
									)}
								</td>
								<td className={td}>
									<span className="text-fg">{finding.package}</span>
								</td>
								<td className={td}>
									<span className={cellMono}>{finding.installed}</span>
								</td>
								<td className={td}>
									{finding.fixed === undefined ? (
										<span className="text-muted">No fix yet</span>
									) : (
										<span className={cellMono}>{finding.fixed}</span>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}

function VersionLine({ version, now }: { version: BaseImageVersion; now: number }) {
	return (
		<li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
			<span className="font-mono text-code text-fg">{version.version}</span>
			<span className="text-muted" title={when(version.builtAt)}>
				built {ago(version.builtAt, now)}
			</span>
			{version.reason === "cve" ? (
				<Badge tone="accent">{REASON_LABELS.cve}</Badge>
			) : version.reason === undefined ? null : (
				<span className="text-xs text-muted">{REASON_LABELS[version.reason]}</span>
			)}
			{version.signed ? null : <Badge tone="error">Unsigned</Badge>}
		</li>
	);
}

function TemplatesTable({ templates }: { templates: readonly BaseImageTemplate[] }) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={th} scope="col">
							Base image
						</th>
						<th className={th} scope="col">
							Channel
						</th>
						<th className={th} scope="col">
							Status
						</th>
					</tr>
				</thead>
				<tbody>
					{templates.map((template) => {
						const status = templateStatus(template);
						return (
							<tr key={template.id} className={rowHover} data-template={template.id}>
								<td className={td}>
									<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{template.name}</span>
								</td>
								<td className={td}>
									<span className="block text-fg">{template.image}</span>
									{template.base.version === undefined ? null : (
										<span className={`${cellSub} font-mono`}>{template.base.version}</span>
									)}
								</td>
								<td className={td}>
									{template.pinned !== undefined ? (
										<span className="flex items-center gap-2">
											<span className="text-fg">Pinned</span>
											<span className={cellMono} title={template.pinned}>
												{shortDigest(template.pinned)}
											</span>
										</span>
									) : template.channel !== undefined ? (
										<span className="text-fg">{template.channel}</span>
									) : (
										<None className="text-faint" />
									)}
								</td>
								<td className={td}>
									<Badge tone={status.tone}>{status.text}</Badge>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}
