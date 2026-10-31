import type { ToolImage, ToolItem } from "@kantel/protocol";
import { memo, type ReactNode, type SyntheticEvent, useContext, useEffect, useId, useState } from "react";
import { Code, languageForPath } from "../code/code.tsx";
import { Disclosure } from "../primitives/controls.tsx";
import { duration } from "../primitives/format.ts";
import {
	ChevronRightIcon,
	EyeIcon,
	FileIcon,
	GlobeIcon,
	type IconProps,
	ImageIcon,
	MinusCircleIcon,
	PencilIcon,
	SearchIcon,
	TerminalIcon,
	VaultIcon,
	XCircleIcon,
} from "../primitives/icons.tsx";
import { StepFailedIcon } from "../primitives/lucide.tsx";
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { ClockTime } from "../primitives/time.tsx";
import { ToolRenderersContext, toolRenderers } from "./tool-renderer-model.ts";
import { codingToolRenderers, InToolCard } from "./tool-views.tsx";
// Only the group summary's reach into Disclosure's own parts is left in this CSS; the rest is Tailwind utilities.
import "./tool-call.css";

// A tool call as one quiet work-log line, after T3 Code's work-log row (TimelineWorkEntryRow.tsx, WorkLog.tsx at
// 1152e917): an icon that says what kind of call it was, the host's plain-words label ("Ran pnpm test", "Read
// src/billing/charge.ts") and a chevron. Like T3, a call shows no duration of its own: when it started appears on
// hover or focus, and how long the work took is said once for the group ("Worked for 8s"). The arguments and output
// are one tap away and rendered only while open; nothing about a call shouts while it runs, though its label is at
// full strength (`labelTone` below) so the call happening now is read before the finished ones.
//
// A tool with an entry in the transcript's renderer registry (tool-renderer-model.ts) can have its own label, its own
// detail and start open; one that renders in place never reaches a row here. The file and shell tools (write, read,
// edit, bash) have one (`codingToolRenderers`, tool-views.tsx): they open to a card of their own, the file as an editor
// shows it, the edit as a diff, the command as a terminal, growing as the model writes the call, with their raw
// arguments and output one switch away. Outside a transcript (a story, a host's own list of calls) a row uses those.
const OUTSIDE_A_TRANSCRIPT = toolRenderers(codingToolRenderers);

type IconComponent = (props: IconProps) => ReactNode;

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md). Quiet work-log rows after T3 Code's
// WorkLog: 24px rows, 13px muted labels (full strength while running or failed), a 16px icon, a chevron at the end, and
// the start time only on hover or focus. The detail is a framed block of selectable mono text with a bounded height,
// the column's full width under its row, not indented past the icon: T3 Code's tool detail is a "panel"
// (WorkLogDetails, WorkLog.tsx), which has no inline start margin. The kt- class names stay as hooks: transcript.css,
// browser-panel.css and loop/align.ts select on them.

/** A group of calls, here and in tool-renderers.tsx. */
export const toolGroup = "kt-tool-group flex min-w-0 flex-col";
/**
 * The call: `group/tool` shows the start time while it is hovered or holds focus. The tallest an argument or output
 * block grows before it scrolls (candidate token: --kt-tool-output-height), and the widest a tool image is shown
 * (candidate token: --kt-tool-image-width).
 */
const call =
	"kt-tool group/tool min-w-0 [--kt-tool-image-width:calc(var(--kt-step-12)*8)] [--kt-tool-output-height:calc(var(--kt-step-12)*5)]";
/** The row: a full-width button, pulled out by its own padding so its icon stays on the column's edge. */
const row =
	"kt-tool-row kt-focusable relative -mx-1.5 my-0 flex min-h-control-xs w-[calc(100%_+_var(--kt-step-1_5)*2)] min-w-0 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-left [font-family:inherit] [font-feature-settings:inherit] [font-weight:inherit] text-sm leading-tight text-muted hover:bg-hover hover:text-fg";
