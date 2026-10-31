import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CallContext } from "@kantel/contracts";
import { createMemorySandboxes } from "@kantel/sandbox/memory";
import { createSandboxExecutionEnv } from "@kantel/sandbox/pi-env";
import {
	createPresentFilesTool,
	MAX_PRESENTED_FILES,
	PRESENT_FILES_TOOL,
	presentedMediaType,
	workspacePathOf,
} from "@kantel/sandbox/present-files";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const ORG = { kind: "organisation", organisationId: "org-1" } as const;

async function setUp() {
	const projectFiles = createMemoryProjectFiles();
	await projectFiles.seed("proj-1", { "brief.md": "# Brief\n" });
	const workspaces = createMemoryWorkspaces({ sources: [projectFiles] });
	const record = await workspaces.create(ctx, {
		owner: ORG,
		seed: {
			name: "s",
			sources: [
				{
					kind: "files",
					files: {
						"out/report.md": "# Report\n\nThe numbers are in.\n",
						"out/page.html": "<!doctype html><h1>Hi</h1>",
						"out/data.csv": "a,b\n1,2\n",
						"out/deck.pdf": "%PDF-1.7\n",
					},
				},
			],
		},
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const env = createSandboxExecutionEnv({
		ctx,
		sessionId: "sess-1",
		workspaceId: record.id,
		sandboxes: createMemorySandboxes({ workspaces }),
		workspaces,
	});
	const tool = createPresentFilesTool(record.id);
	const present = (filepaths: string[]) =>
		tool.execute({ filepaths }, { env } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
	return { workspaceId: record.id, present };
}

describe("present_files", () => {
	it("is shaped like Claude's tool: one required filepaths array, nothing else", () => {
		const tool = createPresentFilesTool("ws-1" as never);
		expect(tool.name).toBe(PRESENT_FILES_TOOL);
		expect(tool.name).toBe("present_files");
		const schema = tool.parameters as unknown as {
			required: string[];
			additionalProperties: boolean;
			properties: { filepaths: { type: string; items: { type: string }; maxItems: number } };
		};
		expect(schema.required).toEqual(["filepaths"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.filepaths.type).toBe("array");
		expect(schema.properties.filepaths.items.type).toBe("string");
		expect(schema.properties.filepaths.maxItems).toBe(MAX_PRESENTED_FILES);
		expect(tool.description).toContain("When NOT to use the present_files tool");
		// Its round runs in order, so a file written in the same round exists when it is presented.
		expect(tool.executionMode).toBe("sequential");
	});

	it("presents workspace files by absolute or relative path, with a preview for text", async () => {
		const { workspaceId, present } = await setUp();
		const result = await present(["/workspace/out/report.md", "out/page.html", "out/data.csv", "out/deck.pdf"]);
		expect(result.isError).toBe(false);
		const files = (result.details as { presentedFiles: unknown[] }).presentedFiles;
		expect(files).toEqual([
			{
				workspaceId,
				path: "out/report.md",
				name: "report.md",
				mimeType: "text/markdown",
				size: 30,
				preview: "# Report\n\nThe numbers are in.",
			},
			{ workspaceId, path: "out/page.html", name: "page.html", mimeType: "text/html", size: 26 },
			{ workspaceId, path: "out/data.csv", name: "data.csv", mimeType: "text/csv", size: 8, preview: "a,b\n1,2" },
			{ workspaceId, path: "out/deck.pdf", name: "deck.pdf", mimeType: "application/pdf", size: 9 },
		]);
	});

	it("presents a file under a mount by its absolute path", async () => {
		const { present } = await setUp();
		const result = await present(["/project/brief.md"]);
		expect(result.isError).toBe(false);
		expect((result.details as { presentedFiles: { path: string }[] }).presentedFiles[0]?.path).toBe(
			"/project/brief.md",
		);
	});

	it("presents what it can, says what it couldn't, and presents a repeated path once", async () => {
		const { present } = await setUp();
		const result = await present(["out/report.md", "out/missing.pdf", "out", "out/report.md"]);
		expect(result.isError).toBe(false);
		expect((result.details as { presentedFiles: unknown[] }).presentedFiles).toHaveLength(1);
		const text = (result.output as { text: string }[])[0]?.text ?? "";
		expect(text).toContain("Not presented:");
		expect(text).toContain("out/missing.pdf");
		expect(text).toContain("is a directory");
	});

	it("fails, with no details, when nothing could be presented", async () => {
		const { present } = await setUp();
		const result = await present(["/etc/passwd"]);
		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
	});
});

describe("presentedMediaType", () => {
	it("knows the formats the viewer renders", () => {
		expect(presentedMediaType("a.PDF")).toBe("application/pdf");
		expect(presentedMediaType("a.docx")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(presentedMediaType("Makefile")).toBe("text/plain");
		expect(presentedMediaType("a.bin")).toBe("application/octet-stream");
	});
});

describe("workspacePathOf", () => {
	it("is relative inside the workspace and absolute under a mount", () => {
		expect(workspacePathOf("/workspace/out/a.md")).toBe("out/a.md");
		expect(workspacePathOf("/project/a.md")).toBe("/project/a.md");
	});
});
