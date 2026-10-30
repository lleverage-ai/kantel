import type { ToolImage, ToolItem } from "@harbour/protocol";
import { memo, type ReactNode, useContext, useEffect, useId, useState } from "react";
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
import { useRenderProbe } from "../primitives/probe.ts";
import { Spinner } from "../primitives/spinner.tsx";
import { ClockTime } from "../primitives/time.tsx";
import { ToolRenderersContext, toolRenderers } from "./tool-renderer-model.ts";
import { codingToolRenderers } from "./tool-views.tsx";
import "./tool-call.css";

// A tool call as one quiet work-log line, after T3 Code's work-log row (TimelineWorkEntryRow.tsx, WorkLog.tsx at
// 1152e917): an icon that says what kind of call it was, the host's plain-words label ("Ran pnpm test", "Read
// src/billing/charge.ts") and a chevron. Like T3, a call shows no duration of its own: when it started appears on
// hover or focus, and how long the work took is said once for the group ("Worked for 8s"). The arguments and output
// are one tap away and rendered only while open; nothing about a call shouts while it runs, though its label is at
// full strength (see tool-call.css) so the call happening now is read before the finished ones.
//
// A tool with an entry in the transcript's renderer registry (tool-renderer-model.ts) can have its own label, its own
// detail and start open; one that renders in place never reaches a row here. The file and shell tools (write, read,
// edit, bash) have one (`codingToolRenderers`, tool-views.tsx): they open to a card of their own, the file as an editor
// shows it, the edit as a diff, the command as a terminal, growing as the model writes the call, with their raw
// arguments and output one switch away. Outside a transcript (a story, a host's own list of calls) a row uses those.
const OUTSIDE_A_TRANSCRIPT = toolRenderers(codingToolRenderers);

type IconComponent = (props: IconProps) => ReactNode;

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

function Leading({ item }: { item: ToolItem }) {
	switch (item.status) {
		case "running":
			return (
				<>
					<Spinner />
					<span className="hb-sr-only">Running</span>
				</>
			);
		case "error":
			return <XCircleIcon label="Failed" className="hb-tool-status" />;
		case "interrupted":
			return <MinusCircleIcon label="Interrupted" className="hb-tool-status" />;
		default: {
			const Icon = toolIcon(item.name);
			return <Icon />;
		}
	}
}

function Detail({ item, id, images }: { item: ToolItem; id?: string; images: boolean }) {
	const args = formatArgs(item.args);
	const running = item.status === "running";
	const output = item.output ?? "";
	return (
		<div id={id} className="hb-tool-detail">
			{images && (item.images?.length ?? 0) > 0 ? (
				<div className="hb-tool-section">
					<div className="hb-tool-section-label">{item.images?.length === 1 ? "Screenshot" : "Screenshots"}</div>
					<ToolImages item={item} />
				</div>
			) : null}
			{args === undefined ? null : (
				<div className="hb-tool-section">
					<div className="hb-tool-section-label">{args.label}</div>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard. */}
					<pre className="hb-tool-pre hb-selectable hb-focusable" tabIndex={0}>
						<Code code={args.text} language={args.language} />
					</pre>
				</div>
			)}
			<div className="hb-tool-section">
				<div className="hb-tool-section-label">
					{running ? "Output so far" : item.status === "error" ? "Error" : "Output"}
				</div>
				{output === "" ? (
					<p className="hb-tool-empty">{running ? "Waiting for output" : "No output"}</p>
				) : (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					<pre className="hb-tool-pre hb-tool-output hb-selectable hb-focusable" tabIndex={0}>
						{running || item.status === "error" ? output : <Code code={output} language={outputLanguage(item)} />}
					</pre>
				)}
			</div>
		</div>
	);
}