/**
 * The label is trimmed to its capitals, as a Button's label is, so the row centres the letters, not a line box whose
 * space below them is deeper than above: the icon, the words and the chevron then share one centre. The even padding
 * gives descenders room inside the clip.
 */
const labelBase = "kt-tool-label min-w-0 flex-1 truncate py-(--kt-trim-room) [text-box:trim-both_cap_alphabetic]";
/**
 * When the call started, by the clock. As in T3 Code (TimelineRowTimestamp), it is out of the flow and transparent until
 * the call is hovered or holds focus, so the label keeps the row's width; then it takes its place before the chevron,
 * with the full date and time as its title.
 */
const stamp =
	"kt-tool-stamp pointer-events-none absolute flex-none text-xs whitespace-nowrap text-faint tabular-nums opacity-0 [text-box:trim-both_cap_alphabetic] group-hover/tool:pointer-events-auto group-hover/tool:static group-hover/tool:opacity-100 group-focus-within/tool:pointer-events-auto group-focus-within/tool:static group-focus-within/tool:opacity-100";
/** An argument or output block: selectable mono text, scrolling past --kt-tool-output-height. */
const pre =
	"kt-tool-pre kt-selectable kt-focusable m-0 max-h-(--kt-tool-output-height) overflow-auto rounded-sm bg-code-surface px-2.5 py-2 font-mono text-code leading-normal whitespace-pre-wrap wrap-anywhere select-text";
const section = "kt-tool-section flex min-w-0 flex-col gap-1";
const sectionLabel = "kt-tool-section-label text-xs text-faint";

/** Failure is said by the icon; an interrupted call's icon is in the approval tone. */
const iconTone = (status: ToolItem["status"]): string =>
	status === "error" ? "text-status-error" : status === "interrupted" ? "text-status-approval" : "text-faint";

/**
 * A failed call's label stays readable at full strength. In a live group every finished call is muted, so the one
 * happening now is read first by its label at full strength, not only by its small spinner. Nothing moves; only the
 * colour differs. Otherwise the label takes the row's colour.
 */
const labelTone = (status: ToolItem["status"]): string =>
	status === "error" || status === "running" ? " text-fg" : "";

// Checked in order; vault comes first so "vault_read" is a vault call, not a read.
const iconRules: readonly [RegExp, IconComponent][] = [
	[/vault/, VaultIcon],
	[/read|view/, EyeIcon],
	[/edit|write|patch/, PencilIcon],
	[/bash|shell|exec|command/, TerminalIcon],
	[/grep|glob|search|find/, SearchIcon],
	[/fetch|web|browser/, GlobeIcon],
	[/image/, ImageIcon],
];

/** The icon for a tool, chosen from its name. */
export function toolIcon(name: string): IconComponent {
	const lower = name.toLowerCase();
	for (const [pattern, icon] of iconRules) if (pattern.test(lower)) return icon;
	return FileIcon;
}

/**
 * What the detail shows for the arguments: a lone `command` as itself, anything else as indented JSON. `language` is
 * what to highlight it as.
 */
export function formatArgs(args: unknown): { label: string; text: string; language?: string } | undefined {
	if (args === undefined || args === null) return undefined;
	if (typeof args === "string") return args === "" ? undefined : { label: "Arguments", text: args };
	if (typeof args === "object") {
		const keys = Object.keys(args);
		if (keys.length === 0) return undefined;
		const command = (args as { command?: unknown }).command;
		if (keys.length === 1 && typeof command === "string") return { label: "Command", text: command, language: "bash" };
	}
	return { label: "Arguments", text: JSON.stringify(args, null, 2), language: "json" };
}

/**
 * What to highlight a call's output as: the file's language when a read-like call names one file (`read` with
 * `path: "src/app.ts"`), otherwise nothing, and the output shows as plain text in the theme's code colour.
 */
