// The runtime's own tools (`SessionRuntimeOptions.tools`): served in process beside host tools, offered to a session
// only when its profile names them, and their images reach the transcript's tool item.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentProfile, SessionRecord } from "@harbour/contracts";
import type { ToolItem } from "@harbour/protocol";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-tools";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
// A 1x1 transparent PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const profile = (tools: string[]): AgentProfile => ({
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools,
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
});

function setUp(tools: string[]) {
	const { models, script } = createScriptedModel();
	const bound: string[] = [];
	const shot = (record: SessionRecord): ToolRegistration =>
		defineTool({
			name: "shot",
			description: "Takes a picture",
			parameters: Type.Object({}),
			execute: async () => {
				bound.push(record.id);
				return {
					output: [
						{ type: "text", text: "A picture" },
						{ type: "image", mimeType: "image/png", data: PIXEL },
					],
					details: {
						images: [
							{ mimeType: "image/svg+xml", data: "PHN2Zy8+" },
							{ mimeType: "image/jpeg", data: PIXEL },
						],
						browserSessionId: "bsession_1",
					},
				};
			},
		});
	const unnamed = defineTool({
		name: "unnamed",
		description: "Not in the profile",
		parameters: Type.Object({}),
		execute: async () => ({ output: [{ type: "text", text: "never" }] }),
	});
	const service = createMemoryRuntime({ models, tools: (record) => [shot(record), unnamed] });
	return { service, script, bound, tools };
}

describe("the runtime's own tools", () => {
	it("offers a session the tools its profile names, bound to it, and shows their images and browser on the tool item", async () => {
		const { service, script, bound } = setUp(["shot"]);
		try {
			await service.profiles.put(ctx, profile(["shot"]));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			script.reply({ toolCalls: [{ name: "shot", args: {} }] }, { text: "Done" });
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Take one" });
			expect(await service.runtime.wait(ctx, session.id, submission.id)).toMatchObject({ answer: "Done" });
			expect(bound).toEqual([session.id]);
			// The model saw the picture's text in the tool result.
			expect(script.requests[1]?.messages.some((message) => message.text.includes("A picture"))).toBe(true);
			const snapshot = await service.runtime.snapshot(ctx, session.id);
			const tool = snapshot.items.find((item): item is ToolItem => item.kind === "tool");
			expect(tool).toMatchObject({ name: "shot", status: "done", output: "A picture" });
			// The content's image, then the details' raster image; the SVG is dropped.
			expect(tool?.images).toEqual([
				{ mimeType: "image/png", data: PIXEL },
				{ mimeType: "image/jpeg", data: PIXEL },
			]);
			// The browser the call used, from its UI details, for the console's live view.
			expect(tool?.browserSessionId).toBe("bsession_1");
		} finally {
			await service.close();
		}
	});

	it("does not offer a tool the profile leaves out", async () => {
		const { service, script } = setUp([]);
		try {
			await service.profiles.put(ctx, profile([]));
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			script.reply({ toolCalls: [{ name: "unnamed", args: {} }] }, { text: "Done" });
			const submission = await service.runtime.prompt(ctx, session.id, { text: "Try it" });
			await service.runtime.wait(ctx, session.id, submission.id);
			const snapshot = await service.runtime.snapshot(ctx, session.id);
			const tool = snapshot.items.find((item): item is ToolItem => item.kind === "tool");
			expect(tool?.status).toBe("error");
			expect(tool?.output ?? "").not.toContain("never");
		} finally {
			await service.close();
		}
	});
});
