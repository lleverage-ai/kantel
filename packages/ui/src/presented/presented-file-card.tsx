import type { PresentedFile, ToolItem } from "@harbour/protocol";
import { File, FileCode, FileImage, FileSpreadsheet, FileText, type LucideIcon, Presentation } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { useWarmHandlers } from "../preview/warm.ts";
import { ImageIcon } from "../primitives/icons.tsx";
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

export type ImageTileProps = PresentedFileCardProps & {
	/** The picture's URL; `loading` while it is read (a frame, its icon breathing); `none` when there is none to show. */
	src: string | "loading" | "none";
};

/**
 * An image in the transcript as a tile: a square of the picture (cropped to fill it, `object-fit: cover`), and under it
 * the file's name and what it is. Every image in the transcript is one, whatever showed it (a `generate_image` call's
 * own picture or the host's read of a presented file), so a set of them is one even grid, and a tile is the same size
 * before, while and after its picture loads. Its size comes from the grid it is in (`ImageTiles`), never from the
 * picture, so a picture that has not loaded (or an engine that sizes it late, as iOS Safari did) can't squash it.
 * Pressing it opens the file in the host's viewer.
 */
export const ImageTile = memo(function ImageTile({ file, src, onOpen, open = false }: ImageTileProps) {
	const [failed, setFailed] = useState<string>();
	const warm = useWarmHandlers(onOpen === undefined ? undefined : file);
	const title = presentedTitle(file);
	const shown = src === failed ? "none" : src;
	const body = (
		<>
			{shown === "loading" || shown === "none" ? (
				<span className="hb-image-tile-picture hb-image-tile-frame" data-state={shown} aria-hidden="true">
					<ImageIcon size="md" className="hb-image-tile-icon" />
				</span>
			) : (
				<img
					className="hb-image-tile-picture"
					src={shown}
					alt={title}
					decoding="async"
					onError={() => setFailed(shown)}
				/>
			)}
			<span className="hb-image-tile-caption">
				<span className="hb-presented-name" title={file.path}>
					{title}
				</span>
				<span className="hb-presented-facts">{presentedSubtitle(file, "image")}</span>
			</span>
		</>
	);
	return onOpen === undefined ? (
		<figure className="hb-image-tile">{body}</figure>
	) : (
		<button
			type="button"
			className={`hb-image-tile hb-image-tile-button hb-focusable${open ? " hb-image-tile-open" : ""}`}
			aria-label={`Open ${title}`}
			aria-pressed={open}
			onClick={() => onOpen(file)}
			{...warm}
		>
			{body}
		</button>
	);
});

/**
 * Image tiles side by side, wrapping: one alone up to `--hb-presented-image-size` (the column's width on a phone), two
 * or more up to `--hb-presented-image-size-many` each, and never fewer than two to a row. Each child is one tile.
 */
export function ImageTiles({ label, children }: { label: string; children: readonly ReactNode[] }) {
	return (
		<ul className="hb-image-tiles" aria-label={label} {...(children.length >= 2 ? { "data-many": "" } : {})}>
			{children}
		</ul>
	);
}

/** One tile's place in `ImageTiles`. */
export function ImageTilesItem({ children }: { children: ReactNode }) {
	return <li className="hb-image-tiles-item">{children}</li>;
}

/**
 * A presented image as a tile (`ImageTile`): a frame while the host reads it, then the picture. A file the host has
 * no picture of keeps its tile, with the image icon in the frame. Without a host that previews images, a file's card.
 */
export const PresentedImageCard = memo(function PresentedImageCard({
	file,
	onOpen,
	open = false,
	previewImage,
}: PresentedImageCardProps) {
	const preview = usePreview(file, previewImage);
	if (previewImage === undefined) return <PresentedFileCard file={file} onOpen={onOpen} open={open} />;
	return <ImageTile file={file} src={preview} onOpen={onOpen} open={open} />;
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
					<li key={presentedKey(first)} className="hb-presented-images">
						<ImageTiles label={run.length === 1 ? "Image" : "Images"}>
							{run.map((file) => (
								<ImageTilesItem key={presentedKey(file)}>
									<PresentedImageCard
										file={file}
										onOpen={open}
										open={openKey === presentedKey(file)}
										previewImage={previewImage}
									/>
								</ImageTilesItem>
							))}
						</ImageTiles>
					</li>
				);
			})}
		</ul>
	);
}
