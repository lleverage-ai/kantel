import {
	type ChangeEvent,
	type ClipboardEvent,
	type DragEvent,
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { IconButton } from "../primitives/button.tsx";
import {
	AlertIcon,
	FileIcon,
	PaperclipIcon,
	SendIcon,
	SteerIcon,
	StopIcon,
	XCircleIcon,
} from "../primitives/icons.tsx";
import { Kbd } from "../primitives/spinner.tsx";
import { AttachmentStrip, type AttachSource, type ComposerAttachment } from "./composer-attachments.tsx";
import { useComposerDock } from "./composer-dock.ts";
import {
	type AttachmentLimits,
	type ComposerState,
	capNudge,
	checkFiles,
	DEFAULT_PASTE_FOLD,
	type FontMetrics,
	foldsPaste,
	limitsSummary,
	type PasteFold,
	type PrimaryAction as PrimaryActionKind,
	pastedTextName,
	pastesInline,
	primaryAction,
	recall,
	rejectionMessage,
	shouldSend,
	sizesFieldByCss,
	submits,
} from "./composer-model.ts";
import { type ComposerModelOption, ModelPicker, selectedModel } from "./model-picker.tsx";
import "./composer.css";

export type { ComposerState } from "./composer-model.ts";

export type ComposerProps = {
	/** The draft, for a controlled composer. Pair with onChange. */
	value?: string;
	/** The first draft, for an uncontrolled composer, which clears itself after sending. */
	defaultValue?: string;
	onChange?: (value: string) => void;
	/**
	 * Sends the draft (trimmed) with its uploaded attachments. Also used to steer when onSteer is not given. The host
	 * takes the attachments out of the draft (`useComposerAttachments().take()` does).
	 */
	onSend: (text: string, attachments: readonly ComposerAttachment[]) => void;
	/** Sends the draft to a running agent, to steer it. */
	onSteer?: (text: string, attachments: readonly ComposerAttachment[]) => void;
	/** Stops the running agent. Without it, Stop shows disabled. */
	onStop?: () => void;
	/** `idle`: Send. `running`: Steer with a draft, Stop without. `sending`: a spinner. `disabled`: nothing works. */
	state: ComposerState;
	/** Why the composer is disabled, shown in the surface in muted text. */
	disabledReason?: string;
	placeholder?: string;
	/**
	 * Docked on the composer's top edge, in a tray that shares its glass: a question, an approval, a notice that a
	 * send failed. The composer never rests while there is one.
	 */
	banner?: ReactNode;
	/** In the toolbar after the model picker: hints such as ComposerSendHint, or the host's own controls. */
	footer?: ReactNode;
	autoFocus?: boolean;
	/** The field's accessible name. */
	label?: string;

	/** The models the session may use, from the host's catalogue. Without them there is no model picker. */
	models?: readonly ComposerModelOption[];
	/** The chosen model's id. Without it the catalogue's default shows as chosen. */
	model?: string;
	onModelChange?: (id: string) => void;

	/** The draft's attachments, as the host reports them. */
	attachments?: readonly ComposerAttachment[];
	/**
	 * Takes files from the picker, a drop or a paste, already checked against `attachmentLimits`. The host uploads
	 * them and adds them to `attachments`. Without it the composer takes no files: no paperclip, drop or file paste.
	 */
	onAttach?: (files: readonly File[], source: AttachSource) => void;
	onRemoveAttachment?: (id: string) => void;
	/** Retries a failed upload. Without it a failed attachment can only be removed. */
	onRetryAttachment?: (id: string) => void;
	/** What the host accepts. The composer turns away anything else, says why, and shows the limits by the paperclip. */
	attachmentLimits?: AttachmentLimits;
	/**
	 * When a paste becomes a pasted-text.txt attachment instead of going into the field. Defaults to 32 KiB or 80
	 * lines; `false` turns it off. Ctrl+Shift+V (Cmd+Shift+V) always pastes into the field. Needs onAttach.
	 */
	pasteFold?: PasteFold | false;

	/** Messages sent before, oldest first: Up in an empty field recalls the last, as a shell does. */
	history?: readonly string[];
	/** Typing or pasting anywhere on the page outside another field goes into the composer, as in T3 Code. */
	captureTyping?: boolean;
	/**
	 * Rest (fold to one line) whatever the transcript says, or never. Left out, the composer rests when the
	 * Transcript it's docked in is scrolled away from its end, and on a narrow screen when it's not in use.
	 */
	resting?: boolean;
};

const coarseQuery = "(pointer: coarse)";

function subscribeCoarse(listener: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const list = window.matchMedia(coarseQuery);
	list.addEventListener("change", listener);
	return () => list.removeEventListener("change", listener);
}

function readCoarse(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function"
		? window.matchMedia(coarseQuery).matches
		: false;
}

/** True under a coarse pointer (a touch screen), where the keyboard is usually a software one. */
function useCoarsePointer(): boolean {
	return useSyncExternalStore(subscribeCoarse, readCoarse, () => false);
}

/** Below this width the composer rests whenever it isn't in use, as T3 Code's does on a phone. In CSS pixels. */
const NARROW_PX = 640;

const utf8 = typeof TextEncoder === "undefined" ? undefined : new TextEncoder();
const byteLength = (text: string) => (utf8 === undefined ? text.length : utf8.encode(text).length);

/** True for an element typing into would be wrong to take over: a field, a control, a menu. */
function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return (
		target.closest("input, textarea, select, button, a[href], [role=dialog], [role=menu], [role=listbox]") !== null
	);
}

