import { describe, expect, it } from "vitest";
import { attachmentKind } from "./composer-attachments.tsx";
import {
	atScrollEnd,
	capNudge,
	checkFiles,
	countLines,
	DEFAULT_PASTE_FOLD,
	foldsPaste,
	hasText,
	limitsSummary,
	pastedTextName,
	pastesInline,
	primaryAction,
	type RecallInput,
	recall,
	recordRestGesture,
	rejectionMessage,
	restGesture,
	restsForKey,
	shouldSend,
	sizesFieldByCss,
	submits,
	wheelPixels,
} from "./composer-model.ts";
import { type ComposerModelOption, filterModels, selectedModel } from "./model-picker.tsx";

/** Sizes are binary, as formatBytes shows them (workspace-model.ts): 1 MB is 1,048,576 bytes. */
const MB = 1024 * 1024;

describe("capNudge", () => {
	it("moves a line down by the gap between its content area's middle and its capitals' middle", () => {
		// The content area's middle 4px above the baseline, the capitals' 5px: the words sit 1px high, so move down 1px.
		expect(capNudge({ ascent: 10, descent: 2, capHeight: 10 })).toBe(1);
		// A deeper descent lowers the content area's middle, so the words sit higher still.
		expect(capNudge({ ascent: 12, descent: 6, capHeight: 10 })).toBe(2);
		// A tall ascent raises it past the capitals' middle: the words sit low, so move up.
		expect(capNudge({ ascent: 14, descent: 3, capHeight: 10 })).toBe(-0.5);
		expect(capNudge({ ascent: 10, descent: 2, capHeight: 8 })).toBe(0);
	});

	it("moves nothing when the metrics are unknown", () => {
		expect(capNudge(undefined)).toBe(0);
		expect(capNudge({ ascent: Number.NaN, descent: 2, capHeight: 8 })).toBe(0);
		expect(capNudge({ ascent: 10, descent: 2, capHeight: 0 })).toBe(0);
	});
});

describe("primaryAction", () => {
	it("sends from idle once there is text", () => {
		expect(primaryAction("idle", "Run the suite")).toBe("send");
		expect(primaryAction("idle", "")).toBe("send-empty");
		expect(primaryAction("idle", "  \n\t ")).toBe("send-empty");
	});

	it("steers a running agent with text and stops it without", () => {
		expect(primaryAction("running", "Use the staging database instead")).toBe("steer");
		expect(primaryAction("running", "")).toBe("stop");
		expect(primaryAction("running", "   ")).toBe("stop");
	});

	it("is busy while sending, whatever the draft", () => {
		expect(primaryAction("sending", "")).toBe("busy");
		expect(primaryAction("sending", "Run the suite")).toBe("busy");
	});

	it("does nothing while disabled, whatever the draft", () => {
		expect(primaryAction("disabled", "")).toBe("disabled");
		expect(primaryAction("disabled", "Run the suite")).toBe("disabled");
	});

	it("submits only for send and steer", () => {
		expect(submits("send")).toBe(true);
		expect(submits("steer")).toBe(true);
		expect(submits("stop")).toBe(false);
		expect(submits("busy")).toBe(false);
		expect(submits("send-empty")).toBe(false);
		expect(submits("disabled")).toBe(false);
	});

	it("counts ready attachments as something to send, and holds while blocked", () => {
		expect(primaryAction("idle", "", { readyAttachments: 1 })).toBe("send");
		expect(primaryAction("idle", "Look", { readyAttachments: 1, blocked: true })).toBe("send-empty");
		expect(primaryAction("running", "", { readyAttachments: 1 })).toBe("steer");
		expect(primaryAction("running", "Look", { blocked: true })).toBe("send-empty");
		expect(primaryAction("running", "", { blocked: true })).toBe("stop");
	});

	it("treats whitespace as empty", () => {
		expect(hasText("")).toBe(false);
		expect(hasText(" \n ")).toBe(false);
		expect(hasText(" a ")).toBe(true);
	});
});

