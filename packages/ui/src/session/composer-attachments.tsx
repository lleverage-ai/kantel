import { useCallback, useEffect, useRef, useState } from "react";
import { FileIcon, RetryIcon, TextFileIcon, XIcon } from "../primitives/icons.tsx";
import { Spinner } from "../primitives/spinner.tsx";
import { formatBytes } from "../workspace/workspace-model.ts";
import { isImage } from "./composer-model.ts";

/** What an attachment is, which decides how the composer shows it. */
export type ComposerAttachmentKind =
	/** A PNG, JPEG, GIF or WebP a model can look at: a thumbnail. */
	| "image"
	/** Any other file: a chip with its name and size. */
	| "file"
	/** Pasted text the composer turned into a file (pasted-text.txt): a chip. */
	| "text";

/**
 * One attachment in the draft, as the host reports it. The host owns the upload: the composer hands it files through
 * `onAttach` and shows what it says back here. `useComposerAttachments` keeps this list for a host that has an
 * upload function and nothing else.
 */
export type ComposerAttachment = {
	/** Stable for the attachment's life in the draft. */
	id: string;
	name: string;
	/** In bytes. */
	size: number;
	/** The MIME type, such as `image/png` or `text/plain`. */
	type: string;
	kind: ComposerAttachmentKind;
	/** A URL the browser can show as the image's thumbnail: an object URL of the file, or the host's own. */
	previewUrl?: string;
	/** `uploading` blocks sending; `failed` blocks it until the attachment is retried or removed. */
	status: "uploading" | "ready" | "failed";
	/** How far the upload is, from 0 to 1. Leave it out when the host can't tell; the composer shows a spinner. */
	progress?: number;
	/** Why the upload failed, in words a person can act on: "The upload timed out." */
	error?: string;
};

/** The kind the composer gives a file. */
export function attachmentKind(file: { name: string; type: string }, pasted = false): ComposerAttachmentKind {
	if (pasted) return "text";
	return isImage(file.type) ? "image" : "file";
}

/** Where a file came from, so a host can treat a paste differently (it may want to skip a virus scan of its text). */
export type AttachSource = "picker" | "drop" | "paste";

/** What the host's upload function gets besides the file. */
export type UploadContext = {
	/** Report how far the upload is, from 0 to 1. Optional: without it the chip shows a spinner. */
	progress: (fraction: number) => void;
	/** Aborted when the person removes the attachment before it finishes. */
	signal: AbortSignal;
	source: AttachSource;
};

/** The host's upload: resolve with whatever the host needs to send the file later (its id on the server). */
export type Upload<R> = (file: File, context: UploadContext) => Promise<R>;

type Entry<R> = {
	attachment: ComposerAttachment;
	file: File;
	source: AttachSource;
	result?: R;
	controller: AbortController;
};

