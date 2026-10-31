import { TOOL_SERVER_MODEL_NAME_MAX, toolServerModelName } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { KANTEL_TOOL_NAMESPACE, MAX_TOOL_NAME_LENGTH } from "../src/tool-names.ts";

describe("tool server tool names under the namespace", () => {
	it("fit exactly within the model's limit at the longest a profile may name", () => {
		expect(KANTEL_TOOL_NAMESPACE.length + TOOL_SERVER_MODEL_NAME_MAX).toBe(MAX_TOOL_NAME_LENGTH);
		const longest = toolServerModelName("sal", "t".repeat(TOOL_SERVER_MODEL_NAME_MAX - "sal__".length));
		expect(`${KANTEL_TOOL_NAMESPACE}${longest}`).toHaveLength(MAX_TOOL_NAME_LENGTH);
	});
});
