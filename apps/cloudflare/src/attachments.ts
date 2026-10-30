/**
 * Prompt attachments on Cloudflare: the files a person attaches in the composer, uploaded before the message is sent
 * and read when it is. Open question 14 in docs/contracts.md, settled as a store the platform owns.
 *
 * - `POST /v1/attachments?projectId=<id>&name=<file name>`, the file's bytes as the body and its type as
 *   `content-type`, stores the file in R2 under the project and answers 201 with its `PromptAttachment`. The operator
 *   role on the project, as for starting a session in it. A file the model can't read is refused here, so the composer
 *   says so on the file's card rather than when the message is sent.
 * - A prompt names its attachments by that reference. The runtime asks `attachmentBlocks` what the model sees of each
 *   (`SessionRuntimeOptions.attachments`), from the session's own project only: an image as image content, a text file
 *   as its text and a PDF as the text in it (pi's messages carry text and images, not documents), each framed by its
 *   name and type so the model can tell the files apart. Nothing else is added to the prompt.
 *
 * A user message is one row in the session's SQLite, which holds at most 2 MB, so what one message carries of its
 * attachments is held to `MESSAGE_BUDGET`: images to `MAX_IMAGE_BYTES` each (the console scales a larger photo down
 * before uploading it), and a long text cut where the budget runs out, saying so.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CallContext,
	HarbourError,
	type ProjectAccess,
	type PromptAttachment,
	type SessionRecord,
} from "@harbour/contracts";
import type { PromptAttachments } from "@harbour/runtime";
import { errorResponse } from "@harbour/runtime/http";
import type { ObjectBucket } from "@harbour/skills/sql";
import { ATTACHMENTS_PATH, MAX_ATTACHMENT_BYTES, readLimited } from "./route.ts";

export { ATTACHMENTS_PATH, MAX_ATTACHMENT_BYTES };
/** The largest image, in bytes: its base64 goes into the message itself. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** The most characters (text, and images' base64) one message carries of its attachments. */
export const MESSAGE_BUDGET = 1_500_000;

/** The image types every provider takes inline. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Types that are text whatever their prefix; anything `text/*` is too. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/javascript",
	"application/typescript",
	"application/x-sh",
	"application/sql",
	"application/graphql",
	"image/svg+xml",
]);

/** Extensions read as text when the browser gives the file no type (or `application/octet-stream`). */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
	(
		"txt md markdown csv tsv json jsonl yaml yml toml ini cfg conf env log xml html htm css scss js mjs cjs jsx ts tsx " +
		"py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish sql graphql proto lua r scala ex exs erl hs " +
		"vue svelte dockerfile makefile gitignore tex rst adoc org diff patch"
	).split(" "),
);

/** How Harbour reads a stored file for the model. */
export type AttachmentFormat = "image" | "pdf" | "text";

function extensionOf(name: string): string {
	const base = name.toLowerCase().split("/").at(-1) ?? "";
	const dot = base.lastIndexOf(".");
	return dot < 0 ? base : base.slice(dot + 1);
}

/** The type the file is stored with: the one given, or one from its extension when the browser gave none. */
export function storedType(name: string, given: string): string {
	const type = given.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type !== "" && type !== "application/octet-stream") return type;
	const extension = extensionOf(name);
	if (extension === "pdf") return "application/pdf";
	if (extension === "png") return "image/png";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "gif") return "image/gif";
	if (extension === "webp") return "image/webp";
	if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
	return type === "" ? "application/octet-stream" : type;
}

