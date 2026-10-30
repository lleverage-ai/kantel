import type { CallContext } from "@harbour/contracts";
import { createRulesApi } from "@harbour/rules/http";
import { createMemoryPromptRules } from "@harbour/rules/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-http";
const alice: CallContext = { actor: { kind: "human", userId: "alice" }, organisationId: ORG };
const agent: CallContext = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: ORG };

function setUp(caller: CallContext = alice) {
	const rules = createMemoryPromptRules();
	const api = createRulesApi({ rules, authenticate: async () => caller });
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await api.fetch(
			new Request(`https://harbour.test/v1${path}`, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			}),
		);
		// biome-ignore lint/suspicious/noExplicitAny: a test reads the answer's JSON loosely.
		const json: any = response === undefined ? undefined : await response.json();
		return { status: response?.status, body: json };
	};
	return { rules, api, call };
}

describe("the rules API", () => {
	it("puts, lists, resolves, gets and removes rules", async () => {
		const { call } = setUp();
		const organisation = { kind: "organisation", organisationId: ORG };
		const put = await call("PUT", "/rules", { owner: organisation, name: "tone", text: "Be brief." });
		expect(put.status).toBe(200);
		expect(put.body).toMatchObject({ owner: organisation, name: "tone", text: "Be brief.", order: 0 });
		await call("PUT", "/rules", {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			name: "mine",
			text: "British English.",
		});
		await call("PUT", "/rules", {
			owner: { kind: "project", organisationId: ORG, projectId: "p1" },
			name: "proj",
			text: "Project rule.",
		});

		expect(
			(await call("GET", "/rules?owner=organisation")).body.items.map((rule: { name: string }) => rule.name),
		).toEqual(["tone"]);
		// `owner=user` defaults to the calling person.
		expect((await call("GET", "/rules?owner=user")).body.items).toHaveLength(1);
		expect((await call("GET", "/rules?owner=project")).status).toBe(400);
		const resolved = await call("GET", "/rules/resolved?projectId=p1");
		expect(resolved.body.items.map((rule: { name: string }) => rule.name)).toEqual(["tone", "proj", "mine"]);
		expect((await call("GET", "/rules/resolved")).body.items.map((rule: { name: string }) => rule.name)).toEqual([
			"tone",
			"mine",
		]);

		const id = put.body.id as string;
		expect((await call("GET", `/rules/${id}`)).body).toMatchObject({ id, name: "tone" });
		expect((await call("DELETE", `/rules/${id}`)).body).toMatchObject({ id });
		expect((await call("GET", `/rules/${id}`)).status).toBe(404);
	});

	it("refuses an invalid body and an agent's write", async () => {
		expect(
			(
				await setUp().call("PUT", "/rules", {
					owner: { kind: "organisation", organisationId: ORG },
					name: "has space",
					text: "x",
				})
			).status,
		).toBe(400);
		const asAgent = setUp(agent);
		const refused = await asAgent.call("PUT", "/rules", {
			owner: { kind: "organisation", organisationId: ORG },
			name: "tone",
			text: "x",
		});
		expect(refused.status).toBe(403);
	});

	it("leaves other paths to other APIs", async () => {
		const { api } = setUp();
		expect(await api.fetch(new Request("https://harbour.test/v1/skills"))).toBeUndefined();
	});
});