export function outputLanguage(item: Pick<ToolItem, "name" | "args" | "status">): string | undefined {
	if (item.status === "error" || !/read|view|cat/i.test(item.name)) return undefined;
	const args = item.args as Record<string, unknown> | undefined;
	const path = args?.path ?? args?.file_path ?? args?.file;
	return typeof path === "string" ? languageForPath(path) : undefined;
}

export const isFailed = (item: ToolItem): boolean => item.status === "error" || item.status === "interrupted";

/**
 * An alert mark in the error tone, and nothing else: what a collapsed section of work (a turn's "Worked for" line, a
 * group's, a browsing run's) shows beside its words when a step it hides failed or was interrupted. A failed step folds
 * away like any other; this keeps it from going unseen. No count: the line says neither how many steps it holds nor how
 * many failed. A screen reader hears "A step failed", as T3 Code labels a failed call's mark (`role="img"`,
 * "Tool call failed", in its `TimelineWorkEntryRow`); the title says the same on hover. Nothing when none failed.
 */
export function StepFailed({ failed }: { failed: boolean }) {
	if (!failed) return null;
	return (
		<span
			role="img"
			aria-label="A step failed"
			title="A step failed"
			className="kt-step-failed inline-flex flex-none items-center text-status-error"
		>
			<StepFailedIcon size="sm" />
		</span>
	);
}

function Leading({ item }: { item: ToolItem }) {
	switch (item.status) {
		case "running":
			return (
				<>
					<Spinner />
					<span className="kt-sr-only">Running</span>
				</>
			);
		case "error":
			return <XCircleIcon label="Failed" className="kt-tool-status" />;
		case "interrupted":
			return <MinusCircleIcon label="Interrupted" className="kt-tool-status" />;
		default: {
			const Icon = toolIcon(item.name);
			return <Icon />;
		}
	}
}

function Detail({
	item,
	id,
	images,
	thought,
}: {
	item: ToolItem;
	id?: string;
	images: boolean;
	thought?: string | undefined;
}) {
	const args = formatArgs(item.args);
	const running = item.status === "running";
	const failed = item.status === "error";
	const output = item.output ?? "";
	// The raw view inside a file or shell call's card (tool-views.tsx) is this detail without its own frame.
	const inCard = useContext(InToolCard);
	const frame = inCard
		? ""
		: ` mx-0 mt-1 mb-2 rounded-control border ${failed ? "border-status-error-line" : "border-border"}`;
	return (
		<div id={id} className={`kt-tool-detail flex min-w-0 flex-col gap-2.5 bg-panel px-3 py-2.5 ${frame}`}>
			{thought === undefined ? null : (
				<div className={section}>
					<div className={sectionLabel}>Thought</div>
					<p className="kt-tool-thought m-0 text-sm leading-normal whitespace-pre-wrap text-muted wrap-anywhere">
						{thought}
					</p>
				</div>
			)}
			{images && (item.images?.length ?? 0) > 0 ? (
				<div className={section}>
					<div className={sectionLabel}>{item.images?.length === 1 ? "Screenshot" : "Screenshots"}</div>
					<ToolImages item={item} />
				</div>
			) : null}
			{args === undefined ? null : (
				<div className={section}>
					<div className={sectionLabel}>{args.label}</div>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
					<pre className={`${pre} text-fg`} tabIndex={0}>
						<Code code={args.text} language={args.language} />
					</pre>
				</div>
			)}
			<div className={section}>
				<div className={sectionLabel}>{running ? "Output so far" : failed ? "Error" : "Output"}</div>
				{output === "" ? (
					<p className="kt-tool-empty m-0 text-sm text-faint">{running ? "Waiting for output" : "No output"}</p>
				) : (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					<pre className={`${pre} kt-tool-output ${failed ? "text-status-error" : "text-fg"}`} tabIndex={0}>
						{running || item.status === "error" ? output : <Code code={output} language={outputLanguage(item)} />}
					</pre>
				)}
			</div>
		</div>
	);
}

