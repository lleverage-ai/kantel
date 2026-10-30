// The composer's attachments for a project: each file the person picks, drops or pastes is uploaded to the project at
// once (`ConsoleClient.uploadAttachment`), shown on its card while it goes, and sent with the next message as a
// reference. A large photo is scaled down in the page first, since an image travels inside the message itself.
import type { UserAttachment } from "@harbour/protocol";
import {
	type AttachmentLimits,
	type ComposerAttachment,
	type ComposerProps,
	isImage,
	useComposerAttachments,
} from "@harbour/ui";
import { useCallback, useMemo } from "react";
import type { ConsoleClient } from "../api/client.ts";

/** What the API takes (apps/cloudflare/src/attachments.ts): images, PDFs and text, 20 MB a file, 10 to a message. */
export const ATTACHMENT_LIMITS: AttachmentLimits = {
	maxFiles: 10,
	maxFileBytes: 20 * 1024 * 1024,
	accept: [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		".pdf",
		"text/*",
		"application/json",
		"application/xml",
		"application/yaml",
		...(
			".txt .md .markdown .csv .tsv .json .jsonl .yaml .yml .toml .ini .cfg .conf .env .log .xml .html .htm .css " +
			".scss .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .kt .swift .c .h .cc .cpp .hpp .cs .php .sh .bash " +
			".zsh .fish .sql .graphql .proto .lua .r .scala .ex .exs .erl .hs .vue .svelte .tex .rst .adoc .org .diff .patch"
		).split(" "),
	],
};

/** The longest edge an image is sent at, as Anthropic suggests; larger ones are scaled down before they go. */
const IMAGE_MAX_EDGE = 1568;
/** The largest image sent as it is; the API takes at most 1 MB, and several share one message. */
const IMAGE_MAX_BYTES = 600 * 1024;

/**
 * The image as it should be sent: as it is when it is small enough, else scaled to `IMAGE_MAX_EDGE` and encoded as
 * JPEG on white, at falling qualities and then smaller sizes until it fits. A GIF small enough keeps its animation.
 * Anything that can't be decoded here goes as it is, for the API to judge.
 */
export async function fitImage(file: File): Promise<File> {
	if (!isImage(file.type) || typeof createImageBitmap !== "function") return file;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		return file;
	}
	try {
		const longest = Math.max(bitmap.width, bitmap.height);
		if (longest <= IMAGE_MAX_EDGE && file.size <= IMAGE_MAX_BYTES) return file;
		let scale = Math.min(1, IMAGE_MAX_EDGE / longest);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const width = Math.max(1, Math.round(bitmap.width * scale));
			const height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d");
			if (context === null) return file;
			context.fillStyle = "#fff";
			context.fillRect(0, 0, width, height);
			context.drawImage(bitmap, 0, 0, width, height);
			for (const quality of [0.86, 0.75, 0.6]) {
				const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
				if (blob !== null && blob.size <= IMAGE_MAX_BYTES) {
					const name = file.name.replace(/\.[^./]+$/, "") || "image";
					return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
				}
			}
			scale *= 0.75;
		}
		return file;
	} finally {
		bitmap.close();
	}
}

/** The composer's attachment props for `projectId`, and the uploaded files' references for a message. */
export function useMessageAttachments(client: ConsoleClient, projectId: string | undefined) {
	const upload = client.uploadAttachment?.bind(client);
	const store = useComposerAttachments<UserAttachment>(
		useCallback(
			async (file, { signal }) => {
				if (upload === undefined || projectId === undefined) throw new Error("This console can't upload files.");
				return upload(projectId, await fitImage(file), signal);
			},
			[upload, projectId],
		),
	);
	const { attachments, attach, remove, retry, ready } = store;
	const composer = useMemo(
		(): Pick<
			ComposerProps,
			"attachments" | "onAttach" | "onRemoveAttachment" | "onRetryAttachment" | "attachmentLimits" | "attachUnavailable"
		> =>
			upload === undefined || projectId === undefined
				? { attachUnavailable: "Attaching files isn't available here" }
				: {
						attachments,
						onAttach: attach,
						onRemoveAttachment: remove,
						onRetryAttachment: retry,
						attachmentLimits: ATTACHMENT_LIMITS,
					},
		[upload, projectId, attachments, attach, remove, retry],
	);
	/** The references of the files `sent` names (the composer's ready attachments), in the order they were attached. */
	const referencesOf = useCallback(
		(sent: readonly ComposerAttachment[]): UserAttachment[] => {
			const ids = new Set(sent.map((attachment) => attachment.id));
			return ready()
				.filter(({ attachment }) => ids.has(attachment.id))
				.map(({ result }) => result);
		},
		[ready],
	);
	/** Takes the files `sent` named out of the draft, once their message has gone. */
	const sentOff = useCallback(
		(sent: readonly ComposerAttachment[]) => {
			for (const attachment of sent) remove(attachment.id);
		},
		[remove],
	);
	return { composer, referencesOf, sentOff };
}
