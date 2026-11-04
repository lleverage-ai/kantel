// The file preview: the one panel the console shows a file in, beside the list it was opened from (below it, in its
// place, on a phone). The chrome is the same for every file: one header line with the file's icon, its name and then
// its kind, muted after a drawn dot, and Download and Close on the right. Where it lives and how big it is go in the
// name's tooltip, never a second line. The body is the file's text in the theme's syntax colours, a part at a time
// (`more` reads the next), or one line where there's no preview (a binary). Presentational: the host reads the file.

import type { ReactNode } from "react";
import { Code, languageForPath } from "../code/code.tsx";
import { Button, buttonClass, IconButton } from "../primitives/button.tsx";
import { fileTypeIcon, fileTypeLabel } from "../primitives/file-icons.ts";
import { bytesText } from "../primitives/format.ts";
import { BackIcon, CloseIcon, DownloadIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";

/** What the preview has of the file. */
export type FilePreviewBody =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string; readonly onRetry?: () => void }
	| {
			readonly status: "text";
			readonly text: string;
			/** How many of its bytes are here, and how many it has. */
			readonly shown: number;
			readonly size: number;
			/** Reads the next part; absent where the preview reads no more (the rest is for Download). */
			readonly onMore?: () => void;
			readonly loadingMore?: boolean;
	  }
	/** No preview: a binary, or a file Kantel can't show here. */
	| { readonly status: "none" };

export interface FilePreviewProps {
	readonly name: string;
	/** Where it is, for the name's tooltip. */
	readonly path?: string;
	/** Its size in bytes, where known. */
	readonly size?: number;
	readonly body: FilePreviewBody;
	/** A link that downloads it, where there is one. */
	readonly downloadHref?: string;
	/** Downloads it, where there's no link. */
	readonly onDownload?: () => void;
	readonly downloading?: boolean;
	readonly onClose?: () => void;
	/** On a phone, where the preview takes the list's place: back to the list. */
	readonly onBack?: () => void;
	readonly className?: string;
}

const icon = (node: ReactNode) => node;

/** The preview's header, body and footer, in a panel the host places. */
export function FilePreview({
	name,
	path,
	size,
	body,
	downloadHref,
	onDownload,
	downloading = false,
	onClose,
	onBack,
	className = "",
}: FilePreviewProps) {
	const type = body.status === "text" ? "text/plain" : "";
	const Icon = fileTypeIcon({ name, type });
	const whole = size ?? (body.status === "text" ? body.size : undefined);
	const tooltip = [path ?? name, whole === undefined ? undefined : bytesText(whole)].filter(Boolean).join("\n");
	return (
		<section
			className={`kt-file-preview flex min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel ${className}`}
			aria-label={name}
		>
			<header className="flex min-h-control-lg flex-none items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
				{onBack === undefined ? null : (
					<IconButton
						variant="ghost"
						size="sm"
						label="Back to the folder"
						icon={icon(<BackIcon />)}
						onClick={onBack}
						className="-ml-1.5 lg:hidden"
					/>
				)}
				{/*
				 * One line: the icon, the name, then its kind, muted after a dot. The dot is drawn, not typed (no middle-dot
				 * strings), and hidden from screen readers. Short of room the name truncates; the kind keeps its width.
				 */}
				<h2 className="m-0 flex min-w-0 flex-auto items-center gap-2 text-sm leading-tight font-medium" title={tooltip}>
					<span className="flex flex-none text-muted">
						<Icon size="sm" />
					</span>
					<span className="min-w-0 truncate">{name}</span>
					<span className="flex max-w-2/5 flex-none items-center gap-2 overflow-hidden font-regular whitespace-nowrap text-muted">
						<span className="inline-block size-0.5 flex-none rounded-full bg-current" aria-hidden="true" />
						<span className="kt-sr-only">, </span>
						<span className="min-w-0 truncate">{fileTypeLabel({ name, type })}</span>
					</span>
				</h2>
				<div className="flex flex-none items-center gap-0.5">
					{downloadHref !== undefined ? (
						<a
							className={`${buttonClass("ghost", "sm", true)} no-underline`}
							href={downloadHref}
							download={name}
							aria-label={`Download ${name}`}
							title={`Download ${name}`}
						>
							<DownloadIcon />
						</a>
					) : onDownload !== undefined ? (
						<IconButton
							variant="ghost"
							size="sm"
							label={`Download ${name}`}
							icon={icon(<DownloadIcon />)}
							busy={downloading}
							onClick={onDownload}
						/>
					) : null}
					{onClose === undefined ? null : (
						<IconButton
							variant="ghost"
							size="sm"
							label="Close the preview"
							icon={icon(<CloseIcon />)}
							onClick={onClose}
							className={onBack === undefined ? "" : "max-lg:hidden"}
						/>
					)}
				</div>
			</header>
			<Body name={name} path={path ?? name} size={whole} body={body} />
		</section>
	);
}

function Body({
	name,
	path,
	size,
	body,
}: {
	name: string;
	path: string;
	size: number | undefined;
	body: FilePreviewBody;
}) {
	if (body.status === "loading") {
		return (
			<div className="px-3 py-3" aria-busy="true">
				<span className="kt-sr-only">Loading {name}</span>
				<Skeleton width="60%" />
			</div>
		);
	}
	if (body.status === "error") {
		return (
			<div className="p-2">
				<Notice
					level="error"
					{...(body.onRetry === undefined
						? {}
						: {
								action: (
									<Button size="xs" onClick={body.onRetry}>
										Try again
									</Button>
								),
							})}
				>
					{body.message}
				</Notice>
			</div>
		);
	}
	if (body.status === "none") {
		return (
			<p className="m-0 px-3 py-2.5 text-sm text-muted">
				{size === undefined ? "No preview." : `${bytesText(size)}, no preview.`}
			</p>
		);
	}
	const rest = body.size - body.shown;
	return (
		<>
			<pre
				className="kt-focusable kt-selectable m-0 min-h-0 flex-auto overflow-auto bg-code-surface px-3 py-2.5 font-mono text-code leading-normal text-fg"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
				tabIndex={0}
			>
				<Code code={body.text} language={languageForPath(path)} />
			</pre>
			{rest <= 0 ? null : (
				<div className="flex flex-none items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-sm text-muted">
					<span className="min-w-0 truncate">
						First {bytesText(body.shown)} of {bytesText(body.size)}
					</span>
					{body.onMore === undefined ? null : (
						<Button size="xs" variant="ghost" busy={body.loadingMore === true} onClick={body.onMore}>
							Load more
						</Button>
					)}
				</div>
			)}
		</>
	);
}
