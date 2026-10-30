/**
 * `create_document`: the agent writes a document for the person, as Claude Docs does. The document is Markdown
 * (headings, lists, tables), saved in the session's workspace under `documents/`, and presented as `present_files`
 * presents a file: a card in the transcript that opens it. A client shows it in its document panel, where the person
 * edits it, and streams the `content` argument into that panel while the model is still writing it.
 *
 * Everything the model is told about it is in its schema; Harbour adds no prompt about it. `title` comes before
 * `content` in the schema, so a model writes it first and a client can name the panel before the text arrives.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkspaceId } from "@harbour/contracts";
import { DEFAULT_ROOT } from "./pi-env.ts";
import { type PresentedFileDetails, workspacePathOf } from "./present-files.ts";

/** The tool's name. */
export const CREATE_DOCUMENT_TOOL = "create_document";
/** Where a document is saved in the workspace. */
export const DOCUMENTS_DIR = "documents";
/** The longest document the tool writes, in characters. */
export const MAX_DOCUMENT_CHARS = 200_000;
/** The longest file name a title makes, before `.md`. */
const MAX_SLUG = 64;

const createDocumentSchema = Type.Object(
	{
		title: Type.String({
			minLength: 1,
			maxLength: 200,
			description: "The document's title, shown to the user above it. Plain text, no Markdown.",
		}),
		content: Type.String({
			minLength: 1,
			maxLength: MAX_DOCUMENT_CHARS,
			description:
				"The whole document as GitHub-flavoured Markdown: headings, paragraphs, bulleted and numbered lists, tables, quotes, code blocks, bold, italic and links. Start with a level 1 heading of the title.",
		}),
	},
	{ additionalProperties: false },
);

const DESCRIPTION = [
	"The create_document tool writes a rich document the user reads, edits and shares in a document panel beside the conversation.",
	"",
	"When to use the create_document tool:",
	"- The user asks for a document, report, plan, guide, brief, letter, summary or other writing to keep, edit or share",
	"- Substantial structured writing (roughly 20 lines or more) the user will come back to",
	"When NOT to use the create_document tool:",
	"- Short answers, explanations and conversation: reply in the chat",
	"- Code, data or other files: write those with the file tools, and show them with present_files",
	"",
	"How it works:",
	"- The document streams into the panel as you write it, then the user can edit it in place",
	`- It is saved in the workspace as Markdown under ${DEFAULT_ROOT}/${DOCUMENTS_DIR}/, named after its title; the result gives its path`,
	"- To change a document later, edit that file with the file tools; to start again, create a new document",
	"- After the call, say in a sentence or two what the document is; don't repeat its contents in the chat",
].join("\n");

/** A file name for a title: lower case, words joined by hyphens, nothing but letters, digits and hyphens. */
export function documentSlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/, "");
	return slug === "" ? "document" : slug;
}

/**
 * `create_document` for one session, whose workspace is `workspaceId`. Writes the document to a new file under
 * `documents/` (never over another one: a second document of the same title gets `-2`), and presents it.
 */
export function createDocumentTool(workspaceId: WorkspaceId): ToolRegistration<typeof createDocumentSchema> {
	return defineTool({
		name: CREATE_DOCUMENT_TOOL,
		description: DESCRIPTION,
		parameters: createDocumentSchema,
		// A call cut short by a restart may have written its file; run again, it writes another rather than lose it.
		replay: "safe",
		executionMode: "sequential",
		async execute(args, api, context) {
			const env = api.env;
			if (env === undefined) throw new Error("This session has no workspace to write a document in");
			const title = args.title.trim();
			if (title === "") throw new Error("A document needs a title");
			const content = args.content.endsWith("\n") ? args.content : `${args.content}\n`;
			const made = await env.createDir(DOCUMENTS_DIR, { recursive: true }, context);
			if (!made.ok) throw new Error(`${DOCUMENTS_DIR}: ${made.error.message}`);
			const slug = documentSlug(title);
			let relative = "";
			for (let attempt = 1; attempt <= 100; attempt++) {
				const candidate = `${DOCUMENTS_DIR}/${attempt === 1 ? slug : `${slug}-${attempt}`}.md`;
				const exists = await env.exists(candidate, context);
				if (!exists.ok) throw new Error(`${candidate}: ${exists.error.message}`);
				if (!exists.value) {
					relative = candidate;
					break;
				}
			}
			if (relative === "") throw new Error(`There are too many documents called ${title}`);
			const written = await env.writeFile(relative, content, context);
			if (!written.ok) throw new Error(`${relative}: ${written.error.message}`);
			const absolute = await env.absolutePath(relative, context);
			const path = absolute.ok ? workspacePathOf(absolute.value) : relative;
			const name = path.split("/").at(-1) ?? path;
			const file: PresentedFileDetails = {
				workspaceId,
				path,
				name,
				mimeType: "text/markdown",
				size: new TextEncoder().encode(content).byteLength,
				title,
			};
			return {
				output: [
					{
						type: "text",
						text: `Created the document "${title}" at ${DEFAULT_ROOT}/${path} and showed it to the user, who can edit it.`,
					},
				],
				details: { presentedFiles: [file] },
			};
		},
	});
}
