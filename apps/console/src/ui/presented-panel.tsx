import type { PresentedFile } from "@harbour/protocol";
import { FilePanel, type FilePanelState, presentedKind, presentedTitle, saveFile } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFile, WorkspaceShares } from "../api/client.ts";
import { ApiError } from "../api/http.ts";
import type { ImagePreviews } from "./image-previews.ts";
import { type Sharer, useFileShare } from "./use-file-share.ts";

// The session screen's viewer for a presented file: reads the file's bytes through the workspace read API (the
// console's own credentials, never a public link) and shows them in the library's FilePanel. An image its card has
// already read (`images`) shows at once from that read and URL, already decoded; the panel then checks the file
// hasn't changed since, and shows the new bytes if it has.

/** What the panel starts on: an image its card has read, or loading. */
function initial(file: PresentedFile, images: ImagePreviews | undefined): FilePanelState {
	const shown = images?.shown(file);
	return shown === undefined ? { status: "loading" } : { status: "ready", content: shown.content, url: shown.url };
}

export function PresentedPanel({
	file,
	read,
	onClose,
	sharesOf,
	sharer,
	images: previews,
}: {
	file: PresentedFile;
	read: (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;
	onClose: () => void;
	sharesOf?: ((file: PresentedFile) => Promise<WorkspaceShares | undefined>) | undefined;
	sharer?: Sharer | undefined;
	/** The session's image previews: an image opens from its card's read rather than reading it again. */
	images?: ImagePreviews | undefined;
}) {
	const images = presentedKind(file) === "image" ? previews : undefined;
	const [state, setState] = useState<FilePanelState>(() => initial(file, images));
	const [type, setType] = useState(() => images?.shown(file)?.contentType || file.mimeType);

	useEffect(() => {
		const abort = new AbortController();
		const show = (read: WorkspaceFile, url?: string) => {
			if (abort.signal.aborted) return;
			setType(read.contentType || file.mimeType);
			// The picture the panel opened on is left as it is: nothing to render again.
			setState((now) =>
				now.status === "ready" && now.content === read.content && now.url === url
					? now
					: { status: "ready", content: read.content, ...(url === undefined ? {} : { url }) },
			);
		};
		const readFresh = () =>
			read(file, abort.signal).then(show, (error: unknown) => {
				if (abort.signal.aborted) return;
				if (error instanceof ApiError && error.code === "too_large") setState({ status: "too-large" });
				else if (error instanceof ApiError && error.code === "not_found") {
					setState({ status: "error", message: `${file.name} is no longer in the workspace.` });
				} else {
					setState({
						status: "error",
						message: `${file.name} couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			});
		if (images === undefined) {
			setState({ status: "loading" });
			readFresh();
			return () => abort.abort();
		}
		// An image: its card's read, at once when it has finished, or joined while it is under way.
		const cached = images.shown(file);
		if (cached === undefined) setState({ status: "loading" });
		void Promise.resolve(cached ?? images.picture(file)).then((picture) => {
			if (abort.signal.aborted) return;
			if (picture === undefined) {
				readFresh();
				return;
			}
			show(picture, picture.url);
			// The card's read may be older than the file: read it again (a 304 while it is the same) and show it if it
			// changed. A failure here leaves the picture.
			read(file, abort.signal).then(
				(now) => {
					if (now.digest !== undefined && now.digest !== picture.digest) show(now);
				},
				() => {},
			);
		});
		return () => abort.abort();
	}, [file, read, images]);

	const download = useMemo(
		() => (state.status === "ready" ? () => saveFile(state.content, file.name, type) : undefined),
		[state, file.name, type],
	);
	const sharing = useFileShare(file, presentedTitle(file), sharesOf, sharer);
	return (
		<FilePanel
			file={file}
			state={state}
			onClose={onClose}
			onDownload={download}
			{...(sharing === undefined
				? {}
				: {
						share: {
							sharing,
							exports:
								download === undefined
									? []
									: [{ id: "download", label: "Download", hint: `The file as it is, ${file.name}`, run: download }],
						},
					})}
		/>
	);
}
