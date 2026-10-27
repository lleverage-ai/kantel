// The composer's decisions, as pure functions so they can be tested without a DOM: which primary action the button
// shows, whether a key press sends, when the docked composer rests, which files it takes and when a paste becomes an
// attachment. After T3 Code (pingdotgg/t3code@1152e9171a9ce6ede20e0cc1f16ed0dbe103da9b): ComposerPrimaryActions.tsx,
// composer-logic.ts, composerScrollGesture.ts, composerPromptHistory.ts, composerAttachmentFiles.ts and
// packages/client-runtime/src/textPaste.ts.

/** What the session lets the composer do. */
export type ComposerState = "idle" | "running" | "sending" | "disabled";

/**
 * The composer's one primary action.
 * - `send`: idle with something to send.
 * - `send-empty`: idle with nothing to send, or with something that can't go yet (an upload still running); Send
 *   shows, disabled.
 * - `steer`: the agent is running and there is something to send; sending it steers the run.
 * - `stop`: the agent is running and the draft is empty; the button stops the run.
 * - `busy`: a message is on its way; a spinner, not clickable.
 * - `disabled`: the composer can't be used right now; Send shows, disabled.
 */
export type PrimaryAction = "send" | "send-empty" | "steer" | "stop" | "busy" | "disabled";

/** True when the draft has something other than whitespace in it. */
export function hasText(text: string): boolean {
	return text.trim().length > 0;
}

/** What else, besides the text, decides the primary action. */
export type DraftExtras = {
	/** Attachments that are uploaded and ready to send. They count as something to send, without text. */
	readyAttachments?: number;
	/** Something stops the draft going yet: an upload still running or failed, a model that can't take an image. */
	blocked?: boolean;
};

/** The primary action for a state and a draft. */
export function primaryAction(state: ComposerState, text: string, extras: DraftExtras = {}): PrimaryAction {
	const content = hasText(text) || (extras.readyAttachments ?? 0) > 0;
	const sendable = content && extras.blocked !== true;
	switch (state) {
		case "sending":
			return "busy";
		case "disabled":
			return "disabled";
		case "running":
			// With something in the draft the button is Steer, even while it's blocked: Stop would throw the draft's
			// meaning away. Blocked, Steer shows disabled.
			if (content) return sendable ? "steer" : "send-empty";
			return "stop";
		case "idle":
			return sendable ? "send" : "send-empty";
	}
}

/** True for the actions that hand the draft to the session (onSend or onSteer). */
export function submits(action: PrimaryAction): action is "send" | "steer" {
	return action === "send" || action === "steer";
}

/** The part of the global `CSS` object the composer reads. Undefined outside a browser (a test, the server). */
export type CssLike = { supports?: (property: string, value: string) => boolean } | undefined;

/**
 * Whether the browser sizes a textarea to its text by itself (`field-sizing: content`, Chromium 123 and later), so
 * the composer can leave its height to CSS rather than measure it on every keystroke. False where it can't tell.
 */
export function sizesFieldByCss(css: CssLike): boolean {
	return typeof css?.supports === "function" && css.supports("field-sizing", "content");
}

/** The parts of a keyboard event the composer reads. A React KeyboardEvent's fields, with the native ones lifted. */
export type KeyLike = {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	/** The native event's isComposing: true while an IME is composing (Japanese, Chinese, Korean input). */
	isComposing?: boolean;
	/** The native keyCode; 229 means an IME has the key. */
	keyCode?: number;
};

/**
 * Whether a key press sends the draft.
 * - Enter sends; Shift+Enter and Alt+Enter are a new line.
 * - Enter while an IME is composing never sends: it confirms the composition.
 * - On a coarse pointer (a phone or tablet's software keyboard) plain Enter is a new line, since the keyboard's
 *   return key is the only way to start one; the send button sends. Ctrl+Enter or Cmd+Enter still sends there, for
 *   a hardware keyboard attached to a tablet.
 */
export function shouldSend(event: KeyLike, coarse: boolean): boolean {
	if (event.key !== "Enter") return false;
	if (event.isComposing === true || event.keyCode === 229) return false;
	if (event.shiftKey === true || event.altKey === true) return false;
	const modified = event.ctrlKey === true || event.metaKey === true;
	if (coarse) return modified;
	return true;
}

// Prompt history: Up and Down recall what you sent before, as a shell does. T3 Code recalls rather than edits: the
// sent message stays as it was, and the recalled text is a new draft (composerPromptHistory.ts:117-174).

/** Where the caret is, and whether anything stops recall. */
export type RecallInput = {
	key: string;
	shiftKey?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	isComposing?: boolean;
	/** The draft now. */
	text: string;
	selectionStart: number;
	selectionEnd: number;
	/** Where in the history the draft came from: -1 for a fresh draft, else an index into `history`. */
	position: number;
	history: readonly string[];
	/** Attachments in the draft. Recall would lose sight of them, so it's off while there are any. */
	attachments: number;
};

