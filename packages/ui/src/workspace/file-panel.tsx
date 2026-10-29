import type { PresentedFile } from "@harbour/protocol";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { IconButton } from "../primitives/button.tsx";
import { XIcon } from "../primitives/icons.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { type PresentedKind, presentedKind, presentedKindLabel } from "../session/presented-file-model.ts";
import { framedHtml, HTML_FRAME_SANDBOX } from "./html-frame.ts";
import { NoteMarkdown } from "./note-markdown.tsx";
import { PdfView } from "./pdf-view.tsx";
import { ViewerHeader, ViewerScroll } from "./viewer-header.tsx";
import { fileViewerLineCap, formatBytes, textLines } from "./workspace-model.ts";
import "./file-panel.css";

// The viewer a presented file opens in: a panel that slides in from the right, with the file's name, kind and size,
// Download and Close, then the file rendered by its kind. Presentational: the host reads the bytes (through the
// workspace read API, with its own credentials) and passes them in.

/** What the host has of the file: its bytes, or why there are none to show. */
export type FilePanelState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "too-large" }
	| { readonly status: "ready"; readonly content: Uint8Array };

export type FilePanelProps = {
	file: PresentedFile;
	state: FilePanelState;
	onClose: () => void;
	/** Saves the file. Shown once its bytes are here. */
	onDownload?: (() => void) | undefined;
	/** Kinds the host renders itself (Office files, say), by kind; the panel shows anything else. */
	renderers?: Partial<Record<PresentedKind, (content: Uint8Array, file: PresentedFile) => ReactNode>>;
};

const decoder = new TextDecoder("utf-8");

/** An object URL for an image's bytes, revoked when they change or the panel goes. */
function useObjectUrl(content: Uint8Array | undefined, type: string): string | undefined {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		if (content === undefined) return;
		const made = URL.createObjectURL(new Blob([content as Uint8Array<ArrayBuffer>], { type }));
		setUrl(made);
		return () => {
			URL.revokeObjectURL(made);
			setUrl(undefined);
		};
	}, [content, type]);
	return url;
}

function TextBody({ text, label }: { text: string; label: string }) {
	const shown = useMemo(() => {
		const lines = textLines(text);
		return lines.length > fileViewerLineCap ? lines.slice(0, fileViewerLineCap).join("\n") : text;
	}, [text]);
	return (
		<ViewerScroll label={label} className="hb-file-panel-scroll">
			<pre className="hb-file-panel-text hb-selectable">{shown}</pre>
		</ViewerScroll>
	);
}

function ImageBody({ content, file }: { content: Uint8Array; file: PresentedFile }) {
	const src = useObjectUrl(content, file.mimeType);
	return (
		<ViewerScroll label={`Image ${file.name}`} className="hb-file-panel-scroll hb-file-panel-image">
			{src === undefined ? null : <img src={src} alt={file.name} decoding="async" />}
		</ViewerScroll>
	);
}

function ReadyBody({
	file,
	content,
	renderers,
}: {
	file: PresentedFile;
	content: Uint8Array;
	renderers: FilePanelProps["renderers"];
}) {
	const kind = presentedKind(file);
	const text = useMemo(
		() => (kind === "markdown" || kind === "html" || kind === "text" || kind === "csv" ? decoder.decode(content) : ""),
		[kind, content],
	);
	const own = renderers?.[kind];
	if (own !== undefined) return <>{own(content, file)}</>;
	switch (kind) {
		case "markdown":
			return (
				<ViewerScroll label={`Contents of ${file.name}`} className="hb-file-panel-scroll hb-file-panel-prose">
					<div className="hb-file-panel-measure">
						<NoteMarkdown text={text} />
					</div>
				</ViewerScroll>
			);
		case "html":
			return (
				<iframe
					className="hb-file-panel-frame"
					title={file.name}
					sandbox={HTML_FRAME_SANDBOX}
					referrerPolicy="no-referrer"
					srcDoc={framedHtml(text)}
				/>
			);
		case "pdf":
			return (
				<ViewerScroll label={`Pages of ${file.name}`} className="hb-file-panel-scroll hb-file-panel-sunken">
					<PdfView content={content} name={file.name} />
				</ViewerScroll>
			);
		case "image":
			return <ImageBody content={content} file={file} />;
		case "text":
		case "csv":
			return <TextBody text={text} label={`Contents of ${file.name}`} />;
		default:
			return (
				<EmptyState title="This file can't be shown here yet">Download it to open it on your computer.</EmptyState>
			);
	}
}

function Body({ file, state, renderers }: Omit<FilePanelProps, "onClose" | "onDownload">) {
	switch (state.status) {
		case "loading":
			return (
				<div className="hb-file-panel-loading" aria-busy="true">
					<span className="hb-sr-only">Loading {file.name}</span>
					<Skeleton width="60%" />
					<Skeleton width="85%" />
					<Skeleton width="75%" />
					<Skeleton lines={3} />
				</div>
			);
		case "error":
			return (
				<div className="hb-file-panel-message">
					<Notice level="error">{state.message}</Notice>
				</div>
			);
		case "too-large":
			return (
				<EmptyState title="This file is too large to show here">
					{`At ${formatBytes(file.size)}, it's more than the viewer loads.`}
				</EmptyState>
			);
		case "ready":
			return <ReadyBody file={file} content={state.content} renderers={renderers} />;
	}
}

/** Down into a tray: Download. */
function DownloadIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			className="hb-icon hb-icon-md"
			aria-hidden="true"
		>
			<path d="M8 2.25v8M4.75 7.25 8 10.5l3.25-3.25M2.75 11.5v1.25a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V11.5" />
		</svg>
	);
}

/**
 * A presented file in a panel that slides in from the right: Markdown rendered, HTML in a sandboxed frame, PDF page by
 * page, text and CSV as text, images fitted; other kinds say to download them unless the host renders them
 * (`renderers`). Escape closes it.
 */
export function FilePanel({ file, state, onClose, onDownload, renderers }: FilePanelProps) {
	const id = useId();
	const kind = presentedKind(file);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<aside className="hb-file-panel" aria-labelledby={id} data-kind={kind}>
			<ViewerHeader
				id={id}
				path={file.path}
				title={file.name}
				facts={
					<>
						<span>{presentedKindLabel(kind)}</span>
						<span>{formatBytes(file.size)}</span>
					</>
				}
				actions={
					<>
						{onDownload === undefined || state.status !== "ready" ? null : (
							<IconButton
								variant="ghost"
								label={`Download ${file.name}`}
								icon={<DownloadIcon />}
								onClick={onDownload}
							/>
						)}
						<IconButton variant="ghost" label="Close the viewer" icon={<XIcon />} onClick={onClose} />
					</>
				}
			/>
			<div className="hb-file-panel-body">
				<Body file={file} state={state} renderers={renderers} />
			</div>
		</aside>
	);
}

/** Saves bytes as a file in the browser, as Download does. */
export function saveFile(content: Uint8Array, name: string, type: string): void {
	const url = URL.createObjectURL(new Blob([content as Uint8Array<ArrayBuffer>], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
