/**
 * `present_files`: the agent shows the person files from its session's workspace. Each becomes a card in the
 * transcript that opens a viewer (PDF, Markdown, HTML, text, Office files) with a download button.
 *
 * It is shaped like Claude's tool of the same name (claude.ai and the Claude apps): one `filepaths` array, the most
 * relevant file first. Everything the model is told about it is in its schema; Harbour adds no prompt about it.
 *
 * The call checks each path is a file it may read, as the session's agent, through the session's execution environment
 * (`./pi-env.ts`), so a path outside the workspace and its mounts is refused exactly as `read` refuses it. It returns
 * the files in its UI details (`details.presentedFiles`), which the transcript projects onto the tool item's `files`
 * (`@harbour/protocol`'s `PresentedFile`): where each file is, never its bytes or a link to them. A client reads the
 * bytes through the workspace read API with its own credentials.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { WorkspaceId } from "@harbour/contracts";
import { DEFAULT_ROOT } from "./pi-env.ts";

/** The tool's name. */
export const PRESENT_FILES_TOOL = "present_files";
/** The most files one call presents. */
export const MAX_PRESENTED_FILES = 20;
/** The most lines and characters of a text file the card previews. */
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 600;

/** One presented file, as the call's UI details carry it (`PresentedFile` in `@harbour/protocol`). */
export type PresentedFileDetails = {
	readonly workspaceId: string;
	readonly path: string;
	readonly name: string;
	readonly mimeType: string;
	readonly size: number;
	readonly preview?: string;
	/** A title to show rather than its name: a document's (`./documents.ts`). */
	readonly title?: string;
};

const MEDIA_TYPES: { readonly [extension: string]: string } = {
	pdf: "application/pdf",
	md: "text/markdown",
	markdown: "text/markdown",
	html: "text/html",
	htm: "text/html",
	txt: "text/plain",
	log: "text/plain",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	xml: "application/xml",
	yaml: "application/yaml",
	yml: "application/yaml",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	doc: "application/msword",
	xls: "application/vnd.ms-excel",
	ppt: "application/vnd.ms-powerpoint",
	zip: "application/zip",
};

/** A file's media type from its name; `application/octet-stream` for one it doesn't know. */
export function presentedMediaType(name: string): string {
	const dot = name.lastIndexOf(".");
	const extension = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
	return MEDIA_TYPES[extension] ?? (extension === "" ? "text/plain" : "application/octet-stream");
}

/** Text a card can preview a few lines of. HTML isn't one: its first lines are markup, not what it shows. */
function previewable(mimeType: string): boolean {
	return (
		mimeType === "text/markdown" ||
		mimeType === "text/plain" ||
		mimeType === "text/csv" ||
		mimeType === "text/tab-separated-values" ||
		mimeType === "application/json" ||
		mimeType === "application/yaml"
	);
}

/** The read API's path for an environment path: relative inside the workspace, absolute under a mount. */
export function workspacePathOf(absolute: string, root = DEFAULT_ROOT): string {
	if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
	return absolute;
}

const presentFilesSchema = Type.Object(
	{
		filepaths: Type.Array(Type.String(), {
			minItems: 1,
			maxItems: MAX_PRESENTED_FILES,
			description: "Array of file paths identifying which files to present to the user",
		}),
	},
	{ additionalProperties: false },
);

const DESCRIPTION = [
	"The present_files tool makes files visible to the user for viewing and rendering in the client interface.",
	"",
	"When to use the present_files tool:",
	"- Making any file available for the user to view, download, or interact with",
	"- Presenting multiple related files at once",
	"- After creating a file that should be presented to the user",
	"When NOT to use the present_files tool:",
	"- When you only need to read file contents for your own processing",
	"- For temporary or intermediate files not meant for user viewing",
	"",
	"How it works:",
	"- Accepts an array of file paths in the workspace (absolute, such as /workspace/report.pdf, or relative to it)",
	"- Each file is shown to the user as a card they can open in a viewer and download; the first one opens on its own",
	"- The viewer renders PDF, Markdown, HTML, plain text, CSV, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx)",
	"- Multiple files can be presented efficiently in a single call",
	"- The first path should be the file most relevant for the user to see first",
	`- At most ${MAX_PRESENTED_FILES} files per call; directories can't be presented`,
].join("\n");

/** The file's first lines, for its card, when it is text and reads as such; nothing otherwise. */
async function previewOf(
	env: ExecutionEnv,
	path: string,
	mimeType: string,
	context: Parameters<ExecutionEnv["readTextLines"]>[2],
): Promise<string | undefined> {
	if (!previewable(mimeType)) return undefined;
	try {
		const lines = await env.readTextLines(path, { maxLines: PREVIEW_LINES }, context);
		if (!lines.ok) return undefined;
		const text = lines.value.join("\n").trimEnd();
		if (text === "" || text.includes("\u0000")) return undefined;
		return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
	} catch {
		return undefined;
	}
}

/**
 * `present_files` for one session, whose workspace is `workspaceId`. Paths resolve as every file tool's do, in the
 * session's environment; a call presents the files it can and says which it couldn't, and fails only when none can be.
 */
export function createPresentFilesTool(workspaceId: WorkspaceId): ToolRegistration<typeof presentFilesSchema> {
	return defineTool({
		name: PRESENT_FILES_TOOL,
		description: DESCRIPTION,
		parameters: presentFilesSchema,
		// It only reads, so a call cut short by a restart runs again.
		replay: "safe",
		// A model writes a file and presents it in the same round. In parallel the present ran before the write and found
		// no file (seen on harbour.myslop.app); a sequential call makes its round run in order.
		executionMode: "sequential",
		async execute(args, api, context) {
			const env = api.env;
			if (env === undefined) throw new Error("This session has no files to present");
			const presented: PresentedFileDetails[] = [];
			const problems: string[] = [];
			const seen = new Set<string>();
			for (const asked of args.filepaths.slice(0, MAX_PRESENTED_FILES)) {
				if (typeof asked !== "string" || asked.trim() === "") {
					problems.push("An empty path can't be presented");
					continue;
				}
				const absolute = await env.absolutePath(asked, context);
				if (!absolute.ok) {
					problems.push(`${asked}: ${absolute.error.message}`);
					continue;
				}
				const info = await env.fileInfo(asked, context);
				if (!info.ok) {
					problems.push(`${asked}: ${info.error.message}`);
					continue;
				}
				if (info.value.kind !== "file") {
					problems.push(`${absolute.value} is a directory; present the files in it instead`);
					continue;
				}
				const path = workspacePathOf(absolute.value);
				if (seen.has(path)) continue;
				seen.add(path);
				const name =
					path
						.split("/")
						.filter((part) => part !== "")
						.at(-1) ?? path;
				const mimeType = presentedMediaType(name);
				const preview = await previewOf(env, asked, mimeType, context);
				presented.push({
					workspaceId,
					path,
					name,
					mimeType,
					size: info.value.size,
					...(preview === undefined ? {} : { preview }),
				});
			}
			const lines: string[] = [];
			if (presented.length > 0) {
				lines.push(
					`Presented ${presented.length === 1 ? "1 file" : `${presented.length} files`} to the user:`,
					...presented.map((file) => (file.path.startsWith("/") ? file.path : `${DEFAULT_ROOT}/${file.path}`)),
				);
			}
			if (problems.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push(presented.length === 0 ? "No file was presented:" : "Not presented:", ...problems);
			}
			return {
				output: [{ type: "text", text: lines.join("\n") }],
				isError: presented.length === 0,
				...(presented.length === 0 ? {} : { details: { presentedFiles: presented } }),
			};
		},
	});
}
