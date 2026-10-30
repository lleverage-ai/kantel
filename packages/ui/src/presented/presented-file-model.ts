import type { PresentedFile, ToolItem, TranscriptItem } from "@harbour/protocol";

// What a presented file is, for its card and its viewer: the pure part, so it can be tested without a page.

/** How the viewer renders a presented file. */
export type PresentedKind = "pdf" | "markdown" | "html" | "csv" | "text" | "image" | "docx" | "xlsx" | "pptx" | "other";

const EXTENSIONS: { readonly [extension: string]: PresentedKind } = {
	pdf: "pdf",
	md: "markdown",
	markdown: "markdown",
	html: "html",
	htm: "html",
	csv: "csv",
	tsv: "csv",
	txt: "text",
	log: "text",
	json: "text",
	xml: "text",
	yaml: "text",
	yml: "text",
	svg: "text",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	docx: "docx",
	xlsx: "xlsx",
	pptx: "pptx",
};

const TYPES: { readonly [mimeType: string]: PresentedKind } = {
	"application/pdf": "pdf",
	"text/markdown": "markdown",
	"text/html": "html",
	"text/csv": "csv",
	"text/tab-separated-values": "csv",
	"text/plain": "text",
	"application/json": "text",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** The viewer for a file, from its name first (what the agent called it), then its media type. */
export function presentedKind(file: Pick<PresentedFile, "name" | "mimeType">): PresentedKind {
	const dot = file.name.lastIndexOf(".");
	const extension = dot <= 0 ? "" : file.name.slice(dot + 1).toLowerCase();
	const byName = EXTENSIONS[extension];
	if (byName !== undefined) return byName;
	const byType = TYPES[file.mimeType.split(";")[0]?.trim().toLowerCase() ?? ""];
	if (byType !== undefined) return byType;
	if (file.mimeType.startsWith("image/")) return "image";
	if (file.mimeType.startsWith("text/") || extension === "") return "text";
	return "other";
}

const LABELS: { readonly [kind in PresentedKind]: string } = {
	pdf: "PDF",
	markdown: "Markdown",
	html: "HTML page",
	csv: "Spreadsheet data",
	text: "Text",
	image: "Image",
	docx: "Word document",
	xlsx: "Excel spreadsheet",
	pptx: "PowerPoint presentation",
	other: "File",
};

/** The kind in words, for the card and the viewer: "PDF", "Word document". */
export function presentedKindLabel(kind: PresentedKind): string {
	return LABELS[kind];
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1);
}

/**
 * A presented file's title on its card: the title it was given (a document's), or its name without the extension, as
 * Claude's cards show it.
 */
export function presentedTitle(file: Pick<PresentedFile, "name" | "title">): string {
	if (file.title !== undefined && file.title.trim() !== "") return file.title.trim();
	const extension = extensionOf(file.name);
	return extension === "" ? file.name : file.name.slice(0, -(extension.length + 1));
}

/**
 * What a presented file is, in a few words, under its title on the card: "PDF document", "Word document", "PNG image".
 * Plain words rather than Claude's "Document · PDF": Harbour's copy has no middle-dot meta strings. A file a model made
 * says which: "JPEG image made with gpt-image-1".
 */
export function presentedSubtitle(
	file: Pick<PresentedFile, "name" | "document" | "model">,
	kind: PresentedKind,
): string {
	const what = presentedWhat(file, kind);
	return file.model === undefined ? what : `${what} made with ${file.model}`;
}

function presentedWhat(file: Pick<PresentedFile, "name" | "document">, kind: PresentedKind): string {
	if (file.document === true) return "Document";
	const extension = extensionOf(file.name).toUpperCase();
	switch (kind) {
		case "pdf":
			return "PDF document";
		case "markdown":
			return "Markdown document";
		case "docx":
			return "Word document";
		case "xlsx":
			return "Excel spreadsheet";
		case "pptx":
			return "PowerPoint presentation";
		case "html":
			return "HTML page";
		case "csv":
			return `${extension === "" ? "CSV" : extension} spreadsheet`;
		case "image":
			return extension === "" ? "Image" : `${extension} image`;
		case "text":
			return extension === "" || extension === "TXT" ? "Text file" : `${extension} file`;
		case "other":
			return extension === "" || extension.length > 5 ? "File" : `${extension} file`;
	}
}

/** A presented file's key: the same file presented again opens the same viewer. */
export const presentedKey = (file: Pick<PresentedFile, "workspaceId" | "path">): string =>
	`${file.workspaceId}:${file.path}`;

/** The files a transcript's finished calls presented, oldest first, with the call that presented each. */
export function presentedFiles(
	items: readonly TranscriptItem[],
): readonly { readonly file: PresentedFile; readonly item: ToolItem }[] {
	const found: { file: PresentedFile; item: ToolItem }[] = [];
	for (const item of items) {
		if (item.kind !== "tool" || item.files === undefined || item.status !== "done") continue;
		for (const file of item.files) found.push({ file, item });
	}
	return found;
}

/**
 * The file to open on its own when new calls finish: the first file of the newest call that presents one never
 * presented before (`seen`), or nothing. `seen` is the keys of every file already presented; the host adds to it.
 */
export function fileToOpen(
	items: readonly TranscriptItem[],
	seen: ReadonlySet<string>,
): { readonly file: PresentedFile; readonly item: ToolItem } | undefined {
	let open: { file: PresentedFile; item: ToolItem } | undefined;
	for (const { file, item } of presentedFiles(items)) {
		if (seen.has(presentedKey(file))) continue;
		if (open === undefined || open.item !== item) open = { file, item };
	}
	return open;
}