/** A tool image as a URL an `<img>` can show. Only the protocol's raster types reach here. */
export function toolImageSrc(image: ToolImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
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
	if (images.length === 0) return null;
	return (
		<div className="hb-tool-images">
			{images.map((image, index) => {
				const src = toolImageSrc(image);
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: a call's images never reorder.
						key={index}
						type="button"
						className="hb-tool-image hb-focusable"
						title="Open full size"
						onClick={() => openImage(image)}
					>
						<img src={src} alt={imageAlt(item, index, images.length)} loading="lazy" decoding="async" />
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
function openImage(image: ToolImage): void {
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
}: ToolCallChipProps) {
	useRenderProbe("ToolCallChip", item.id);
	const renderer = (useContext(ToolRenderersContext) ?? OUTSIDE_A_TRANSCRIPT).get(item.name);
	const [open, setOpen] = useState(() => defaultOpen || renderer?.openByDefault?.(item) === true);
	// The detail's switch to the raw arguments and output, kept here so it stays as left when the row closes and opens.
	const [raw, setRaw] = useState(false);
	const id = useId();
	const label = renderer?.label?.(item) ?? item.label;
	return (
		<div
			className={`hb-tool hb-tool-${item.status}${open ? " hb-tool-open" : ""}${linked ? " hb-tool-linked" : ""}${item.streaming ? " hb-tool-streaming" : ""}`}
			data-call={item.callId}
		>
			<button
				type="button"
				className="hb-tool-row hb-focusable"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="hb-tool-icon">
					<Leading item={item} />
				</span>
				<span className="hb-tool-label">{label}</span>
				<ClockTime at={item.at} className="hb-tool-stamp" />
				<ChevronRightIcon size="sm" className="hb-tool-chevron" />
			</button>
			{browserView ?? (images === "inline" ? <ToolImages item={item} /> : null)}
			{!open ? null : renderer?.detail === undefined ? (
				<Detail item={item} id={id} images={images === "detail"} />
			) : (
				<div id={id}>
					{renderer.detail({
						item,
						raw: <Detail item={item} images={images === "detail"} />,
						showRaw: raw,
						onShowRawChange: setRaw,
					})}
				</div>
			)}
		</div>
	);
});

/** "Worked for 8s, 4 steps": from the first call's start to the last call's end. */
export function workSummary(items: readonly ToolItem[]): string {
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		start = Math.min(start, item.at);
		end = Math.max(end, item.endedAt ?? item.at);
	}
	const steps = items.length === 1 ? "1 step" : `${items.length} steps`;
	return items.length === 0 ? "No steps" : `Worked for ${duration(end - start)}, ${steps}`;
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
	 * is closed: only its failed and interrupted calls show, so a failure is never hidden.
	 */
	folded?: boolean;
};

/** A call whose pictures are shown as cards of their own: `generate_image`'s, as the files it presented. */
export const imagesAsCards = (item: ToolItem): boolean =>
	item.name === "generate_image" && (item.files?.length ?? 0) > 0;

/**
 * Consecutive tool calls. While any call runs, or the group is live (the turn may add to it), every call shows.
 * Once all are finished, however few, they collapse to one "Worked for 8s, 4 steps" disclosure: as in T3 Code, the
 * calls carry no duration of their own, so the group's summary is the one place the time is told.
 * Failed and interrupted calls stay visible under the summary while it is collapsed, so a failure is never hidden.
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
	const failed = items.filter(isFailed);
	if (folded) return failed.length === 0 ? null : <div className="hb-tool-group">{failed.map(chip)}</div>;
	if (live || running || items.length === 0) {
		return <div className="hb-tool-group">{items.map(chip)}</div>;
	}
	// A live browser view stays in view under the folded group, as the last screenshot would.
	const viewed = [...items].reverse().find((item) => browserViews?.has(item.id) === true);
	const view = viewed === undefined ? undefined : browserViews?.get(viewed.id);
	// The last picture the work left (such as the page a browser ended on) stays in view under the folded group.
	const lastWithImage = [...items].reverse().find((item) => !imagesAsCards(item) && (item.images?.length ?? 0) > 0);
	const lastImage = lastWithImage?.images?.at(-1);
	return (
		<div className="hb-tool-group hb-tool-group-collapsible">
			<Disclosure className="hb-tool-group-summary" summary={workSummary(items)} open={open} onOpenChange={setOpen}>
				{items.map(chip)}
			</Disclosure>
			{!open && failed.length > 0 ? <div className="hb-tool-group-failed">{failed.map(chip)}</div> : null}
			{!open && view !== undefined && viewed !== undefined && !failed.includes(viewed) ? view : null}
			{!open &&
			view === undefined &&
			lastWithImage !== undefined &&
			lastImage !== undefined &&
			!failed.includes(lastWithImage) ? (
				<ToolImages item={lastWithImage} images={[lastImage]} />
			) : null}
		</div>
	);
});
