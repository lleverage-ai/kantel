import type { PresentedFile } from "@harbour/protocol";
import { FilePanel, type FilePanelState, saveFile } from "@harbour/ui";
import { useEffect, useState } from "react";
import type { WorkspaceFile } from "../api/client.ts";
import { ApiError } from "../api/http.ts";

// The session screen's viewer for a presented file: reads the file's bytes through the workspace read API (the
// console's own credentials, never a public link) and shows them in the library's FilePanel.

export function PresentedPanel({
	file,
	read,
	onClose,
}: {
	file: PresentedFile;
	read: (file: PresentedFile, signal: AbortSignal) => Promise<WorkspaceFile>;
	onClose: () => void;
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

	return (
		<FilePanel
			file={file}
			state={state}
			onClose={onClose}
			onDownload={state.status === "ready" ? () => saveFile(state.content, file.name, type) : undefined}
		/>
	);
}