function hasFiles(event: DragEvent): boolean {
	return [...event.dataTransfer.types].includes("Files");
}

/**
 * The message box at the foot of a session, after T3 Code's composer: a glass surface with a field that grows to
 * about nine lines and then scrolls, a toolbar (model picker and host controls on the left, the paperclip and one
 * round primary action on the right) and attachments above the field.
 *
 * Docked in a Transcript (its `dock` prop) it floats over the transcript's foot, and rests, folding to one line,
 * while the reader scrolls back; focus or a return to the end brings it back. On a narrow screen it rests whenever
 * it isn't in use. Enter sends, Shift+Enter is a new line, and a software keyboard's Enter is a new line. Questions
 * and approvals dock on its top edge through `banner`.
 *
 * The library never uploads: files go to the host through `onAttach`, and the host reports them in `attachments`.
 */
export function Composer({
	value,
	defaultValue,
	onChange,
	onSend,
	onSteer,
	onStop,
	state,
	disabledReason,
	placeholder = "Ask anything",
	banner,
	footer,
	autoFocus = false,
	label = "Message",
	models,
	model,
	onModelChange,
	attachments = [],
	onAttach,
	onRemoveAttachment,
	onRetryAttachment,
	attachmentLimits = {},
	pasteFold = DEFAULT_PASTE_FOLD,
	history,
	captureTyping = false,
	resting,
}: ComposerProps) {
	const [draft, setDraft] = useState(defaultValue ?? "");
	const controlled = value !== undefined;
	const text = controlled ? value : draft;
	const root = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const coarse = useCoarsePointer();
	const dock = useComposerDock();
	const ids = useId();
	const reasonId = `${ids}-reason`;
	const noteId = `${ids}-note`;
	const disabled = state === "disabled";
	const showReason = disabled && disabledReason !== undefined && disabledReason !== "";
	// Disabled with a reason and nothing typed, the composer is one line: the reason and the action. An empty field,
	// or an invitation to type, beside the reason would contradict it. A draft always stays visible.
	const folded = showReason && text === "";
	const hasBanner = banner !== undefined && banner !== null && banner !== false;

	// Models.
	const chosen = models === undefined || models.length === 0 ? undefined : selectedModel(models, model);
	const showModels = models !== undefined && models.length > 0 && onModelChange !== undefined;

	// Attachments, and what stops the draft going.
	const ready = useMemo(() => attachments.filter((attachment) => attachment.status === "ready"), [attachments]);
	const uploading = attachments.some((attachment) => attachment.status === "uploading");
	const failed = attachments.some((attachment) => attachment.status === "failed");
	const images = attachments.some((attachment) => attachment.kind === "image");
	const blindModel = images && chosen?.capabilities?.images === false;
	const blockedBy = blindModel
		? `${chosen?.label} can't read images. Choose another model or remove the image.`
		: failed
			? "An attachment didn't upload. Retry it or remove it."
			: uploading
				? "Waiting for the attachments to upload."
				: undefined;
	const action = primaryAction(state, text, { readyAttachments: ready.length, blocked: blockedBy !== undefined });

	// Files turned away, and announcements for a screen reader.
	const [rejected, setRejected] = useState("");
	const [announcement, setAnnouncement] = useState("");

	// Resting: focus, the picker and a wrapped draft keep the composer expanded.
	const [focused, setFocused] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [wraps, setWraps] = useState(false);
	const [dragDepth, setDragDepth] = useState(0);
	const draggingHere = dragDepth > 0;
	const dragging = draggingHere || (dock?.dragging ?? false);
	const multiline = text.includes("\n") || wraps;
	const restWanted = resting ?? ((dock?.resting ?? false) || narrow);
	// Nor does anything that needs the reader to act: a failed upload, an image the model can't read, a file turned away.
	const needsAction = failed || blindModel || rejected !== "";
	const rest =
		restWanted &&
		!focused &&
		!menuOpen &&
		!multiline &&
		!hasBanner &&
		!folded &&
		!dragging &&
		!disabled &&
		!needsAction;

	// Prompt history: where the draft came from, -1 for a fresh one.
	const historyPosition = useRef(-1);
	const caretToEnd = useRef(false);
	const inlinePaste = useRef(false);

	const setText = useCallback(
		(next: string) => {
			if (!controlled) setDraft(next);
			onChange?.(next);
		},
		[controlled, onChange],
	);

	// Height: CSS sizes the field where it can (field-sizing: content); elsewhere it's measured on every change.
	const cssSizing = useMemo(() => sizesFieldByCss(typeof CSS === "undefined" ? undefined : CSS), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: coarse changes the type size, so the field is measured again.
	useLayoutEffect(() => {
		const element = field.current;
		if (element === null) return;
		if (!cssSizing) {
			element.style.height = "";
			if (!rest) {
				element.style.height = "auto";
				element.style.height = `${element.scrollHeight}px`;
			}
		}
		// A single line that wraps keeps the composer expanded, as a line break does. Measured only while expanded:
		// resting, the field is one line by construction. Re-measured when the type size changes with the pointer.
		if (!rest) {
			const line = Number.parseFloat(getComputedStyle(element).lineHeight);
			const next = text !== "" && Number.isFinite(line) && element.scrollHeight > line * 1.5 + 8;
			setWraps((current) => (current === next ? current : next));
		}
		if (caretToEnd.current) {
			caretToEnd.current = false;
			element.setSelectionRange(element.value.length, element.value.length);
		}
	}, [text, coarse, rest, cssSizing]);

	// Resting, the one-line field's words sit level with the buttons beside them, on the middle of their capitals. A
	// field's text can't be trimmed to its capitals as a label's is, so its font is measured (once, and again when
	// web fonts finish loading or the type size changes) and the field moved by the difference: --hb-composer-nudge.
	// biome-ignore lint/correctness/useExhaustiveDependencies: coarse changes the type size, so the font is measured again.
	useLayoutEffect(() => {
		const element = field.current;
		const box = root.current;
		if (!rest || element === null || box === null) return;
		const measure = () => box.style.setProperty("--hb-composer-nudge", `${capNudge(fontMetrics(element))}px`);
		measure();
		let live = true;
		document.fonts?.ready.then(() => {
			if (live) measure();
		});
		return () => {
			live = false;
		};
	}, [rest, coarse]);

	// Width: narrow screens rest while the composer isn't in use.
	useEffect(() => {
		const element = root.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? element.clientWidth;
			setNarrow(width > 0 && width < NARROW_PX);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// Also when the field appears: a composer mounted disabled (folded) takes focus once it can be typed in.
	useEffect(() => {
		if (autoFocus && !folded) field.current?.focus();
	}, [autoFocus, folded]);

	const focusField = useCallback(() => field.current?.focus(), []);

	// Focus anywhere in the composer (the field, the picker, a chip's button) keeps it expanded, and brings a
	// resting one back for good: scrolling away again rests it again.
	const onFocus = () => {
		setFocused(true);
		dock?.wake();
	};
	const onBlur = (event: FocusEvent<HTMLDivElement>) => {
		if (root.current?.contains(event.relatedTarget as Node | null)) return;
		setFocused(false);
	};

	// A press on the surface outside a control puts the caret in the field, as clicking anywhere in T3 Code's does.
	const onSurfaceDown = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (target === field.current || target.closest("button, a, input, textarea, [role=dialog]") !== null) return;
		if (disabled || field.current === null) return;
		event.preventDefault();
		field.current.focus();
	};

	// Files in: check them against the limits, hand the rest to the host, say what was turned away.
	const take = useCallback(
		(files: readonly File[], source: AttachSource) => {
			if (onAttach === undefined || files.length === 0) return;
			const { accepted, rejected: turnedAway } = checkFiles(files, attachmentLimits, attachments.length);
			setRejected(rejectionMessage(turnedAway));
			if (accepted.length === 0) return;
			onAttach(accepted, source);
			setAnnouncement(accepted.length === 1 ? `Attached ${accepted[0]?.name}.` : `Attached ${accepted.length} files.`);
		},
		[onAttach, attachmentLimits, attachments.length],
	);

	// Drops anywhere on the transcript come here while docked.
	const limitsText = limitsSummary(attachmentLimits);
	const takeRef = useRef(take);
	takeRef.current = take;
	const canAttach = onAttach !== undefined && !disabled;
	// Keyed on the stable registration function, not the whole dock, which changes as it rests and drags.
	const acceptDrops = dock?.acceptDrops;
	useEffect(() => {
		if (acceptDrops === undefined || !canAttach) return;
		return acceptDrops((files) => takeRef.current(files, "drop"), limitsText);
	}, [acceptDrops, canAttach, limitsText]);

	const change = (event: ChangeEvent<HTMLTextAreaElement>) => {
		historyPosition.current = -1;
		if (rejected !== "") setRejected("");
		setText(event.target.value);
	};

	const submit = useCallback(() => {
		if (!submits(action)) return;
		const message = text.trim();
		if (action === "steer") (onSteer ?? onSend)(message, ready);
		else onSend(message, ready);
		historyPosition.current = -1;
		setRejected("");
		if (!controlled) setDraft("");
		field.current?.focus();
	}, [action, text, ready, onSend, onSteer, controlled]);

	const stop = () => {
		onStop?.();
		field.current?.focus();
	};

	const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const native = event.nativeEvent;
		if (pastesInline(event)) inlinePaste.current = true;
		if (history !== undefined && history.length > 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			const element = event.currentTarget;
			const next = recall({
				key: event.key,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				isComposing: native.isComposing,
				text,
				selectionStart: element.selectionStart,
				selectionEnd: element.selectionEnd,
				position: historyPosition.current,
				history,
				attachments: attachments.length,
			});
			if (next !== undefined) {
				event.preventDefault();
				historyPosition.current = next.position;
				caretToEnd.current = true;
				setText(next.text);
				return;
			}
		}
		const sends = shouldSend(
			{
				key: event.key,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				isComposing: native.isComposing,
				keyCode: native.keyCode,
			},
			coarse,
		);
		if (!sends) return;
		// Enter never inserts a new line where it would send, even when there is nothing to send yet.
		event.preventDefault();
		submit();
	};

	// Paste: files from the clipboard (a screenshot) become attachments; a long text becomes pasted-text.txt.
	const foldPaste = useCallback(
		(pasted: string): boolean => {
			if (onAttach === undefined || pasteFold === false) return false;
			if (!foldsPaste(pasted, pasteFold, byteLength)) return false;
			const name = pastedTextName(attachments.map((attachment) => attachment.name));
			take([new File([pasted], name, { type: "text/plain;charset=utf-8" })], "paste");
			return true;
		},
		[onAttach, pasteFold, attachments, take],
	);

	const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const inline = inlinePaste.current;
		inlinePaste.current = false;
		if (onAttach === undefined) return;
		const files = [...event.clipboardData.files];
		if (files.length > 0) {
			event.preventDefault();
			take(files, "paste");
			return;
		}
		if (inline) return;
		if (foldPaste(event.clipboardData.getData("text/plain"))) event.preventDefault();
	};

	// Type or paste anywhere: the composer takes keys and pastes nothing else on the page wants.
	const textRef = useRef(text);
	textRef.current = text;
	useEffect(() => {
		if (!captureTyping || disabled) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
			if (event.key.length !== 1 || event.key === " " || ownsKeys(event.target)) return;
			if (field.current === null || document.activeElement === field.current) return;
			event.preventDefault();
			caretToEnd.current = true;
			setText(textRef.current + event.key);
			field.current.focus();
		};
		const onPaste = (event: globalThis.ClipboardEvent) => {
			if (event.defaultPrevented || ownsKeys(event.target) || field.current === null) return;
			const pasted = event.clipboardData?.getData("text/plain") ?? "";
			if (pasted === "" || (event.clipboardData?.files.length ?? 0) > 0) return;
			event.preventDefault();
			field.current.focus();
			if (foldPaste(pasted)) return;
			caretToEnd.current = true;
			setText(textRef.current + pasted);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("paste", onPaste);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("paste", onPaste);
		};
	}, [captureTyping, disabled, setText, foldPaste]);

	// Dragging files over the composer itself (when it's docked, the transcript handles drops for it).
	const dragHandlers =
		canAttach && dock === null
			? {
					onDragEnter: (event: DragEvent<HTMLDivElement>) => {
						if (!hasFiles(event)) return;
						event.preventDefault();
						setDragDepth((depth) => depth + 1);
					},
					onDragOver: (event: DragEvent<HTMLDivElement>) => {
						if (!hasFiles(event)) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					},
					onDragLeave: (event: DragEvent<HTMLDivElement>) => {
						if (!hasFiles(event)) return;
						setDragDepth((depth) => Math.max(0, depth - 1));
					},
					onDrop: (event: DragEvent<HTMLDivElement>) => {
						if (!hasFiles(event)) return;
						event.preventDefault();
						setDragDepth(0);
						take([...event.dataTransfer.files], "drop");
					},
				}
			: {};

	const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
		take([...(event.target.files ?? [])], "picker");
		// The same file can be picked again after it's removed.
		event.target.value = "";
		field.current?.focus();
	};

	const note = blindModel
		? { level: "warning" as const, text: blockedBy }
		: rejected !== ""
			? { level: "error" as const, text: rejected }
			: undefined;

	const hasControls = !showReason && (showModels || (footer !== undefined && footer !== null));
	const attachTitle = limitsText === "" ? "Attach files" : `Attach files. ${limitsText}.`;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: focus bubbling from the controls inside, and a pointer-only file drop (the paperclip is the keyboard's way).
		<div
			ref={root}
			className={`hb-composer hb-composer-${state}`}
			data-rest={rest || undefined}
			data-folded={folded || undefined}
			data-dragging={dragging || undefined}
			data-controls={hasControls || undefined}
			onFocus={onFocus}
			onBlur={onBlur}
			{...dragHandlers}
		>
			{hasBanner ? <div className="hb-composer-banner">{banner}</div> : null}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a press on the surface's padding focuses the field. */}
			<div className="hb-composer-surface" data-focus-surface="" onMouseDown={onSurfaceDown}>
				<div className="hb-composer-body">
					{rest ? (
						<RestingAttachments attachments={attachments} />
					) : (
						<AttachmentStrip
							attachments={attachments}
							onRemove={onRemoveAttachment}
							onRetry={onRetryAttachment}
							disabled={disabled}
						/>
					)}
					{note === undefined || rest ? null : (
						<p
							id={noteId}
							className={`hb-composer-note hb-composer-note-${note.level}`}
							role={note.level === "error" ? "alert" : "status"}
						>
							{note.level === "error" ? <XCircleIcon size="sm" /> : <AlertIcon size="sm" />}
							<span>{note.text}</span>
						</p>
					)}
					{folded ? (
						<p id={reasonId} className="hb-composer-reason">
							<span className="hb-composer-reason-text">{disabledReason}</span>
						</p>
					) : (
						<textarea
							ref={field}
							className="hb-composer-input"
							rows={1}
							value={text}
							onChange={change}
							onKeyDown={keyDown}
							onPaste={paste}
							placeholder={showReason ? undefined : placeholder}
							aria-label={label}
							aria-describedby={
								[showReason ? reasonId : undefined, note ? noteId : undefined].filter(Boolean).join(" ") || undefined
							}
							disabled={disabled}
							enterKeyHint={coarse ? "enter" : "send"}
							wrap={rest ? "off" : "soft"}
						/>
					)}
				</div>
				<div className="hb-composer-bar">
					{showReason && !folded ? (
						<p id={reasonId} className="hb-composer-reason">
							<span className="hb-composer-reason-text">{disabledReason}</span>
						</p>
					) : hasControls ? (
						<div className="hb-composer-controls">
							{showModels && models !== undefined && onModelChange !== undefined ? (
								<ModelPicker
									models={models}
									value={model}
									onChange={onModelChange}
									disabled={disabled}
									size={rest ? "xs" : "sm"}
									onOpenChange={setMenuOpen}
									returnFocus={focusField}
								/>
							) : null}
							{footer}
						</div>
					) : null}
					<div className="hb-composer-actions">
						{onAttach === undefined ? null : (
							<>
								<IconButton
									className="hb-composer-attach"
									variant="ghost"
									label="Attach files"
									title={attachTitle}
									icon={<PaperclipIcon />}
									onClick={() => fileInput.current?.click()}
									disabled={disabled}
								/>
								<input
									ref={fileInput}
									className="hb-sr-only"
									type="file"
									multiple
									tabIndex={-1}
									aria-hidden="true"
									accept={attachmentLimits.accept?.join(",")}
									onChange={pickFiles}
								/>
							</>
						)}
						<PrimaryAction
							action={action}
							onSubmit={submit}
							onStop={onStop === undefined ? undefined : stop}
							reason={blockedBy}
						/>
					</div>
				</div>
				{draggingHere ? (
					<div className="hb-composer-drop" aria-hidden="true">
						<span className="hb-composer-drop-label">Drop files to attach</span>
						{limitsText === "" ? null : <span className="hb-composer-drop-limits">{limitsText}</span>}
					</div>
				) : null}
			</div>
			<p className="hb-sr-only" role="status" aria-live="polite">
				{announcement}
			</p>
		</div>
	);
}