/**
 * What Up or Down does to the draft: `undefined` when the key should move the caret as usual, else the new draft
 * and its history position. Up from an empty draft (caret anywhere) recalls the last message sent; Up again, with the
 * caret on the first line, goes further back. Down with the caret on the last line goes forward, and past the newest
 * returns to an empty draft. Modifiers, an IME, a selection or attachments turn it off.
 */
export function recall(input: RecallInput): { text: string; position: number } | undefined {
	const { key, text, history, position } = input;
	if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
	if (input.shiftKey || input.altKey || input.ctrlKey || input.metaKey || input.isComposing) return undefined;
	if (input.attachments > 0 || history.length === 0) return undefined;
	if (input.selectionStart !== input.selectionEnd) return undefined;
	const recalled = position >= 0 && position < history.length && history[position] === text;
	if (!recalled && text !== "") return undefined;
	if (key === "ArrowUp") {
		if (recalled && text.lastIndexOf("\n", input.selectionStart - 1) !== -1) return undefined;
		const next = recalled ? position - 1 : history.length - 1;
		if (next < 0) return undefined;
		return { text: history[next] ?? "", position: next };
	}
	if (!recalled) return undefined;
	if (text.indexOf("\n", input.selectionEnd) !== -1) return undefined;
	const next = position + 1;
	if (next >= history.length) return { text: "", position: -1 };
	return { text: history[next] ?? "", position: next };
}

// Resting: when you scroll the transcript to read back, the docked composer folds to one line so it covers less of
// what you're reading (T3 Code's "collapse on scroll", ChatComposer.tsx:2376-2478 and composerScrollGesture.ts).

/** Wheel movement, in CSS pixels, within one gesture before the composer rests. */
export const REST_THRESHOLD_PX = 24;
/** A pause longer than this between wheel events starts a new gesture. */
export const REST_GESTURE_GAP_MS = 120;

export type RestGesture = { accumulated: number; lastAt: number };

export function restGesture(): RestGesture {
	return { accumulated: 0, lastAt: Number.NEGATIVE_INFINITY };
}

/** A wheel event's movement in CSS pixels, whatever unit the device reports in. */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
	const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1;
	return Math.abs(deltaY) * unit;
}

/**
 * Records a wheel event over the transcript; true when the gesture has moved far enough to rest the composer. Only
 * movement the transcript can actually make counts, and scrolling down at the end never does, since that is where
 * the composer is wanted.
 */
export function recordRestGesture(
	gesture: RestGesture,
	input: { now: number; pixels: number; canScroll: boolean; downAtEnd: boolean },
): boolean {
	if (input.now - gesture.lastAt > REST_GESTURE_GAP_MS) gesture.accumulated = 0;
	gesture.lastAt = input.now;
	if (!input.canScroll || input.downAtEnd) {
		gesture.accumulated = 0;
		return false;
	}
	gesture.accumulated += input.pixels;
	if (gesture.accumulated < REST_THRESHOLD_PX) return false;
	gesture.accumulated = 0;
	return true;
}

/** Keys that scroll the transcript a page or to an end, and so rest the composer as the wheel does. */
export function restsForKey(key: string, scroll: { top: number; height: number; client: number }): boolean {
	const atEnd = scroll.top >= scroll.height - scroll.client - 1;
	switch (key) {
		case "PageUp":
		case "Home":
			return scroll.top > 1;
		case "PageDown":
		case "End":
			return !atEnd;
		default:
			return false;
	}
}

/** True when a scroller is at (within a pixel of) its end, which brings a resting composer back. */
export function atScrollEnd(scroll: { top: number; height: number; client: number }): boolean {
	return scroll.top >= scroll.height - scroll.client - 1;
}

// Attachments. The library never uploads anything: it checks what it's given against the host's limits, hands the
// files that pass to the host, and shows what the host reports back.

/** What the host accepts. Every limit is optional; leave one out and the composer doesn't check it. */
export type AttachmentLimits = {
	/** At most this many attachments in one message, counting those already in the draft. */
	maxFiles?: number;
	/** The largest file, in bytes. */
	maxFileBytes?: number;
	/** The largest image, in bytes, when images have a lower limit than other files. */
	maxImageBytes?: number;
	/**
	 * What the host takes: MIME types (`image/png`), wildcards (`image/*`) or extensions (`.pdf`). Leave it out to
	 * take any file. Also passed to the file picker's `accept`.
	 */
	accept?: readonly string[];
};

/** A file the composer turned away, and why, in words a person can act on. */
export type RejectedFile = { name: string; reason: string };

/** True for the image types a model can read. Other image types (SVG, HEIC) travel as files. */
export function isImage(type: string): boolean {
	return /^image\/(png|jpe?g|gif|webp)$/i.test(type);
}