/** How the model reads a file of this name and type, or undefined when Harbour can't read it for the model. */
export function formatOf(name: string, type: string): AttachmentFormat | undefined {
	if (IMAGE_TYPES.has(type)) return "image";
	if (type === "application/pdf") return "pdf";
	if (type.startsWith("text/") || TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
	return undefined;
}

/** What is kept beside a file's bytes. */
type StoredAttachment = PromptAttachment & {
	readonly format: AttachmentFormat;
	readonly organisationId: string;
	readonly projectId: string;
	readonly uploadedAt: number;
};

/** Reads a PDF's text, page by page; the default is pdf.js through unpdf, loaded the first time a PDF arrives. */
export type PdfText = (bytes: Uint8Array) => Promise<{ readonly pages: number; readonly text: string }>;

export const unpdfText: PdfText = async (bytes) => {
	const { extractText, getDocumentProxy } = await import("unpdf");
	// pdf.js takes the buffer over, so it gets a copy.
	const pdf = await getDocumentProxy(bytes.slice());
	const { totalPages, text } = await extractText(pdf, { mergePages: false });
	return {
		pages: totalPages,
		text: text
			.map((page) => page.trim())
			.filter((page) => page !== "")
			.join("\n\n"),
	};
};

export interface AttachmentStoreOptions {
	readonly objects: ObjectBucket;
	readonly clock?: { now(): number };
	readonly pdfText?: PdfText;
	readonly newId?: () => string;
}

export interface AttachmentStore {
	/** Stores a file under the project; refuses one the model couldn't read. */
	put(
		scope: { readonly organisationId: string; readonly projectId: string },
		file: { readonly name: string; readonly type: string; readonly bytes: Uint8Array },
	): Promise<PromptAttachment>;
	/** What the model reads of a session's attachments, from the session's project only. */
	readonly reader: PromptAttachments;
}

const keyOf = (organisationId: string, projectId: string, id: string) =>
	`attachments/${encodeURIComponent(organisationId)}/${encodeURIComponent(projectId)}/${id}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Standard base64, built 8 KiB at a time (one `fromCharCode` over megabytes overflows the stack). */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}

/** The reference a caller holds: the stored record without where it lives. */
const publicOf = ({ id, name, type, size, kind }: StoredAttachment): PromptAttachment => ({
	id,
	name,
	type,
	size,
	kind,
});

/** A name safe inside the frame's quotes. */
const quoted = (value: string) => value.replace(/[\r\n"<>]/g, " ");

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
	const { objects } = options;
	const clock = options.clock ?? { now: () => Date.now() };
	const pdfText = options.pdfText ?? unpdfText;
	const newId = options.newId ?? (() => crypto.randomUUID());

	const put: AttachmentStore["put"] = async (scope, file) => {
		const name = file.name.trim().split(/[\\/]/).at(-1)?.slice(0, 255) ?? "";
		if (name === "") throw new HarbourError("invalid", "The file needs a name");
		if (file.bytes.byteLength === 0) throw new HarbourError("invalid", `${name} is empty`);
		const type = storedType(name, file.type);
		const format = formatOf(name, type);
		if (format === undefined) {
			throw new HarbourError(
				"invalid",
				`${name} isn't a type the model can read. Attach an image, a PDF or a text file.`,
			);
		}
		if (format === "image" && file.bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new HarbourError(
				"invalid",
				`${name} is larger than the 1 MB an image can be. Scale it down and try again.`,
			);
		}
		let text: string | undefined;
		if (format === "pdf") {
			const read = await pdfText(file.bytes).catch(() => {
				throw new HarbourError("invalid", `${name} couldn't be read as a PDF`);
			});
			if (read.text.trim() === "") {
				throw new HarbourError(
					"invalid",
					`${name} has no text to read. A scanned PDF needs its pages attached as images.`,
				);
			}
			text = read.text;
		}
		if (format === "text" && file.bytes.includes(0)) {
			throw new HarbourError("invalid", `${name} isn't a text file`);
		}
		const id = newId();
		const record: StoredAttachment = {
			id,
			name,
			type,
			size: file.bytes.byteLength,
			kind: format === "image" ? "image" : name.startsWith("pasted-text") && type === "text/plain" ? "text" : "file",
			format,
			organisationId: scope.organisationId,
			projectId: scope.projectId,
			uploadedAt: clock.now(),
		};
		const key = keyOf(scope.organisationId, scope.projectId, id);
		await objects.put(key, file.bytes);
		// A PDF's text is read once, here, and kept beside it.
		if (text !== undefined) await objects.put(`${key}.txt`, encoder.encode(text));
		await objects.put(`${key}.json`, encoder.encode(JSON.stringify(record)));
		return publicOf(record);
	};

	const load = async (session: SessionRecord, id: string) => {
		// An ID is one this store made: never a path into another key.
		if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new HarbourError("invalid", `No attachment ${id} in this project`);
		const key = keyOf(session.organisationId, session.projectId, id);
		const meta = await objects.get(`${key}.json`);
		if (meta === undefined) throw new HarbourError("not_found", `No attachment ${id} in this project`);
		const record = JSON.parse(decoder.decode(meta)) as StoredAttachment;
		const bytes = await objects.get(record.format === "pdf" ? `${key}.txt` : key);
		if (bytes === undefined) throw new HarbourError("not_found", `Attachment ${record.name} is gone`);
		return { record, bytes };
	};

	const reader: PromptAttachments = {
		async read(_ctx: CallContext, session, attachments) {
			const loaded = await Promise.all(attachments.map((attachment) => load(session, attachment.id)));
			const blocks: (TextContent | ImageContent)[] = [];
			let budget = MESSAGE_BUDGET;
			// Images first: they can't be cut, so they take their share before any text does.
			for (const { record, bytes } of loaded) {
				if (record.format === "image") budget -= Math.ceil(bytes.byteLength / 3) * 4;
			}
			if (budget < 0) {
				throw new HarbourError(
					"invalid",
					"These images are too large to send in one message together. Send fewer at once, or smaller ones.",
				);
			}
			for (const { record, bytes } of loaded) {
				const open = `<file name="${quoted(record.name)}" type="${record.type}">`;
				if (record.format === "image") {
					blocks.push({ type: "text", text: open });
					blocks.push({ type: "image", data: toBase64(bytes), mimeType: record.type });
					blocks.push({ type: "text", text: "</file>" });
					continue;
				}
				const text = decoder.decode(bytes);
				const room = Math.max(0, budget - open.length - 200);
				const cut = text.length > room;
				const shown = cut ? text.slice(0, room) : text;
				budget -= shown.length + open.length;
				const note = cut ? `\n[Cut short: the first ${shown.length} of ${text.length} characters.]` : "";
				blocks.push({ type: "text", text: `${open}\n${shown}${note}\n</file>` });
			}
			return { blocks, attachments: loaded.map(({ record }) => publicOf(record)) };
		},
	};

	return { put, reader };
}