describe("shouldSend", () => {
	it("sends on plain Enter with a fine pointer", () => {
		expect(shouldSend({ key: "Enter" }, false)).toBe(true);
	});

	it("leaves Shift+Enter and Alt+Enter as a new line", () => {
		expect(shouldSend({ key: "Enter", shiftKey: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", altKey: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", shiftKey: true, metaKey: true }, false)).toBe(false);
	});

	it("never sends while an IME is composing", () => {
		expect(shouldSend({ key: "Enter", isComposing: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", keyCode: 229 }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", isComposing: true, metaKey: true }, true)).toBe(false);
	});

	it("leaves plain Enter as a new line on a coarse pointer", () => {
		expect(shouldSend({ key: "Enter" }, true)).toBe(false);
	});

	it("sends on Ctrl+Enter or Cmd+Enter with any pointer", () => {
		expect(shouldSend({ key: "Enter", ctrlKey: true }, true)).toBe(true);
		expect(shouldSend({ key: "Enter", metaKey: true }, true)).toBe(true);
		expect(shouldSend({ key: "Enter", metaKey: true }, false)).toBe(true);
	});

	it("ignores other keys, Escape included", () => {
		expect(shouldSend({ key: "a" }, false)).toBe(false);
		expect(shouldSend({ key: "Escape" }, false)).toBe(false);
		expect(shouldSend({ key: "Tab" }, false)).toBe(false);
	});
});

describe("sizesFieldByCss", () => {
	it("uses field-sizing only where the browser says it supports it", () => {
		expect(sizesFieldByCss(undefined)).toBe(false);
		expect(sizesFieldByCss({})).toBe(false);
		expect(sizesFieldByCss({ supports: () => false })).toBe(false);
		expect(sizesFieldByCss({ supports: (property, value) => property === "field-sizing" && value === "content" })).toBe(
			true,
		);
	});
});

describe("recall", () => {
	const history = ["first", "second\nline two", "third"];
	const at = (text: string, position: number, caret = text.length): RecallInput => ({
		key: "ArrowUp",
		text,
		selectionStart: caret,
		selectionEnd: caret,
		position,
		history,
		attachments: 0,
	});

	it("recalls the last message from an empty draft, then goes further back", () => {
		expect(recall(at("", -1))).toEqual({ text: "third", position: 2 });
		expect(recall(at("third", 2, 0))).toEqual({ text: "second\nline two", position: 1 });
	});

	it("moves the caret instead when it isn't on the first line of a recalled draft", () => {
		expect(recall(at("second\nline two", 1))).toBeUndefined();
		expect(recall(at("second\nline two", 1, 3))).toEqual({ text: "first", position: 0 });
	});

	it("stops at the oldest message", () => {
		expect(recall(at("first", 0, 0))).toBeUndefined();
	});

	it("goes forward with Down and returns to an empty draft past the newest", () => {
		expect(recall({ ...at("first", 0), key: "ArrowDown" })).toEqual({ text: "second\nline two", position: 1 });
		expect(recall({ ...at("third", 2), key: "ArrowDown" })).toEqual({ text: "", position: -1 });
		expect(recall({ ...at("", -1), key: "ArrowDown" })).toBeUndefined();
	});

	it("never replaces a draft you typed, or one with attachments, a selection or a modifier", () => {
		expect(recall(at("my own words", -1))).toBeUndefined();
		expect(recall({ ...at("", -1), attachments: 1 })).toBeUndefined();
		expect(recall({ ...at("third", 2, 0), selectionEnd: 3 })).toBeUndefined();
		expect(recall({ ...at("", -1), shiftKey: true })).toBeUndefined();
		expect(recall({ ...at("", -1), isComposing: true })).toBeUndefined();
		expect(recall({ ...at("", -1), history: [] })).toBeUndefined();
		expect(recall({ ...at("", -1), key: "ArrowLeft" })).toBeUndefined();
	});

	it("treats a recalled draft you then edited as your own", () => {
		expect(recall(at("third, edited", 2, 0))).toBeUndefined();
	});
});

