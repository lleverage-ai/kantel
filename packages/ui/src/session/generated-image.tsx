import type { PresentedFile, ToolImage, ToolItem } from "@harbour/protocol";
import { memo } from "react";
import { PresentedFileCard } from "../presented/presented-file-card.tsx";
import { presentedKey, presentedTitle } from "../presented/presented-file-model.ts";
import { ImageIcon } from "../primitives/icons.tsx";
import { toolImageSrc } from "./tool-call.tsx";
import "./generated-image.css";

// The images `generate_image` makes, in the transcript: while the call runs, a placeholder the shape of each image it
// asked for; once it is done, each image as a card under the work, with the model that made it.

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
		<div className="hb-image-placeholder" data-aspect={aspect} aria-hidden="true">
			<span className="hb-image-placeholder-sweep" />
			<ImageIcon size="md" className="hb-image-placeholder-icon" />
		</div>
	);
}

/** The placeholders for a running `generate_image` call: one per image it asked for, in the shape it asked for. */
export const ImagePlaceholders = memo(function ImagePlaceholders({ item }: { item: ToolItem }) {
	const { aspect, count } = imageRequest(item.args);
	return (
		<div className="hb-generated-images" role="status">
			<span className="hb-sr-only">{count === 1 ? "Making an image" : `Making ${count} images`}</span>
			{Array.from({ length: count }, (_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: placeholders are identical and never reorder.
				<ImagePlaceholder key={index} aspect={aspect} />
			))}
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
};

/**
 * One generated image as a card: the picture, and under it the file's name and the model that made it. Pressing it
 * opens the file in the host's viewer. Without a picture to show (the call returned none) it is a file's card.
 */
export const GeneratedImageCard = memo(function GeneratedImageCard({
	file,
	image,
	onOpen,
	open = false,
}: GeneratedImageCardProps) {
	if (image === undefined) return <PresentedFileCard file={file} onOpen={onOpen} open={open} />;
	const title = presentedTitle(file);
	const model = madeWith(file);
	const body = (
		<>
			<img
				className="hb-generated-image-picture"
				src={toolImageSrc(image)}
				alt={title}
				loading="lazy"
				decoding="async"
			/>
			<span className="hb-generated-image-caption">
				<span className="hb-generated-image-name" title={file.path}>
					{title}
				</span>
				{model === undefined ? null : <span className="hb-generated-image-model">{model}</span>}
			</span>
		</>
	);
	return onOpen === undefined ? (
		<figure className="hb-generated-image">{body}</figure>
	) : (
		<button
			type="button"
			className={`hb-generated-image hb-generated-image-button hb-focusable${open ? " hb-generated-image-open" : ""}`}
			aria-label={`Open ${title}`}
			aria-pressed={open}
			onClick={() => onOpen(file)}
		>
			{body}
		</button>
	);
});

export type GeneratedImagesProps = {
	/** A finished `generate_image` call: its `files`, and its `images` when there is one for each file. */
	item: ToolItem;
	onOpen?: ((file: PresentedFile, item: ToolItem) => void) | undefined;
	/** The key (`presentedKey`) of the file open in the viewer, if any. */
	openKey?: string | undefined;
};

/** The images one `generate_image` call made, as cards side by side. */
export function GeneratedImages({ item, onOpen, openKey }: GeneratedImagesProps) {
	const files = item.status === "done" ? (item.files ?? []) : [];
	if (files.length === 0) return null;
	// The call's pictures are its files' only when there is one for each: an image too large to scale down has none.
	const images = item.images?.length === files.length ? item.images : undefined;
	return (
		<ul className="hb-generated-images" aria-label={files.length === 1 ? "Generated image" : "Generated images"}>
			{files.map((file, index) => (
				<li key={presentedKey(file)} className="hb-generated-images-item">
					<GeneratedImageCard
						file={file}
						image={images?.[index]}
						onOpen={onOpen === undefined ? undefined : (opened) => onOpen(opened, item)}
						open={openKey === presentedKey(file)}
					/>
				</li>
			))}
		</ul>
	);
}