let sequence = 0;
const nextId = () => `attachment-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

export type ComposerAttachments<R> = {
	/** For the composer's `attachments`. */
	attachments: readonly ComposerAttachment[];
	/** For `onAttach`: starts an upload for each file. */
	attach: (files: readonly File[], source: AttachSource) => void;
	/** For `onRemoveAttachment`: aborts its upload if it's still running. */
	remove: (id: string) => void;
	/** For `onRetryAttachment`. */
	retry: (id: string) => void;
	/** Takes the uploaded attachments out of the draft, with what `upload` resolved to: call it in `onSend`. */
	take: () => { attachment: ComposerAttachment; file: File; result: R }[];
	/** Removes everything, aborting what's still uploading. */
	clear: () => void;
};

/**
 * Keeps a draft's attachments for a host that has an upload function and nothing else: starts an upload for each
 * file the composer hands over, reports progress and failure, aborts on remove, makes and frees image thumbnails.
 * The library never uploads anything itself: `upload` is the host's.
 */
export function useComposerAttachments<R>(upload: Upload<R>): ComposerAttachments<R> {
	const entries = useRef(new Map<string, Entry<R>>());
	const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
	const uploadRef = useRef(upload);
	uploadRef.current = upload;

	const publish = useCallback(() => {
		setAttachments([...entries.current.values()].map((entry) => entry.attachment));
	}, []);

	const update = useCallback(
		(id: string, patch: Partial<ComposerAttachment>) => {
			const entry = entries.current.get(id);
			if (entry === undefined) return;
			entry.attachment = { ...entry.attachment, ...patch };
			publish();
		},
		[publish],
	);

	const start = useCallback(
		(entry: Entry<R>) => {
			const { id } = entry.attachment;
			const controller = new AbortController();
			entry.controller = controller;
			let lastPercent = -1;
			uploadRef
				.current(entry.file, {
					signal: controller.signal,
					source: entry.source,
					progress: (fraction) => {
						// Only re-render when the shown percentage changes.
						const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
						if (percent === lastPercent || controller.signal.aborted) return;
						lastPercent = percent;
						update(id, { progress: percent / 100 });
					},
				})
				.then(
					(result) => {
						if (controller.signal.aborted) return;
						entry.result = result;
						update(id, { status: "ready", progress: 1, error: undefined });
					},
					(error: unknown) => {
						if (controller.signal.aborted) return;
						const message = error instanceof Error && error.message !== "" ? error.message : "The upload failed.";
						update(id, { status: "failed", error: message });
					},
				);
		},
		[update],
	);

	const attach = useCallback(
		(files: readonly File[], source: AttachSource) => {
			for (const file of files) {
				const kind = attachmentKind(file, source === "paste" && file.type.startsWith("text/"));
				const entry: Entry<R> = {
					file,
					source,
					controller: new AbortController(),
					attachment: {
						id: nextId(),
						name: file.name,
						size: file.size,
						type: file.type,
						kind,
						status: "uploading",
						...(kind === "image" && typeof URL.createObjectURL === "function"
							? { previewUrl: URL.createObjectURL(file) }
							: {}),
					},
				};
				entries.current.set(entry.attachment.id, entry);
				start(entry);
			}
			publish();
		},
		[publish, start],
	);

	const drop = useCallback((entry: Entry<R>, abort: boolean) => {
		if (abort) entry.controller.abort();
		const url = entry.attachment.previewUrl;
		if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
		entries.current.delete(entry.attachment.id);
	}, []);

	const remove = useCallback(
		(id: string) => {
			const entry = entries.current.get(id);
			if (entry === undefined) return;
			drop(entry, true);
			publish();
		},
		[drop, publish],
	);

	const retry = useCallback(
		(id: string) => {
			const entry = entries.current.get(id);
			if (entry === undefined || entry.attachment.status !== "failed") return;
			entry.attachment = { ...entry.attachment, status: "uploading", progress: undefined, error: undefined };
			publish();
			start(entry);
		},
		[publish, start],
	);

	const take = useCallback(() => {
		const ready: { attachment: ComposerAttachment; file: File; result: R }[] = [];
		for (const entry of [...entries.current.values()]) {
			if (entry.attachment.status !== "ready") continue;
			ready.push({ attachment: entry.attachment, file: entry.file, result: entry.result as R });
			// The thumbnail's object URL stays valid: the host may show the sent image in the transcript.
			entries.current.delete(entry.attachment.id);
		}
		publish();
		return ready;
	}, [publish]);

	const clear = useCallback(() => {
		for (const entry of [...entries.current.values()]) drop(entry, true);
		publish();
	}, [drop, publish]);

	// Leaving the page aborts what's still uploading and frees the thumbnails.
	useEffect(() => {
		const all = entries.current;
		return () => {
			for (const entry of all.values()) {
				entry.controller.abort();
				const url = entry.attachment.previewUrl;
				if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
			}
			all.clear();
		};
	}, []);

	return { attachments, attach, remove, retry, take, clear };
}

// The strip: thumbnails for images, chips for files and pasted text, above the field.

type StripProps = {
	attachments: readonly ComposerAttachment[];
	onRemove?: (id: string) => void;
	onRetry?: (id: string) => void;
	disabled: boolean;
};

function statusText(attachment: ComposerAttachment): string {
	switch (attachment.status) {
		case "uploading":
			return attachment.progress === undefined
				? "uploading"
				: `uploading, ${Math.round(attachment.progress * 100)} percent`;
		case "failed":
			return `failed${attachment.error ? `: ${attachment.error}` : ""}`;
		case "ready":
			return "ready";
	}
}

/** The attachments in the draft. Each says what it is, its size and its upload's state to a screen reader. */
export function AttachmentStrip({ attachments, onRemove, onRetry, disabled }: StripProps) {
	if (attachments.length === 0) return null;
	const images = attachments.filter((attachment) => attachment.kind === "image");
	const files = attachments.filter((attachment) => attachment.kind !== "image");
	return (
		<div className="hb-composer-attachments">
			{images.length === 0 ? null : (
				<ul className="hb-composer-thumbs" aria-label="Attached images">
					{images.map((attachment) => (
						<Thumbnail
							key={attachment.id}
							attachment={attachment}
							onRemove={onRemove}
							onRetry={onRetry}
							disabled={disabled}
						/>
					))}
				</ul>
			)}
			{files.length === 0 ? null : (
				<ul className="hb-composer-chips" aria-label="Attached files">
					{files.map((attachment) => (
						<Chip
							key={attachment.id}
							attachment={attachment}
							onRemove={onRemove}
							onRetry={onRetry}
							disabled={disabled}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

type ItemProps = {
	attachment: ComposerAttachment;
	onRemove?: (id: string) => void;
	onRetry?: (id: string) => void;
	disabled: boolean;
};

function Progress({ attachment }: { attachment: ComposerAttachment }) {
	if (attachment.status !== "uploading") return null;
	if (attachment.progress === undefined) return <Spinner size="sm" />;
	return (
		<span className="hb-composer-progress-text" aria-hidden="true">
			{Math.round(attachment.progress * 100)}%
		</span>
	);
}

function Thumbnail({ attachment, onRemove, onRetry, disabled }: ItemProps) {
	const failed = attachment.status === "failed";
	const uploading = attachment.status === "uploading";
	return (
		<li
			className={`hb-composer-thumb${failed ? " hb-composer-thumb-failed" : ""}`}
			title={failed && attachment.error ? `${attachment.name}: ${attachment.error}` : attachment.name}
		>
			{attachment.previewUrl ? (
				<img className="hb-composer-thumb-image" src={attachment.previewUrl} alt={attachment.name} />
			) : (
				<span className="hb-composer-thumb-image hb-composer-thumb-blank" role="img" aria-label={attachment.name} />
			)}
			<span className="hb-sr-only">
				{attachment.name}, {formatBytes(attachment.size)}, {statusText(attachment)}
			</span>
			{uploading ? (
				<span className="hb-composer-thumb-veil" aria-hidden="true">
					{attachment.progress === undefined ? <Spinner size="sm" /> : null}
				</span>
			) : null}
			{uploading && attachment.progress !== undefined ? (
				<span className="hb-composer-thumb-bar" aria-hidden="true">
					<span className="hb-composer-thumb-bar-fill" style={{ transform: `scaleX(${attachment.progress})` }} />
				</span>
			) : null}
			{failed && onRetry ? (
				<button
					type="button"
					className="hb-composer-thumb-retry hb-focusable"
					aria-label={`Retry ${attachment.name}`}
					title={attachment.error ? `${attachment.error} Retry.` : "Retry"}
					onClick={() => onRetry(attachment.id)}
					disabled={disabled}
				>
					<RetryIcon />
				</button>
			) : null}
			{onRemove ? (
				<button
					type="button"
					className="hb-composer-thumb-remove hb-focusable"
					aria-label={`Remove ${attachment.name}`}
					title="Remove"
					onClick={() => onRemove(attachment.id)}
					disabled={disabled}
				>
					<XIcon size="sm" />
				</button>
			) : null}
		</li>
	);
}

function Chip({ attachment, onRemove, onRetry, disabled }: ItemProps) {
	const failed = attachment.status === "failed";
	const Icon = attachment.kind === "text" ? TextFileIcon : FileIcon;
	return (
		<li
			className={`hb-composer-chip${failed ? " hb-composer-chip-failed" : ""}`}
			title={failed && attachment.error ? `${attachment.name}: ${attachment.error}` : attachment.name}
		>
			<Icon size="sm" className="hb-composer-chip-icon" />
			<span className="hb-composer-chip-name">{attachment.name}</span>
			<span className="hb-composer-chip-meta">
				{failed ? "Failed" : formatBytes(attachment.size)}
				<span className="hb-sr-only">, {statusText(attachment)}</span>
			</span>
			<Progress attachment={attachment} />
			{failed && onRetry ? (
				<button
					type="button"
					className="hb-composer-chip-button hb-focusable"
					aria-label={`Retry ${attachment.name}`}
					title={attachment.error ? `${attachment.error} Retry.` : "Retry"}
					onClick={() => onRetry(attachment.id)}
					disabled={disabled}
				>
					<RetryIcon size="sm" />
				</button>
			) : null}
			{onRemove ? (
				<button
					type="button"
					className="hb-composer-chip-button hb-focusable"
					aria-label={`Remove ${attachment.name}`}
					title="Remove"
					onClick={() => onRemove(attachment.id)}
					disabled={disabled}
				>
					<XIcon size="sm" />
				</button>
			) : null}
		</li>
	);
}
