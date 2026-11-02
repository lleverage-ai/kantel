import { TOOL_SERVER_MODEL_NAME_MAX, toolServerModelName } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { KANTEL_TOOL_NAMESPACE, MAX_TOOL_NAME_LENGTH } from "../src/tool-names.ts";

describe("tool server tool names under the namespace", () => {
	it("fit within the model's limit at the longest a profile may name", () => {
		// 50 was set against `mcp__harbour__` (14 characters); `mcp__kantel__` is 13, so one is to spare.
		expect(KANTEL_TOOL_NAMESPACE.length + TOOL_SERVER_MODEL_NAME_MAX).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
		const longest = toolServerModelName("atlas", "t".repeat(TOOL_SERVER_MODEL_NAME_MAX - "atlas__".length));
		expect(`${KANTEL_TOOL_NAMESPACE}${longest}`.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
	});
});