describe("resting", () => {
	const scroll = { height: 2000, client: 500 };

	it("rests once a wheel gesture moves 24px the list can go", () => {
		const gesture = restGesture();
		expect(recordRestGesture(gesture, { now: 0, pixels: 10, canScroll: true, downAtEnd: false })).toBe(false);
		expect(recordRestGesture(gesture, { now: 40, pixels: 10, canScroll: true, downAtEnd: false })).toBe(false);
		expect(recordRestGesture(gesture, { now: 80, pixels: 10, canScroll: true, downAtEnd: false })).toBe(true);
	});

	it("starts a new gesture after a pause", () => {
		const gesture = restGesture();
		recordRestGesture(gesture, { now: 0, pixels: 20, canScroll: true, downAtEnd: false });
		expect(recordRestGesture(gesture, { now: 500, pixels: 20, canScroll: true, downAtEnd: false })).toBe(false);
	});

	it("never rests for movement the list can't make, or scrolling down at the end", () => {
		const gesture = restGesture();
		expect(recordRestGesture(gesture, { now: 0, pixels: 200, canScroll: false, downAtEnd: false })).toBe(false);
		expect(recordRestGesture(gesture, { now: 10, pixels: 200, canScroll: true, downAtEnd: true })).toBe(false);
	});

	it("reads wheel movement in pixels, lines or pages", () => {
		expect(wheelPixels(-120, 0, 800)).toBe(120);
		expect(wheelPixels(3, 1, 800)).toBe(48);
		expect(wheelPixels(-1, 2, 800)).toBe(800);
	});

	it("rests for Page Up and Home away from the top, Page Down and End away from the end", () => {
		expect(restsForKey("PageUp", { ...scroll, top: 1500 })).toBe(true);
		expect(restsForKey("Home", { ...scroll, top: 0 })).toBe(false);
		expect(restsForKey("End", { ...scroll, top: 1500 })).toBe(false);
		expect(restsForKey("PageDown", { ...scroll, top: 200 })).toBe(true);
		expect(restsForKey("ArrowUp", { ...scroll, top: 1000 })).toBe(false);
	});

	it("knows the end within a pixel", () => {
		expect(atScrollEnd({ ...scroll, top: 1500 })).toBe(true);
		expect(atScrollEnd({ ...scroll, top: 1499.5 })).toBe(true);
		expect(atScrollEnd({ ...scroll, top: 1400 })).toBe(false);
	});
});

describe("checkFiles", () => {
	const png = (name: string, size: number) => ({ name, size, type: "image/png" });
	const pdf = (name: string, size: number) => ({ name, size, type: "application/pdf" });

	it("takes everything without limits, except empty files", () => {
		const { accepted, rejected } = checkFiles([png("a.png", 10), pdf("b.pdf", 0)], {}, 0);
		expect(accepted.map((file) => file.name)).toEqual(["a.png"]);
		expect(rejected).toEqual([{ name: "b.pdf", reason: "is empty" }]);
	});

	it("applies the image limit to images and the file limit to the rest", () => {
		const limits = { maxImageBytes: 5 * MB, maxFileBytes: 20 * MB };
		const { accepted, rejected } = checkFiles(
			[png("big.png", 6 * MB), pdf("big.pdf", 6 * MB), pdf("huge.pdf", 30 * MB)],
			limits,
			0,
		);
		expect(accepted.map((file) => file.name)).toEqual(["big.pdf"]);
		expect(rejected).toEqual([
			{ name: "big.png", reason: "is larger than 5 MB" },
			{ name: "huge.pdf", reason: "is larger than 20 MB" },
		]);
	});

	it("counts what is already in the draft against the maximum", () => {
		const { accepted, rejected } = checkFiles([pdf("a.pdf", 1), pdf("b.pdf", 1)], { maxFiles: 3 }, 2);
		expect(accepted.map((file) => file.name)).toEqual(["a.pdf"]);
		expect(rejected).toEqual([{ name: "b.pdf", reason: "would go over 3 attachments" }]);
	});

	it("matches accept by MIME type, wildcard or extension", () => {
		const limits = { accept: ["image/*", ".md", "application/pdf"] };
		const files = [
			png("a.png", 1),
			{ name: "NOTES.MD", size: 1, type: "" },
			pdf("c.pdf", 1),
			{ name: "d.zip", size: 1, type: "application/zip" },
		];
		const { accepted, rejected } = checkFiles(files, limits, 0);
		expect(accepted.map((file) => file.name)).toEqual(["a.png", "NOTES.MD", "c.pdf"]);
		expect(rejected).toEqual([{ name: "d.zip", reason: "isn't a type this session takes" }]);
	});

	it("says why in one sentence", () => {
		expect(rejectionMessage([])).toBe("");
		expect(rejectionMessage([{ name: "a.heic", reason: "isn't a type this session takes" }])).toBe(
			"a.heic isn't a type this session takes.",
		);
		expect(
			rejectionMessage([
				{ name: "a.png", reason: "is empty" },
				{ name: "b.png", reason: "is empty" },
			]),
		).toBe("2 files weren't added: each is empty.");
		expect(
			rejectionMessage([
				{ name: "a.png", reason: "is empty" },
				{ name: "b.zip", reason: "isn't a type this session takes" },
			]),
		).toBe("2 files weren't added. a.png is empty; b.zip isn't a type this session takes.");
	});

	it("summarises the limits plainly", () => {
		expect(limitsSummary({})).toBe("");
		expect(limitsSummary({ maxImageBytes: 5 * MB, maxFileBytes: 20 * MB, maxFiles: 10 })).toBe(
			"Images up to 5 MB, files up to 20 MB, 10 at most",
		);
		expect(limitsSummary({ maxFileBytes: 1024 })).toBe("Files up to 1 KB");
	});

	it("tells images, pasted text and other files apart", () => {
		expect(attachmentKind({ name: "a.png", type: "image/png" })).toBe("image");
		expect(attachmentKind({ name: "a.svg", type: "image/svg+xml" })).toBe("file");
		expect(attachmentKind({ name: "pasted-text.txt", type: "text/plain" }, true)).toBe("text");
		expect(attachmentKind({ name: "a.pdf", type: "application/pdf" })).toBe("file");
	});
});

