import type { CallContext } from "@harbour/contracts";
import { createOnboardingApi } from "@harbour/onboarding/http";
import { createMemoryOnboarding } from "@harbour/onboarding/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-http";
const alice: CallContext = { actor: { kind: "human", userId: "alice" }, organisationId: ORG };
const agent: CallContext = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: ORG };

function setUp(caller: CallContext = alice) {
	const onboarding = createMemoryOnboarding();
	const api = createOnboardingApi({ onboarding, authenticate: async () => caller });
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
	return { onboarding, api, call };
}

describe("the onboarding API", () => {
	it("gets, settles steps, goes back, dismisses and reopens", async () => {
		const { call } = setUp();
		const fresh = await call("GET", "/onboarding");
		expect(fresh.status).toBe(200);
		expect(fresh.body).toEqual({
			organisationId: ORG,
			status: "active",
			current: "models",
			steps: { models: "pending", connectors: "pending", session: "pending" },
		});

		const done = await call("PUT", "/onboarding/steps/models", { status: "done" });
		expect(done.status).toBe(200);
		expect(done.body).toMatchObject({ status: "active", current: "connectors", steps: { models: "done" } });
		expect(typeof done.body.updatedAt).toBe("number");
		expect((await call("PUT", "/onboarding/steps/connectors", { status: "skipped" })).body).toMatchObject({
			current: "session",
		});

		const back = await call("PUT", "/onboarding/current", { step: "connectors" });
		expect(back.body).toMatchObject({ current: "connectors", steps: { models: "done", connectors: "skipped" } });

		expect((await call("POST", "/onboarding/dismiss")).body).toMatchObject({ status: "dismissed" });
		// No body: the first step.
		expect((await call("POST", "/onboarding/reopen")).body).toMatchObject({ status: "active", current: "models" });
		await call("POST", "/onboarding/dismiss");
		expect((await call("POST", "/onboarding/reopen", { step: "session" })).body).toMatchObject({
			status: "active",
			current: "session",
			steps: { models: "done", connectors: "skipped", session: "pending" },
		});

		const completed = await call("PUT", "/onboarding/steps/session", { status: "done" });
		expect(completed.body).toMatchObject({ status: "completed", current: "session" });
		expect((await call("GET", "/onboarding")).body).toEqual(completed.body);
	});

	it("refuses an unknown step or status and an agent's change, and lets an agent read", async () => {
		const { call } = setUp();
		expect((await call("PUT", "/onboarding/steps/billing", { status: "done" })).status).toBe(400);
		expect((await call("PUT", "/onboarding/steps/models", { status: "finished" })).status).toBe(400);
		expect((await call("PUT", "/onboarding/current", {})).status).toBe(400);
		expect((await call("POST", "/onboarding/reopen", { step: "billing" })).status).toBe(400);

		const asAgent = setUp(agent);
		const refused = await asAgent.call("PUT", "/onboarding/steps/models", { status: "done" });
		expect(refused.status).toBe(403);
		expect(refused.body.error.code).toBe("forbidden");
		expect((await asAgent.call("POST", "/onboarding/dismiss")).status).toBe(403);
		expect((await asAgent.call("GET", "/onboarding")).status).toBe(200);
	});

	it("answers 404 for an unknown onboarding route and leaves other paths to other APIs", async () => {
		const { api, call } = setUp();
		expect((await call("GET", "/onboarding/steps")).status).toBe(404);
		expect(await api.fetch(new Request("https://harbour.test/v1/rules"))).toBeUndefined();
		expect(await api.fetch(new Request("https://harbour.test/v1/onboardingx"))).toBeUndefined();
	});
});
