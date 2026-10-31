import type { PresentedFile, ToolImage, ToolItem } from "@kantel/protocol";
import { memo } from "react";
import {
	ImageTile,
	ImageTiles,
	ImageTilesItem,
	PresentedImageCard,
	type PreviewImageSource,
} from "../presented/presented-file-card.tsx";
import { presentedKey } from "../presented/presented-file-model.ts";
import { ImageIcon } from "../primitives/icons.tsx";
import { toolImageSrc } from "./tool-call.tsx";
import "./generated-image.css";

// The images `generate_image` makes, in the transcript: while the call runs, a placeholder the shape of each image it
// asked for; once it is done, each image as a tile under the work (`ImageTile`, as every image in the transcript is),
// with the model that made it.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md); generated-image.css keeps the
// placeholder's sweep and breathing (keyframes). The kt- class names stay as hooks for tests and stories.

/** The images' block in the transcript, under the work. */
export const generatedImagesFrame = "kt-generated-images mx-0 mt-2 mb-1 min-w-0";

/** The shape `generate_image` was asked for. */
export type ImageAspect = "square" | "landscape" | "portrait";

/** What a `generate_image` call asked for, from its arguments: the shape and how many. Square and one by default. */
export function imageRequest(args: unknown): { readonly aspect: ImageAspect; readonly count: number } {
	const input = typeof args === "object" && args !== null ? (args as { readonly [key: string]: unknown }) : {};
	const aspect = input.aspect === "landscape" || input.aspect === "portrait" ? input.aspect : "square";
	const count =
		typeof input.count === "number" && Number.isInteger(input.count) ? Math.min(4, Math.max(1, input.count)) : 1;
	return { aspect, count };
}

/** Whether a call is a `generate_image` still running: its placeholders show. */
export const makingImages = (item: ToolItem): boolean => item.name === "generate_image" && item.status === "running";

/**
 * One image being made: a frame the shape of the image to come, a light moving slowly across it and an image icon
 * breathing in its middle. Both animate transform and opacity alone, which the compositor runs without the main thread.
 */
export function ImagePlaceholder({ aspect = "square" }: { aspect?: ImageAspect }) {
	return (
		// A frame the shape of the image to come (gpt-image's 1024 square, 1536 by 1024 and 1024 by 1536), as wide as its
		// place in the grid, and rounded as the tile the image becomes.
		<div
			className="kt-image-placeholder relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-bubble border border-border-strong bg-panel text-faint data-[aspect=landscape]:aspect-3/2 data-[aspect=portrait]:aspect-2/3"
			data-aspect={aspect}
			aria-hidden="true"
		>
			<span className="kt-image-placeholder-sweep" />
			{/* `!`: the icon's own size (icons.css's .kt-icon-md, unlayered) would beat a plain utility. */}
			<ImageIcon size="md" className="kt-image-placeholder-icon relative size-control-xs!" />
		</div>
	);
}

/**
 * The placeholders for a running `generate_image` call: one per image it asked for, in the shape it asked for, as wide
 * as the tiles the images become.
 */
export const ImagePlaceholders = memo(function ImagePlaceholders({ item }: { item: ToolItem }) {
	const { aspect, count } = imageRequest(item.args);
	return (
		<div className={generatedImagesFrame} role="status">
			<span className="kt-sr-only">{count === 1 ? "Making an image" : `Making ${count} images`}</span>
			<ImageTiles label={count === 1 ? "Image to come" : "Images to come"}>
				{Array.from({ length: count }, (_, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and never reorder.
					<ImageTilesItem key={index}>
						<ImagePlaceholder aspect={aspect} />
					</ImageTilesItem>
				))}
			</ImageTiles>
		</div>
	);
});

/** "Made with gpt-image-1": the model that made a file, for its card and the viewer. */
export function madeWith(file: Pick<PresentedFile, "model">): string | undefined {
	return file.model === undefined ? undefined : `Made with ${file.model}`;
}

export type GeneratedImageCardProps = {
	file: PresentedFile;
	/** The picture to show, as the call returned it (scaled down when the file is large). */
	image: ToolImage | undefined;
	onOpen?: ((file: PresentedFile) => void) | undefined;
	open?: boolean;
	/** The host's previews, for an image the call returned no picture of (too large to scale down). */
	previewImage?: PreviewImageSource | undefined;
};

/**
 * One generated image as a tile (`ImageTile`): the picture, and under it the file's name and "PNG image made with
 * gpt-image-1". Pressing it opens the file in the host's viewer. Without a picture from the call (the image was too
 * large to scale down) the tile shows the host's read of the file (`PresentedImageCard`); without a host either, it is
 * a file's card.
 */
export const GeneratedImageCard = memo(function GeneratedImageCard({
	file,
	image,
	onOpen,
	open = false,
	previewImage,
}: GeneratedImageCardProps) {
	if (image === undefined) {
		return <PresentedImageCard file={file} onOpen={onOpen} open={open} previewImage={previewImage} />;
	}
	return <ImageTile file={file} src={toolImageSrc(image)} onOpen={onOpen} open={open} />;
});

export type GeneratedImagesProps = {
	/** A finished `generate_image` call: its `files`, and its `images` when there is one for each file. */
	item: ToolItem;
	onOpen?: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key (`presentedKey`) of the file open in the viewer, if any. */
	openKey?: string | undefined;
	/** The host's previews, for an image the call returned no picture of. */
	previewImage?: PreviewImageSource | undefined;
};

/** The images one `generate_image` call made, as tiles side by side, wrapping (`ImageTiles`). */
export function GeneratedImages({ item, onOpen, openKey, previewImage }: GeneratedImagesProps) {
	const files = item.status === "done" ? (item.files ?? []) : [];
	if (files.length === 0) return null;
	// The call's pictures are its files' only when there is one for each: an image too large to scale down has none.
	const images = item.images?.length === files.length ? item.images : undefined;
	return (
		<div className={generatedImagesFrame}>
			<ImageTiles label={files.length === 1 ? "Generated image" : "Generated images"}>
				{files.map((file, index) => (
					<ImageTilesItem key={presentedKey(file)}>
						<GeneratedImageCard
							file={file}
							image={images?.[index]}
							onOpen={onOpen === undefined ? undefined : (opened) => onOpen(opened, item)}
							open={openKey === presentedKey(file)}
							previewImage={previewImage}
						/>
					</ImageTilesItem>
				))}
			</ImageTiles>
		</div>
	);
}