/** An element's font's metrics, from canvas. Undefined where there is no canvas (a test, the server). */
function fontMetrics(element: Element): FontMetrics | undefined {
	const context = document.createElement("canvas").getContext?.("2d");
	if (context === null || context === undefined) return undefined;
	const style = getComputedStyle(element);
	context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const metrics = context.measureText("H");
	return {
		ascent: metrics.fontBoundingBoxAscent,
		descent: metrics.fontBoundingBoxDescent,
		capHeight: metrics.actualBoundingBoxAscent,
	};
}

/** Resting, attachments show as up to three small squares and a count, beside the one-line field. */
function RestingAttachments({ attachments }: { attachments: readonly ComposerAttachment[] }) {
	if (attachments.length === 0) return null;
	const shown = attachments.slice(0, 3);
	const more = attachments.length - shown.length;
	return (
		<span className="hb-composer-rest-attachments" aria-label={`${attachments.length} attached`} role="img">
			{shown.map((attachment) =>
				attachment.kind === "image" && attachment.previewUrl ? (
					<img key={attachment.id} className="hb-composer-rest-thumb" src={attachment.previewUrl} alt="" />
				) : (
					<span key={attachment.id} className="hb-composer-rest-thumb">
						<FileIcon size="sm" />
					</span>
				),
			)}
			{more > 0 ? <span className="hb-composer-rest-more">+{more}</span> : null}
		</span>
	);
}

