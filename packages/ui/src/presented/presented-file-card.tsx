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

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

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

/**
 * The cards' list: one block, the cards close to each other, a block apart from the work above and the words below
 * (docs/spacing.md). session/transcript.css drops the top margin for the first thing in a folded row, through the
 * `hb-presented-files` hook. Exported for the draft card a streaming answer writes in the same wrappers
 * (session/message.tsx).
 */
export const presentedFilesClass =
	"hb-presented-files mx-0 mt-between mb-0 flex list-none flex-col items-stretch gap-within p-0";
/** A card's row in the list, no wider than a card. */
export const presentedFilesItemClass = "hb-presented-files-item flex min-w-0 max-w-card";

/** The square the icon sits in, tinted for the kind of file (as primitives/file-icons.ts's fileTileClass tiles are). */
const iconSquare = "inline-flex size-control-lg flex-none items-center justify-center rounded-control";

/** Each kind's tint: its status colour on that colour's soft ground; text and other files stay neutral. */
const TINTS: { readonly [kind in PresentedKind]: string } = {
	pdf: "bg-status-error-soft text-status-error",
	html: "bg-status-working-soft text-status-working",
	docx: "bg-accent-soft text-accent-text",
	markdown: "bg-accent-soft text-accent-text",
	xlsx: "bg-status-done-soft text-status-done",
	csv: "bg-status-done-soft text-status-done",
	pptx: "bg-status-approval-soft text-status-approval",
	image: "bg-status-waiting-soft text-status-waiting",
	text: "bg-active text-muted",
	other: "bg-active text-muted",
};

/**
 * A card: a rounded, quiet panel with the icon, then the title over its kind. `[font:inherit]` as it may be a button;
 * the border's colour is set by whether it's open (`cardBorder`).
 */
const card =
	"flex w-full min-w-0 items-center gap-3 rounded-bubble border bg-raised py-pad-card pr-4 pl-pad-card text-left text-fg [font:inherit]";

/** A card or tile that opens the file: it lifts on hover. */
const pressable =
	"cursor-pointer transition-colors duration-(--hb-duration-fast) hover:border-border-strong hover:bg-user-message";

/** The border of a card or tile: the accent while its file is open in the viewer. */
const cardBorder = (open: boolean) => (open ? "border-accent" : "border-border");