/**
 * The upload route: `POST /v1/attachments?projectId=&name=`, the file as the body. The gateway signs the caller in
 * first; this checks the operator role on the project, reads at most `MAX_ATTACHMENT_BYTES` and stores the file.
 */
export function createAttachmentsApi(options: {
	readonly store: AttachmentStore;
	readonly access: ProjectAccess;
	readonly authenticate: (request: Request) => Promise<CallContext>;
}): (request: Request) => Promise<Response> {
	return async (request) => {
		try {
			if (request.method !== "POST") {
				await request.body?.cancel().catch(() => undefined);
				return Response.json(
					{ error: { code: "invalid", message: "POST only" } },
					{ status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
				);
			}
			const url = new URL(request.url);
			const projectId = url.searchParams.get("projectId") ?? "";
			const name = url.searchParams.get("name") ?? "";
			if (projectId === "" || name === "") {
				await request.body?.cancel().catch(() => undefined);
				throw new HarbourError("invalid", "Name the project and the file: ?projectId=&name=");
			}
			const ctx = await options.authenticate(request);
			await options.access.require(ctx, { projectId, needed: "operator", operation: "attachment.upload" });
			const bytes = await readLimited(request, MAX_ATTACHMENT_BYTES);
			if (bytes === undefined) {
				return Response.json(
					{ error: { code: "invalid", message: `${name} is larger than the 20 MB a file can be` } },
					{ status: 413, headers: { "cache-control": "no-store" } },
				);
			}
			const attachment = await options.store.put(
				{ organisationId: ctx.organisationId, projectId },
				{ name, type: request.headers.get("content-type") ?? "", bytes },
			);
			return Response.json(attachment, { status: 201, headers: { "cache-control": "no-store" } });
		} catch (error) {
			return errorResponse(error);
		}
	};
}
