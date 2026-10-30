// Pictures of a session's files as object URLs, for the transcript's cards: each file read once, however many cards ask
// for it, kept while the session is open, and freed when it closes. A read that fails leaves the card its icon, and
// the next card to ask reads again (the file may still have been being written). Used for the images sent with a
// message (`sent-attachments.ts`) and those a call presented (`image-previews.ts`). The panel a card opens shows the
// same read and URL (`picture`, `shown`), so opening an image fetches and decodes nothing it hasn't already.

type Picture = { readonly content: Uint8Array; readonly contentType: string };

/** A file's read with the object URL made from it. */
export type Shown<R extends Picture> = R & { readonly url: string };

export type ImageUrls<T, R extends Picture = Picture> = {
	url(file: T): Promise<string | undefined>;
	/** The file's read and URL, reading it if no card has yet (or joining the read a card started). */
	picture(file: T): Promise<Shown<R> | undefined>;
	/** The file's read and URL when a read has already finished, at once; undefined otherwise. */
	shown(file: T): Shown<R> | undefined;
	dispose(): void;
};

/**
 * A session's image URLs. `key` names a file (two cards for one file share a read), `read` fetches it, and `type`
 * is the type to assume when the read doesn't say. Pass `objectUrl` and `revoke` to make URLs some other way (a test).
 */
export function createImageUrls<T, R extends Picture>(
	key: (file: T) => string,
	read: (file: T, signal: AbortSignal) => Promise<R>,
	options: {
		readonly type?: (file: T) => string;
		readonly objectUrl?: (blob: Blob) => string;
		readonly revoke?: (url: string) => void;
	} = {},
): ImageUrls<T, R> {
	const { objectUrl = (blob) => URL.createObjectURL(blob), revoke = (url) => URL.revokeObjectURL(url) } = options;
	const pictures = new Map<string, Promise<Shown<R> | undefined>>();
	const done = new Map<string, Shown<R>>();
	const made: string[] = [];
	let disposed = false;
	const picture = (file: T): Promise<Shown<R> | undefined> => {
		const name = key(file);
		let shown = pictures.get(name);
		if (shown === undefined) {
			// Not aborted with the card: another card for the same file, or this one mounting again, takes the same read.
			shown = read(file, new AbortController().signal).then(
				(answer) => {
					const type = answer.contentType || (options.type?.(file) ?? "");
					if (disposed || !type.startsWith("image/")) return undefined;
					const url = objectUrl(new Blob([answer.content as Uint8Array<ArrayBuffer>], { type }));
					made.push(url);
					const ready: Shown<R> = { ...answer, url };
					done.set(name, ready);
					return ready;
				},
				() => {
					pictures.delete(name);
					return undefined;
				},
			);
			pictures.set(name, shown);
		}
		return shown;
	};
	return {
		url: async (file) => (await picture(file))?.url,
		picture,
		shown: (file) => done.get(key(file)),
		dispose() {
			disposed = true;
			for (const url of made.splice(0)) revoke(url);
			pictures.clear();
			done.clear();
		},
	};
}
