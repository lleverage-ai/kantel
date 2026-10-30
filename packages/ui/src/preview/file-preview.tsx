import { ChevronLeft, ChevronRight, Download, Eye, FolderOpen, Maximize2, Minimize2, Pencil, X } from "lucide-react";
import {
	type ComponentType,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ShareButton, SharePopover, type SharePopoverProps, shareAnchor } from "../documents/share-popover.tsx";
import { IconButton } from "../primitives/button.tsx";
import { Skeleton, Spinner, skeletonClass } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import {
	clampWidth,
	neighbours,
	PREVIEW_WIDTH,
	type PreviewContent,
	type PreviewFile,
	previewTitle,
	textOf,
} from "./preview-model.ts";
import {
	loadBody,
	loadedBody,
	type PreviewBodyProps,
	type PreviewRenderer,
	rendererFor,
	rendererOf,
} from "./registry.ts";
import "./preview.css";

// The file preview: one panel for every file the console opens, from a card in the transcript, a file the agent
// presented or wrote, or the workspace browser. The chrome is the same for every kind (the kind's icon, the name and
// where it is, its size, Preview and Edit, Copy, Download, Share, Previous and Next, Close); only the body differs,
// drawn by the renderer the registry (registry.ts) picks for the file.
//
// It stays mounted while files change, so moving between them swaps the body without the panel sliding again, and
// a body whose code and bytes are here renders in the first frame. Presentational: the host reads the bytes (and
// caches them), saves edits and says where the file can be shared or revealed.

/** Whether the person's edits are saved. */
export type PreviewSaveState = "saved" | "saving" | "unsaved" | "failed";

export type FilePreviewProps = {
	/** The file shown. Undefined closes the panel (it slides out, then renders nothing). */
	file: PreviewFile | undefined;
	/** What the host has of its content. */
	content: PreviewContent;
	/** Closes the preview. Without it (a preview embedded in a page) there is no Close. */
	onClose?: (() => void) | undefined;
	/** The files Previous and Next move through (the session's presented files, a folder's), in order. */
	siblings?: readonly PreviewFile[] | undefined;
	/** Opens another file in the panel: Previous, Next, `j` and `k`. */
	onNavigate?: ((file: PreviewFile) => void) | undefined;
	/** Saves the file. Shown once its bytes are here. */
	onDownload?: (() => void) | undefined;
	/** Shows the file where it lives (the workspace browser), with what to call that. */
	reveal?: { readonly label: string; readonly run: () => void } | undefined;
	/** Share and Export, from a Share button in the header. Absent, there is no Share. */
	share?: Omit<SharePopoverProps, "title" | "onClose"> | undefined;
	/**
	 * Saves the person's edits; rejects when it couldn't (the file changed meanwhile, the request failed). With it, a
	 * text file offers Edit; edits save a moment after the person stops typing, at once on Cmd/Ctrl+S, and as the file
	 * closes.
	 */
	onSave?: ((text: string) => Promise<void>) | undefined;
	/**
	 * `overlay` (default) slides in at the right of its host and can be resized from its left edge, its width kept
	 * between visits; `docked` fills the pane its host gives it (the workspace browser's).
	 */
	layout?: "overlay" | "docked";
	/** Shows Back, on a phone, to return to wherever the file was opened from. */
	onBack?: (() => void) | undefined;
	/** The host's class for the panel's place in its layout. */
	className?: string;
	/** Called with the readable page's element (a document's), so a host can print what the person sees. */
	pageRef?: ((element: HTMLElement | null) => void) | undefined;
	/** Where the remembered width is kept. Defaults to one key for every overlay preview. */
	widthKey?: string;
};

const WIDTH_KEY = "harbour.preview.width";
/** How long after the last keystroke an edit is saved. */
const SAVE_AFTER_MS = 800;

const SAVE_LABELS: { readonly [state in PreviewSaveState]: string } = {
	saved: "Saved",
	saving: "Saving",
	unsaved: "Edited",
	failed: "Couldn't save",
};

const isEditable = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	(target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null);

