import { memo, type ReactNode, useId, useMemo, useState } from "react";
import { CopyButton } from "../primitives/controls.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { present, ViewerHeader, ViewerScroll } from "./viewer-header.tsx";
import { entryName, fileViewerLineCap, formatBytes, textLines } from "./workspace-model.ts";
import "./file-viewer.css";

/** What the host has for the file: its text, or why there is none to show. */
export type FileViewState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly text: string; readonly size: number; readonly version?: string | number }
	| { readonly status: "binary"; readonly size: number; readonly contentType?: string }
	| {
			readonly status: "image";
			/**
			 * Where the image's bytes are: an object URL the host made from the content route's answer, or the route's URL
			 * itself when the browser's own credentials reach it.
			 */
			readonly src: string;
			readonly size: number;
			readonly contentType?: string;
	  }
	| { readonly status: "too-large"; readonly size: number };

export type FileViewerProps = {
	/** The file's path in the workspace: "src/app.ts", or "/project/README.md" under a mount. */
	path: string;
	state: FileViewState;
	/** Shows a Back button at the left, for a file opened from the tree on a phone. */
	onBack?: (() => void) | undefined;
	/** Buttons at the right end of the header, after Copy: open the note view, the file's history. */
	actions?: ReactNode;
};

const count = new Intl.NumberFormat("en-GB");

const skeletonWidths = ["38%", "62%", "54%", "70%", "24%", "58%", "46%", "66%", "30%"];

/**
 * The text with its line numbers. The numbers are one block beside the text, hidden from screen readers and from
 * selection, so copying the text copies only the text. Lines never wrap: long ones scroll sideways, with the
 * numbers held at the left.
 */
const FileText = memo(function FileText({ label, text }: { label: string; text: string }) {
	const view = useMemo(() => {
		const lines = textLines(text);
		const shown = lines.length > fileViewerLineCap ? lines.slice(0, fileViewerLineCap) : lines;
		const hidden = lines.length - shown.length;
		const more = hidden === 1 ? "1 more line isn't" : `${count.format(hidden)} more lines aren't`;
		return {
			text: shown.join("\n"),
			numbers: shown.map((_, index) => index + 1).join("\n"),
			cap: hidden === 0 ? undefined : `Showing the first ${count.format(shown.length)} lines. ${more} shown here.`,
		};
	}, [text]);
	return (
		<>
			{view.cap === undefined ? null : (
				<div className="hb-file-viewer-cap">
					<Notice announce={false}>{view.cap}</Notice>
				</div>
			)}
			<ViewerScroll label={label} className="hb-file-viewer-scroll">
				<div className="hb-file-viewer-code">
					<pre className="hb-file-viewer-gutter" aria-hidden="true">
						{view.numbers}
					</pre>
					<pre className="hb-file-viewer-text">
						<code>{view.text}</code>
					</pre>
				</div>
			</ViewerScroll>
		</>
	);
});

type Dimensions = { readonly width: number; readonly height: number };

/**
 * The image, fitted inside the viewer and never scaled past its own size, on a sunken backdrop so its edges show.
 * Its pixel size goes to the header once it has loaded; one the browser can't decode says so instead of a broken icon.
 */
function FileImage({
	name,
	src,
	contentType,
	onDimensions,
}: {
	name: string;
	src: string;
	contentType: string | undefined;
	onDimensions: (dimensions: Dimensions | undefined) => void;
}) {
	const [failed, setFailed] = useState(false);
	if (failed) {
		return (
			<EmptyState title="This image can't be shown here">
				{contentType === undefined
					? "The browser couldn't read it."
					: `The browser couldn't read it as ${contentType}.`}
			</EmptyState>
		);
	}
	return (
		<ViewerScroll label={`Image ${name}`} className="hb-file-viewer-scroll hb-file-viewer-image">
			<img
				className="hb-file-viewer-picture"
				src={src}
				alt={name}
				decoding="async"
				onLoad={(event) => {
					const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
					onDimensions(width > 0 && height > 0 ? { width, height } : undefined);
				}}
				onError={() => {
					setFailed(true);
					onDimensions(undefined);
				}}
			/>
		</ViewerScroll>
	);
}

function FileBody({
	name,
	state,
	onDimensions,
}: {
	name: string;
	state: FileViewState;
	onDimensions: (dimensions: Dimensions | undefined) => void;
}) {
	switch (state.status) {
		case "loading":
			return (
				<div className="hb-file-viewer-loading" aria-busy="true">
					<span className="hb-sr-only">Loading the file</span>
					{skeletonWidths.map((width) => (
						<Skeleton key={width} width={width} />
					))}
				</div>
			);
		case "error":
			return (
				<div className="hb-file-viewer-message">
					<Notice level="error">{state.message}</Notice>
				</div>
			);
		case "binary":
			return (
				<EmptyState title="This file can't be shown here">
					{state.contentType === undefined ? "It isn't a text file." : `It's ${state.contentType}, not text.`}
				</EmptyState>
			);
		case "image":
			// Keyed by its source, so a new image starts without the last one's failure or size.
			return (
				<FileImage
					key={state.src}
					name={name}
					src={state.src}
					contentType={state.contentType}
					onDimensions={onDimensions}
				/>
			);
		case "too-large":
			return (
				<EmptyState title="This file is too large to show here">
					{`At ${formatBytes(state.size)}, it's more than the viewer loads.`}
				</EmptyState>
			);
		case "ready":
			return state.text === "" ? (
				<EmptyState title="This file is empty" />
			) : (
				<FileText label={`Contents of ${name}`} text={state.text} />
			);
	}
}

/**
 * One file's text, read-only: a header with the name, its folder, its size and Copy, then the text in mono with line
 * numbers, scrolling within the viewer. An image is shown fitted to the viewer, with its pixel size in the header.
 * Binary and very large files say they can't be shown; an empty file says so. The text is rendered as text, never as
 * HTML. Presentational: the host reads the file through the workspace read API and passes its state.
 */
export function FileViewer({ path, state, onBack, actions }: FileViewerProps) {
	const id = useId();
	const name = entryName(path) || path;
	const size = state.status === "loading" || state.status === "error" ? undefined : state.size;
	const [loaded, setLoaded] = useState<{ readonly src: string; readonly dimensions: Dimensions }>();
	const src = state.status === "image" ? state.src : undefined;
	const dimensions = loaded !== undefined && loaded.src === src ? loaded.dimensions : undefined;
	const onDimensions = (next: Dimensions | undefined) =>
		setLoaded(src === undefined || next === undefined ? undefined : { src, dimensions: next });
	const copy =
		state.status === "ready" && state.text !== "" ? (
			<CopyButton text={state.text} label="Copy contents" iconOnly variant="ghost" />
		) : null;
	const headerActions =
		copy === null && !present(actions) ? undefined : (
			<>
				{copy}
				{actions}
			</>
		);
	return (
		<section className="hb-file-viewer" aria-labelledby={id}>
			<ViewerHeader
				id={id}
				path={path}
				title={name}
				facts={
					size === undefined ? undefined : (
						<>
							<span>{formatBytes(size)}</span>
							{dimensions === undefined ? null : (
								<span>{`${count.format(dimensions.width)} × ${count.format(dimensions.height)} px`}</span>
							)}
						</>
					)
				}
				onBack={onBack}
				actions={headerActions}
			/>
			<div className="hb-file-viewer-body">
				<FileBody name={name} state={state} onDimensions={onDimensions} />
			</div>
		</section>
	);
}
