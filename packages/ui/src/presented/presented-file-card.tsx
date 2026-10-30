import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { File, FileCode, FileImage, FileSpreadsheet, FileText, type LucideIcon, Presentation } from "lucide-react";
import { memo } from "react";
import {
	type PresentedKind,
	presentedKey,
	presentedKind,
	presentedSubtitle,
	presentedTitle,
} from "./presented-file-model.ts";
import "./presented-file-card.css";

// A file the agent presented (`present_files`), as a card that stays in the transcript, after Claude's: a lucide icon
// for the kind of file in a square tinted to match, the file's title and, muted under it, what kind of file it is.
// No preview: pressing the card opens the file in the host's viewer, which is where its content is.

const ICONS: { readonly [kind in PresentedKind]: LucideIcon } = {
	pdf: FileText,
	markdown: FileText,
	html: FileCode,
	csv: FileSpreadsheet,
	text: FileText,
	image: FileImage,
	docx: FileText,
	xlsx: FileSpreadsheet,
	pptx: Presentation,
	other: File,
};

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
	const body = (
		<>
			<span className="hb-presented-icon" data-kind={kind}>
				<Icon className="hb-icon hb-icon-md" strokeWidth={1.75} aria-hidden="true" />
			</span>
			<span className="hb-presented-text">
				<span className="hb-presented-name" title={file.path}>
					{presentedTitle(file)}
				</span>
				<span className="hb-presented-facts">{presentedSubtitle(file, kind)}</span>
			</span>
		</>
	);
	return onOpen === undefined ? (
		<div className="hb-presented-card">{body}</div>
	) : (
		<button
			type="button"
			className={`hb-presented-card hb-presented-card-button hb-focusable${open ? " hb-presented-card-open" : ""}`}
			aria-label={`Open ${presentedTitle(file)}`}
			aria-pressed={open}
			onClick={() => onOpen(file)}
		>
			{body}
		</button>
	);
});

/** A document the agent is still writing (`create_document` streaming in), as the card it becomes. */
export const DraftDocumentCard = memo(function DraftDocumentCard({ title }: { title: string }) {
	return (
		<div className="hb-presented-card hb-presented-card-draft" aria-live="polite">
			<span className="hb-presented-icon" data-kind="markdown">
				<FileText className="hb-icon hb-icon-md" strokeWidth={1.75} aria-hidden="true" />
			</span>
			<span className="hb-presented-text">
				<span className="hb-presented-name">{title}</span>
				<span className="hb-presented-facts">Writing the document</span>
			</span>
		</div>
	);
});

export type PresentedFilesProps = {
	/** A finished `present_files` call: its `files`. */
	item: ToolItem;
	onOpen?: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key (`presentedKey`) of the file open in the viewer, if any. */
	openKey?: string | undefined;
};

/** The files one call presented, as cards one under another. Nothing for a call that presented none. */
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
