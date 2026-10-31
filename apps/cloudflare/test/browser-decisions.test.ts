// Browser goal mode's decisions (src/browser-decisions.ts): a container's request, checked against its browser's token,
// answered by Clef through Workers AI or Jev with the Worker's key, never with the key in the container.
import { describe, expect, it } from "vitest";
import { answerDecision, CLEF_MODEL, JEV_MODEL } from "../src/browser-decisions.ts";

const TOKEN = "a".repeat(64);
const body = { questions: { pick: { type: "choose", options: ["a", "b"] } }, state: "page" };
const ask = (path: string, init: RequestInit = {}) =>
	new Request(`http://192.0.2.10${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		...init,
	});

describe("browser goal mode's decisions", () => {
	it("answers Clef through the Workers AI binding with the request as given, and prices it", async () => {
		const runs: { model: string; input: unknown }[] = [];
		const ai = {
			run: async (model: string, input: unknown) => {
				runs.push({ model, input });
				return {
					model: "cloudflare/clef",
					answers: { pick: { value: "a", p: 0.9 } },
					usage: { input_tokens: 1_000_000 },
				};
			},
		};
		const response = await answerDecision(ask("/decide/clef"), TOKEN, { ai });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			model: "cloudflare/clef",
			answers: { pick: { value: "a", p: 0.9 } },
			usage: { input_tokens: 1_000_000 },
			cost_usd: 0.33,
		});
		expect(runs).toEqual([{ model: CLEF_MODEL, input: body }]);
	});

	it("answers Jev with the Worker's key, which the container never sends", async () => {
		const sent: { url: string; init: RequestInit }[] = [];
		const fetch = async (url: string, init?: RequestInit) => {
			sent.push({ url, init: init ?? {} });
			return Response.json({ answers: { pick: { value: "b", p: 0.7 } }, usage: { input_tokens: 10 } });
		};
		const response = await answerDecision(ask("/decide/jev"), TOKEN, { jevApiKey: "jev-key", fetch });
		expect(response.status).toBe(200);
		expect((await response.json()) as object).toMatchObject({ model: JEV_MODEL, answers: { pick: { value: "b" } } });
		expect(sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe("Bearer jev-key");
		expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ model: JEV_MODEL, ...body });
	});

	it("refuses a request without the browser's token, so a page can't spend the model", async () => {
		const ai = { run: async () => ({ answers: {} }) };
		for (const authorization of ["", "Bearer nope", `Bearer ${TOKEN}x`]) {
			const response = await answerDecision(ask("/decide/clef", { headers: { authorization } }), TOKEN, { ai });
			expect(response.status, authorization).toBe(403);
		}
	});

	it("is unavailable without the model's binding or key, and refuses other routes and bodies", async () => {
		expect((await answerDecision(ask("/decide/clef"), TOKEN, {})).status).toBe(503);
		expect((await answerDecision(ask("/decide/jev"), TOKEN, {})).status).toBe(503);
		expect((await answerDecision(ask("/decide/gpt"), TOKEN, {})).status).toBe(404);
		expect((await answerDecision(ask("/decide/clef", { method: "GET", body: null }), TOKEN, {})).status).toBe(405);
		expect((await answerDecision(ask("/decide/clef", { body: "nope" }), TOKEN, {})).status).toBe(400);
		expect((await answerDecision(ask("/decide/clef", { body: "{}" }), TOKEN, {})).status).toBe(400);
	});

	it("says the model failed when it gives no answers", async () => {
		const ai = { run: async () => ({ result: "text" }) };
		expect((await answerDecision(ask("/decide/clef"), TOKEN, { ai })).status).toBe(502);
	});
});
