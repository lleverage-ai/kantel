import type { UserAttachment } from "@harbour/protocol";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { fileTypeIcon, fileTypeKind, fileTypeLabel } from "../primitives/file-icons.ts";
import { formatBytes } from "../workspace/workspace-model.ts";
import "./attachment-card.css";

// An attached file as a card, after Claude's: one size whatever its name, the image itself for a photo and the file
// type's Lucide icon on its tint for anything else, then the name (cut short, whole on hover) over its type and size.
// The composer's draft and a sent message both show their files with it, in an `AttachmentCards` list.

/** What a card shows of a file. */
export type AttachmentCardFile = {
	readonly name: string;
	/** The MIME type, such as `image/png`. */
	readonly type: string;
	/** In bytes. */
	readonly size: number;
	readonly kind: "image" | "file" | "text";
};

export type AttachmentCardProps = {
	file: AttachmentCardFile;
	/** The image's thumbnail, for an image. Without it, the image's icon. */
	previewUrl?: string | undefined;
	/** In place of the type and size, such as an upload's progress or why it failed. */
	facts?: ReactNode;
	/** Shown as failed: an error border and tint. */
	failed?: boolean;
	/** Opens the file: the whole card is then a button. */
	onOpen?: (() => void) | undefined;
	/** Starts reading the file, as the pointer reaches the card or it takes focus, so opening it is quick. */
	onWarm?: (() => void) | undefined;
	/** Shown as the file open in the panel. */
	open?: boolean;
	/** Buttons at the card's end, such as Remove. */
	actions?: ReactNode;
	/** The tooltip: the whole name by default. */
	title?: string;
	/** For a screen reader, after the name, type and size: an upload's state. */
	status?: string;
};

/** One attached file, at the one size every card has. */
export function AttachmentCard({
	file,
	previewUrl,
	facts,
	failed = false,
	onOpen,
	onWarm,
	open = false,
	actions,
	title,
	status,
}: AttachmentCardProps) {
	const [broken, setBroken] = useState<string>();
	const shown = previewUrl !== undefined && previewUrl !== broken ? previewUrl : undefined;
	const Icon = fileTypeIcon(file);
	const body = (
		<>
			{shown === undefined ? (
				<span className="hb-attachment-card-tile hb-file-tile" data-kind={fileTypeKind(file)}>
					<Icon />
				</span>
			) : (
				<img
					className="hb-attachment-card-tile hb-attachment-card-image"
					src={shown}
					alt=""
					onError={() => setBroken(shown)}
				/>
			)}
			<span className="hb-attachment-card-text">
				<span className="hb-attachment-card-name">{file.name}</span>
				<span className="hb-attachment-card-facts">
					{facts ?? (
						<>
							<span className="hb-attachment-card-fact">{file.kind === "text" ? "Pasted" : fileTypeLabel(file)}</span>
							<span className="hb-attachment-card-fact">{formatBytes(file.size)}</span>
						</>
					)}
				</span>
				{status === undefined ? null : <span className="hb-sr-only">, {status}</span>}
			</span>
		</>
	);
	const className = `hb-attachment-card${failed ? " hb-attachment-card-failed" : ""}`;
	return (
		<div className={className} title={title ?? file.name} data-open={open || undefined}>
			{onOpen === undefined ? (
				<span className="hb-attachment-card-main">{body}</span>
			) : (
				<button
					type="button"
					className="hb-attachment-card-main hb-attachment-card-button hb-focusable"
					aria-label={`Open ${file.name}`}
					aria-pressed={open}
					onClick={onOpen}
					onPointerEnter={onWarm}
					onFocus={onWarm}
					onPointerDown={onWarm}
				>
					{body}
				</button>
			)}
			{actions === undefined ? null : <span className="hb-attachment-card-actions">{actions}</span>}
		</div>
	);
}

/** A row of cards that wraps: right-aligned above a sent message's bubble, left-aligned in the composer. */
export function AttachmentCards({
	label,
	align = "start",
	children,
}: {
	/** The list's name for a screen reader: "Attached files". */
	label: string;
	align?: "start" | "end";
	children: ReactNode;
}) {
	return (
		<ul className="hb-attachment-cards" data-align={align} aria-label={label}>
			{children}
		</ul>
	);
}

/**
 * What the host gives a sent message's attachment cards: each image's thumbnail, and opening a file in its panel.
 * Without it the cards show icons and don't open.
 */
export type SentAttachmentsHost = {
	/** A URL the browser can show as the image's thumbnail; undefined when there is none. Called once per image card. */
	readonly thumbnail?: (attachment: UserAttachment, signal: AbortSignal) => Promise<string | undefined>;
	/** Opens the file, as the transcript's presented files open, in the panel at the right. */
	readonly open?: (attachment: UserAttachment) => void;
	/** Starts reading the file before it is opened: the card's hover, focus or press. */
	readonly warm?: (attachment: UserAttachment) => void;
	/** The attachment open in the panel, by ID, shown as such. */
	readonly openId?: string;
};

export const SentAttachmentsContext = createContext<SentAttachmentsHost>({});

/** An image's thumbnail from the host, once it has one. */
function useThumbnail(attachment: UserAttachment): string | undefined {
	const { thumbnail } = useContext(SentAttachmentsContext);
	const [url, setUrl] = useState<string>();
	const wanted = attachment.kind === "image" && thumbnail !== undefined;
	useEffect(() => {
		if (!wanted || thumbnail === undefined) return;
		const abort = new AbortController();
		thumbnail(attachment, abort.signal).then(
			(found) => {
				if (!abort.signal.aborted) setUrl(found);
			},
			() => {
				// No thumbnail: the card keeps the image's icon.
			},
		);
		return () => abort.abort();
	}, [wanted, thumbnail, attachment]);
	return wanted ? url : undefined;
}

function SentAttachment({ attachment }: { attachment: UserAttachment }) {
	const { open, openId, warm } = useContext(SentAttachmentsContext);
	const previewUrl = useThumbnail(attachment);
	return (
		<li className="hb-attachment-cards-item">
			<AttachmentCard
				file={attachment}
				previewUrl={previewUrl}
				onOpen={open === undefined ? undefined : () => open(attachment)}
				onWarm={warm === undefined ? undefined : () => warm(attachment)}
				open={openId === attachment.id}
			/>
		</li>
	);
}

/** The files sent with a message, above its bubble: a card each, right-aligned with the bubble. */
export function SentAttachments({ attachments }: { attachments: readonly UserAttachment[] }) {
	return (
		<AttachmentCards label="Attached files" align="end">
			{attachments.map((attachment) => (
				<SentAttachment key={attachment.id} attachment={attachment} />
			))}
		</AttachmentCards>
	);
}
