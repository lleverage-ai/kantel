import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { File, FileCode, FileImage, FileSpreadsheet, FileText, type LucideIcon, Presentation } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useWarmHandlers } from "../preview/warm.ts";
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
// An image shows as itself when the host can preview it (`previewImage`); any other file has no preview: pressing the
// card opens the file in the host's viewer, which is where its content is.

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
	const warm = useWarmHandlers(onOpen === undefined ? undefined : file);
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
			{...warm}
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

/**
 * A URL an `<img>` can show for an image file, or undefined when there is none. The host's, usually an object URL of
 * the file's bytes from the workspace read API; keep it stable and cache what it reads.
 */
export type PreviewImageSource = (file: PresentedFile, signal: AbortSignal) => Promise<string | undefined>;

/** An image's preview: `loading` until the host answers, then its URL, or `none` (no host, or it has none). */
function usePreview(file: PresentedFile, previewImage: PreviewImageSource | undefined): string | "loading" | "none" {
	const [preview, setPreview] = useState<string | "loading" | "none">(previewImage === undefined ? "none" : "loading");
	useEffect(() => {
		if (previewImage === undefined) {
			setPreview("none");
			return;
		}
		const abort = new AbortController();
		setPreview("loading");
		previewImage(file, abort.signal).then(
			(url) => {
				if (!abort.signal.aborted) setPreview(url ?? "none");
			},
			() => {
				if (!abort.signal.aborted) setPreview("none");
			},
		);
		return () => abort.abort();
	}, [file, previewImage]);
	return preview;
}

export type PresentedImageCardProps = PresentedFileCardProps & {
	/** The host's previews. Without one, or when it has none for the file, the image is a file's card with its icon. */
	previewImage?: PreviewImageSource | undefined;
};

/**
 * A presented image as a picture, with its name and kind under it: a frame its shape while the host reads it, then the
 * image itself, no wider or taller than an image is shown in the transcript. Pressing it opens the file in the host's
 * viewer. When the host can't preview it, it is a file's card.
 */
export const PresentedImageCard = memo(function PresentedImageCard({
	file,
	onOpen,
	open = false,
	previewImage,
}: PresentedImageCardProps) {
	const preview = usePreview(file, previewImage);
	const [failed, setFailed] = useState(false);
	const warm = useWarmHandlers(onOpen === undefined ? undefined : file);
	if (preview === "none" || failed) return <PresentedFileCard file={file} onOpen={onOpen} open={open} />;
	const title = presentedTitle(file);
	const body = (
		<>
			{preview === "loading" ? (
				<span className="hb-presented-image-frame" aria-hidden="true" />
			) : (
				<img
					className="hb-presented-image-picture"
					src={preview}
					alt={title}
					decoding="async"
					onError={() => setFailed(true)}
				/>
			)}
			<span className="hb-presented-image-caption">
				<span className="hb-presented-name" title={file.path}>
					{title}
				</span>
				<span className="hb-presented-facts">{presentedSubtitle(file, "image")}</span>
			</span>
		</>
	);
	return onOpen === undefined ? (
		<figure className="hb-presented-image">{body}</figure>
	) : (
		<button
			type="button"
			className={`hb-presented-image hb-presented-image-button hb-focusable${open ? " hb-presented-image-open" : ""}`}
			aria-label={`Open ${title}`}
			aria-pressed={open}
			onClick={() => onOpen(file)}
			{...warm}
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
	/** The host's image previews: an image file shows as itself. Without it, every file is a card with its icon. */
	previewImage?: PreviewImageSource | undefined;
};

/** The files in order, with each run of images next to each other together, so they sit side by side. */
function runs(files: readonly PresentedFile[], images: boolean): readonly (readonly PresentedFile[])[] {
	const out: PresentedFile[][] = [];
	let run: PresentedFile[] | undefined;
	let runImages = false;
	for (const file of files) {
		const image = images && presentedKind(file) === "image";
		if (run === undefined || image !== runImages || !image) {
			run = [];
			runImages = image;
			out.push(run);
		}
		run.push(file);
	}
	return out;
}

/**
 * The files one call presented, as cards one under another; with a host that previews images, each image as a
 * picture, side by side with the images next to it. Nothing for a call that presented none.
 */
export function PresentedFiles({ item, onOpen, openKey, previewImage }: PresentedFilesProps) {
	const files = item.status === "done" ? (item.files ?? []) : [];
	if (files.length === 0) return null;
	const open = onOpen === undefined ? undefined : (opened: PresentedFile) => onOpen(opened, item);
	return (
		<ul className="hb-presented-files" aria-label={files.length === 1 ? "Presented file" : "Presented files"}>
			{runs(files, previewImage !== undefined).map((run) => {
				const first = run[0] as PresentedFile;
				if (previewImage === undefined || presentedKind(first) !== "image") {
					return (
						<li key={presentedKey(first)} className="hb-presented-files-item">
							<PresentedFileCard file={first} onOpen={open} open={openKey === presentedKey(first)} />
						</li>
					);
				}
				return (
					<li
						key={presentedKey(first)}
						className="hb-presented-images"
						{...(run.length >= 3 ? { "data-many": "" } : {})}
					>
						{run.map((file) => (
							<PresentedImageCard
								key={presentedKey(file)}
								file={file}
								onOpen={open}
								open={openKey === presentedKey(file)}
								previewImage={previewImage}
							/>
						))}
					</li>
				);
			})}
		</ul>
	);
}