/** The title over its kind. */
const cardText = "flex min-w-0 flex-1 flex-col gap-0.5";
/** The file's title, cut short with an ellipsis. */
const cardName = "truncate text-md leading-tight font-medium";
/** What kind of file it is, muted, under the title. */
const cardFacts = "truncate text-sm leading-tight text-muted";

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
			<span className={`${iconSquare} ${TINTS[kind]}`} data-kind={kind}>
				<Icon className="hb-icon hb-icon-md" strokeWidth={1.75} aria-hidden="true" />
			</span>
			<span className={cardText}>
				<span className={cardName} title={file.path}>
					{presentedTitle(file)}
				</span>
				<span className={cardFacts}>{presentedSubtitle(file, kind)}</span>
			</span>
		</>
	);
	return onOpen === undefined ? (
		<div className={`hb-presented-card ${card} ${cardBorder(false)}`}>{body}</div>
	) : (
		<button
			type="button"
			className={`hb-presented-card hb-focusable ${card} ${pressable} ${cardBorder(open)}`}
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
		<div className={`hb-presented-card hb-presented-card-draft ${card} ${cardBorder(false)}`} aria-live="polite">
			<span className={`${iconSquare} ${TINTS.markdown}`} data-kind="markdown">
				<FileText className="hb-icon hb-icon-md" strokeWidth={1.75} aria-hidden="true" />
			</span>
			<span className={cardText}>
				<span className={cardName}>{title}</span>
				<span className={cardFacts}>Writing the document</span>
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
/**
 * A tile: the picture as a square, then the name and what it is, in a card as wide as its place. `[font:inherit]` as
 * it may be a button.
 */
const imageTile =
	"m-0 flex w-full min-w-0 flex-col overflow-hidden rounded-bubble border bg-raised p-0 text-left text-fg [font:inherit]";

/**
 * The picture fills a square, cropped rather than squeezed; the viewer shows it whole. The frame before it (and in
 * place of a picture the host has none of) is the same square.
 */
const imageTileSquare = "aspect-square h-auto w-full bg-panel object-cover";

export const ImageTile = memo(function ImageTile({ file, src, onOpen, open = false }: ImageTileProps) {
	const [failed, setFailed] = useState<string>();
	const warm = useWarmHandlers(onOpen === undefined ? undefined : file);
	const title = presentedTitle(file);
	const shown = src === failed ? "none" : src;
	const body = (
		<>
			{shown === "loading" || shown === "none" ? (
				<span
					className={`hb-image-tile-picture hb-image-tile-frame ${imageTileSquare} group/frame flex items-center justify-center text-faint`}
					data-state={shown}
					aria-hidden="true"
				>
					<ImageIcon
						size="md"
						// The icon a little larger than md; `!` because icons.css's .hb-icon-md is unlayered. While the host reads the
						// picture it breathes: opacity alone, as the placeholders' does (hb-pulse is in base.css).
						className="size-control-xs! group-data-[state=loading]/frame:animate-[hb-pulse_var(--hb-duration-pulse)_var(--hb-ease-breathe)_infinite]"
					/>
				</span>
			) : (
				<img
					className={`hb-image-tile-picture block ${imageTileSquare}`}
					src={shown}
					alt={title}
					decoding="async"
					onError={() => setFailed(shown)}
				/>
			)}
			{/* The caption is as wide as the tile: a long name is cut short. */}
			<span className="flex min-w-0 flex-col gap-0.5 border-t border-border px-3 py-2">
				<span className={cardName} title={file.path}>
					{title}
				</span>
				<span className={cardFacts}>{presentedSubtitle(file, "image")}</span>
			</span>
		</>
	);
	return onOpen === undefined ? (
		<figure className={`hb-image-tile ${imageTile} ${cardBorder(false)}`}>{body}</figure>
	) : (
		<button
			type="button"
			className={`hb-image-tile hb-focusable ${imageTile} ${pressable} ${cardBorder(open)}`}
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
 *
 * Each place has a set width, so a tile never takes its size from its picture: a picture that hasn't loaded, or one an
 * engine sizes late (iOS Safari shrank `width: fit-content` cards round a `max-width: 100%` image to their caption's
 * padding), can't squash it. The places read data-many through `group/tiles` (ImageTilesItem).
 */
export function ImageTiles({ label, children }: { label: string; children: readonly ReactNode[] }) {
	return (
		<ul
			className="hb-image-tiles group/tiles m-0 flex min-w-0 list-none flex-wrap items-start gap-within p-0"
			aria-label={label}
			{...(children.length >= 2 ? { "data-many": "" } : {})}
		>
			{children}
		</ul>
	);
}

/** One tile's place in `ImageTiles`. */
export function ImageTilesItem({ children }: { children: ReactNode }) {
	return (
		<li
			// One alone up to --hb-presented-image-size (the column's width on a phone); two or more smaller, four to a row
			// in the content column and two on a phone, never fewer.
			className="hb-image-tiles-item w-[min(100%,var(--hb-presented-image-size))] min-w-0 flex-none group-data-many/tiles:w-[min(calc((100%_-_var(--hb-gap-within))/2),var(--hb-presented-image-size-many))]"
		>
			{children}
		</li>
	);
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
		<ul className={presentedFilesClass} aria-label={files.length === 1 ? "Presented file" : "Presented files"}>
			{runs(files, previewImage !== undefined).map((run) => {
				const first = run[0] as PresentedFile;
				if (previewImage === undefined || presentedKind(first) !== "image") {
					return (
						<li key={presentedKey(first)} className={presentedFilesItemClass}>
							<PresentedFileCard file={first} onOpen={open} open={openKey === presentedKey(first)} />
						</li>
					);
				}
				return (
					<li key={presentedKey(first)} className="hb-presented-images min-w-0">
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