/** A tool image as a URL an `<img>` can show. Only the protocol's raster types reach here. */
export function toolImageSrc(image: ToolImage): string {
	return image.url ?? `data:${image.mimeType};base64,${image.data}`;
}

/**
 * An image by reference's pixel size as an `<img>`'s `width` and `height`, when the reference gives it: the browser
 * keeps the image's room (at its aspect ratio, under `h-auto`) before it loads, so a transcript that opens at its end
 * doesn't move as images arrive. Empty for an inline image or one whose size isn't known.
 */
export function toolImageSize(image: ToolImage): { width?: number; height?: number } {
	return image.url !== undefined && image.width !== undefined && image.height !== undefined
		? { width: image.width, height: image.height }
		: {};
}

/** How often, and how long apart, a referenced image that isn't there yet is asked for again. */
const IMAGE_RETRIES = 8;
const IMAGE_RETRY_MS = 600;

/**
 * An `<img>`'s `onError` for a tool image: one by reference may not be stored yet (a browser's screenshot is taken
 * after its step answers), so it is asked for again, a little later each time. One that never comes (the step's
 * screenshot couldn't be taken, as when the browser closed under it) is hidden, with the frame it sits in, rather than
 * left as a broken image. An inline one is never asked for again.
 */
export function retryToolImage(event: SyntheticEvent<HTMLImageElement>): void {
	const img = event.currentTarget;
	if (img.src.startsWith("data:")) return;
	const tries = Number(img.dataset.tries ?? "0") + 1;
	if (tries > IMAGE_RETRIES) {
		const frame = img.closest<HTMLElement>(".kt-tool-image, .kt-browser-step-shot");
		(frame ?? img).hidden = true;
		return;
	}
	img.dataset.tries = String(tries);
	const next = new URL(img.src);
	next.searchParams.set("try", String(tries));
	setTimeout(() => {
		if (img.isConnected) img.src = next.href;
	}, IMAGE_RETRY_MS * tries);
}

/** The page a browser call left, as words for a screen reader: "Screenshot after Opening en.wikipedia.org". */
function imageAlt(item: ToolItem, index: number, count: number): string {
	return count === 1 ? `Screenshot after ${item.label}` : `Screenshot ${index + 1} of ${count} after ${item.label}`;
}

export type ToolImagesProps = { item: ToolItem; images?: readonly ToolImage[] };

/**
 * The images a call returned, such as a browser's screenshot, shown under its row without opening it, so a person
 * watches the browser move. Each opens full size on click, as a link to the image itself.
 */
export function ToolImages({ item, images = item.images ?? [] }: ToolImagesProps) {
	return <Images item={item} images={images} grouped={false} />;
}

/**
 * The images under a row, in line with its label; under a folded group's summary (`grouped`), in line with the
 * summary's words. browser-panel.css takes the margin off in the browser panel.
 */
function Images({ item, images, grouped }: { item: ToolItem; images: readonly ToolImage[]; grouped: boolean }) {
	if (images.length === 0) return null;
	return (
		<div
			className={`kt-tool-images mt-1 mr-0 mb-2 flex min-w-0 flex-wrap gap-2 ${grouped ? "ml-4" : "ml-[calc(var(--kt-icon-md)_+_var(--kt-step-2))]"}`}
		>
			{images.map((image, index) => {
				const src = toolImageSrc(image);
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: a call's images never reorder.
						key={index}
						type="button"
						// Each opens the image full size; --kt-tool-image-width is set on the call (`call` above).
						className="kt-tool-image kt-focusable block max-w-[min(100%,var(--kt-tool-image-width))] cursor-zoom-in overflow-hidden rounded-control border border-border-strong bg-panel p-0 hover:border-faint"
						title="Open full size"
						onClick={() => openImage(image)}
					>
						<img
							className="block h-auto w-full"
							src={src}
							{...toolImageSize(image)}
							alt={imageAlt(item, index, images.length)}
							loading="lazy"
							decoding="async"
							onError={retryToolImage}
						/>
					</button>
				);
			})}
		</div>
	);
}

