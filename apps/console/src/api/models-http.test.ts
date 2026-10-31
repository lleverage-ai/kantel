import type { ConnectorModels } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { apiModels, choiceId, imageModelOptions, ModelsApiError } from "./models-http.ts";

const CPA: ConnectorModels = {
	id: "cpa",
	owner: { kind: "platform" },
	preset: "cliproxyapi",
	routes: [
		{ name: "default", modelId: "claude-sonnet-5-5" },
		{ name: "images", modelId: "gpt-image-1" },
	],
	models: [
		{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: ["text", "image"], output: ["text"] },
		{ id: "gpt-image-1", name: "GPT Image 1", input: ["text", "image"], output: ["image"], imageApi: "openai-images" },
		{ id: "dall-e-3", name: "DALL-E 3", input: ["text"], output: ["image"], imageApi: "openai-images" },
	],
};

describe("the Models page's seam", () => {
	it("offers each image model: as the route that names it, else over the connector's first route", () => {
		const unrouted: ConnectorModels = { ...CPA, id: "none", routes: [] };
		expect(imageModelOptions([CPA, unrouted])).toEqual([
			{ id: "images", choice: { route: "images" }, label: "GPT Image 1 (route images)", connectorId: "cpa" },
			{
				id: "default:dall-e-3",
				choice: { route: "default", modelId: "dall-e-3" },
				label: "DALL-E 3 (cpa)",
				connectorId: "cpa",
			},
		]);
		expect(choiceId({ route: "default" })).toBe("default");
		expect(choiceId({ route: "default", modelId: "gpt-5" })).toBe("default:gpt-5");
	});

	it("calls the connectors and profile routes, and rejects with the API's code and message", async () => {
		const seen: string[] = [];
		const models = apiModels({
			headers: () => ({ authorization: "Bearer t" }),
			fetch: async (input, init) => {
				seen.push(`${init?.method} ${String(input)} ${init?.body ?? ""}`);
				if (String(input).includes("test-image")) {
					return Response.json({ error: { code: "forbidden", message: "Needs admin" } }, { status: 403 });
				}
				return Response.json({ items: [CPA] });
			},
		});
		expect(await models.connectors("prj 1")).toEqual([CPA]);
		const refused = await models.testImage("cpa", { projectId: "prj 1", modelId: "gpt-image-1" }).catch((e) => e);
		expect(refused).toBeInstanceOf(ModelsApiError);
		expect(refused).toMatchObject({ code: "forbidden", message: "Needs admin" });
		expect(seen).toEqual([
			"GET /v1/connectors?projectId=prj+1 ",
			'POST /v1/connectors/cpa/test-image {"projectId":"prj 1","modelId":"gpt-image-1"}',
		]);
	});
});
