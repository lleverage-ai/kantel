import type { UserAttachment } from "@harbour/protocol";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { fileTileClass, fileTypeIcon, fileTypeKind, fileTypeLabel } from "../primitives/file-icons.ts";
import { formatBytes } from "../workspace/workspace-model.ts";

// An attached file as a card, after Claude's: one size whatever its name, the image itself for a photo and the file
// type's Lucide icon on its tint for anything else, then the name (cut short, whole on hover) over its type and size.
// The composer's draft and a sent message both show their files with it, in an `AttachmentCards` list.
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The hb- class names stay as hooks (loop/align.ts measures
// the card, its name, facts and tile). The composer (composer-attachments.tsx) renders its own list items and facts,
// so those are styled from here through their parents: the items from the list, the facts from their row.

/**
 * The list: one gap between cards, across and down. Its items (`hb-attachment-cards-item`, the composer's too) are the
 * card's one width, or half the row less the gap when the row is too narrow for two, so a phone shows two a row.
 */
const cardList =
	"hb-attachment-cards flex min-w-0 list-none flex-wrap gap-2 p-0 *:flex *:w-[min(var(--hb-attachment-width),calc((100%_-_var(--hb-step-2))/2))] *:min-w-0 *:flex-none";
/** The card: every one the same height, whatever it holds. */
const card =
	"hb-attachment-card flex h-[calc(var(--hb-control-md)+var(--hb-step-1)*2+var(--hb-hairline)*2)] w-full min-w-0 items-center rounded-control border text-xs leading-none text-fg transition-[background-color,border-color] duration-(--hb-duration-fast) motion-reduce:duration-(--hb-duration-instant)";
/** The tile and the words, the whole card but its actions. */
const cardMain = "hb-attachment-card-main flex h-full min-w-0 flex-1 items-center gap-2 py-1 pr-2.5 pl-1";
/** The main part as a button: the card's shape, the card's type. */
const cardButton =
	"hb-attachment-card-button hb-focusable m-0 cursor-pointer rounded-[inherit] border-0 bg-transparent text-start [color:inherit] [font:inherit]";
/** The thumbnail or the type's icon on its tint. */
const tile = "hb-attachment-card-tile size-control-md flex-none place-items-center rounded-sm";
/** Trimmed to their capitals, so the two lines centre on the tile. */
const trimmed = "py-(--hb-trim-room) [text-box:trim-both_cap_alphabetic]";
/**
 * The type and size, or what the host puts there. Each fact (`hb-attachment-card-fact`, the composer's too) is trimmed
 * like the name; a failed upload's reason may be long, so it is cut short like the name, and whole in the tooltip.
 */
const factRow =
	"hb-attachment-card-facts flex min-w-0 gap-1.5 whitespace-nowrap tabular-nums [&>.hb-attachment-card-fact]:py-(--hb-trim-room) [&>.hb-attachment-card-fact]:[text-box:trim-both_cap_alphabetic]";
const factsFine = "text-muted [&>.hb-attachment-card-fact]:flex-none";
const factsFailed =
	"text-status-error [&>.hb-attachment-card-fact]:min-w-0 [&>.hb-attachment-card-fact]:flex-[0_1_auto] [&>.hb-attachment-card-fact]:overflow-hidden [&>.hb-attachment-card-fact]:text-ellipsis";

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
				<span
					// `!` when failed: fileTileClass tints by kind with `data-[kind=…]:` utilities, which would beat a plain one.
					className={`${tile} ${fileTileClass} grid ${failed ? "bg-status-error-soft! text-status-error!" : ""}`}
					data-kind={fileTypeKind(file)}
				>
					<Icon />
				</span>
			) : (
				<img
					className={`${tile} hb-attachment-card-image block bg-sunken object-cover`}
					src={shown}
					alt=""
					onError={() => setBroken(shown)}
				/>
			)}
			<span className="hb-attachment-card-text flex min-w-0 flex-1 flex-col gap-0.5">
				<span className={`hb-attachment-card-name min-w-0 truncate font-medium ${trimmed}`}>{file.name}</span>
				<span className={`${factRow} ${failed ? factsFailed : factsFine}`}>
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
	// Open, the accent border, failed or not. Failed, the error's fill, until the card's button is hovered.
	const border = open ? "border-accent" : failed ? "border-status-error-line" : "border-border-strong";
	const fill = failed ? "hb-attachment-card-failed bg-status-error-soft" : "bg-raised";
	const className = `${card} ${border} ${fill} has-[.hb-attachment-card-button:hover]:bg-user-message`;
	return (
		<div className={className} title={title ?? file.name} data-open={open || undefined}>
			{onOpen === undefined ? (
				<span className={cardMain}>{body}</span>
			) : (
				<button
					type="button"
					className={`${cardMain} ${cardButton}`}
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
			{actions === undefined ? null : (
				<span className="hb-attachment-card-actions flex flex-none items-center gap-0.5 pr-1">{actions}</span>
			)}
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
		<ul
			// Above a sent message: right-aligned, so the cards' right edge is the bubble's, with the bubble's 80% at most
			// and a card gap less 2px (6px) of clear space above it (the message's own gap makes up the rest).
			className={`${cardList} ${align === "end" ? "mx-0 mt-0 mb-1.5 w-[80%] justify-end" : "m-0"}`}
			data-align={align}
			aria-label={label}
		>
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
