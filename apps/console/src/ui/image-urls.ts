// Pictures of a session's files as object URLs, for the transcript's cards: each file read once, however many cards ask
// for it, kept while the session is open, and freed when it closes. A read that fails leaves the card its icon, and
// the next card to ask reads again (the file may still have been being written). Used for the images sent with a
// message (`sent-attachments.ts`) and those a call presented (`image-previews.ts`).

type Picture = { readonly content: Uint8Array; readonly contentType: string };

export type ImageUrls<T> = { url(file: T): Promise<string | undefined>; dispose(): void };

/**
 * A session's image URLs. `key` names a file (two cards for one file share a read), `read` fetches it, and `type`
 * is the type to assume when the read doesn't say. Pass `objectUrl` and `revoke` to make URLs some other way (a test).
 */
export function createImageUrls<T>(
	key: (file: T) => string,
	read: (file: T, signal: AbortSignal) => Promise<Picture>,
	options: {
		readonly type?: (file: T) => string;
		readonly objectUrl?: (blob: Blob) => string;
		readonly revoke?: (url: string) => void;
	} = {},
): ImageUrls<T> {
	const { objectUrl = (blob) => URL.createObjectURL(blob), revoke = (url) => URL.revokeObjectURL(url) } = options;
	const urls = new Map<string, Promise<string | undefined>>();
	const made: string[] = [];
	let disposed = false;
	return {
		url(file) {
			const name = key(file);
			let url = urls.get(name);
			if (url === undefined) {
				// Not aborted with the card: another card for the same file, or this one mounting again, takes the same read.
				url = read(file, new AbortController().signal).then(
					({ content, contentType }) => {
						const type = contentType || (options.type?.(file) ?? "");
						if (disposed || !type.startsWith("image/")) return undefined;
						const picture = objectUrl(new Blob([content as Uint8Array<ArrayBuffer>], { type }));
						made.push(picture);
						return picture;
					},
					() => {
						urls.delete(name);
						return undefined;
					},
				);
				urls.set(name, url);
			}
			return url;
		},
		dispose() {
			disposed = true;
			for (const url of made.splice(0)) revoke(url);
			urls.clear();
		},
	};
}
