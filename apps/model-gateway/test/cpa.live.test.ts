import {
	createRecordingFetch,
	type ModelConnectorTarget,
	registerModelConnectorConformance,
} from "@harbour/testing/models";
import { describe, expect, it } from "vitest";
import { withNodeStack } from "./support.ts";

/**
 * The connector suite against a real CLIProxyAPI, on all three wire APIs, through the Node server. It runs only when
 * `HARBOUR_CPA_BASE_URL` (such as `http://cpa.internal:8317`, with or without `/v1`) and `HARBOUR_CPA_API_KEY` are
 * set, and skips otherwise; CI sets neither. `HARBOUR_CPA_MESSAGES_MODEL`, `HARBOUR_CPA_RESPONSES_MODEL` and
 * `HARBOUR_CPA_COMPLETIONS_MODEL` pick the models (defaults below; each must be in pi-ai's catalogue).
 */
const baseUrl = process.env.HARBOUR_CPA_BASE_URL;
const key = process.env.HARBOUR_CPA_API_KEY;

if (baseUrl && key) {
	const root = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
	const targets: ModelConnectorTarget[] = [
		["anthropic-messages", process.env.HARBOUR_CPA_MESSAGES_MODEL || "claude-sonnet-4-5"],
		["openai-responses", process.env.HARBOUR_CPA_RESPONSES_MODEL || "gpt-5"],
		["openai-completions", process.env.HARBOUR_CPA_COMPLETIONS_MODEL || "gemini-2.5-pro"],
	].map(([api, modelId]) => ({
		preset: "cliproxyapi",
		api: api as ModelConnectorTarget["api"],
		modelId: modelId!,
		baseUrl: root,
		key,
	}));
	registerModelConnectorConformance(
		{ describe, expect, it },
		"cliproxyapi, live",
		async (deps, use) => {
			await withNodeStack(deps, createRecordingFetch(), use);
		},
		targets,
	);
} else {
	describe.skip("cliproxyapi, live", () => {
		it("needs HARBOUR_CPA_BASE_URL and HARBOUR_CPA_API_KEY", () => {});
	});
}