/**
 * Opens an image full size in a new tab, as a blob URL: browsers refuse to open a data URL in a tab. The URL is freed
 * once the tab has had time to load it.
 */
export function openImage(image: ToolImage): void {
	if (image.url !== undefined) {
		window.open(image.url, "_blank", "noopener");
		return;
	}
	const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
	window.open(url, "_blank", "noopener");
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type ToolCallChipProps = {
	item: ToolItem;
	defaultOpen?: boolean;
	/**
	 * Shown under the row in place of its images: the live view of the browser the call used (`BrowserLiveView`), when
	 * this is the newest call on it. The view shows the screenshot itself whenever it isn't live.
	 */
	browserView?: ReactNode;
	/** The call a link names (`#turn=`): it stands out briefly. */
	linked?: boolean;
	/**
	 * Where the call's images go: `inline` under its row without opening it (the default), or `detail`, only once the
	 * row is opened, as a browsing run's steps do so a browser's every step doesn't post a screenshot; or `none`, when
	 * they are shown as cards of their own (`generate_image`'s, as the files it presented).
	 */
	images?: "inline" | "detail" | "none";
	/**
	 * What the agent thought before the call, as a step of a run (`ToolRunRow`): it folds into the call's detail, rather
	 * than being a "Thought it through" row of its own.
	 */
	thought?: string;
};

/**
 * One tool call as a quiet row: icon, label, chevron, and when it started on hover or focus. A button with
 * aria-expanded; the arguments and output render only while it is open. Memoised on `item`, so a transcript
 * re-renders only the call that changed, and nothing in it ticks.
 */
export const ToolCallChip = memo(function ToolCallChip({
	item,
	defaultOpen = false,
	browserView,
	linked = false,
	images = "inline",
	thought,
}: ToolCallChipProps) {
	useRenderProbe("ToolCallChip", item.id);
	const renderer = (useContext(ToolRenderersContext) ?? OUTSIDE_A_TRANSCRIPT).get(item.name);
	const [open, setOpen] = useState(() => defaultOpen || renderer?.openByDefault?.(item) === true);
	// The detail's switch to the raw arguments and output, kept here so it stays as left when the row closes and opens.
	const [raw, setRaw] = useState(false);
	const id = useId();
	const label = renderer?.label?.(item) ?? item.label;
	const note = renderer?.note?.(item);
	return (
		<div
			className={`${call} kt-tool-${item.status}${open ? " kt-tool-open" : ""}${linked ? " kt-tool-linked" : ""}${item.streaming ? " kt-tool-streaming" : ""}`}
			data-call={item.callId}
		>
			<button
				type="button"
				className={row}
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span
					className={`kt-tool-icon inline-flex size-icon-md flex-none items-center justify-center ${iconTone(item.status)}`}
				>
					<Leading item={item} />
				</span>
				<span className={`${labelBase}${labelTone(item.status)}`}>{label}</span>
				<ClockTime at={item.at} className={stamp} />
				{/* Always there, as in T3 Code: the one hint that a row opens. */}
				<ChevronRightIcon
					size="sm"
					className={`kt-tool-chevron flex-none text-faint transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{note === undefined || open ? null : (
				// Why the call failed, in view without opening it, in line with the label.
				<p className="kt-tool-note m-0 mb-1 ml-[calc(var(--kt-icon-md)_+_var(--kt-step-2))] text-xs leading-normal text-status-error wrap-anywhere">
					{note}
				</p>
			)}
			{browserView ?? (images === "inline" ? <ToolImages item={item} /> : null)}
			{!open ? null : renderer?.detail === undefined ? (
				<Detail item={item} id={id} images={images === "detail"} thought={thought} />
			) : (
				<div id={id}>
					{renderer.detail({
						item,
						thought,
						raw: <Detail item={item} images={images === "detail"} />,
						showRaw: raw,
						onShowRawChange: setRaw,
					})}
				</div>
			)}
		</div>
	);
});

/** "Worked for 8s": from the first call's start to the last call's end. It says the time, never how many steps. */
export function workSummary(items: readonly ToolItem[]): string {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		start = Math.min(start, item.at);
		end = Math.max(end, item.endedAt ?? item.at);
	}
	return items.length === 0 ? "Worked" : `Worked for ${duration(end - start)}`;
}

export type ToolCallGroupProps = {
	items: readonly ToolItem[];
	live?: boolean;
	/**
	 * Live browser views, by the id of the call each goes under (see `ToolCallChipProps.browserView`). A folded group
	 * keeps its newest one in view under its summary, in place of the last screenshot.
	 */
	browserViews?: ReadonlyMap<string, ReactNode>;
	/**
	 * The ID of the call a link names (`#turn=`): a folded group opens to show it, and it stands out briefly. The group
	 * stays open once the call stops standing out.
	 */
	focus?: string;
	/**
	 * The group is in a finished turn whose work is folded under the turn's "Worked for" line (`TurnFold`), and that line
	 * is closed: none of its calls show, failed ones included; the turn's line marks those.
	 */
	folded?: boolean;
};

/** A call whose pictures are shown as cards of their own: `generate_image`'s, as the files it presented. */
export const imagesAsCards = (item: ToolItem): boolean =>
	item.name === "generate_image" && (item.files?.length ?? 0) > 0;

/**
 * Consecutive tool calls. While any call runs, or the group is live (the turn may add to it), every call shows.
 * Once all are finished, however few, they collapse to one "Worked for 8s" disclosure: as in T3 Code, the calls carry
 * no duration of their own, so the group's summary is the one place the time is told.
 * Failed and interrupted calls collapse with the rest; the closed summary carries an alert mark (`StepFailed`).
 */
export const ToolCallGroup = memo(function ToolCallGroup({
	items,
	live = false,
	browserViews,
	focus,
	folded = false,
}: ToolCallGroupProps) {
	const [open, setOpen] = useState(focus !== undefined);
	useEffect(() => {
		if (focus !== undefined) setOpen(true);
	}, [focus]);
	const running = items.some((item) => item.status === "running");
	const chip = (item: ToolItem) => (
		<ToolCallChip
			key={item.id}
			item={item}
			browserView={browserViews?.get(item.id)}
			linked={item.id === focus}
			{...(imagesAsCards(item) ? { images: "none" as const } : {})}
		/>
	);
	if (folded) return null;
	if (live || running || items.length === 0) {
		return <div className={toolGroup}>{items.map(chip)}</div>;
	}
	// A live browser view stays in view under the folded group, as the last screenshot would.
	const viewed = [...items].reverse().find((item) => browserViews?.has(item.id) === true);
	const view = viewed === undefined ? undefined : browserViews?.get(viewed.id);
	// The last picture the work left (such as the page a browser ended on) stays in view under the folded group.
	const lastWithImage = [...items].reverse().find((item) => !imagesAsCards(item) && (item.images?.length ?? 0) > 0);
	const lastImage = lastWithImage?.images?.at(-1);
	return (
		<div className={`${toolGroup} kt-tool-group-collapsible`}>
			<Disclosure
				className="kt-tool-group-summary"
				summary={workSummary(items)}
				trailing={open ? null : <StepFailed failed={items.some(isFailed)} />}
				open={open}
				onOpenChange={setOpen}
			>
				{items.map(chip)}
			</Disclosure>
			{!open && view !== undefined ? view : null}
			{!open && view === undefined && lastWithImage !== undefined && lastImage !== undefined ? (
				<Images item={lastWithImage} images={[lastImage]} grouped />
			) : null}
		</div>
	);
});
