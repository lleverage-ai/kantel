/**
 * A prompt's attachments, as the model reads them. The host uploaded and stored each file (the prompt carries only a
 * `PromptAttachment` reference); the runtime asks the host for what the model should see of each, and places that
 * ahead of the typed words in the user message. Nothing here adds instructions: each file is its own content, framed by
 * its name and type so the model can tell the files apart and refer to them.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import { type CallContext, KantelError, type PromptAttachment, type SessionRecord } from "@kantel/contracts";

/** One block of what the model reads of an attachment. */
export type AttachmentBlock = TextContent | ImageContent;

/** What the model reads of a prompt's attachments, and the files as the host stored them, for the transcript. */
export interface ReadAttachments {
	readonly blocks: readonly AttachmentBlock[];
	/** The attachments in the order given, named as stored rather than as the caller said. */
	readonly attachments: readonly PromptAttachment[];
}

/**
 * Reads a prompt's attachments through the host that stored them. `read` answers, in the order given, what the model
 * sees of each: an image as image content, a text file's or a PDF's text as text. It refuses an attachment the session's
 * project doesn't hold (`not_found`) or one it can't read (`invalid`, with the reason in words a person can act on).
 */
export interface PromptAttachments {
	read(ctx: CallContext, session: SessionRecord, attachments: readonly PromptAttachment[]): Promise<ReadAttachments>;
}

/** The most attachments one prompt may carry. */
export const MAX_PROMPT_ATTACHMENTS = 20;

const KINDS: ReadonlySet<unknown> = new Set(["image", "file", "text"]);

/** A prompt body's `attachments`, checked: each a reference with an ID, a name, a type, a size and a kind. */
export function parseAttachments(value: unknown): readonly PromptAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new KantelError("invalid", "attachments must be a list");
	if (value.length > MAX_PROMPT_ATTACHMENTS) {
		throw new KantelError("invalid", `A prompt takes at most ${MAX_PROMPT_ATTACHMENTS} attachments`);
	}
	const seen = new Set<string>();
	return value.map((item: unknown) => {
		const candidate = (typeof item === "object" && item !== null ? item : {}) as Partial<PromptAttachment>;
		const { id, name, type, size, kind } = candidate;
		if (
			typeof id !== "string" ||
			id === "" ||
			typeof name !== "string" ||
			name === "" ||
			typeof type !== "string" ||
			typeof size !== "number" ||
			!Number.isFinite(size) ||
			size < 0 ||
			!KINDS.has(kind)
		) {
			throw new KantelError("invalid", "Each attachment needs an id, name, type, size and kind");
		}
		if (seen.has(id)) throw new KantelError("invalid", `Attachment ${id} is named twice`);
		seen.add(id);
		return { id, name, type, size, kind: kind as PromptAttachment["kind"] };
	});
}

/** The user message for typed words and the attachments' blocks: the files first, then the words, as a person reads. */
export function userInputOf(text: string, blocks: readonly AttachmentBlock[]): UserInput {
	if (blocks.length === 0) return text;
	return text.trim() === "" ? [...blocks] : [...blocks, { type: "text", text }];
}
