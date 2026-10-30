import { useEffect, useState } from "react";
import { EmptyState } from "../../primitives/surface.tsx";
import type { PreviewBodyProps } from "../registry.ts";
import { BodyScroll } from "./scroll.tsx";

// An image, fitted inside the panel and never scaled past its own size, on the sunken backdrop so its edges show. It
// is decoded off the main thread (`img.decode()`) before it's shown, so it appears whole rather than painting in, and
// its pixel size goes to the header. The last few images' object URLs are kept with their decoded state, so opening an
// image again shows it in the first frame.

const count = new Intl.NumberFormat("en-GB");

/** `borrowed`: the host's URL (a card's picture), never revoked here. */
type Decoded = { readonly url: string; readonly width: number; readonly height: number; readonly borrowed?: true };

/** Recent images, by their bytes: their object URL and size once decoded. The oldest is revoked past `KEEP`. */
const recent = new Map<Uint8Array, Decoded | Promise<Decoded>>();
const KEEP = 24;

function decode(bytes: Uint8Array, type: string, given?: string): Decoded | Promise<Decoded> {
	const known = recent.get(bytes);
	if (known !== undefined) {
		recent.delete(bytes);
		recent.set(bytes, known);
		return known;
	}
	// A URL the card has already drawn decodes at once, from the browser's image cache.
	const url = given ?? URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
	const image = new Image();
	image.src = url;
	const pending = image.decode().then(
		() => {
			const done: Decoded = {
				url,
				width: image.naturalWidth,
				height: image.naturalHeight,
				...(given === undefined ? {} : { borrowed: true as const }),
			};
			if (recent.get(bytes) === pending) recent.set(bytes, done);
			return done;
		},
		(reason: unknown) => {
			recent.delete(bytes);
			if (given === undefined) URL.revokeObjectURL(url);
			throw reason;
		},
	);
	recent.set(bytes, pending);
	while (recent.size > KEEP) {
		const [oldest, entry] = recent.entries().next().value as [Uint8Array, Decoded | Promise<Decoded>];
		recent.delete(oldest);
		if (!(entry instanceof Promise) && entry.borrowed !== true) URL.revokeObjectURL(entry.url);
	}
	return pending;
}

export default function ImageBody({ file, bytes, contentType, url, label, onFacts }: PreviewBodyProps) {
	const [state, setState] = useState<{ bytes: Uint8Array; image?: Decoded; failed?: true }>(() => {
		const known = recent.get(bytes);
		return known === undefined || known instanceof Promise ? { bytes } : { bytes, image: known };
	});
	useEffect(() => {
		let live = true;
		const result = decode(bytes, contentType || file.mimeType || "image/png", url);
		if (!(result instanceof Promise)) setState({ bytes, image: result });
		else
			result.then(
				(image) => live && setState({ bytes, image }),
				() => live && setState({ bytes, failed: true }),
			);
		return () => {
			live = false;
		};
	}, [bytes, contentType, file.mimeType, url]);
	const image = state.bytes === bytes ? state.image : undefined;
	useEffect(() => {
		if (image !== undefined) onFacts?.([`${count.format(image.width)} × ${count.format(image.height)} px`]);
	}, [image, onFacts]);
	if (state.bytes === bytes && state.failed) {
		return <EmptyState title="This image can't be shown here">The browser couldn't read it.</EmptyState>;
	}
	return (
		<BodyScroll
			label={label}
			className="grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center bg-sunken p-gutter"
		>
			{image === undefined ? null : (
				<img
					className="block h-auto max-h-full max-w-full rounded-sm object-contain shadow-float"
					src={image.url}
					alt={file.name}
					width={image.width}
					height={image.height}
				/>
			)}
		</BodyScroll>
	);
}
