import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CallContext } from "@harbour/contracts";
import { CREATE_DOCUMENT_TOOL, createDocumentTool, documentSlug } from "@harbour/sandbox/documents";
import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { createSandboxExecutionEnv } from "@harbour/sandbox/pi-env";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const ORG = { kind: "organisation", organisationId: "org-1" } as const;

async function setUp() {
	const workspaces = createMemoryWorkspaces();
	const record = await workspaces.create(ctx, { owner: ORG, seed: { name: "s", sources: [] } });
	const env = createSandboxExecutionEnv({
		ctx,
		sessionId: "sess-1",
		workspaceId: record.id,
		sandboxes: createMemorySandboxes({ workspaces }),
		workspaces,
	});
	const tool = createDocumentTool(record.id);
	const create = (title: string, content: string) =>
		tool.execute({ title, content }, { env } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
	const read = async (path: string) => new TextDecoder().decode((await workspaces.read(ctx, record.id, path)).content);
	return { workspaceId: record.id, create, read };
}

describe("create_document", () => {
	it("asks for a title, then the Markdown, and nothing else", () => {
		const tool = createDocumentTool("ws-1" as never);
		expect(tool.name).toBe(CREATE_DOCUMENT_TOOL);
		const schema = tool.parameters as unknown as { required: string[]; properties: Record<string, unknown> };
		expect(Object.keys(schema.properties)).toEqual(["title", "content"]);
		expect(schema.required).toEqual(["title", "content"]);
	});

	it("saves the document under documents/ and presents it with its title", async () => {
		const { workspaceId, create, read } = await setUp();
		const result = await create("The colours of the rainbow", "# The colours of the rainbow\n\nRed, orange.");
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({
			presentedFiles: [
				{
					workspaceId,
					path: "documents/the-colours-of-the-rainbow.md",
					name: "the-colours-of-the-rainbow.md",
					mimeType: "text/markdown",
					size: 43,
					title: "The colours of the rainbow",
				},
			],
		});
		expect(await read("documents/the-colours-of-the-rainbow.md")).toBe(
			"# The colours of the rainbow\n\nRed, orange.\n",
		);
	});

	it("never writes over another document of the same title", async () => {
		const { create, read } = await setUp();
		await create("Plan", "# One");
		const second = await create("Plan", "# Two");
		const [file] = (second.details as { presentedFiles: { path: string }[] }).presentedFiles;
		expect(file?.path).toBe("documents/plan-2.md");
		expect(await read("documents/plan.md")).toBe("# One\n");
		expect(await read("documents/plan-2.md")).toBe("# Two\n");
	});

	it("names a file after its title in plain letters and hyphens", () => {
		expect(documentSlug("Q3 plan: what's next?")).toBe("q3-plan-what-s-next");
		expect(documentSlug("Café résumé")).toBe("cafe-resume");
		expect(documentSlug("!!!")).toBe("document");
	});
});
