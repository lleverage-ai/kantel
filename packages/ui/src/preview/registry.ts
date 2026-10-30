import {
	Braces,
	File,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Globe,
	type LucideIcon,
	Presentation,
} from "lucide-react";
import type { ComponentType } from "react";
import { matchKind, type PreviewFile, type PreviewKind, type PreviewMatch } from "./preview-model.ts";

// The file preview's renderer registry: one entry per kind of file, matched by extension and media type. The panel's
// chrome is the same for every kind; an entry says only how its body is drawn, whether the person can edit it, and
// where its code is. Each body is its own chunk, loaded the first time a file of its kind opens or is warmed
// (`warmPreview`, on a card's hover, focus or press), so the console's first load carries none of them.
//
// Adding a kind is one entry here plus its body module in ./bodies/.

/** What a body is given: the file, its bytes (and text, for a text kind) and whether it is being edited. */
export type PreviewBodyProps = {
	readonly file: PreviewFile;
	readonly bytes: Uint8Array;
	/** The bytes as UTF-8, for a `text` entry; "" for a `bytes` one. While streaming, what has arrived. */
	readonly text: string;
	/** The type the server answered with, else the file's. */
	readonly contentType: string;
	/** An object URL the host already has for the bytes (see PreviewContent). */
	readonly url?: string | undefined;
	/** The text is still arriving (a document being written): no editing, a caret at its end. */
	readonly streaming: boolean;
	/** The person switched to Edit (only for an `editable` entry). */
	readonly editing: boolean;
	/** The text after each edit, while editing. */
	readonly onText?: ((text: string) => void) | undefined;
	/** What a screen reader calls the body's region: "Contents of report.md". */
	readonly label: string;
	/** Facts only the body learns, for the header after the size: an image's pixel size, a table's rows. */
	readonly onFacts?: ((facts: readonly string[]) => void) | undefined;
};

export type PreviewRenderer = {
	readonly kind: PreviewKind;
	/** The kind in words, under the name in the header: "Markdown", "Python". */
	readonly label: string;
	readonly icon: LucideIcon;
	readonly match: PreviewMatch;
	/** Whether the body takes the bytes decoded as text (and so can stream and be copied as text) or the raw bytes. */
	readonly content: "text" | "bytes";
	/** Whether Edit is offered when the host can save. */
	readonly editable?: boolean;
	readonly load: () => Promise<{ readonly default: ComponentType<PreviewBodyProps> }>;
};

const CODE_EXTENSIONS = (
	"ts tsx mts cts js jsx mjs cjs py rb rs go java kt kts swift c h cc cpp hpp cs php sh bash zsh fish sql graphql gql " +
	"proto lua r scala ex exs erl hs vue svelte css scss less xml svg yml yaml toml ini conf env cfg txt log diff patch " +
	"dockerfile makefile gradle tf hcl lock gitignore editorconfig properties rst tex"
).split(" ");

