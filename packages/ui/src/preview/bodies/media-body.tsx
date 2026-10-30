import type { PreviewBodyProps } from "../registry.ts";
import { rendererFor } from "../registry.ts";
import { useObjectUrl } from "./object-url.ts";

// Audio and video, in the browser's own player, from the bytes the host read (an object URL, so the console's
// credentials never go into a media URL). Video fits the panel on the sunken backdrop; audio sits centred.

export default function MediaBody({ file, bytes, contentType }: PreviewBodyProps) {
	const kind = rendererFor(file, contentType).kind;
	const url = useObjectUrl(bytes, contentType || file.mimeType || (kind === "audio" ? "audio/mpeg" : "video/mp4"));
	return (
		<div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center bg-sunken p-gutter">
			{url === undefined ? null : kind === "audio" ? (
				// biome-ignore lint/a11y/useMediaCaption: a file from the workspace has no captions to offer.
				<audio className="w-full max-w-doc" src={url} controls preload="metadata" aria-label={file.name} />
			) : (
				// biome-ignore lint/a11y/useMediaCaption: a file from the workspace has no captions to offer.
				<video
					className="block max-h-full max-w-full rounded-sm shadow-float"
					src={url}
					controls
					playsInline
					preload="metadata"
					aria-label={file.name}
				/>
			)}
		</div>
	);
}