describe("pasted text", () => {
	const bytes = (text: string) => new TextEncoder().encode(text).length;

	it("folds a paste of 80 lines or 32 KiB, and leaves a short one inline", () => {
		expect(foldsPaste("short", DEFAULT_PASTE_FOLD, bytes)).toBe(false);
		expect(foldsPaste("line\n".repeat(79), DEFAULT_PASTE_FOLD, bytes)).toBe(false);
		expect(foldsPaste("line\n".repeat(80), DEFAULT_PASTE_FOLD, bytes)).toBe(true);
		expect(foldsPaste("x".repeat(32 * 1024), DEFAULT_PASTE_FOLD, bytes)).toBe(true);
		expect(foldsPaste("é".repeat(16 * 1024), DEFAULT_PASTE_FOLD, bytes)).toBe(true);
		expect(foldsPaste("", DEFAULT_PASTE_FOLD, bytes)).toBe(false);
		expect(foldsPaste("line\n".repeat(500), {}, bytes)).toBe(false);
	});

	it("counts lines without a trailing break", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("one")).toBe(1);
		expect(countLines("one\ntwo\n")).toBe(2);
		expect(countLines("one\ntwo")).toBe(2);
	});

	it("names folded pastes in sequence", () => {
		expect(pastedTextName([])).toBe("pasted-text.txt");
		expect(pastedTextName(["pasted-text.txt"])).toBe("pasted-text-2.txt");
		expect(pastedTextName(["pasted-text.txt", "pasted-text-2.txt", "notes.md"])).toBe("pasted-text-3.txt");
	});

	it("pastes inline with Ctrl+Shift+V or Cmd+Shift+V", () => {
		expect(pastesInline({ key: "V", shiftKey: true, ctrlKey: true })).toBe(true);
		expect(pastesInline({ key: "v", shiftKey: true, metaKey: true })).toBe(true);
		expect(pastesInline({ key: "v", ctrlKey: true })).toBe(false);
	});
});

describe("model picker", () => {
	const models: ComposerModelOption[] = [
		{ id: "a/off", label: "Off", provider: "A", disabledReason: "Not enabled" },
		{ id: "a/fast", label: "Fast", provider: "A", description: "For small edits" },
		{ id: "b/deep", label: "Deep Think", provider: "B", default: true },
	];

	it("shows the chosen model, else the default, else the first enabled one", () => {
		expect(selectedModel(models, "a/fast")?.id).toBe("a/fast");
		expect(selectedModel(models, "gone")?.id).toBe("b/deep");
		expect(selectedModel(models.slice(0, 2), undefined)?.id).toBe("a/fast");
		expect(selectedModel([], undefined)).toBeUndefined();
	});

	it("filters by every word across label, provider, description and id", () => {
		expect(filterModels(models, "").length).toBe(3);
		expect(filterModels(models, "small").map((model) => model.id)).toEqual(["a/fast"]);
		expect(filterModels(models, "b deep").map((model) => model.id)).toEqual(["b/deep"]);
		expect(filterModels(models, "deep a").map((model) => model.id)).toEqual([]);
	});
});