/** The registry, in match order: the first entry whose extension (then type) fits the file renders it. */
export const PREVIEW_RENDERERS: readonly PreviewRenderer[] = [
	{
		kind: "markdown",
		label: "Markdown",
		icon: FileText,
		match: { extensions: ["md", "markdown", "mdx"], types: ["text/markdown", "text/x-markdown"] },
		content: "text",
		editable: true,
		load: () => import("./bodies/markdown-body.tsx"),
	},
	{
		kind: "json",
		label: "JSON",
		icon: Braces,
		match: { extensions: ["json", "jsonc", "json5", "geojson", "ipynb"], types: ["application/json"] },
		content: "text",
		editable: true,
		load: () => import("./bodies/json-body.tsx"),
	},
	{
		kind: "csv",
		label: "Table",
		icon: FileSpreadsheet,
		match: { extensions: ["csv", "tsv"], types: ["text/csv", "text/tab-separated-values"] },
		content: "text",
		editable: true,
		load: () => import("./bodies/table-body.tsx"),
	},
	{
		kind: "html",
		label: "HTML page",
		icon: Globe,
		match: { extensions: ["html", "htm"], types: ["text/html"] },
		content: "text",
		editable: true,
		load: () => import("./bodies/html-body.tsx"),
	},
	{
		kind: "image",
		label: "Image",
		icon: FileImage,
		match: {
			extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"],
			typePrefixes: ["image/"],
		},
		content: "bytes",
		load: () => import("./bodies/image-body.tsx"),
	},
	{
		kind: "pdf",
		label: "PDF",
		icon: FileText,
		match: { extensions: ["pdf"], types: ["application/pdf"] },
		content: "bytes",
		load: () => import("./bodies/pdf-body.tsx"),
	},
	{
		kind: "audio",
		label: "Audio",
		icon: FileAudio,
		match: { extensions: ["mp3", "wav", "m4a", "aac", "flac", "oga", "opus"], typePrefixes: ["audio/"] },
		content: "bytes",
		load: () => import("./bodies/media-body.tsx"),
	},
	{
		kind: "video",
		label: "Video",
		icon: FileVideo,
		match: { extensions: ["mp4", "webm", "mov", "m4v", "ogv"], typePrefixes: ["video/"] },
		content: "bytes",
		load: () => import("./bodies/media-body.tsx"),
	},
	{
		kind: "docx",
		label: "Word document",
		icon: FileText,
		match: {
			extensions: ["docx"],
			types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		},
		content: "bytes",
		load: () => import("./bodies/office-body.tsx"),
	},
	{
		kind: "xlsx",
		label: "Excel spreadsheet",
		icon: FileSpreadsheet,
		match: { extensions: ["xlsx"], types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
		content: "bytes",
		load: () => import("./bodies/office-body.tsx"),
	},
	{
		kind: "pptx",
		label: "PowerPoint presentation",
		icon: Presentation,
		match: {
			extensions: ["pptx"],
			types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
		},
		content: "bytes",
		load: () => import("./bodies/office-body.tsx"),
	},
	{
		kind: "code",
		label: "Text",
		icon: FileCode,
		match: {
			extensions: CODE_EXTENSIONS,
			names: ["dockerfile", "makefile", "license", "readme", "procfile", "gemfile"],
			types: ["application/xml", "application/javascript", "application/x-sh", "application/yaml"],
			typePrefixes: ["text/"],
		},
		content: "text",
		editable: true,
		load: () => import("./bodies/code-body.tsx"),
	},
	{
		kind: "binary",
		label: "File",
		icon: File,
		match: {},
		content: "bytes",
		load: () => import("./bodies/binary-body.tsx"),
	},
];

const BY_KIND = new Map(PREVIEW_RENDERERS.map((entry) => [entry.kind, entry]));

/** The entry for a kind. */
export function rendererOf(kind: PreviewKind): PreviewRenderer {
	return BY_KIND.get(kind) ?? (BY_KIND.get("binary") as PreviewRenderer);
}

/**
 * The renderer for a file: by its name, then its type, then the type the server answered with. A file with no
 * extension and no type is taken as text and shown as code; the body falls back to the binary view if its bytes
 * aren't text.
 */
export function rendererFor(file: Pick<PreviewFile, "name" | "mimeType">, contentType?: string): PreviewRenderer {
	const kind = matchKind(PREVIEW_RENDERERS, file, "binary", contentType);
	if (kind === "binary" && file.name.indexOf(".") <= 0 && (file.mimeType ?? "") === "") return rendererOf("code");
	return rendererOf(kind);
}

const loaded = new Map<PreviewKind, ComponentType<PreviewBodyProps>>();
const loading = new Map<PreviewKind, Promise<ComponentType<PreviewBodyProps>>>();

/** Loads a kind's body once. A failed load (the network dropped) is tried again next time. */
export function loadBody(kind: PreviewKind): Promise<ComponentType<PreviewBodyProps>> {
	const existing = loading.get(kind);
	if (existing !== undefined) return existing;
	const started = rendererOf(kind)
		.load()
		.then((module) => {
			loaded.set(kind, module.default);
			return module.default;
		});
	loading.set(kind, started);
	started.catch(() => loading.delete(kind));
	return started;
}

/** A kind's body if it has loaded: rendered straight away, with no Suspense fallback. */
export function loadedBody(kind: PreviewKind): ComponentType<PreviewBodyProps> | undefined {
	return loaded.get(kind);
}

/**
 * Starts loading the body that will show `file`, so opening it doesn't wait for its code. Cheap to call again; hosts
 * call it on a card's hover, focus or press.
 */
export function warmPreview(file: Pick<PreviewFile, "name" | "mimeType">): void {
	void loadBody(rendererFor(file).kind).catch(() => {});
}
