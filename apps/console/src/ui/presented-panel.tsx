import type { PresentedFile } from "@harbour/protocol";
import { FilePanel, type FilePanelState, presentedTitle, saveFile } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFile, WorkspaceShares } from "../api/client.ts";
import { ApiError } from "../api/http.ts";
import { type Sharer, useFileShare } from "./use-file-share.ts";

// The session screen's viewer for a presented file: reads the file's bytes through the workspace read API (the
// console's own credentials, never a public link) and shows them in the library's FilePanel.

export function PresentedPanel({
	file,
	read,
	onClose,
	sharesOf,
	sharer,
}: {
	file: PresentedFile;
	read: (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;
	onClose: () => void;
	sharesOf?: ((file: PresentedFile) => Promise<WorkspaceShares | undefined>) | undefined;
	sharer?: Sharer | undefined;
}) {
	const [state, setState] = useState<FilePanelState>({ status: "loading" });
	const [type, setType] = useState(file.mimeType);

	useEffect(() => {
		const abort = new AbortController();
		setState({ status: "loading" });
		read(file, abort.signal).then(
			(read) => {
				if (abort.signal.aborted) return;
				setType(read.contentType || file.mimeType);
				setState({ status: "ready", content: read.content });
			},
			(error: unknown) => {
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
			},
		);
		return () => abort.abort();
	}, [file, read]);

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
