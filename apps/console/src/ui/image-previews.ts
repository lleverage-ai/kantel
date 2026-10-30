// The pictures of the images a session's calls presented, for their cards in the transcript (`previewImage`): read
// through the workspace read API (the console's own credentials, never a public link), once per file, and freed when
// the session closes (`image-urls.ts`). The panel an image's card opens shows the same read (`picture`, `shown`).

import type { PresentedFile } from "@harbour/protocol";
import { presentedKey } from "@harbour/ui";
import { useEffect, useState } from "react";
import type { WorkspaceFile } from "../api/client.ts";
import { createImageUrls, type ImageUrls } from "./image-urls.ts";

type Read = (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;

/** A session's image previews, from its workspace reads. Pass `objectUrl` to make URLs some other way (a test). */
export function createImagePreviews(
	read: Read,
	objectUrl?: (blob: Blob) => string,
	revoke?: (url: string) => void,
): ImageUrls<PresentedFile, WorkspaceFile> {
	return createImageUrls(presentedKey, read, {
		type: (file) => file.mimeType,
		...(objectUrl === undefined ? {} : { objectUrl }),
		...(revoke === undefined ? {} : { revoke }),
	});
}

export type ImagePreviews = ImageUrls<PresentedFile, WorkspaceFile>;

/** The session view's image previews: undefined while the session can't read its workspace. */
export function useImagePreviews(read: Read | undefined): ImagePreviews | undefined {
	// Made in the effect, so previews freed when the session closes (or React mounts it again) are never used again.
	const [previews, setPreviews] = useState<ImagePreviews>();
	useEffect(() => {
		if (read === undefined) {
			setPreviews(undefined);
			return;
		}
		const next = createImagePreviews(read);
		setPreviews(next);
		return () => next.dispose();
	}, [read]);
	return previews;
}
