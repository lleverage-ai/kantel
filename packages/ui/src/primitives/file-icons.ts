import type { ReactNode } from "react";
import type { IconProps } from "./icons.tsx";
import { FileCodeIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, LucideFileIcon } from "./lucide.tsx";
import "./file-tile.css";

// Which Lucide file icon, and which short type, an attachment card shows for a file, as Claude's file cards do.

const CODE_EXTENSIONS = new Set(
	(
		"js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish sql graphql proto lua r " +
		"scala ex exs erl hs vue svelte html htm css scss json jsonl yaml yml toml xml ini"
	).split(" "),
);
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods", "numbers"]);
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "log", "pdf", "doc", "docx", "rtf", "odt"]);

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * What kind of file it is, for its icon and its tile's tint (the same tints as a presented file's card): `pdf`, `text`,
 * `code`, `sheet`, `image` or `other`.
 */
export type FileTypeKind = "pdf" | "text" | "code" | "sheet" | "image" | "other";

export function fileTypeKind(file: { name: string; type: string }): FileTypeKind {
	const extension = extensionOf(file.name);
	const type = file.type.toLowerCase();
	if (type.startsWith("image/")) return "image";
	if (type === "application/pdf" || extension === "pdf") return "pdf";
	if (SHEET_EXTENSIONS.has(extension) || type === "text/csv") return "sheet";
	if (CODE_EXTENSIONS.has(extension) || type === "application/json") return "code";
	if (type.startsWith("text/") || DOCUMENT_EXTENSIONS.has(extension)) return "text";
	return "other";
}

const ICONS: { readonly [kind in FileTypeKind]: (props: IconProps) => ReactNode } = {
	pdf: FileTextIcon,
	text: FileTextIcon,
	code: FileCodeIcon,
	sheet: FileSpreadsheetIcon,
	image: FileImageIcon,
	other: LucideFileIcon,
};

/** The Lucide icon for a file, by its type and name: file-image, file-spreadsheet, file-code, file-text or file. */
export function fileTypeIcon(file: { name: string; type: string }): (props: IconProps) => ReactNode {
	return ICONS[fileTypeKind(file)];
}

/** The short type a file card shows: its extension in capitals ("PDF", "CSV"), or what its type says. */
export function fileTypeLabel(file: { name: string; type: string }): string {
	const extension = extensionOf(file.name);
	if (extension !== "" && extension.length <= 5) return extension.toUpperCase();
	if (file.type === "application/pdf") return "PDF";
	if (file.type.startsWith("image/")) return "Image";
	if (file.type.startsWith("text/")) return "Text";
	return "File";
}
