import type { SessionRecord } from "@harbour/contracts";
import { joinPromptLayers, matchesSessionFilter, paginate } from "@harbour/runtime";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";

const record: SessionRecord = {
	id: "s1",
	organisationId: "o",
	projectId: "p",
	agentId: "a",
	status: "idle",
	labels: { task: "T-1", lane: "web" },
	createdBy: { kind: "system", component: "test" },
	createdAt: 0,
	updatedAt: 0,
};

describe("runtime helpers", () => {
	it("pages with an opaque cursor and refuses a cursor it did not give out", () => {
		const first = paginate([1, 2, 3], { limit: 2 });
		expect(first.items).toEqual([1, 2]);
		expect(first.nextCursor).toBeDefined();
		const second = paginate([1, 2, 3], { limit: 2, cursor: first.nextCursor! });
		expect(second).toEqual({ items: [3] });
		expect(() => paginate([1], { cursor: "nonsense" })).toThrow(/cursor/);
	});

	it("matches a session filter only when every given field and label matches", () => {
		expect(matchesSessionFilter(record, undefined)).toBe(true);
		expect(matchesSessionFilter(record, { projectId: "p", labels: { task: "T-1" } })).toBe(true);
		expect(matchesSessionFilter(record, { labels: { task: "T-1", lane: "api" } })).toBe(false);
		expect(matchesSessionFilter(record, { status: "running" })).toBe(false);
	});

	it("joins prompt layers in order", () => {
		expect(
			joinPromptLayers([
				{ name: "role", text: "One" },
				{ name: "empty", text: "" },
				{ name: "brief", text: "Two" },
			]),
		).toBe("One\n\nTwo");
	});

	it("answers from the script and says so when the script runs dry", async () => {
		const { models, script } = createScriptedModel();
		const model = models.getModels()[0]!;
		script.reply({ text: "scripted" });
		const first = await models.completeSimple(model, { systemPrompt: "Be kind.", messages: [] });
		const second = await models.completeSimple(model, { messages: [] });
		expect(first.content).toEqual([{ type: "text", text: "scripted" }]);
		expect(second.content).toEqual([{ type: "text", text: "(no scripted reply)" }]);
		expect(script.requests[0]?.system).toBe("Be kind.");
	});
});