function accepts(accept: readonly string[], file: { name: string; type: string }): boolean {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return accept.some((entry) => {
		const rule = entry.trim().toLowerCase();
		if (rule.startsWith(".")) return name.endsWith(rule);
		if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
		return type === rule;
	});
}

/** Splits incoming files into those within the limits and those turned away, keeping their order. */
export function checkFiles<F extends { name: string; size: number; type: string }>(
	files: readonly F[],
	limits: AttachmentLimits,
	existing: number,
): { accepted: F[]; rejected: RejectedFile[] } {
	const accepted: F[] = [];
	const rejected: RejectedFile[] = [];
	for (const file of files) {
		const image = isImage(file.type);
		const maxBytes = image ? (limits.maxImageBytes ?? limits.maxFileBytes) : limits.maxFileBytes;
		if (file.size === 0) {
			rejected.push({ name: file.name, reason: "is empty" });
		} else if (limits.accept !== undefined && limits.accept.length > 0 && !accepts(limits.accept, file)) {
			rejected.push({ name: file.name, reason: "isn't a type this session takes" });
		} else if (maxBytes !== undefined && file.size > maxBytes) {
			rejected.push({ name: file.name, reason: `is larger than ${formatBytes(maxBytes)}` });
		} else if (limits.maxFiles !== undefined && existing + accepted.length >= limits.maxFiles) {
			rejected.push({ name: file.name, reason: `would go over ${limits.maxFiles} attachments` });
		} else {
			accepted.push(file);
		}
	}
	return { accepted, rejected };
}

/** One sentence for the files turned away: "notes.heic isn't a type this session takes." or a count. */
export function rejectionMessage(rejected: readonly RejectedFile[]): string {
	if (rejected.length === 0) return "";
	if (rejected.length === 1) {
		const [only] = rejected;
		return `${only?.name} ${only?.reason}.`;
	}
	const reasons = new Set(rejected.map((file) => file.reason));
	if (reasons.size === 1) return `${rejected.length} files weren't added: each ${[...reasons][0]}.`;
	return `${rejected.length} files weren't added. ${rejected.map((file) => `${file.name} ${file.reason}`).join("; ")}.`;
}

/** The limits in one plain line for the picker's hint: "Images up to 10 MB, files up to 50 MB, 20 at most". */
export function limitsSummary(limits: AttachmentLimits): string {
	const parts: string[] = [];
	if (limits.maxImageBytes !== undefined && limits.maxImageBytes !== limits.maxFileBytes) {
		parts.push(`images up to ${formatBytes(limits.maxImageBytes)}`);
	}
	if (limits.maxFileBytes !== undefined) parts.push(`files up to ${formatBytes(limits.maxFileBytes)}`);
	if (limits.maxFiles !== undefined) parts.push(`${limits.maxFiles} at most`);
	const text = parts.join(", ");
	return text === "" ? "" : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Bytes in the units people use: "980 B", "39 KB", "4.2 MB". Decimal, as file managers show them. */
export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${rounded} ${units[unit]}`;
}

// Pasted text. T3 Code turns a paste of 32 KiB or more into a pasted-text.txt attachment; Claude does the same at a
// lower size. Harbour folds at 32 KiB or 80 lines, whichever comes first, so a pasted log never floods the field.

export type PasteFold = {
	/** Fold pastes of at least this many bytes (UTF-8). */
	bytes?: number;
	/** Fold pastes of at least this many lines. */
	lines?: number;
};

export const DEFAULT_PASTE_FOLD = { bytes: 32 * 1024, lines: 80 } as const satisfies PasteFold;

/** How many lines a text has: one more than its line breaks, not counting a final one. */
export function countLines(text: string): number {
	if (text === "") return 0;
	const breaks = text.match(/\n/g)?.length ?? 0;
	return text.endsWith("\n") ? breaks : breaks + 1;
}

/** True when a paste should become an attachment rather than go into the field. */
export function foldsPaste(text: string, fold: PasteFold, byteLength: (text: string) => number): boolean {
	if (text === "") return false;
	if (fold.lines !== undefined && countLines(text) >= fold.lines) return true;
	if (fold.bytes !== undefined && (text.length >= fold.bytes || byteLength(text) >= fold.bytes)) return true;
	return false;
}

/** The next free name for a folded paste: pasted-text.txt, then pasted-text-2.txt and on. */
export function pastedTextName(existing: readonly string[]): string {
	const names = new Set(existing.map((name) => name.toLowerCase()));
	if (!names.has("pasted-text.txt")) return "pasted-text.txt";
	for (let sequence = 2; ; sequence += 1) {
		const candidate = `pasted-text-${sequence}.txt`;
		if (!names.has(candidate)) return candidate;
	}
}

/** True for the chord that pastes without folding: Ctrl+Shift+V, or Cmd+Shift+V on a Mac. */
export function pastesInline(event: KeyLike): boolean {
	return (
		event.key.toLowerCase() === "v" && event.shiftKey === true && (event.ctrlKey === true || event.metaKey === true)
	);
}
