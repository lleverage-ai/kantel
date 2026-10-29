import { describe, expect, it } from "vitest";
import type { SessionParent } from "../api/client.ts";
import { lineageOf, MAX_LINEAGE } from "./lineage.ts";

const parents = (links: Record<string, SessionParent>) => async (sessionId: string) => links[sessionId];

describe("lineageOf", () => {
	it("is empty for a top-level session", async () => {
		expect(await lineageOf(parents({}), "s-top")).toEqual([]);
	});

	it("lists the sessions above a subagent's, outermost first", async () => {
		const links = {
			"s-grandchild": { id: "s-child", title: "Write the refund tests" },
			"s-child": { id: "s-top", title: "Fix the billing worker" },
		};
		expect(await lineageOf(parents(links), "s-grandchild")).toEqual([
			{ id: "s-top", title: "Fix the billing worker" },
			{ id: "s-child", title: "Write the refund tests" },
		]);
	});

	it("stops at a loop and at the deepest level it shows", async () => {
		const loop = { "s-a": { id: "s-b", title: "B" }, "s-b": { id: "s-a", title: "A" } };
		expect(await lineageOf(parents(loop), "s-a")).toEqual([{ id: "s-b", title: "B" }]);
		const deep = async (sessionId: string) => ({ id: `${sessionId}+`, title: sessionId });
		expect(await lineageOf(deep, "s")).toHaveLength(MAX_LINEAGE);
	});
});
