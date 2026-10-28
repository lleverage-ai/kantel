import { parseCatalogueListing } from "@harbour/models/catalogue";
import {
	createRecordingFetch,
	type ModelConnectorTarget,
	registerModelConnectorConformance,
} from "@harbour/testing/models";
import { describe, expect, it } from "vitest";
import { chooseCpaModels } from "./cpa-models.ts";
import { withNodeStack } from "./support.ts";

/**
 * The connector suite against a real CLIProxyAPI, on all three wire APIs, through the Node server. It runs only when
 * `HARBOUR_CPA_BASE_URL` (such as `http://cpa.internal:8317`, with or without `/v1`) and `HARBOUR_CPA_API_KEY` are
 * set, and skips otherwise; CI sets neither.
 *
 * It reads CPA's `/v1/models` first and runs each wire API on a model this CPA lists and pi-ai's catalogue knows
 * (`chooseCpaModels`): `HARBOUR_CPA_MESSAGES_MODEL`, `HARBOUR_CPA_RESPONSES_MODEL` and `HARBOUR_CPA_COMPLETIONS_MODEL`
 * pick one, and must name such a model. A wire API with no usable model fails with the reason, before any call.
 */
const baseUrl = process.env.HARBOUR_CPA_BASE_URL;
const key = process.env.HARBOUR_CPA_API_KEY;

/** CPA's model IDs, or why they couldn't be read. Only the status is reported, never the request or its key. */
async function cpaListing(root: string, apiKey: string): Promise<readonly string[] | string> {
	try {
		const response = await fetch(`${root}/models`, {
			headers: { authorization: `Bearer ${apiKey}` },
			// It runs while the file is collected, where no test timeout applies; this bounds the body read too.
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return `CPA's /v1/models answered ${response.status}`;
		return parseCatalogueListing(await response.json()).map((model) => model.id);
	} catch (error) {
		return `CPA's /v1/models could not be read: ${error instanceof Error ? error.name : "error"}`;
	}
}

if (baseUrl && key) {
	const root = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
	const listing = await cpaListing(root, key);
	const failures: (readonly [string, string])[] = [];
	const targets: ModelConnectorTarget[] = [];
	if (typeof listing === "string") failures.push(["reads CPA's model listing", listing]);
	else {
		for (const choice of chooseCpaModels(listing, process.env)) {
			if ("error" in choice) failures.push([`has a model to run ${choice.api} on`, choice.error]);
			else targets.push({ preset: "cliproxyapi", api: choice.api, modelId: choice.modelId, baseUrl: root, key });
		}
	}
	if (failures.length > 0) {
		describe("cliproxyapi, live, setup", () => {
			for (const [name, reason] of failures) {
				it(name, () => {
					throw new Error(reason);
				});
			}
		});
	}
	if (targets.length > 0) {
		registerModelConnectorConformance(
			{ describe, expect, it },
			"cliproxyapi, live",
			async (deps, use) => {
				await withNodeStack(deps, createRecordingFetch(), use);
			},
			targets,
		);
	}
} else {
	describe.skip("cliproxyapi, live", () => {
		it("needs HARBOUR_CPA_BASE_URL and HARBOUR_CPA_API_KEY", () => {});
	});
}
