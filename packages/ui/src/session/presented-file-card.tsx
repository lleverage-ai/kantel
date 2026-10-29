import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { memo, type ReactNode } from "react";
import { FileIcon, GlobeIcon, type IconProps, ImageIcon, TextFileIcon } from "../primitives/icons.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import { type PresentedKind, presentedKey, presentedKind, presentedKindLabel } from "./presented-file-model.ts";
import "./presented-file-card.css";

// A file the agent presented (`present_files`), as a card that stays in the transcript: its name, what kind of file it
// is, its size and, for text, its first lines. Pressing it opens the file in the host's viewer.

type IconComponent = (props: IconProps) => ReactNode;

const ICONS: { readonly [kind in PresentedKind]: IconComponent } = {
	pdf: FileIcon,
	markdown: TextFileIcon,
	html: GlobeIcon,
	csv: TextFileIcon,
	text: TextFileIcon,
	image: ImageIcon,
	docx: TextFileIcon,
	xlsx: TextFileIcon,
	pptx: FileIcon,
	other: FileIcon,
};

/** The short tag on the card's icon: "PDF", "DOCX". */
function tagOf(file: PresentedFile, kind: PresentedKind): string {
	if (kind === "markdown") return "MD";
	const dot = file.name.lastIndexOf(".");
	const extension = dot <= 0 ? "" : file.name.slice(dot + 1);
	return extension.length > 0 && extension.length <= 4 ? extension.toUpperCase() : "";
}

export type PresentedFileCardProps = {
	file: PresentedFile;
	/** Opens the file in the host's viewer. Without it the card shows what the file is, with nothing to press. */
	onOpen?: ((file: PresentedFile) => void) | undefined;
	/** The file is open in the viewer now. */
	open?: boolean;
};

/** One presented file as a card. */
export const PresentedFileCard = memo(function PresentedFileCard({
	file,
	onOpen,
	open = false,
}: PresentedFileCardProps) {
	const kind = presentedKind(file);
	const Icon = ICONS[kind];
	const tag = tagOf(file, kind);
	const body = (
		<>
			<span className="hb-presented-icon" data-kind={kind}>
				<Icon />
				{tag === "" ? null : <span className="hb-presented-tag">{tag}</span>}
			</span>
			<span className="hb-presented-text">
				<span className="hb-presented-name" title={file.path}>
					{file.name}
				</span>
				<span className="hb-presented-facts">
					<span>{presentedKindLabel(kind)}</span>
					<span>{formatBytes(file.size)}</span>
				</span>
				{file.preview === undefined ? null : (
					<span className="hb-presented-preview" aria-hidden="true">
						{file.preview}
					</span>
				)}
			</span>
		</>
	);
	return onOpen === undefined ? (
		<div className="hb-presented-card">{body}</div>
	) : (
		<button
			type="button"
			className={`hb-presented-card hb-presented-card-button hb-focusable${open ? " hb-presented-card-open" : ""}`}
			aria-label={`Open ${file.name}`}
			aria-pressed={open}
			onClick={() => onOpen(file)}
		>
			{body}
		</button>
	);
});

export type PresentedFilesProps = {
	/** A finished `present_files` call: its `files`. */
	item: ToolItem;
	onOpen?: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key (`presentedKey`) of the file open in the viewer, if any. */
	openKey?: string | undefined;
};

/** The files one call presented, as cards in a row that wraps. Nothing for a call that presented none. */
export function PresentedFiles({ item, onOpen, openKey }: PresentedFilesProps) {
	const files = item.status === "done" ? (item.files ?? []) : [];
	if (files.length === 0) return null;
	return (
		<ul className="hb-presented-files" aria-label={files.length === 1 ? "Presented file" : "Presented files"}>
			{files.map((file) => (
				<li key={presentedKey(file)} className="hb-presented-files-item">
					<PresentedFileCard
						file={file}
						onOpen={onOpen === undefined ? undefined : (opened) => onOpen(opened, item)}
						open={openKey === presentedKey(file)}
					/>
				</li>
			))}
		</ul>
	);
}