/** The round button at the composer's bottom right. One element whatever the action, so focus survives a change. */
function PrimaryAction({
	action,
	onSubmit,
	onStop,
	reason,
}: {
	action: PrimaryActionKind;
	onSubmit: () => void;
	onStop: (() => void) | undefined;
	reason: string | undefined;
}) {
	switch (action) {
		case "stop":
			return (
				<IconButton
					className="hb-composer-action hb-composer-action-stop"
					size="md"
					variant="danger"
					label="Stop"
					icon={<StopIcon size="sm" />}
					onClick={onStop}
					disabled={onStop === undefined}
				/>
			);
		case "steer":
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Steer"
					title="Send to the running agent"
					icon={<SteerIcon />}
					onClick={onSubmit}
				/>
			);
		case "busy":
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Sending"
					icon={<SendIcon />}
					busy
				/>
			);
		default:
			return (
				<IconButton
					className="hb-composer-action"
					size="md"
					variant="primary"
					label="Send"
					title={action === "send-empty" && reason !== undefined ? reason : "Send"}
					icon={<SendIcon />}
					onClick={onSubmit}
					disabled={action !== "send"}
				/>
			);
	}
}

/**
 * The footer hint "Enter to send", hidden under a coarse pointer, where Enter is a new line and the button sends.
 */
export function ComposerSendHint() {
	return (
		<span className="hb-composer-hint">
			<Kbd>Enter</Kbd>
			<span>to send</span>
		</span>
	);
}
