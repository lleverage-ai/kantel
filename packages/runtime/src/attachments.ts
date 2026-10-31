/**
 * A prompt's attachments, as the model reads them. The host uploaded and stored each file (the prompt carries only a
 * `PromptAttachment` reference); the runtime asks the host for what the model should see of each, and places that
 * ahead of the typed words in the user message. Nothing here adds instructions: each file is its own content, framed by
 * its name and type so the model can tell the files apart and refer to them.
 *
 * Seeing a file is not having it. A session's tools (`generate_image`'s `reference_images`, `read`, `bash`) work on its
 * files, so each attachment the host hands over as uploaded (`ReadAttachments.files`) is also saved in the session's
 * files under `uploads/` (`saveAttachments`), and one line after the files says where (`savedFilesBlock`). Without it
 * the model saw a photo it was asked to edit but had no file to edit (TASK-4265). A session with no files, or a file
 * the workspace refuses, is only read, as before.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type CallContext, KantelError, type PromptAttachment, type SessionRecord } from "@kantel/contracts";

/** One block of what the model reads of an attachment. */
export type AttachmentBlock = TextContent | ImageContent;

/** What the model reads of a prompt's attachments, and the files as the host stored them, for the transcript. */
export interface ReadAttachments {
	readonly blocks: readonly AttachmentBlock[];
	/** The attachments in the order given, named as stored rather than as the caller said. */
	readonly attachments: readonly PromptAttachment[];
	/**
	 * The files as uploaded, in the order given, for the session's files. A host may leave one out (too large to hold),
	 * or give none; those are only read.
	 */
	readonly files?: readonly AttachmentFile[];
}

/** One attachment's bytes as uploaded. */
export interface AttachmentFile {
	readonly attachment: PromptAttachment;
	readonly bytes: Uint8Array;
}

/** Where a prompt's attachments are saved in the session's files. */
export const UPLOADS_DIR = "uploads";

/** One attachment saved in the session's files: its name as uploaded, and its path there. */
export interface SavedAttachment {
	readonly name: string;
	readonly path: string;
}

/** A file name safe as one path segment: no separators or control characters, never `.` or `..`. */
export function uploadName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
	const safe = name.replace(/[\u0000-\u001f\u007f/\\]+/g, "-").trim();
	return safe === "" || safe === "." || safe === ".." ? "file" : safe;
}

/** `name`, or `name-2`, `name-3`… before its extension, for the `attempt`th try (1 is the name itself). */
function numbered(name: string, attempt: number): string {
	if (attempt === 1) return name;
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? `${name}-${attempt}` : `${name.slice(0, dot)}-${attempt}${name.slice(dot)}`;
}

/** How many numbered names `saveAttachments` tries before it gives a file up. */
const MAX_NAME_ATTEMPTS = 50;

/**
 * Saves each file in the session's files under `uploads/`, never over a file already there: a second `image.jpg` (every
 * photo from an iPhone is one) goes in as `image-2.jpg`. Answers the files it saved, in order; one the workspace refuses
 * is left out, so the prompt still goes with what the model can see of it.
 */
export async function saveAttachments(
	env: ExecutionEnv,
	files: readonly AttachmentFile[],
	context: Context,
): Promise<readonly SavedAttachment[]> {
	const saved: SavedAttachment[] = [];
	const taken = new Set<string>();
	for (const { attachment, bytes } of files) {
		const base = uploadName(attachment.name);
		try {
			for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
				const path = `${UPLOADS_DIR}/${numbered(base, attempt)}`;
				if (taken.has(path)) continue;
				const exists = await env.exists(path, context);
				if (!exists.ok) break;
				if (exists.value) continue;
				const written = await env.writeFile(path, bytes, context);
				if (written.ok) {
					taken.add(path);
					saved.push({ name: attachment.name, path });
				}
				break;
			}
		} catch {
			// A workspace that throws rather than answering an error leaves this file unsaved, as a refusal does.
		}
	}
	return saved;
}

/** The line after the files that says where each is saved, so tools that take a path can use it; none when none is. */
export function savedFilesBlock(saved: readonly SavedAttachment[]): TextContent | undefined {
	if (saved.length === 0) return undefined;
	const lines = saved.map(({ name, path }) => `- ${path} (attached as ${name})`);
	return { type: "text", text: `The attached files are saved in the session's files:\n${lines.join("\n")}` };
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