function storedWidth(key: string): number {
	try {
		const stored = Number(localStorage.getItem(key));
		return stored > 0 ? clampWidth(stored) : PREVIEW_WIDTH.initial;
	} catch {
		return PREVIEW_WIDTH.initial;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Editing: the text being edited, saved after a pause, at once on request, and before the file changes or closes.

function useEdits(file: PreviewFile | undefined, onSave: FilePreviewProps["onSave"]) {
	const [saveState, setSaveState] = useState<PreviewSaveState>("saved");
	const [edited, setEdited] = useState<{ key: string; text: string }>();
	const pending = useRef<{ key: string; text: string; save: (text: string) => Promise<void> } | undefined>(undefined);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const queue = useRef<Promise<void>>(Promise.resolve());

	const flush = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = undefined;
		const next = pending.current;
		if (next === undefined) return;
		pending.current = undefined;
		queue.current = queue.current.then(async () => {
			setSaveState("saving");
			try {
				await next.save(next.text);
				setSaveState(pending.current === undefined ? "saved" : "unsaved");
			} catch {
				// A conflict or a failed request: the edits stay on the page, and the next one tries again.
				setSaveState("failed");
			}
		});
	}, []);

	const key = file?.key;
	// Another file, or none: whatever is pending for the last one is saved first.
	// biome-ignore lint/correctness/useExhaustiveDependencies: it runs again (and flushes) when the file changes.
	useEffect(() => {
		setSaveState("saved");
		return flush;
	}, [key, flush]);

	const onText = useCallback(
		(text: string) => {
			if (key === undefined || onSave === undefined) return;
			pending.current = { key, text, save: onSave };
			setEdited({ key, text });
			setSaveState("unsaved");
			clearTimeout(timer.current);
			timer.current = setTimeout(flush, SAVE_AFTER_MS);
		},
		[key, onSave, flush],
	);
	return { saveState, onText, flush, edited: edited !== undefined && edited.key === key ? edited.text : undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// The body: the renderer's component once its code is here, a placeholder shaped like it until then.

function Placeholder({ renderer, title }: { renderer: PreviewRenderer; title: string }) {
	const shape =
		renderer.kind === "image" || renderer.kind === "video" || renderer.kind === "pdf" ? (
			<div className="grid h-full place-items-center bg-sunken p-gutter">
				<span className={`${skeletonClass} aspect-4/3 w-3/4 max-w-doc`} />
			</div>
		) : renderer.kind === "markdown" || renderer.kind === "docx" ? (
			<div className="mx-auto flex w-full max-w-doc flex-col gap-3 px-gutter pt-8">
				<Skeleton width="55%" />
				<Skeleton width="92%" />
				<Skeleton width="85%" />
				<Skeleton lines={4} />
			</div>
		) : (
			<div className="flex flex-col gap-2.5 px-gutter pt-4">
				<Skeleton width="40%" />
				<Skeleton width="72%" />
				<Skeleton width="64%" />
				<Skeleton width="80%" />
				<Skeleton width="30%" />
			</div>
		);
	return (
		<div
			className="h-full animate-[hb-preview-fade_var(--hb-duration)_var(--hb-ease)_both] [animation-delay:var(--hb-duration-fast)]"
			aria-busy="true"
		>
			<span className="hb-sr-only">Loading {title}</span>
			{shape}
		</div>
	);
}

/** The renderer's body component, at once when its code has loaded before, else once it has. */
function useBody(renderer: PreviewRenderer): ComponentType<PreviewBodyProps> | undefined | Error {
	const [state, setState] = useState<{ kind: string; body: ComponentType<PreviewBodyProps> | Error }>();
	const ready = loadedBody(renderer.kind);
	useEffect(() => {
		if (ready !== undefined) return;
		let live = true;
		loadBody(renderer.kind).then(
			(body) => live && setState({ kind: renderer.kind, body }),
			(reason: unknown) =>
				live && setState({ kind: renderer.kind, body: reason instanceof Error ? reason : new Error(String(reason)) }),
		);
		return () => {
			live = false;
		};
	}, [renderer.kind, ready]);
	return ready ?? (state?.kind === renderer.kind ? state.body : undefined);
}

function Body({
	file,
	content,
	renderer,
	editing,
	onText,
	edited,
	onFacts,
}: {
	file: PreviewFile;
	content: PreviewContent;
	renderer: PreviewRenderer;
	editing: boolean;
	onText: ((text: string) => void) | undefined;
	edited: string | undefined;
	onFacts: (facts: readonly string[]) => void;
}) {
	const title = previewTitle(file);
	// Bytes that should be text but aren't (a binary with no extension) are shown as a file that can't be previewed.
	const decoded = useMemo(() => {
		if (content.status === "streaming") return { text: content.text, bytes: new Uint8Array() };
		if (content.status !== "ready") return undefined;
		if (renderer.content === "bytes") return { text: "", bytes: content.bytes };
		const text = textOf(content.bytes);
		return text === undefined ? { text: "", bytes: content.bytes, binary: true } : { text, bytes: content.bytes };
	}, [content, renderer.content]);
	const shown = decoded?.binary === true ? rendererOf("binary") : renderer;
	const Component = useBody(shown);

	if (content.status === "error") {
		return (
			<div className="px-gutter pt-6">
				<Notice level="error">{content.message}</Notice>
			</div>
		);
	}
	if (content.status === "too-large") {
		return (
			<EmptyState title="This file is too large to show here">
				{file.size === undefined
					? "It's more than the preview loads. Download it to open it."
					: `At ${formatBytes(file.size)}, it's more than the preview loads. Download it to open it.`}
			</EmptyState>
		);
	}
	if (Component instanceof Error) {
		return (
			<div className="px-gutter pt-6">
				<Notice level="error">{`The preview couldn't load: ${Component.message}`}</Notice>
			</div>
		);
	}
	if (decoded === undefined || Component === undefined) return <Placeholder renderer={shown} title={title} />;
	return (
		<Component
			file={file}
			bytes={decoded.bytes}
			text={edited ?? decoded.text}
			contentType={content.status === "ready" ? (content.contentType ?? file.mimeType ?? "") : (file.mimeType ?? "")}
			url={content.status === "ready" ? content.url : undefined}
			streaming={content.status === "streaming"}
			editing={editing}
			onText={onText}
			label={`Contents of ${title}`}
			onFacts={onFacts}
		/>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// The panel.

function SaveStatus({
	streaming,
	saveState,
	editing,
}: {
	streaming: boolean;
	saveState: PreviewSaveState;
	editing: boolean;
}) {
	const line = "inline-flex flex-none items-center gap-1.5 text-xs";
	if (streaming) {
		return (
			<span className={`${line} text-muted`} aria-live="polite">
				<Spinner size="sm" />
				Writing
			</span>
		);
	}
	if (!editing && saveState === "saved") return null;
	return (
		<span className={`${line} ${saveState === "failed" ? "text-status-error" : "text-muted"}`} aria-live="polite">
			{saveState === "saving" ? <Spinner size="sm" /> : null}
			{SAVE_LABELS[saveState]}
		</span>
	);
}

const icon = (Icon: ComponentType<{ className?: string; size?: number; strokeWidth?: number }>) => (
	<Icon className="hb-icon hb-icon-md" size={16} strokeWidth={1.5} aria-hidden="true" />
);

/**
 * A file in a panel that slides in from the right: its kind's icon, name, folder and size above the file drawn by its
 * renderer. Escape closes it (not while sharing); `j`/`k` and the arrow keys move between `siblings`; Cmd/Ctrl+S saves
 * while editing. Focus moves into the panel as it opens and back to where it was as it closes.
 */
export function FilePreview({
	file,
	content,
	onClose,
	siblings,
	onNavigate,
	onDownload,
	reveal,
	share,
	onSave,
	layout = "overlay",
	onBack,
	className = "",
	pageRef,
	widthKey = WIDTH_KEY,
}: FilePreviewProps) {
	const id = useId();
	// The file on screen: the one given, or while it slides out, the last one.
	const [shown, setShown] = useState(file);
	const [closing, setClosing] = useState(false);
	if (file !== undefined && (shown !== file || closing)) {
		setShown(file);
		setClosing(false);
	} else if (file === undefined && shown !== undefined && !closing) {
		// An overlay slides out; a docked preview gives its pane back at once.
		if (layout === "overlay") setClosing(true);
		else setShown(undefined);
	}
	const current = file ?? shown;
	const lastContent = useRef(content);
	if (file !== undefined) lastContent.current = content;
	const showing = file === undefined ? lastContent.current : content;

	const renderer = useMemo(
		() =>
			current === undefined
				? rendererOf("binary")
				: rendererFor(current, showing.status === "ready" ? showing.contentType : undefined),
		[current, showing],
	);
	const streaming = showing.status === "streaming";
	const canEdit = renderer.editable === true && onSave !== undefined && showing.status === "ready" && !streaming;
	// A document the agent wrote opens in Edit, as Claude Docs does; anything else opens in Preview.
	const [mode, setMode] = useState<{ key: string | undefined; editing: boolean }>({ key: undefined, editing: false });
	const editing = canEdit && (mode.key === current?.key ? mode.editing : current?.document === true);
	const setEditing = (next: boolean) => setMode({ key: current?.key, editing: next });

	const { saveState, onText, flush, edited } = useEdits(file, onSave);
	const [facts, setFacts] = useState<{ key: string | undefined; facts: readonly string[] }>({
		key: undefined,
		facts: [],
	});
	const key = current?.key;
	const onFacts = useCallback((next: readonly string[]) => setFacts({ key, facts: next }), [key]);
	const [sharing, setSharing] = useState(false);
	// Full screen: the panel covers its host. Kept while files change; Escape leaves it before it closes the panel.
	const [expanded, setExpanded] = useState(false);

	const place = useMemo(
		() =>
			neighbours(
				(siblings ?? []).map((each) => each.key),
				current?.key,
			),
		[siblings, current?.key],
	);
	const go = useCallback(
		(to: string | undefined) => {
			const target = to === undefined ? undefined : siblings?.find((each) => each.key === to);
			if (target !== undefined) onNavigate?.(target);
		},
		[siblings, onNavigate],
	);

	// Focus: into the panel as it opens, back where it came from as it closes.
	const panel = useRef<HTMLElement>(null);
	const returnTo = useRef<HTMLElement | null>(null);
	const open = file !== undefined;
	useLayoutEffect(() => {
		if (!open) {
			setExpanded(false);
			return;
		}
		const active = document.activeElement;
		// A file that opens on its own (the agent presented it) while the person types stays out of their way.
		if (isEditable(active)) return;
		if (!(active instanceof HTMLElement) || !panel.current?.contains(active)) {
			returnTo.current = active instanceof HTMLElement ? active : null;
			panel.current?.focus({ preventScroll: true });
		}
		return () => {
			const element = panel.current;
			const back = returnTo.current;
			if (element !== null && (element.contains(document.activeElement) || document.activeElement === document.body)) {
				if (back?.isConnected) back.focus({ preventScroll: true });
			}
		};
	}, [open]);

	// Keys: Escape anywhere (the composer's own Escape aside), the rest only with focus in the panel.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			const inside = panel.current?.contains(event.target as Node) === true;
			if (event.key === "Escape") {
				if (sharing || (!inside && isEditable(event.target))) return;
				if (expanded) {
					setExpanded(false);
					return;
				}
				if (onClose === undefined) return;
				flush();
				onClose();
				return;
			}
			if (!inside) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				if (!editing) return;
				event.preventDefault();
				flush();
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
			const scroller = event.target instanceof HTMLElement ? event.target : null;
			// The arrows scroll a body that's wider than the panel (code, a table); j and k always move.
			const sideways = scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
			if (event.key === "f") {
				event.preventDefault();
				setExpanded((now) => !now);
			} else if (event.key === "j" || (event.key === "ArrowRight" && !sideways)) {
				if (place.next === undefined) return;
				event.preventDefault();
				go(place.next);
			} else if (event.key === "k" || (event.key === "ArrowLeft" && !sideways)) {
				if (place.previous === undefined) return;
				event.preventDefault();
				go(place.previous);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, sharing, editing, expanded, flush, onClose, place, go]);

	// The width, as a share of the host: remembered, and dragged (or arrowed) from the panel's left edge.
	const [width, setWidth] = useState(() => (layout === "overlay" ? storedWidth(widthKey) : PREVIEW_WIDTH.initial));
	const commitWidth = useCallback(
		(next: number) => {
			const clamped = clampWidth(next);
			setWidth(clamped);
			try {
				localStorage.setItem(widthKey, String(Math.round(clamped * 1000) / 1000));
			} catch {
				// Private browsing: the width lasts as long as the page.
			}
		},
		[widthKey],
	);
	const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
		const element = panel.current;
		const host = element?.parentElement;
		if (element === null || element === undefined || host === null || host === undefined) return;
		event.preventDefault();
		const bounds = host.getBoundingClientRect();
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		let next = width;
		let frame = 0;
		const move = (moved: PointerEvent) => {
			next = clampWidth((bounds.right - moved.clientX) / bounds.width);
			cancelAnimationFrame(frame);
			// Straight onto the element, a frame at a time: no React render per pointer move.
			frame = requestAnimationFrame(() => element.style.setProperty("--hb-preview-share", `${next * 100}%`));
		};
		const end = () => {
			cancelAnimationFrame(frame);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			document.documentElement.removeAttribute("data-hb-resizing");
			commitWidth(next);
		};
		document.documentElement.setAttribute("data-hb-resizing", "");
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};

	if (current === undefined) return null;
	const title = previewTitle(current);
	const size = current.size ?? (showing.status === "ready" ? showing.bytes.byteLength : undefined);
	const bodyFacts = facts.key === current.key ? facts.facts : [];
	// The header is one line, the name and its kind, as Claude's is; where the file is and how big go in the name's
	// tooltip (and Reveal), never a second line.
	const tooltip = [
		current.path || title,
		size === undefined ? undefined : formatBytes(size),
		...bodyFacts,
		current.model === undefined ? undefined : `Made with ${current.model}`,
	]
		.filter((part) => part !== undefined)
		.join("\n");
	const Icon = renderer.icon;
	const style = (layout === "overlay" && !expanded ? { "--hb-preview-share": `${width * 100}%` } : {}) as CSSProperties;

	return (
		<aside
			ref={panel}
			// Slides in (and out) from the right (hb-preview-in/out, preview.css): transform and opacity only.
			className={`hb-preview relative flex h-full min-h-0 min-w-0 flex-col bg-canvas text-fg outline-none ${
				layout === "overlay" ? "border-l border-border" : "w-full flex-auto"
			} ${
				// Expanded, it covers its host (the transcript beside it, or the file tree), as a full-screen viewer does.
				expanded ? "hb-preview-expanded absolute! inset-0 z-(--hb-z-overlay) border-l-0" : ""
			} ${
				closing
					? "animate-[hb-preview-out_var(--hb-duration-fast)_var(--hb-ease)_forwards]"
					: "animate-[hb-preview-in_var(--hb-duration)_var(--hb-ease)]"
			} motion-reduce:animate-none ${className}`}
			style={style}
			tabIndex={-1}
			aria-labelledby={id}
			data-kind={renderer.kind}
			data-layout={layout}
			inert={closing || undefined}
			onAnimationEnd={(event) => {
				if (event.target === event.currentTarget && closing) {
					setShown(undefined);
					setClosing(false);
				}
			}}
		>
			{layout === "overlay" && !expanded ? (
				// biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA), not a rule between content.
				<div
					className="hb-preview-resize hb-focusable absolute inset-y-0 -left-1 z-1 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent"
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize the preview"
					aria-valuemin={Math.round(PREVIEW_WIDTH.min * 100)}
					aria-valuemax={Math.round(PREVIEW_WIDTH.max * 100)}
					aria-valuenow={Math.round(width * 100)}
					tabIndex={0}
					onPointerDown={onResizeStart}
					onDoubleClick={() => commitWidth(PREVIEW_WIDTH.initial)}
					onKeyDown={(event) => {
						const step = event.key === "ArrowLeft" ? 0.02 : event.key === "ArrowRight" ? -0.02 : 0;
						if (step === 0) return;
						event.preventDefault();
						event.stopPropagation();
						commitWidth(width + step);
					}}
				/>
			) : null}
			<header className="flex min-h-control-lg flex-none items-center gap-2 border-b border-border py-2 pr-2.5 pl-gutter">
				{onBack === undefined ? null : (
					<IconButton variant="ghost" label="Back" icon={icon(ChevronLeft)} onClick={onBack} className="-ml-2" />
				)}
				{/*
				 * One line: the icon, the name, then its kind, muted after a dot. Path and size are in the tooltip. Everything
				 * sits on the text's baseline. The icon and the dot have no text, so each one's baseline is its border box's
				 * bottom (margins don't move it): the icon is shifted 4px down, centring its 16px on the text's middle, and the
				 * dot 2px up, to the height a typed middle dot would have.
				 */}
				<h2
					id={id}
					className="m-0 flex min-w-0 flex-auto items-baseline gap-2 text-md leading-tight font-medium"
					title={tooltip}
				>
					<Icon
						className="hb-icon relative top-1 flex-none text-muted"
						size={16}
						strokeWidth={1.5}
						aria-hidden="true"
					/>
					{/* Short of room the name truncates; the kind keeps its width, up to two fifths of the line. */}
					<span className="min-w-0 truncate">{title}</span>
					<span className="flex max-w-2/5 flex-none items-baseline gap-2 overflow-hidden font-regular whitespace-nowrap text-muted">
						{/* The separator is drawn, not typed (no middle-dot strings), and hidden from screen readers. */}
						<span
							className="relative -top-0.5 inline-block size-0.5 flex-none rounded-full bg-current"
							aria-hidden="true"
						/>
						<span className="hb-sr-only">, </span>
						<span className="min-w-0 truncate">{renderer.label}</span>
					</span>
					<SaveStatus streaming={streaming} saveState={saveState} editing={editing} />
				</h2>
				<div className="flex flex-none items-center gap-0.5">
					{canEdit ? (
						<IconButton
							variant="ghost"
							label={editing ? "Stop editing" : "Edit"}
							icon={icon(editing ? Eye : Pencil)}
							aria-pressed={editing}
							onClick={() => {
								if (editing) flush();
								setEditing(!editing);
							}}
						/>
					) : null}
					{place.count > 1 && onNavigate !== undefined ? (
						<>
							<IconButton
								variant="ghost"
								label={`Previous file (${place.index + 1} of ${place.count})`}
								title="Previous file (k)"
								icon={icon(ChevronLeft)}
								disabled={place.previous === undefined}
								onClick={() => go(place.previous)}
							/>
							<IconButton
								variant="ghost"
								label={`Next file (${place.index + 1} of ${place.count})`}
								title="Next file (j)"
								icon={icon(ChevronRight)}
								disabled={place.next === undefined}
								onClick={() => go(place.next)}
							/>
						</>
					) : null}
					{reveal === undefined ? null : (
						<IconButton variant="ghost" label={reveal.label} icon={icon(FolderOpen)} onClick={reveal.run} />
					)}
					{share === undefined || streaming ? null : (
						<span className={shareAnchor}>
							<ShareButton iconOnly open={sharing} onToggle={() => setSharing((now) => !now)} />
							{sharing ? <SharePopover {...share} title={title} onClose={() => setSharing(false)} /> : null}
						</span>
					)}
					{onDownload === undefined || showing.status !== "ready" ? null : (
						<IconButton variant="ghost" label={`Download ${current.name}`} icon={icon(Download)} onClick={onDownload} />
					)}
					<IconButton
						variant="ghost"
						label={expanded ? "Exit full screen" : "Full screen"}
						title={expanded ? "Exit full screen (f)" : "Full screen (f)"}
						icon={icon(expanded ? Minimize2 : Maximize2)}
						aria-pressed={expanded}
						onClick={() => setExpanded(!expanded)}
					/>
					{onClose === undefined ? null : (
						<IconButton
							variant="ghost"
							label="Close the preview"
							title="Close (Esc)"
							icon={icon(X)}
							onClick={() => {
								flush();
								onClose();
							}}
						/>
					)}
				</div>
			</header>
			<div className="min-h-0 flex-auto" ref={pageRef}>
				<Body
					file={current}
					content={showing}
					renderer={renderer}
					editing={editing}
					onText={canEdit ? onText : undefined}
					edited={edited}
					onFacts={onFacts}
				/>
			</div>
		</aside>
	);
}

/** Saves bytes as a file in the browser, as Download does. */
export function saveFile(content: Uint8Array, name: string, type: string): void {
	const url = URL.createObjectURL(new Blob([content as Uint8Array<ArrayBuffer>], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
